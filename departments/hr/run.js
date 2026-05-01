#!/usr/bin/env node

/**
 * departments/hr/run.js — HR orchestrator for Darkroom.
 *
 * Manages the org: interviewing roles and building brains. Runs independently
 * of the factory — brains are set up before production starts, not during.
 *
 * Usage:
 *   node departments/hr/run.js --role <id>
 *   node departments/hr/run.js --role <id> --run-id <id>  # GUI mode
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const { fileExists, logEvent, readFile, writeFile, buildSystemPrompt, runLockableInterview } = require("../../lib/runner-utils");
const { claudeCall }       = require("../../adapters/claude-cli");
const { createInteraction } = require("../../io/interaction");
const { cliAdapter }       = require("../../io/adapters/cli");
const { fileAdapter }      = require("../../io/adapters/file");
const { A, createPhaseDisplay, setRunDir } = require("../../lib/display");
const org     = require("../../lib/org");
const workers = require("../../lib/workers");

const HR_SESSIONS_DIR = path.join(__dirname, "..", "..", "org", "sessions");

function createIO(runDir) {
  if (process.env.DARK_ROOM_IO === "file") return createInteraction(fileAdapter(runDir));
  return createInteraction(cliAdapter());
}

function makeTokenLogger(tokenLogPath) {
  return (label, usage) => {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      phase: "HR",
      label,
      input:      usage?.input_tokens                ?? 0,
      output:     usage?.output_tokens               ?? 0,
      cacheRead:  usage?.cache_read_input_tokens     ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    });
    fs.appendFileSync(tokenLogPath, entry + "\n");
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const roleId       = get("--role");
  const createRole   = args.includes("--create-role");
  const createWorker = args.includes("--create-worker");
  const runId        = get("--run-id") ?? crypto.randomBytes(4).toString("hex");
  const io           = get("--io") ?? null;

  if (!roleId && !createRole && !createWorker) {
    console.error("Usage: node departments/hr/run.js --role <id>  |  --create-role  |  --create-worker");
    process.exit(1);
  }

  return { roleId, createRole, createWorker, runId, io };
}

async function runInterview(role, runDir, io) {
  const transcriptPath = org.getTranscriptPath(role);
  const logTokensRole  = makeTokenLogger(org.getTokenLogPath(role));

  const interviewerPrompt  = readFile(path.join(__dirname, "brain-interviewer.md"));
  const roleContext        = org.buildRoleContext(role);
  const contextFileContent = role.contextFile
    ? readFile(path.join(__dirname, "..", "..", role.contextFile))
    : null;

  function buildInterviewSystem(...extra) {
    return buildSystemPrompt(
      interviewerPrompt,
      roleContext,
      contextFileContent ? `## Additional Context\n\n${contextFileContent}` : null,
      ...extra
    );
  }

  // Recovery path: transcript exists but brain was never written
  if (fileExists(transcriptPath) && !org.brainExists(role)) {
    console.log(`  ${A.yellow("↻")}  ${role.name} brain transcript found — recovering from previous session\n`);
    const display = createPhaseDisplay("HR", `${role.name} Brain`, "", "recovering...");
    display.update("locking brain...");
    const lockPrompt = buildInterviewSystem(`## Interview Transcript\n\n${readFile(transcriptPath)}`);
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked brain profile now as specified in your output format.",
      (u) => logTokensRole(`${role.name} Brain Interviewer`, u)
    );
    const lockedOutput = result.output ?? result;
    if (!lockedOutput?.brain) {
      display.stop();
      console.error(`Recovery failed for role: ${role.id}`);
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    org.writeBrain(role, lockedOutput.brain);
    if (lockedOutput.config && role.config?.length > 0) org.writeRoleConfig(role, lockedOutput.config);
    display.finish(`${role.name} brain recovered`);
    console.log(`\n  ${A.dim(`${role.name} brain saved.`)}\n`);
    return;
  }

  // Fresh interview
  writeFile(transcriptPath, `# Brain Interview Transcript — ${role.name}\n`);
  const systemPrompt = buildInterviewSystem();

  const display = createPhaseDisplay("HR", `${role.name} Brain`, "", "thinking...");
  display.log(`\n  ${A.dim(`Building the ${role.name} decision-making profile.`)}`);
  display.log(`  ${A.dim('When you\'re satisfied, type "lock" to finalize.\n')}`);

  async function executeLock() {
    display.update("locking brain...");
    const lockPrompt = buildInterviewSystem(`## Interview Transcript\n\n${readFile(transcriptPath)}`);
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked brain profile now as specified in your output format.",
      (u) => logTokensRole(`${role.name} Brain Interviewer`, u)
    );
    return result.output ?? result;
  }

  const lockedOutput = await runLockableInterview({
    systemPrompt, transcriptPath, display, io,
    agentName: `${role.name} Brain Interviewer`,
    lockSignalRe: /ready to lock the brain/i,
    lockConfirmPrompt: `Lock the ${role.name} brain?`,
    executeLock,
    onUsage: (u) => logTokensRole(`${role.name} Brain Interviewer`, u),
  });

  if (!lockedOutput?.brain) {
    console.error(`Interview for ${role.name} did not produce a valid locked output.`);
    console.error(JSON.stringify(lockedOutput, null, 2));
    process.exit(1);
  }

  org.writeBrain(role, lockedOutput.brain);
  if (lockedOutput.config && role.config?.length > 0) org.writeRoleConfig(role, lockedOutput.config);
  display.finish(`${role.name} brain written`);
  io.close();
  console.log(`\n  ${A.dim(`${role.name} brain saved — will be used for all future decisions in this domain.`)}\n`);
}

async function runCreateRole(runDir, io) {
  const designerPrompt = readFile(path.join(__dirname, "role-designer.md"));
  const factoryContext = org.buildCreateRoleContext();

  const systemPrompt   = buildSystemPrompt(designerPrompt, factoryContext);
  const transcriptPath = path.join(runDir, "role-design-transcript.md");
  writeFile(transcriptPath, "# Role Design Transcript\n");

  const display = createPhaseDisplay("HR", "Role Designer", "", "thinking...");
  display.log(`\n  ${A.dim("Designing a new org role.")}`);
  display.log(`  ${A.dim('When the spec is ready, say "yes" to create the role.\n')}`);

  const logTokensDesign = makeTokenLogger(path.join(runDir, "token-usage.jsonl"));

  async function executeLock() {
    display.update("creating role...");
    const lockPrompt = buildSystemPrompt(
      designerPrompt,
      factoryContext,
      `## Design Transcript\n\n${readFile(transcriptPath)}`
    );
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked role spec now as specified in your output format.",
      (u) => logTokensDesign("Role Designer", u)
    );
    return result.output ?? result;
  }

  const lockedOutput = await runLockableInterview({
    systemPrompt, transcriptPath, display, io,
    agentName: "Role Designer",
    lockSignalRe: /ready to create this role/i,
    lockConfirmPrompt: "Create this role and start the brain interview?",
    executeLock,
    onUsage: (u) => logTokensDesign("Role Designer", u),
  });

  if (!lockedOutput?.id || !lockedOutput?.name) {
    console.error("Role design did not produce a valid spec.");
    console.error(JSON.stringify(lockedOutput, null, 2));
    process.exit(1);
  }

  const newRole = org.addRole(lockedOutput);
  display.finish(`Role "${newRole.name}" created`);
  console.log(`\n  ${A.dim(`Role saved to org chart — starting brain interview for ${newRole.name}.\n`)}`);
  return newRole;
}

async function runCreateWorker(runDir, io) {
  const designerPrompt  = readFile(path.join(__dirname, "worker-designer.md"));
  const factoryContext  = workers.buildCreateWorkerContext();

  const systemPrompt   = buildSystemPrompt(designerPrompt, factoryContext);
  const transcriptPath = path.join(runDir, "worker-design-transcript.md");
  writeFile(transcriptPath, "# Worker Design Transcript\n");

  const display = createPhaseDisplay("HR", "Worker Designer", "", "thinking...");
  display.log(`\n  ${A.dim("Designing a new worker agent.")}`);
  display.log(`  ${A.dim('When the spec is ready, say "yes" to create the worker.\n')}`);

  const logTokensDesign = makeTokenLogger(path.join(runDir, "token-usage.jsonl"));

  async function executeLock() {
    display.update("creating worker...");
    const lockPrompt = buildSystemPrompt(
      designerPrompt,
      factoryContext,
      `## Design Transcript\n\n${readFile(transcriptPath)}`
    );
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked worker spec now as specified in your output format.",
      (u) => logTokensDesign("Worker Designer", u)
    );
    return result.output ?? result;
  }

  const lockedOutput = await runLockableInterview({
    systemPrompt, transcriptPath, display, io,
    agentName: "Worker Designer",
    lockSignalRe: /ready to create this worker/i,
    lockConfirmPrompt: "Create this worker?",
    executeLock,
    onUsage: (u) => logTokensDesign("Worker Designer", u),
  });

  if (!lockedOutput?.id || !lockedOutput?.name) {
    console.error("Worker design did not produce a valid spec.");
    console.error(JSON.stringify(lockedOutput, null, 2));
    process.exit(1);
  }

  const newWorker = workers.addWorker(lockedOutput);
  display.finish(`Worker "${newWorker.name}" created`);
  console.log(`\n  ${A.dim(`Worker saved — assign it to a slot in any factory profile.\n`)}`);
  return newWorker;
}

async function main() {
  const { roleId, createRole, createWorker, runId, io: ioFlag } = parseArgs();
  if (ioFlag === "file") process.env.DARK_ROOM_IO = "file";

  const runDir = path.join(HR_SESSIONS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  setRunDir(runDir);
  const io = createIO(runDir);

  if (createRole) {
    console.log(`\n${A.bold("Darkroom")} — HR`);
    console.log(`Task:  ${A.cyan("New Role Design")}`);
    console.log(`Run:   ${A.cyan(runId)}\n`);

    logEvent(runDir, { phase: "hr", event: "role-design-start" });
    const role = await runCreateRole(runDir, io);
    logEvent(runDir, { phase: "hr", event: "role-design-complete", role: role.id });

    logEvent(runDir, { phase: "hr", event: "interview-start", role: role.id });
    await runInterview(role, runDir, io);
    logEvent(runDir, { phase: "hr", event: "interview-complete", role: role.id });
  } else if (createWorker) {
    console.log(`\n${A.bold("Darkroom")} — HR`);
    console.log(`Task:  ${A.cyan("New Worker Design")}`);
    console.log(`Run:   ${A.cyan(runId)}\n`);

    logEvent(runDir, { phase: "hr", event: "worker-design-start" });
    await runCreateWorker(runDir, io);
    logEvent(runDir, { phase: "hr", event: "worker-design-complete" });
  } else {
    org.reloadAll();
    const roles = org.loadRoles();
    const role  = roles[roleId];
    if (!role) {
      console.error(`Unknown role: ${roleId}`);
      process.exit(1);
    }

    console.log(`\n${A.bold("Darkroom")} — HR`);
    console.log(`Role:  ${A.cyan(role.name)}`);
    console.log(`Run:   ${A.cyan(runId)}\n`);

    logEvent(runDir, { phase: "hr", event: "interview-start", role: role.id });
    await runInterview(role, runDir, io);
    logEvent(runDir, { phase: "hr", event: "interview-complete", role: role.id });
  }

  logEvent(runDir, { phase: "factory", event: "pipeline-complete" });
}

main().catch((e) => { console.error(e); process.exit(1); });

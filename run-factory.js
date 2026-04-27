#!/usr/bin/env node

/**
 * run-factory.js — Pipeline entry point for the Software Factory.
 *
 * Runs the brain interview (once, global), loads the pipeline profile,
 * hands off to the graph executor, then writes the ledger entry.
 *
 * Modes:
 *   --mode manual  (default) Human handles all decisions inside each runner.
 *   --mode auto    Orchestrator acts as human-in-the-loop.
 *
 * Usage:
 *   node run-factory.js                          # new run, full pipeline
 *   node run-factory.js --run-id <id>            # resume an existing run
 *   node run-factory.js --stop-after <division>  # design|build|review|security
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileExists, logEvent, readFile, writeFile, buildSystemPrompt, runLockableInterview } = require("./lib/runner-utils");
const { claudeCall, claudeCallAsync } = require("./adapters/claude-cli");
const { createInteraction } = require("./io/interaction");
const { cliAdapter } = require("./io/adapters/cli");
const { fileAdapter } = require("./io/adapters/file");
const { A, createPhaseDisplay, setRunDir } = require("./lib/display");
const { runGraph, readTokenUsage, readBudgetLimit } = require("./lib/graph");
const org = require("./lib/org");

// Module-level io and mode — set once in main(), shared by leadership functions.
let io   = null;
let mode = "manual";

function createIO(runDir) {
  if (process.env.DARK_ROOM_IO === "file") return createInteraction(fileAdapter(runDir));
  return createInteraction(cliAdapter());
}

const RUNS_DIR   = path.join(__dirname, "runs");
const AGENTS_DIR = path.join(__dirname, "agents");
const DIVISIONS  = ["design", "build", "review", "security"];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const mode      = get("--mode") ?? "manual";
  const stopAfter = get("--stop-after") ?? null;
  const runId     = get("--run-id") ?? crypto.randomBytes(4).toString("hex");
  const caveman   = args.includes("--caveman");
  const tag       = get("--tag") ?? null;
  const io        = get("--io") ?? null;
  const profile   = get("--profile") ?? "full";

  if (stopAfter && !DIVISIONS.includes(stopAfter)) {
    console.error(`--stop-after must be one of: ${DIVISIONS.join(", ")}`);
    process.exit(1);
  }

  const profilePath = path.join(__dirname, "profiles", `${profile}.json`);
  if (!fs.existsSync(profilePath)) {
    console.error(`Unknown profile: ${profile}  (no profiles/${profile}.json found)`);
    process.exit(1);
  }

  return { mode, stopAfter, runId, caveman, tag, io, profile };
}

// ---------------------------------------------------------------------------
// Leadership token logger
// ---------------------------------------------------------------------------

function makeTokenLogger(tokenLogPath) {
  return (label, usage) => {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      phase: "Leadership",
      label,
      input:      usage?.input_tokens                ?? 0,
      output:     usage?.output_tokens               ?? 0,
      cacheRead:  usage?.cache_read_input_tokens     ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    });
    fs.appendFileSync(tokenLogPath, entry + "\n");
  };
}

// Default token logger points to the root role's log (used for run-brain interview).
function logTokens(label, usage) {
  makeTokenLogger(org.getTokenLogPath(org.getRootRole()))(label, usage);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Run brain interview (per-run, after Design)
// ---------------------------------------------------------------------------

async function runRunBrainInterview(runDir) {
  const runBrainPath = path.join(runDir, "run-brain.md");
  if (fileExists(runBrainPath)) {
    console.log(`  ${A.green("✓")}  Run brain found — skipping interview\n`);
    return;
  }

  const handoffDir = path.join(runDir, "handoff");

  const systemPrompt = buildSystemPrompt(
    readFile(path.join(AGENTS_DIR, "leadership", "run-brain-interviewer.md")),
    `## Global Brain\n\n${org.readBrain(org.getRootRole())}`,
    `## Factory Manifest\n\n${readFile(path.join(handoffDir, "factory-manifest.json"))}`,
    `## Build Spec\n\n${readFile(path.join(handoffDir, "build-spec.md"))}`,
    fileExists(path.join(handoffDir, "review-spec.md"))
      ? `## Review Spec\n\n${readFile(path.join(handoffDir, "review-spec.md"))}`
      : null,
    fileExists(path.join(handoffDir, "runtime-spec.md"))
      ? `## Runtime Spec\n\n${readFile(path.join(handoffDir, "runtime-spec.md"))}`
      : null
  );

  if (mode === "auto") {
    const display = createPhaseDisplay("Leadership", "Run Brain", "", "generating...");
    let result;
    try {
      result = await claudeCallAsync(
        systemPrompt,
        "Generate the locked run brain now. All necessary context is in the specs and the global brain. Produce the locked output as specified in your output format.",
        (u) => logTokens("Run Brain (auto)", u)
      );
    } catch (err) {
      logEvent(runDir, { phase: "leadership", event: "run-brain-error", error: String(err.message ?? err) });
      display.fail("run brain call failed: " + String(err.message ?? err));
      throw err;
    }
    const lockedOutput = result.output ?? result;
    if (!lockedOutput?.runBrain) {
      const msg = "run brain produced invalid output: " + JSON.stringify(result).slice(0, 200);
      logEvent(runDir, { phase: "leadership", event: "run-brain-error", error: msg });
      display.fail(msg);
      process.exit(1);
    }
    writeFile(runBrainPath, lockedOutput.runBrain);
    if (lockedOutput.config) {
      writeFile(path.join(runDir, "run-config.json"), JSON.stringify(lockedOutput.config, null, 2));
    }
    display.finish("run-brain.md generated");
    console.log(`\n  ${A.dim("Run brain generated from specs — applies to this run only.")}\n`);
    return;
  }

  const transcriptPath = path.join(runDir, "run-brain-transcript.md");
  writeFile(transcriptPath, "# Run Brain Interview Transcript\n");

  const ioLocal = createIO(runDir);

  const display = createPhaseDisplay("Leadership", "Run Brain", "", "reading specs...");
  display.log(`\n  ${A.dim("Calibrating for this specific project.")}`);
  display.log(`  ${A.dim('Type "lock" when you\'re satisfied.\n')}`);

  async function executeLock() {
    display.update("locking run brain...");
    const lockPrompt = buildSystemPrompt(
      readFile(path.join(AGENTS_DIR, "leadership", "run-brain-interviewer.md")),
      `## Global Brain\n\n${org.readBrain(org.getRootRole())}`,
      `## Factory Manifest\n\n${readFile(path.join(handoffDir, "factory-manifest.json"))}`,
      `## Build Spec\n\n${readFile(path.join(handoffDir, "build-spec.md"))}`,
      fileExists(path.join(handoffDir, "review-spec.md"))
        ? `## Review Spec\n\n${readFile(path.join(handoffDir, "review-spec.md"))}`
        : null,
      fileExists(path.join(handoffDir, "runtime-spec.md"))
        ? `## Runtime Spec\n\n${readFile(path.join(handoffDir, "runtime-spec.md"))}`
        : null,
      `## Interview Transcript\n\n${readFile(transcriptPath)}`
    );
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked run brain now as specified in your output format.",
      (u) => logTokens("Run Brain", u)
    );
    return result.output ?? result;
  }

  const lockedOutput = await runLockableInterview({
    systemPrompt, transcriptPath, display, io: ioLocal,
    agentName: "Run Brain",
    lockSignalRe: /ready to lock the run brain/i,
    lockConfirmPrompt: "Lock the run brain?",
    executeLock,
    onUsage: (u) => logTokens("Run Brain", u),
  });

  if (!lockedOutput?.runBrain) {
    console.error("Run brain interview did not produce a valid locked output.");
    console.error(JSON.stringify(lockedOutput, null, 2));
    process.exit(1);
  }

  writeFile(runBrainPath, lockedOutput.runBrain);
  if (lockedOutput.config) {
    writeFile(path.join(runDir, "run-config.json"), JSON.stringify(lockedOutput.config, null, 2));
  }
  display.finish("run-brain.md written");
  ioLocal.close();
  console.log(`\n  ${A.dim("Run brain saved — applies to this run only.")}\n`);
}

// ---------------------------------------------------------------------------
// Token ledger
// ---------------------------------------------------------------------------

function writeLedgerEntry(runDir) {
  const ledgerDir  = path.join(__dirname, "accounts");
  const ledgerPath = path.join(ledgerDir, "ledger.jsonl");
  fs.mkdirSync(ledgerDir, { recursive: true });

  const manifestPath = path.join(runDir, "handoff", "factory-manifest.json");
  const manifest = fileExists(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : {};

  const runBrainPath = path.join(runDir, "run-brain.md");
  const scope = fileExists(runBrainPath)
    ? (readFile(runBrainPath).match(/## Project Intent\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().split("\n")[0] ?? "")
    : "";

  const { byPhase, totIn, totOut, totCache } = readTokenUsage(runDir);

  const entry = {
    ts:          new Date().toISOString(),
    runId:       path.basename(runDir),
    projectName: manifest.projectName ?? "",
    scope:       scope.slice(0, 200),
    tokens: {
      ...byPhase,
      total: { input: totIn, output: totOut, cacheRead: totCache },
    },
  };

  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { mode: parsedMode, stopAfter, runId, caveman, tag, io: ioFlag, profile: profileName } = parseArgs();
  mode = parsedMode;
  if (ioFlag === "file") process.env.DARK_ROOM_IO = "file";
  const runDir = path.join(RUNS_DIR, runId);
  setRunDir(runDir);
  io = createIO(runDir);

  if (caveman) process.env.FACTORY_CAVEMAN = "1";

  fs.mkdirSync(runDir, { recursive: true });
  if (tag) writeFile(path.join(runDir, "run-meta.json"), JSON.stringify({ tag, ts: new Date().toISOString() }, null, 2));
  logEvent(runDir, { phase: "factory", event: "start", mode, stopAfter, caveman, tag, profile: profileName });

  const isDefault = profileName === "full";
  console.log(`\n${A.bold("Software Factory")} — Pipeline Orchestrator`);
  console.log(`Run:     ${A.cyan(runId)}${tag ? `  ·  ${A.bold(tag)}` : ""}`);
  console.log(`Profile: ${isDefault ? A.dim(profileName) : A.cyan(profileName)}`);
  console.log(`Mode:    ${mode}${stopAfter ? `  ·  stopping after ${stopAfter}` : ""}${caveman ? `  ·  ${A.dim("caveman")}` : ""}\n`);

  // ── Org brains check ────────────────────────────────────────────────────

  const missingBrains = org.getRolesMissingBrain();
  if (missingBrains.length === 0) {
    console.log(`  ${A.green("✓")}  Org brains ready\n`);
  } else if (mode === "auto") {
    console.log(`  ${A.yellow("⚠")}  No brain found for: ${missingBrains.map((r) => r.name).join(", ")}`);
    console.log(`  ${A.dim("Run HR first to build org brains (node departments/hr/run.js --role <id>).")}`);
    console.log(`  ${A.dim("Auto-mode decisions will require human input until brains are set up.\n")}`);
  } else {
    console.log(`  ${A.dim("ℹ")}  No org brains set up — run HR to enable auto-mode decisions\n`);
  }

  // ── Graph executor ───────────────────────────────────────────────────────

  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, "profiles", `${profileName}.json`), "utf8"));

  // Write worker assignments for dept runners to resolve slot prompts at runtime.
  const assignPath = path.join(runDir, "worker-assignments.json");
  writeFile(assignPath, JSON.stringify(profile.workerAssignments ?? {}, null, 2));

  await runGraph(profile, {
    runId,
    runDir,
    mode,
    stopAfter,
    caveman,
    io,
    logTokens,
    onNodeComplete: async (nodeId) => {
      if (nodeId === "design") {
        if (!fileExists(path.join(runDir, "run-brain.md"))) {
          logEvent(runDir, { phase: "leadership", event: "run-brain-start" });
        }
        await runRunBrainInterview(runDir);
      }
    },
  });

  // ── Pipeline complete ────────────────────────────────────────────────────

  logEvent(runDir, { phase: "factory", event: "pipeline-complete" });
  writeLedgerEntry(runDir);

  const { totOut } = readTokenUsage(runDir);
  const { limit }  = readBudgetLimit(runDir);
  const budgetLine = limit
    ? `  Tokens:   ${totOut.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} output`
    : `  Tokens:   ${totOut.toLocaleString("en-US")} output`;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${A.green("✓")}  Pipeline complete  ·  ${A.cyan(runId)}`);
  console.log(A.dim(budgetLine));
  console.log(`  Inspect:  node inspect.js ${runId}`);
  console.log(`${"─".repeat(60)}\n`);
  io.close();
}

main().catch((err) => {
  console.error(A.red("✗  Fatal:"), err.message ?? err);
  process.exit(1);
});

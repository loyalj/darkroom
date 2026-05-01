#!/usr/bin/env node

/**
 * Phase 1 design division runner.
 *
 * Drives the full design workflow manually:
 *   Phase 1: Functional interview
 *   Phase 2: Experience interview
 *   Phase 3: Consistency check (private)
 *   Phase 4: Clarification round (if needed)
 *   Phase 5: Spec generation
 *
 * Transcripts and output artifacts are written to runs/{run-id}/
 *
 * Usage:
 *   node departments/design/runner.js
 *   node departments/design/runner.js --run-id <existing-id>   # resume a run
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createInteraction } = require("../../io/interaction");
const { cliAdapter } = require("../../io/adapters/cli");
const { fileAdapter } = require("../../io/adapters/file");
const { createPhaseDisplay, createTicker, setRunDir } = require("../../lib/display");
const { logTokens, writeTokenTable, logTime, writeTimeTable } = require("../../lib/token-log");
const { readFile, writeFile, buildSystemPrompt, logEvent, fileExists } = require("../../lib/runner-utils");
const { claudeCall, claudeTurn } = require("../../adapters/claude-cli");
const { runReflector } = require("../../lib/memory");
const workers = require("../../lib/workers");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(__dirname, "..", "..", "agents");
const RUNS_DIR = path.join(__dirname, "..", "..", "runs");
const SHARED_CONVENTIONS = path.join(AGENTS_DIR, "shared", "conventions.md");
const SHARED_OUTPUT_FORMATS = path.join(
  AGENTS_DIR,
  "shared",
  "output-formats.md"
);

// Memory context — loaded once at startup from memory-context.md written by graph executor.
let memoryContext = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function appendTranscript(transcriptPath, role, content) {
  const entry = `\n## ${role}\n\n${content.trim()}\n`;
  fs.appendFileSync(transcriptPath, entry, "utf8");
}

function runId() {
  return crypto.randomBytes(4).toString("hex");
}


// ---------------------------------------------------------------------------
// Interactive interview phase
// ---------------------------------------------------------------------------

async function runInterviewPhase(io, display, agentPromptContent, systemContext, transcriptPath, completionSignal, onUsage) {
  const agentPrompt = agentPromptContent;
  const systemPrompt = buildSystemPrompt(readFile(SHARED_CONVENTIONS), readFile(SHARED_OUTPUT_FORMATS), agentPrompt, systemContext || "", memoryContext);

  const conversationHistory = [];

  // Kick off with an opening message from the agent
  display.update("thinking...");
  let agentTurn = claudeTurn(systemPrompt, conversationHistory, onUsage);
  display.update("your turn");
  display.log(`\nAgent: ${agentTurn}\n`, { subtype: "interview" });
  appendTranscript(transcriptPath, "Agent", agentTurn);
  conversationHistory.push({ role: "assistant", content: agentTurn });

  while (true) {
    const userInput = await io.turn("You: ", { context: agentTurn });
    if (!userInput.trim()) continue;

    appendTranscript(transcriptPath, "User", userInput);
    conversationHistory.push({ role: "user", content: userInput });

    display.update("thinking...");
    agentTurn = claudeTurn(systemPrompt, conversationHistory, onUsage);
    display.update("your turn");
    display.log(`\nAgent: ${agentTurn}\n`, { subtype: "interview" });
    appendTranscript(transcriptPath, "Agent", agentTurn);
    conversationHistory.push({ role: "assistant", content: agentTurn });

    if (agentTurn.toLowerCase().includes(completionSignal.toLowerCase())) {
      break;
    }

    // Fallback: agent broke protocol and emitted a JSON envelope — treat as completion
    const trimmed = agentTurn.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"status"')) {
      appendTranscript(transcriptPath, "System", "(Interview concluded — agent produced structured output instead of completion signal.)");
      break;
    }
  }

  return conversationHistory;
}

// ---------------------------------------------------------------------------
// Clarification round
// ---------------------------------------------------------------------------

async function runClarificationRound(io, issues, transcriptPath, display) {
  display.log("A few things need clarification before the spec can be written.\n");

  for (const issue of issues) {
    display.log(`[${issue.id.toUpperCase()}] ${issue.summary}`);
    display.log(`\nQuestion: ${issue.question}\n`);

    const answer = await io.turn("Your answer: ", { context: issue.question });
    appendTranscript(transcriptPath, `Clarification [${issue.id}]`, issue.question);
    appendTranscript(transcriptPath, "User", answer);
    display.log("");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const resumeIndex = args.indexOf("--run-id");
  const id = resumeIndex >= 0 ? args[resumeIndex + 1] : runId();
  const modeIndex = args.indexOf("--mode");
  const runMode = modeIndex >= 0 ? args[modeIndex + 1] : "manual";
  const runDir = path.join(RUNS_DIR, id);
  setRunDir(runDir);
  const io = process.env.DARK_ROOM_IO === "file"
    ? createInteraction(fileAdapter(runDir))
    : createInteraction(cliAdapter());

  fs.mkdirSync(path.join(runDir, "handoff"), { recursive: true });

  const memCtxPath = path.join(runDir, "memory-context.md");
  memoryContext = fileExists(memCtxPath) ? readFile(memCtxPath) : null;

  console.log(`\nDarkroom — Design Division`);
  console.log(`Run: ${id}\n`);

  logEvent(runDir, { phase: "design", event: "start" });

  // ── Phase 1: Functional Interview ──────────────────────────────────────

  const functionalTranscriptPath = path.join(runDir, "functional-transcript.md");
  if (!fs.existsSync(functionalTranscriptPath)) {
    writeFile(functionalTranscriptPath, `# Functional Interview Transcript\n`);
    const display = createPhaseDisplay("Design", "Functional Interview", "1 of 5", "starting up", { onFinish: (ms) => logTime(runDir, "Design", "Functional Interview", ms) });
    await runInterviewPhase(
      io,
      display,
      workers.resolveSlotPrompt(runDir, "design.interviewer"),
      "",
      functionalTranscriptPath,
      "I have everything I need on the functional side.",
      (u) => logTokens(runDir, "Design", "Functional Interview", u)
    );
    display.finish("complete");
    logEvent(runDir, { phase: "design", event: "functional-interview-complete" });
  } else {
    console.log("Phase 1 transcript found — skipping.\n");
  }

  // ── Phase 2: Experience Interview ──────────────────────────────────────

  const experienceTranscriptPath = path.join(runDir, "experience-transcript.md");
  if (!fs.existsSync(experienceTranscriptPath)) {
    writeFile(experienceTranscriptPath, `# Experience Interview Transcript\n`);
    const functionalContext = `## Functional Interview Context\n\n${readFile(functionalTranscriptPath)}`;
    const display = createPhaseDisplay("Design", "Experience Interview", "2 of 5", "starting up", { onFinish: (ms) => logTime(runDir, "Design", "Experience Interview", ms) });
    await runInterviewPhase(
      io,
      display,
      workers.resolveSlotPrompt(runDir, "design.experience-interviewer"),
      functionalContext,
      experienceTranscriptPath,
      "I have everything I need on the experience side.",
      (u) => logTokens(runDir, "Design", "Experience Interview", u)
    );
    display.finish("complete");
    logEvent(runDir, { phase: "design", event: "experience-interview-complete" });
  } else {
    console.log("Phase 2 transcript found — skipping.\n");
  }

  // ── Phase 3: Consistency Check ─────────────────────────────────────────

  const clarificationTranscriptPath = path.join(runDir, "clarification-transcript.md");
  let issuesFound = [];

  if (!fs.existsSync(clarificationTranscriptPath)) {
    const ticker = createTicker("Design  ·  Consistency Check  [3 of 5]");

    const checkerPrompt = buildSystemPrompt(
      readFile(SHARED_CONVENTIONS),
      readFile(SHARED_OUTPUT_FORMATS),
      readFile(path.join(__dirname, "consistency-checker.md")),
      memoryContext
    );

    const checkerMessage = [
      `## Functional Interview Transcript\n\n${readFile(functionalTranscriptPath)}`,
      `## Experience Interview Transcript\n\n${readFile(experienceTranscriptPath)}`,
    ].join("\n\n---\n\n");

    const t0checker = Date.now();
    const checkerResult = claudeCall(checkerPrompt, checkerMessage, (u) => logTokens(runDir, "Design", "Consistency Checker", u));
    logTime(runDir, "Design", "Consistency Checker", Date.now() - t0checker);
    const output = checkerResult.output ?? checkerResult;
    issuesFound = output.issues || [];

    logEvent(runDir, { phase: "design", event: "consistency-check-complete", issueCount: issuesFound.length });

    if (issuesFound.length === 0) {
      ticker.done("no issues found");
      writeFile(clarificationTranscriptPath, `# Clarification Transcript\n\n(No issues found — clarification round skipped)\n`);
    } else if (runMode === "auto") {
      ticker.done(`${issuesFound.length} issue${issuesFound.length === 1 ? "" : "s"} found — skipped in auto mode`);
      writeFile(clarificationTranscriptPath, `# Clarification Transcript\n\n(${issuesFound.length} issue${issuesFound.length === 1 ? "" : "s"} found — clarification skipped in auto mode, proceeding with best-effort spec generation)\n`);
      logEvent(runDir, { phase: "design", event: "clarification-round-skipped", issueCount: issuesFound.length });
    } else {
      ticker.done(`${issuesFound.length} issue${issuesFound.length === 1 ? "" : "s"} found`);
      writeFile(clarificationTranscriptPath, `# Clarification Transcript\n`);

      // ── Phase 4: Clarification Round ─────────────────────────────────

      const display = createPhaseDisplay(
        "Design", "Clarification", "4 of 5",
        `${issuesFound.length} issue${issuesFound.length === 1 ? "" : "s"} to resolve`,
        { onFinish: (ms) => logTime(runDir, "Design", "Clarification", ms) }
      );
      await runClarificationRound(io, issuesFound, clarificationTranscriptPath, display);
      display.finish("all clarifications complete");
      logEvent(runDir, { phase: "design", event: "clarification-round-complete" });
    }
  } else {
    console.log("Clarification transcript found — skipping.\n");
  }

  // ── Phase 5: Spec Generation ───────────────────────────────────────────

  const buildSpecPath = path.join(runDir, "handoff", "build-spec.md");

  if (!fs.existsSync(buildSpecPath)) {
    const ticker = createTicker("Design  ·  Spec Generation  [5 of 5]");

    const writerPrompt = buildSystemPrompt(
      readFile(SHARED_CONVENTIONS),
      readFile(SHARED_OUTPUT_FORMATS),
      workers.resolveSlotPrompt(runDir, "design.spec-writer"),
      memoryContext
    );

    const writerMessage = [
      `## Functional Interview Transcript\n\n${readFile(functionalTranscriptPath)}`,
      `## Experience Interview Transcript\n\n${readFile(experienceTranscriptPath)}`,
      `## Clarification Transcript\n\n${readFile(clarificationTranscriptPath)}`,
    ].join("\n\n---\n\n");

    const t0writer = Date.now();
    const writerResult = claudeCall(writerPrompt, writerMessage, (u) => logTokens(runDir, "Design", "Spec Writer", u));
    logTime(runDir, "Design", "Spec Writer", Date.now() - t0writer);
    const output = writerResult.output ?? writerResult;

    if (!output.buildSpec || !output.reviewSpec || !output.runtimeSpec || !output.factoryManifest) {
      ticker.fail("incomplete output from spec writer");
      console.error(JSON.stringify(writerResult, null, 2));
      process.exit(1);
    }

    writeFile(buildSpecPath, output.buildSpec);
    writeFile(path.join(runDir, "handoff", "review-spec.md"), output.reviewSpec);
    writeFile(path.join(runDir, "handoff", "runtime-spec.md"), output.runtimeSpec);
    writeFile(
      path.join(runDir, "handoff", "factory-manifest.json"),
      JSON.stringify(output.factoryManifest, null, 2)
    );

    ticker.done("4 specs written");
    logEvent(runDir, { phase: "design", event: "specs-generated" });
  } else {
    console.log("Specs already generated — skipping.\n");
  }

  // ── Done ───────────────────────────────────────────────────────────────

  writeTokenTable(runDir);
  writeTimeTable(runDir);

  const designManifestPath = path.join(runDir, "handoff", "factory-manifest.json");
  const designManifest = fileExists(designManifestPath) ? JSON.parse(readFile(designManifestPath)) : {};
  const clarificationTranscriptExists = fileExists(path.join(runDir, "clarification-transcript.md"));
  const clarificationContent = clarificationTranscriptExists ? readFile(path.join(runDir, "clarification-transcript.md")) : "";
  const clarificationIssueCount = (clarificationContent.match(/^\[/gm) || []).length;

  const reflectorContext = [
    `## Run ID\n\n${id}`,
    `## Factory Manifest\n\n${JSON.stringify(designManifest, null, 2)}`,
    `## Outcome\n\nDesign division completed all phases successfully.`,
    `## Clarification Issues Found\n\n${clarificationIssueCount}`,
  ].join("\n\n---\n\n");

  await runReflector("design", runDir, reflectorContext, (u) => logTokens(runDir, "Design", "Wiki Reflector", u));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Design Division complete.`);
  console.log(`  Run: ${id}`);
  console.log(`${"─".repeat(60)}\n`);
  console.log("Proceed to build: node departments/run-build.js --run-id " + id + "\n");

  logEvent(runDir, { phase: "design", event: "design-division-complete" });
  io.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

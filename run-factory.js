#!/usr/bin/env node

/**
 * run-factory.js — Pipeline orchestrator for the Software Factory.
 *
 * Runs the full division sequence and handles inter-division handoffs and
 * feedback loops automatically. Human decision points inside each division
 * remain unchanged in manual mode.
 *
 * Modes:
 *   --mode manual  (default) Human handles all decisions inside each runner.
 *   --mode auto    Orchestrator acts as human-in-the-loop. (coming soon)
 *
 * Usage:
 *   node run-factory.js                          # new run, full pipeline
 *   node run-factory.js --run-id <id>            # resume an existing run
 *   node run-factory.js --stop-after <division>  # design|build|review|security
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const { fileExists, logEvent, writeDecision, readFile, writeFile, buildSystemPrompt, clipForDisplay, question, claudeRaw, claudeCall, claudeTurn, runLockableInterview } = require("./runner-utils");
const { A, createPhaseDisplay } = require("./display");

const RUNS_DIR    = path.join(__dirname, "runs");
const BRAIN_PATH  = path.join(__dirname, "brain.md");
const AGENTS_DIR  = path.join(__dirname, "agents");
const DIVISIONS   = ["Design", "Build", "Review", "Security"];
const MAX_LOOPS   = 3;

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

  // auto mode is live — signals handled for implemented decision points
  if (stopAfter && !DIVISIONS.map((d) => d.toLowerCase()).includes(stopAfter)) {
    console.error(`--stop-after must be one of: ${DIVISIONS.map((d) => d.toLowerCase()).join(", ")}`);
    process.exit(1);
  }

  return { mode, stopAfter, runId, caveman, tag };
}

// ---------------------------------------------------------------------------
// Division runner
// ---------------------------------------------------------------------------

function runDivision(script, extraArgs = []) {
  const result = spawnSync("node", [script, ...extraArgs], {
    stdio: "inherit",
    cwd: __dirname,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    // Ctrl+C or external kill — exit cleanly with conventional code
    process.exit(130);
  }
  return result.status ?? 1;
}

// Auto mode: spawn with piped stdin/stdout, passthrough to terminal, intercept signals.
function runDivisionAuto(script, extraArgs = [], onSignal) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [script, ...extraArgs], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: __dirname,
      env: { ...process.env, FACTORY_AUTO: "1" },
    });

    let buf = "";
    let signalInFlight = false;

    proc.stdout.on("data", (chunk) => {
      process.stdout.write(chunk); // passthrough to terminal
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep trailing incomplete line

      for (const line of lines) {
        const match = line.match(/^FACTORY_SIGNAL:(.+)$/);
        if (match && !signalInFlight) {
          signalInFlight = true;
          let signal;
          try { signal = JSON.parse(match[1]); } catch { signal = { raw: match[1] }; }
          Promise.resolve(onSignal(signal))
            .then((response) => {
              proc.stdin.write(response + "\n");
              signalInFlight = false;
            })
            .catch(reject);
        }
      }
    });

    proc.on("close", (code) => {
      if (code === 130) process.exit(130);
      resolve(code ?? 1);
    });

    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Auto decisions
// ---------------------------------------------------------------------------

async function makeCopyReviewDecision(runDir) {
  const copyReviewPath = path.join(runDir, "build", "copy-review.txt");
  const copyContent = readFile(copyReviewPath);
  const brainContent = readFile(BRAIN_PATH);
  const runBrainPath = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for a Software Factory. You make autonomous decisions at control points using the operator's decision-making profile (brain.md).

Respond with valid JSON only:
- To approve:          {"decision":"approve","confidence":"high"|"medium"|"low","reasoning":"..."}
- To request revision: {"decision":"reject","confidence":"high"|"medium"|"low","feedback":"...specific feedback for the copywriter...","reasoning":"..."}
- To escalate to human (when genuinely uncertain): {"decision":"escalate","reasoning":"...why you cannot decide confidently..."}

Use "escalate" only when the brain does not give you enough signal to decide — for example, the copy style is so different from anything described that you cannot tell if it fits the voice.
Base your decision on the operator's copy voice preferences and quality bar from the brain.`,
    `## Global Brain\n\n${brainContent}`,
    runBrainContent ? `## Run Brain\n\n${runBrainContent}` : null
  );

  const result = claudeCall(
    systemPrompt,
    `## Decision Point: Copy Review\n\nReview the following copy and decide whether to approve it or request revision.\n\n${copyContent}`,
    (u) => logTokens("Copy Review Decision", u)
  );

  // Escalate if explicitly requested or confidence is low
  if (result.decision === "escalate" || result.confidence === "low") {
    writeDecision(runDir, {
      decisionPoint: "copy-review",
      evidence: copyContent.slice(0, 1000),
      brainContext: `voice: ${brainContent.match(/## Copy Voice\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().slice(0, 200) ?? "(see brain.md)"}`,
      decision: "escalate",
      reasoning: result.reasoning ?? "",
      humanOverride: false,
    });

    const answer = await escalate(runDir, "Low confidence on copy review", {
      at: "Build Phase 4 — Copy Review",
      detail: result.reasoning ?? "The orchestrator could not determine whether this copy matches your voice.",
      options: ["approve", "reject: <feedback>", "abort"],
    });

    if (/^abort/i.test(answer)) process.exit(1);

    const humanApproved = /^approve/i.test(answer);
    const humanFeedback = answer.replace(/^reject:\s*/i, "").trim();

    writeDecision(runDir, {
      decisionPoint: "copy-review",
      evidence: copyContent.slice(0, 200),
      brainContext: "(escalated)",
      decision: humanApproved ? "approve" : "reject",
      reasoning: "Human override after escalation.",
      humanOverride: true,
    });

    return humanApproved ? "yes" : (humanFeedback || "Please revise the copy.");
  }

  const approved = result.decision === "approve";

  writeDecision(runDir, {
    decisionPoint: "copy-review",
    evidence: copyContent.slice(0, 1000),
    brainContext: `voice: ${brainContent.match(/## Copy Voice\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().slice(0, 200) ?? "(see brain.md)"}`,
    decision: result.decision,
    reasoning: result.reasoning ?? "",
    humanOverride: false,
  });

  const confidenceColor = result.confidence === "high" ? A.green : result.confidence === "medium" ? A.yellow : A.red;
  console.log(`\n  ${A.cyan("●")}  Auto decision: copy-review → ${approved ? A.green("approve") : A.yellow("reject")}  ${A.dim("(" + confidenceColor(result.confidence ?? "?") + " confidence)")}`);
  if (result.reasoning) {
    console.log(`  ${A.dim("↳ " + result.reasoning.split(/[.\n]/)[0].trim())}\n`);
  }

  return approved ? "yes" : (result.feedback ?? "Please revise the copy.");
}

async function handleBuildSignal(runDir, signal) {
  if (signal.point === "copy-review") return makeCopyReviewDecision(runDir);
  return handleUnknownSignal(runDir, signal);
}

// ---------------------------------------------------------------------------
// Security decision handlers
// ---------------------------------------------------------------------------

async function makeSecurityFindingDecision(runDir, signal) {
  const finding = signal.finding ?? "(finding not available)";
  const brainContent = readFile(BRAIN_PATH);
  const runBrainPath = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for a Software Factory. Decide whether to accept or fix a high security finding.

Respond with valid JSON only:
- To accept (acknowledge and ship with known risk): {"decision":"accept","confidence":"high"|"medium"|"low","reasoning":"..."}
- To fix (send back for remediation):               {"decision":"fix","confidence":"high"|"medium"|"low","reasoning":"..."}
- To escalate: {"decision":"escalate","reasoning":"..."}

Base your decision on the operator's security posture — their stated thresholds for what can be accepted vs. must be fixed.`,
    `## Global Brain\n\n${brainContent}`,
    runBrainContent ? `## Run Brain\n\n${runBrainContent}` : null
  );

  const result = claudeCall(
    systemPrompt,
    `## Decision Point: High Security Finding\n\n${finding}`,
    (u) => logTokens("Security Finding Decision", u)
  );

  if (result.decision === "escalate" || result.confidence === "low") {
    writeDecision(runDir, { decisionPoint: "security-finding", evidence: finding.slice(0, 500), brainContext: "(see brain.md)", decision: "escalate", reasoning: result.reasoning ?? "", humanOverride: false });
    const answer = await escalate(runDir, "Low confidence on security finding", {
      at: "Security Phase 4 — High Finding Review",
      detail: `Finding:\n${finding.slice(0, 400)}\n\nReason: ${result.reasoning ?? "Unable to determine whether to accept or fix."}`,
      options: ["accept", "fix", "abort"],
    });
    if (/^abort/i.test(answer)) process.exit(1);
    const humanDecision = /^accept/i.test(answer) ? "accept" : "fix";
    writeDecision(runDir, { decisionPoint: "security-finding", evidence: finding.slice(0, 200), brainContext: "(escalated)", decision: humanDecision, reasoning: "Human override after escalation.", humanOverride: true });
    return humanDecision;
  }

  writeDecision(runDir, { decisionPoint: "security-finding", evidence: finding.slice(0, 500), brainContext: `security: ${brainContent.match(/## Security Posture\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().slice(0, 200) ?? "(see brain.md)"}`, decision: result.decision, reasoning: result.reasoning ?? "", humanOverride: false });
  const decisionColor = result.decision === "accept" ? A.green : A.yellow;
  console.log(`\n  ${A.cyan("●")}  Auto decision: security-finding → ${decisionColor(result.decision)}`);
  if (result.reasoning) console.log(`  ${A.dim("↳ " + result.reasoning.split(/[.\n]/)[0].trim())}\n`);

  return result.decision === "accept" ? "accept" : "fix";
}

async function makeSecurityFinalApprovalDecision(runDir) {
  // All findings have been handled — default approve unless low confidence
  const brainContent = readFile(BRAIN_PATH);
  const runBrainPath = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for a Software Factory. All security findings have been reviewed and either accepted or sent for remediation. Decide whether to give final approval.

Respond with valid JSON only:
- {"decision":"approve","confidence":"high"|"medium"|"low","reasoning":"..."}
- {"decision":"escalate","reasoning":"..."}

Only escalate if there is a specific unresolved concern. Approving here means the security review is complete.`,
    `## Global Brain\n\n${brainContent}`,
    runBrainContent ? `## Run Brain\n\n${runBrainContent}` : null
  );

  const result = claudeCall(
    systemPrompt,
    "All findings have been reviewed. Should the security review be approved?",
    (u) => logTokens("Security Final Approval Decision", u)
  );

  if (result.decision === "escalate" || result.confidence === "low") {
    writeDecision(runDir, { decisionPoint: "security-final-approval", evidence: "(post-finding review)", brainContext: "(see brain.md)", decision: "escalate", reasoning: result.reasoning ?? "", humanOverride: false });
    const answer = await escalate(runDir, "Low confidence on security final approval", {
      at: "Security Phase 4 — Final Approval",
      detail: result.reasoning ?? "Uncertain whether all findings have been adequately handled.",
      options: ["yes (approve)", "no (reject)", "abort"],
    });
    if (/^abort/i.test(answer)) process.exit(1);
    const humanDecision = /^yes/i.test(answer) ? "yes" : "no";
    writeDecision(runDir, { decisionPoint: "security-final-approval", evidence: "(post-finding review)", brainContext: "(escalated)", decision: humanDecision === "yes" ? "approve" : "reject", reasoning: "Human override after escalation.", humanOverride: true });
    return humanDecision;
  }

  writeDecision(runDir, { decisionPoint: "security-final-approval", evidence: "(post-finding review)", brainContext: "(findings resolved)", decision: "approve", reasoning: result.reasoning ?? "", humanOverride: false });
  console.log(`\n  ${A.cyan("●")}  Auto decision: security-final-approval → ${A.green("approve")}\n`);
  return "yes";
}

async function handleSecuritySignal(runDir, signal) {
  if (signal.point === "security-block")         return ""; // acknowledge BLOCK, remediations will be written
  if (signal.point === "security-finding")       return makeSecurityFindingDecision(runDir, signal);
  if (signal.point === "security-final-approval") return makeSecurityFinalApprovalDecision(runDir);
  return handleUnknownSignal(runDir, signal);
}

// ---------------------------------------------------------------------------
// Review decision handlers
// ---------------------------------------------------------------------------

async function makeReviewVerdictNoShipDecision(runDir) {
  const verdictPath = path.join(runDir, "review", "verdict-report.md");
  const verdictContent = fileExists(verdictPath) ? readFile(verdictPath) : "(verdict not available)";
  const brainContent = readFile(BRAIN_PATH);
  const runBrainPath = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for a Software Factory. The review verdict is NO-SHIP. Decide whether to accept the verdict (route back to build) or override it (ship anyway).

Respond with valid JSON only:
- To accept (route back to build): {"decision":"accept","confidence":"high"|"medium"|"low","reasoning":"..."}
- To override and ship: {"decision":"override","reason":"...logged override reason...","confidence":"high"|"medium"|"low","reasoning":"..."}
- To escalate: {"decision":"escalate","reasoning":"..."}

Overriding should be rare and only when the failures are minor, clearly out of scope, or the operator's quality bar explicitly allows it. If in doubt, accept the verdict.`,
    `## Global Brain\n\n${brainContent}`,
    runBrainContent ? `## Run Brain\n\n${runBrainContent}` : null
  );

  const result = claudeCall(
    systemPrompt,
    `## Decision Point: Review Verdict — NO-SHIP\n\n${verdictContent}`,
    (u) => logTokens("Review Verdict Decision", u)
  );

  if (result.decision === "escalate" || result.confidence === "low") {
    writeDecision(runDir, { decisionPoint: "review-verdict-no-ship", evidence: verdictContent.slice(0, 500), brainContext: "(see brain.md)", decision: "escalate", reasoning: result.reasoning ?? "", humanOverride: false });
    const answer = await escalate(runDir, "Low confidence on NO-SHIP verdict", {
      at: "Review Phase 6 — Verdict",
      detail: result.reasoning ?? "Unable to determine whether to accept the no-ship verdict or override it.",
      options: ["accept (route to build)", "override: <reason>", "abort"],
    });
    if (/^abort/i.test(answer)) process.exit(1);
    const humanAccept = /^accept/i.test(answer);
    const overrideReason = answer.replace(/^override[\s:]+/i, "").trim();
    writeDecision(runDir, { decisionPoint: "review-verdict-no-ship", evidence: verdictContent.slice(0, 200), brainContext: "(escalated)", decision: humanAccept ? "accept" : "override", reasoning: "Human override after escalation.", humanOverride: true });
    return humanAccept ? "accept" : `override: ${overrideReason || "operator decision"}`;
  }

  writeDecision(runDir, { decisionPoint: "review-verdict-no-ship", evidence: verdictContent.slice(0, 500), brainContext: `quality: ${brainContent.match(/## Quality Bar\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().slice(0, 200) ?? "(see brain.md)"}`, decision: result.decision, reasoning: result.reasoning ?? "", humanOverride: false });
  const decisionColor = result.decision === "override" ? A.yellow : A.green;
  console.log(`\n  ${A.cyan("●")}  Auto decision: review-verdict-no-ship → ${decisionColor(result.decision)}`);
  if (result.reasoning) console.log(`  ${A.dim("↳ " + result.reasoning.split(/[.\n]/)[0].trim())}\n`);

  if (result.decision === "override") return `override: ${result.reason ?? "orchestrator decision"}`;
  return "accept";
}

async function makeReviewVerdictShipDecision(runDir) {
  // Verdict is SHIP — approve unless confidence is low
  const brainContent = readFile(BRAIN_PATH);
  const runBrainPath = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;
  const verdictPath = path.join(runDir, "review", "verdict-report.md");
  const verdictContent = fileExists(verdictPath) ? readFile(verdictPath) : "(verdict not available)";

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for a Software Factory. The review verdict is SHIP. Decide whether to approve and ship.

Respond with valid JSON only:
- {"decision":"approve","confidence":"high"|"medium"|"low","reasoning":"..."}
- {"decision":"escalate","reasoning":"..."}

Only escalate if there is a specific concern. A SHIP verdict from the review division should almost always be approved.`,
    `## Global Brain\n\n${brainContent}`,
    runBrainContent ? `## Run Brain\n\n${runBrainContent}` : null
  );

  const result = claudeCall(
    systemPrompt,
    `## Decision Point: Review Verdict — SHIP\n\n${verdictContent}`,
    (u) => logTokens("Review Verdict Ship Decision", u)
  );

  if (result.decision === "escalate" || result.confidence === "low") {
    writeDecision(runDir, { decisionPoint: "review-verdict-ship", evidence: verdictContent.slice(0, 500), brainContext: "(see brain.md)", decision: "escalate", reasoning: result.reasoning ?? "", humanOverride: false });
    const answer = await escalate(runDir, "Low confidence on SHIP verdict approval", {
      at: "Review Phase 6 — Verdict",
      detail: result.reasoning ?? "Uncertain whether to approve the ship verdict.",
      options: ["yes (approve and ship)", "no (reject)", "abort"],
    });
    if (/^abort/i.test(answer)) process.exit(1);
    const humanDecision = /^yes/i.test(answer) ? "yes" : "no";
    writeDecision(runDir, { decisionPoint: "review-verdict-ship", evidence: verdictContent.slice(0, 200), brainContext: "(escalated)", decision: humanDecision === "yes" ? "approve" : "reject", reasoning: "Human override after escalation.", humanOverride: true });
    return humanDecision;
  }

  writeDecision(runDir, { decisionPoint: "review-verdict-ship", evidence: verdictContent.slice(0, 200), brainContext: "(ship verdict)", decision: "approve", reasoning: result.reasoning ?? "", humanOverride: false });
  console.log(`\n  ${A.cyan("●")}  Auto decision: review-verdict-ship → ${A.green("approve")}\n`);
  return "yes";
}

async function handleReviewSignal(runDir, signal) {
  if (signal.point === "review-verdict-no-ship") return makeReviewVerdictNoShipDecision(runDir);
  if (signal.point === "review-verdict-ship")    return makeReviewVerdictShipDecision(runDir);
  return handleUnknownSignal(runDir, signal);
}

// ---------------------------------------------------------------------------
// Unknown signal fallback
// ---------------------------------------------------------------------------

async function handleUnknownSignal(runDir, signal) {
  console.log(`\n  ${A.yellow("⚠")}  Unknown signal: ${signal.point ?? signal.raw}`);
  await escalate(runDir, `Unhandled signal: ${signal.point ?? signal.raw}`, {
    at: "Division runner",
    detail: "The factory received a decision signal it does not yet handle in auto mode.\nThe runner is waiting for input.",
    options: ["continue (pass empty response)", "abort"],
  });
  return "";
}

// ---------------------------------------------------------------------------
// Outcome detection
// ---------------------------------------------------------------------------

function readLog(runDir) {
  const p = path.join(runDir, "log.jsonl");
  if (!fileExists(p)) return [];
  return fs.readFileSync(p, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function lastEvent(runDir, phase, event) {
  return readLog(runDir).filter((e) => e.phase === phase && e.event === event).pop() ?? null;
}

function hasPendingReviewFailures(runDir) {
  const dir = path.join(runDir, "failure-reports");
  return fileExists(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json"));
}

function hasPendingSecurityRemediations(runDir) {
  return fileExists(path.join(runDir, "security-remediations", "remediation-requests.md"));
}

// ---------------------------------------------------------------------------
// Brain interview
// ---------------------------------------------------------------------------

function logTokens(label, usage) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    phase: "Leadership",
    label,
    input:      usage?.input_tokens      ?? 0,
    output:     usage?.output_tokens     ?? 0,
    cacheRead:  usage?.cache_read_input_tokens  ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  });
  const logPath = path.join(__dirname, "brain-token-usage.jsonl");
  fs.appendFileSync(logPath, entry + "\n");
}

async function runBrainInterview() {
  if (fileExists(BRAIN_PATH)) {
    console.log(`  ${A.green("✓")}  Brain found — skipping interview\n`);
    return;
  }

  const transcriptPath = path.join(__dirname, "brain-transcript.md");

  // Recovery: transcript exists from a previous session but brain.md was never written.
  // Skip the interview entirely and re-run only the lock step.
  if (fileExists(transcriptPath)) {
    console.log(`  ${A.yellow("↻")}  Brain transcript found — recovering from previous session\n`);
    const display = createPhaseDisplay("Leadership", "Brain Interview", "", "recovering...");
    display.update("locking brain...");
    const lockPrompt = buildSystemPrompt(
      readFile(path.join(AGENTS_DIR, "leadership", "brain-interviewer.md")),
      `## Interview Transcript\n\n${readFile(transcriptPath)}`
    );
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked brain profile now as specified in your output format.",
      (u) => logTokens("Brain Interviewer", u)
    );
    const lockedOutput = result.output ?? result;
    if (!lockedOutput?.brain) {
      display.stop();
      console.error("Recovery lock did not produce a valid brain. Raw output:");
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    writeFile(BRAIN_PATH, lockedOutput.brain);
    if (lockedOutput.config) {
      writeFile(path.join(__dirname, "brain-config.json"), JSON.stringify(lockedOutput.config, null, 2));
    }
    display.finish("brain.md recovered");
    console.log(`\n  ${A.dim("Brain saved to brain.md — this will be used for all future auto decisions.")}\n`);
    return;
  }

  writeFile(transcriptPath, "# Brain Interview Transcript\n");

  const systemPrompt = buildSystemPrompt(
    readFile(path.join(AGENTS_DIR, "leadership", "brain-interviewer.md"))
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const display = createPhaseDisplay("Leadership", "Brain Interview", "", "thinking...");
  display.log(`\n  ${A.dim("The factory is building your decision-making profile.")}`);
  display.log(`  ${A.dim('When you\'re satisfied, type "lock" to finalize.\n')}`);

  async function executeLock() {
    display.update("locking brain...");
    const lockPrompt = buildSystemPrompt(
      readFile(path.join(AGENTS_DIR, "leadership", "brain-interviewer.md")),
      `## Interview Transcript\n\n${readFile(transcriptPath)}`
    );
    const result = claudeCall(
      lockPrompt,
      "The operator has confirmed. Produce the locked brain profile now as specified in your output format.",
      (u) => logTokens("Brain Interviewer", u)
    );
    return result.output ?? result;
  }

  const lockedOutput = await runLockableInterview({
    systemPrompt, transcriptPath, display, rl,
    agentName: "Brain Interviewer",
    lockSignalRe: /ready to lock the brain/i,
    lockConfirmPrompt: "Lock the brain?",
    executeLock,
    onUsage: (u) => logTokens("Brain Interviewer", u),
  });
  rl.close();

  if (!lockedOutput?.brain) {
    console.error("Brain interview did not produce a valid locked output.");
    console.error(JSON.stringify(lockedOutput, null, 2));
    process.exit(1);
  }

  writeFile(BRAIN_PATH, lockedOutput.brain);
  if (lockedOutput.config) {
    writeFile(path.join(__dirname, "brain-config.json"), JSON.stringify(lockedOutput.config, null, 2));
  }
  display.finish("brain.md written");

  console.log(`\n  ${A.dim("Brain saved to brain.md — this will be used for all future auto decisions.")}\n`);
}

// ---------------------------------------------------------------------------
// Run brain interview
// ---------------------------------------------------------------------------

async function runRunBrainInterview(runDir, mode = "manual") {
  const runBrainPath = path.join(runDir, "run-brain.md");
  if (fileExists(runBrainPath)) {
    console.log(`  ${A.green("✓")}  Run brain found — skipping interview\n`);
    return;
  }

  const handoffDir = path.join(runDir, "handoff");

  const systemPrompt = buildSystemPrompt(
    readFile(path.join(AGENTS_DIR, "leadership", "run-brain-interviewer.md")),
    `## Global Brain\n\n${readFile(BRAIN_PATH)}`,
    `## Factory Manifest\n\n${readFile(path.join(handoffDir, "factory-manifest.json"))}`,
    `## Build Spec\n\n${readFile(path.join(handoffDir, "build-spec.md"))}`,
    fileExists(path.join(handoffDir, "review-spec.md"))
      ? `## Review Spec\n\n${readFile(path.join(handoffDir, "review-spec.md"))}`
      : null,
    fileExists(path.join(handoffDir, "runtime-spec.md"))
      ? `## Runtime Spec\n\n${readFile(path.join(handoffDir, "runtime-spec.md"))}`
      : null
  );

  // Auto mode: generate run brain directly from specs + global brain — no interview needed.
  if (mode === "auto") {
    const display = createPhaseDisplay("Leadership", "Run Brain", "", "generating...");
    const result = claudeCall(
      systemPrompt,
      "Generate the locked run brain now. All necessary context is in the specs and the global brain. Produce the locked output as specified in your output format.",
      (u) => logTokens("Run Brain (auto)", u)
    );
    const lockedOutput = result.output ?? result;
    if (!lockedOutput?.runBrain) {
      display.stop();
      console.error("Auto run brain generation did not produce valid output:");
      console.error(JSON.stringify(result, null, 2));
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const display = createPhaseDisplay("Leadership", "Run Brain", "", "reading specs...");
  display.log(`\n  ${A.dim("Calibrating for this specific project.")}`);
  display.log(`  ${A.dim('Type "lock" when you\'re satisfied.\n')}`);

  async function executeLock() {
    display.update("locking run brain...");
    const lockPrompt = buildSystemPrompt(
      readFile(path.join(AGENTS_DIR, "leadership", "run-brain-interviewer.md")),
      `## Global Brain\n\n${readFile(BRAIN_PATH)}`,
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
    systemPrompt, transcriptPath, display, rl,
    agentName: "Run Brain",
    lockSignalRe: /ready to lock the run brain/i,
    lockConfirmPrompt: "Lock the run brain?",
    executeLock,
    onUsage: (u) => logTokens("Run Brain", u),
  });
  rl.close();

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

  console.log(`\n  ${A.dim("Run brain saved — applies to this run only.")}\n`);
}

// ---------------------------------------------------------------------------
// Accountant
// ---------------------------------------------------------------------------

function readTokenUsage(runDir) {
  const logPath = path.join(runDir, "token-usage.jsonl");
  if (!fileExists(logPath)) return { byPhase: {}, totOut: 0 };

  const entries = fs.readFileSync(logPath, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const byPhase = {};
  let totIn = 0, totOut = 0, totCache = 0;
  for (const e of entries) {
    if (!byPhase[e.phase]) byPhase[e.phase] = { input: 0, output: 0, cacheRead: 0 };
    byPhase[e.phase].input     += e.input     ?? 0;
    byPhase[e.phase].output    += e.output    ?? 0;
    byPhase[e.phase].cacheRead += e.cacheRead ?? 0;
    totIn    += e.input     ?? 0;
    totOut   += e.output    ?? 0;
    totCache += e.cacheRead ?? 0;
  }
  return { byPhase, totIn, totOut, totCache };
}

function readBudgetLimit(runDir) {
  // Run config takes priority, then global brain config, then no limit.
  const runCfgPath = path.join(runDir, "run-config.json");
  if (fileExists(runCfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(runCfgPath, "utf8"));
    if (cfg.tokenLimit != null && cfg.tokenLimit !== 0) return { limit: cfg.tokenLimit, source: "run brain" };
    if (cfg.tokenLimit === 0) return { limit: null, source: "run brain (no limit)" };
  }
  const brainCfgPath = path.join(__dirname, "brain-config.json");
  if (fileExists(brainCfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(brainCfgPath, "utf8"));
    if (cfg.tokenLimitPerRun != null) return { limit: cfg.tokenLimitPerRun, source: "global brain" };
  }
  return { limit: null, source: "none" };
}

async function checkBudget(runDir, checkpoint) {
  const { limit, source } = readBudgetLimit(runDir);
  if (!limit) return; // no limit set

  const { totOut } = readTokenUsage(runDir);
  if (totOut <= limit) return; // within budget

  const n = (v) => v.toLocaleString("en-US");
  const pct = Math.round((totOut / limit) * 100);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${A.yellow("⚠")}  ${A.bold("Budget exceeded")}  ·  ${checkpoint}`);
  console.log(`  Spent:  ${A.yellow(n(totOut))} output tokens`);
  console.log(`  Limit:  ${n(limit)} output tokens  ${A.dim("(" + source + ")")}`);
  console.log(`  Usage:  ${A.yellow(pct + "%")}`);
  console.log(`${"─".repeat(60)}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await question(rl, "Continue anyway? (yes / abort): ");
  rl.close();

  if (!/^(yes|y)/i.test(answer.trim())) {
    console.log(`\n  ${A.red("✗")}  Aborted by budget limit.\n`);
    process.exit(1);
  }
  console.log(`  ${A.dim("Continuing past budget limit — noted.")}\n`);
}

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
// Escalation handler
// ---------------------------------------------------------------------------

// Single extension point for all human interventions in auto mode.
// Future: add email/Slack hooks here before the CLI prompt.
async function escalate(runDir, reason, context = {}) {
  const options = context.options ?? ["continue", "abort"];

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${A.yellow("⚑")}  ${A.bold("Escalation")}  ·  ${reason}`);
  console.log(`${"═".repeat(60)}`);
  if (context.at)     console.log(`  ${A.dim("At:")}  ${context.at}`);
  if (context.detail) {
    console.log();
    for (const line of context.detail.trim().split("\n")) {
      console.log(`  ${A.dim(line)}`);
    }
  }
  console.log(`\n  ${A.dim("Options:")}  ${options.join("  /  ")}`);
  console.log(`${"═".repeat(60)}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const raw = await question(rl, "  Your choice: ");
  rl.close();

  const answer = raw.trim().toLowerCase();
  logEvent(runDir, { phase: "factory", event: "escalation", reason, answer, context: context.at ?? "" });
  return answer;
}

function readLoopLimit(runDir) {
  const runCfgPath = path.join(runDir, "run-config.json");
  if (fileExists(runCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(runCfgPath, "utf8"));
      if (cfg.maxLoopsBeforeEscalate != null) return cfg.maxLoopsBeforeEscalate;
    } catch {}
  }
  const brainCfgPath = path.join(__dirname, "brain-config.json");
  if (fileExists(brainCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(brainCfgPath, "utf8"));
      if (cfg.maxLoopsBeforeEscalate != null) return cfg.maxLoopsBeforeEscalate;
    } catch {}
  }
  return MAX_LOOPS; // fall back to hard ceiling
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function banner(runDir, current, note = "") {
  let project = "";
  try {
    project = JSON.parse(fs.readFileSync(
      path.join(runDir, "handoff", "factory-manifest.json"), "utf8"
    )).projectName ?? "";
  } catch {}

  const currentIdx = DIVISIONS.indexOf(current);
  const pipeline = DIVISIONS.map((d, i) => {
    if (i < currentIdx) return A.green(d);
    if (i === currentIdx) return A.bold(A.cyan(d));
    return A.dim(d);
  }).join(A.dim("  →  "));

  const id = path.basename(runDir);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${A.bold("Software Factory")}${project ? `  ·  ${project}` : ""}  ·  ${A.cyan(id)}`);
  console.log(`  ${pipeline}`);
  if (note) console.log(`  ${A.yellow(note)}`);
  console.log(`${"─".repeat(60)}\n`);
}

function abort(runDir, division, reason, loop) {
  const extra = loop > 1 ? ` (loop ${loop})` : "";
  console.error(`\n${A.red("✗")}  ${division} division failed${extra}. ${reason}`);
  logEvent(runDir, { phase: "factory", event: "aborted", division: division.toLowerCase(), reason, loop });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { mode, stopAfter, runId, caveman, tag } = parseArgs();
  const runDir = path.join(RUNS_DIR, runId);

  if (caveman) process.env.FACTORY_CAVEMAN = "1";

  fs.mkdirSync(runDir, { recursive: true });
  if (tag) writeFile(path.join(runDir, "run-meta.json"), JSON.stringify({ tag, ts: new Date().toISOString() }, null, 2));
  logEvent(runDir, { phase: "factory", event: "start", mode, stopAfter, caveman, tag });

  console.log(`\n${A.bold("Software Factory")} — Pipeline Orchestrator`);
  console.log(`Run:  ${A.cyan(runId)}${tag ? `  ·  ${A.bold(tag)}` : ""}`);
  console.log(`Mode: ${mode}${stopAfter ? `  ·  stopping after ${stopAfter}` : ""}${caveman ? `  ·  ${A.dim("caveman")}` : ""}\n`);

  // ── Brain ────────────────────────────────────────────────────────────────

  await runBrainInterview();

  // ── Design ──────────────────────────────────────────────────────────────

  const designDone = fileExists(path.join(runDir, "handoff", "build-spec.md"));

  if (!designDone) {
    banner(runDir, "Design");
    if (runDivision("run-design.js", ["--run-id", runId]) !== 0) {
      abort(runDir, "Design", "Exiting.", 1);
    }
    logEvent(runDir, { phase: "factory", event: "division-complete", division: "design" });
  } else {
    console.log(`  ${A.green("✓")}  Design — specs found, skipping\n`);
  }

  if (stopAfter === "design") {
    logEvent(runDir, { phase: "factory", event: "stopped-after", division: "design" });
    console.log("Stopped after Design as requested.\n");
    return;
  }

  // ── Run Brain ────────────────────────────────────────────────────────────

  await runRunBrainInterview(runDir, mode);

  // ── Build → Review loop ─────────────────────────────────────────────────

  const reviewShipped =
    !!lastEvent(runDir, "review", "ship-approved") ||
    !!lastEvent(runDir, "review", "ship-approved-override");

  if (!reviewShipped) {
    let reviewLoopLimit = readLoopLimit(runDir);
    for (let loop = 1; loop <= MAX_LOOPS; loop++) {
      const loopNote = loop > 1 ? `Build → Review  ·  attempt ${loop} of ${MAX_LOOPS}` : "";

      // Build — skip only if artifact exists and no pending review failures
      const artifactReady = fileExists(path.join(runDir, "artifact", "MANIFEST.txt"));
      if (!artifactReady || hasPendingReviewFailures(runDir)) {
        banner(runDir, "Build", loopNote);
        const buildExit = mode === "auto"
          ? await runDivisionAuto("run-build.js", ["--run-id", runId], (sig) => handleBuildSignal(runDir, sig))
          : runDivision("run-build.js", ["--run-id", runId]);
        if (buildExit !== 0) abort(runDir, "Build", "Exiting.", loop);
        logEvent(runDir, { phase: "factory", event: "division-complete", division: "build", loop });
        await checkBudget(runDir, `after Build (loop ${loop})`);
      } else {
        console.log(`  ${A.green("✓")}  Build — artifact found, skipping\n`);
      }

      if (stopAfter === "build") {
        logEvent(runDir, { phase: "factory", event: "stopped-after", division: "build" });
        console.log("Stopped after Build as requested.\n");
        return;
      }

      // Review
      banner(runDir, "Review", loopNote);
      const reviewExit = mode === "auto"
        ? await runDivisionAuto("run-review.js", ["--run-id", runId], (sig) => handleReviewSignal(runDir, sig))
        : runDivision("run-review.js", ["--run-id", runId]);
      if (reviewExit !== 0) abort(runDir, "Review", "Exiting.", loop);
      logEvent(runDir, { phase: "factory", event: "division-complete", division: "review", loop });
      await checkBudget(runDir, `after Review (loop ${loop})`);

      if (stopAfter === "review") {
        logEvent(runDir, { phase: "factory", event: "stopped-after", division: "review" });
        console.log("Stopped after Review as requested.\n");
        return;
      }

      // Did it ship?
      const nowShipped =
        !!lastEvent(runDir, "review", "ship-approved") ||
        !!lastEvent(runDir, "review", "ship-approved-override");
      if (nowShipped) break;

      if (!hasPendingReviewFailures(runDir)) {
        abort(runDir, "Review", "No-ship with no failure reports written. Cannot route back to Build.", loop);
      }

      if (loop >= reviewLoopLimit) {
        const answer = await escalate(runDir, `Build → Review loop limit reached (${loop} attempts)`, {
          at: `Build → Review loop ${loop}`,
          detail: `The factory has run ${loop} Build → Review loop(s) without shipping.\nFailure reports remain. Review is still returning no-ship.`,
          options: ["continue (one more loop)", "abort"],
        });
        if (!/^continue/i.test(answer)) abort(runDir, "Review", "Escalated — operator chose to abort.", loop);
        reviewLoopLimit = loop + 1; // grant one more
      }

      console.log(`\n  ${A.yellow("Review returned no-ship — routing failure reports back to Build.")}\n`);
      logEvent(runDir, { phase: "factory", event: "loop-back", from: "review", to: "build", loop });
    }
  } else {
    console.log(`  ${A.green("✓")}  Review — already shipped, skipping\n`);
  }

  // ── Build → Security loop ───────────────────────────────────────────────

  const securityApproved = !!lastEvent(runDir, "security", "security-approved");

  if (!securityApproved) {
    let securityLoopLimit = readLoopLimit(runDir);
    for (let loop = 1; loop <= MAX_LOOPS; loop++) {
      const loopNote = loop > 1 ? `Build → Security  ·  attempt ${loop} of ${MAX_LOOPS}` : "";

      // Rebuild only if security sent remediations
      if (hasPendingSecurityRemediations(runDir)) {
        banner(runDir, "Build", loopNote);
        const rebuildExit = mode === "auto"
          ? await runDivisionAuto("run-build.js", ["--run-id", runId], (sig) => handleBuildSignal(runDir, sig))
          : runDivision("run-build.js", ["--run-id", runId]);
        if (rebuildExit !== 0) abort(runDir, "Build", "Failed during security remediation. Exiting.", loop);
        logEvent(runDir, { phase: "factory", event: "division-complete", division: "build", loop, context: "security-remediation" });
        await checkBudget(runDir, `after Build / security remediation (loop ${loop})`);
      }

      // Security
      banner(runDir, "Security", loopNote);
      const code = mode === "auto"
        ? await runDivisionAuto("run-security.js", ["--run-id", runId], (sig) => handleSecuritySignal(runDir, sig))
        : runDivision("run-security.js", ["--run-id", runId]);
      logEvent(runDir, { phase: "factory", event: "division-complete", division: "security", loop });
      await checkBudget(runDir, `after Security (loop ${loop})`);

      if (code === 0) break; // approved

      if (!hasPendingSecurityRemediations(runDir)) {
        abort(runDir, "Security", "Blocked with no remediation report written. Cannot route back to Build.", loop);
      }

      if (loop >= securityLoopLimit) {
        const answer = await escalate(runDir, `Build → Security loop limit reached (${loop} attempts)`, {
          at: `Build → Security loop ${loop}`,
          detail: `The factory has run ${loop} Build → Security loop(s) without passing.\nRemediation requests remain. Security is still blocking.`,
          options: ["continue (one more loop)", "abort"],
        });
        if (!/^continue/i.test(answer)) abort(runDir, "Security", "Escalated — operator chose to abort.", loop);
        securityLoopLimit = loop + 1;
      }

      console.log(`\n  ${A.yellow("Security blocked — routing remediations back to Build.")}\n`);
      logEvent(runDir, { phase: "factory", event: "loop-back", from: "security", to: "build", loop });
    }
  } else {
    console.log(`  ${A.green("✓")}  Security — already approved, skipping\n`);
  }

  // ── Done ────────────────────────────────────────────────────────────────

  logEvent(runDir, { phase: "factory", event: "pipeline-complete" });
  writeLedgerEntry(runDir);

  const { totOut } = readTokenUsage(runDir);
  const { limit } = readBudgetLimit(runDir);
  const budgetLine = limit
    ? `  Tokens:   ${totOut.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} output`
    : `  Tokens:   ${totOut.toLocaleString("en-US")} output`;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${A.green("✓")}  Pipeline complete  ·  ${A.cyan(runId)}`);
  console.log(A.dim(budgetLine));
  console.log(`  Inspect:  node inspect.js ${runId}`);
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((err) => {
  console.error(A.red("✗  Fatal:"), err.message ?? err);
  process.exit(1);
});

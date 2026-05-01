"use strict";

/**
 * graph.js — Pipeline graph executor for Darkroom.
 *
 * Loads a profile JSON, walks nodes in order, checks skip conditions,
 * runs each node via the appropriate runner, routes between nodes based
 * on log events, and manages backward-edge loop limits.
 *
 * Exports: runGraph, readTokenUsage, readBudgetLimit
 */

const { spawnSync } = require("child_process");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { fileExists, logEvent, readFile, buildSystemPrompt, writeFile, writeDecision } = require("./runner-utils");
const { claudeCall } = require("../adapters/claude-cli");
const { A } = require("./display");
const { buildMemoryBlock } = require("./memory");
const org   = require("./org");
const types = require("./types");

const MAX_LOOPS = 3;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// I/O context
// ---------------------------------------------------------------------------

function buildIoContext(node, runDir) {
  const schemaPath = path.join(__dirname, "..", "departments", node.id, "schema.json");
  let inputs = [];
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    inputs = schema.inputs ?? [];
  } catch {}
  return { inputs: types.resolve(inputs, runDir) };
}

// ---------------------------------------------------------------------------
// Division runners
// ---------------------------------------------------------------------------

function runDivision(script, extraArgs = []) {
  const result = spawnSync("node", [script, ...extraArgs], {
    stdio: ["inherit", "inherit", "pipe"],
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) process.exit(130);
  const stderr = result.stderr?.toString().trim() ?? "";
  if (stderr) process.stderr.write(stderr + "\n");
  return { code: result.status ?? 1, stderr: stderr.slice(0, 600) };
}

function runDivisionAuto(script, extraArgs, onSignal, runDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [script, ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, FACTORY_AUTO: "1" },
    });

    let buf = "";
    let stderrBuf = "";
    let signalInFlight = false;

    proc.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();

      for (const line of lines) {
        const match = line.match(/^FACTORY_SIGNAL:(.+)$/);
        if (match && !signalInFlight) {
          signalInFlight = true;
          let signal;
          try { signal = JSON.parse(match[1]); } catch { signal = { raw: match[1] }; }
          Promise.resolve(onSignal(signal))
            .then((response) => {
              if (process.env.DARK_ROOM_IO === "file" && runDir) {
                fs.writeFileSync(path.join(runDir, "input-response.json"), JSON.stringify({ response }));
              } else {
                proc.stdin.write(response + "\n");
              }
              signalInFlight = false;
            })
            .catch(reject);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrBuf += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 130) process.exit(130);
      resolve({ code: code ?? 1, stderr: stderrBuf.trim().slice(0, 600) });
    });

    proc.on("error", reject);
  });
}

async function runBuildWithFeedback(runId, runDir, mode, io, logTokens, managerRoleId, orgProfile) {
  const buildDir = path.join(runDir, "build");
  const feedbackNeededPath = path.join(buildDir, "verification-feedback-needed.json");
  const feedbackPath       = path.join(buildDir, "verification-feedback.json");

  while (true) {
    const result = mode === "auto"
      ? await runDivisionAuto("departments/build/runner.js", ["--run-id", runId], (sig) => handleBuildSignal(runDir, sig, io, logTokens, managerRoleId, orgProfile), runDir)
      : runDivision("departments/build/runner.js", ["--run-id", runId]);

    process.stdout.write(A.resetScroll + A.moveTo(1, 1) + A.clearToEnd);

    if (result.code !== 43) return result;

    const neededData = JSON.parse(readFile(feedbackNeededPath));
    fs.unlinkSync(feedbackNeededPath);

    console.log(`\n${"─".repeat(60)}`);
    console.log("  Verification failed — describe what needs to be fixed.");
    console.log(`${"─".repeat(60)}\n`);

    if (neededData.failures) {
      for (const f of neededData.failures) {
        console.log(`  [FAIL] Criterion ${f.criterionId}: ${f.description}`);
        if (f.expected) console.log(`         Expected: ${f.expected}`);
        if (f.observed) console.log(`         Observed: ${f.observed}\n`);
      }
    }

    const feedback = await io.turn("Your feedback: ");
    if (!feedback.trim()) {
      console.log("No feedback provided. Aborting.");
      process.exit(1);
    }

    writeFile(feedbackPath, JSON.stringify({ feedback }));
  }
}

// ---------------------------------------------------------------------------
// Log / file queries
// ---------------------------------------------------------------------------

function readLog(runDir) {
  const p = path.join(runDir, "log.jsonl");
  if (!fileExists(p)) return [];
  return fs.readFileSync(p, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function hasLogEvent(runDir, eventName) {
  return readLog(runDir).some((e) => e.event === eventName);
}

function hasPendingReviewFailures(runDir) {
  const dir = path.join(runDir, "failure-reports");
  return fileExists(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json"));
}

function hasPendingSecurityRemediations(runDir) {
  return fileExists(path.join(runDir, "security-remediations", "remediation-requests.md"));
}

// ---------------------------------------------------------------------------
// Budget / accounting
// ---------------------------------------------------------------------------

function readBudgetLimit(runDir) {
  const runCfgPath = path.join(runDir, "run-config.json");
  if (fileExists(runCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(runCfgPath, "utf8"));
      if (cfg.tokenLimit != null && cfg.tokenLimit !== 0) return { limit: cfg.tokenLimit, source: "run brain" };
      if (cfg.tokenLimit === 0) return { limit: null, source: "run brain (no limit)" };
    } catch {}
  }
  const tokenLimit = org.readConfigValue("tokenLimitPerRun");
  if (tokenLimit != null) return { limit: tokenLimit, source: "global brain" };
  return { limit: null, source: "none" };
}

function readTokenUsage(runDir) {
  const logPath = path.join(runDir, "token-usage.jsonl");
  if (!fileExists(logPath)) return { byPhase: {}, totIn: 0, totOut: 0, totCache: 0 };

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

function readLoopLimit(runDir) {
  const runCfgPath = path.join(runDir, "run-config.json");
  if (fileExists(runCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(runCfgPath, "utf8"));
      if (cfg.maxLoopsBeforeEscalate != null) return cfg.maxLoopsBeforeEscalate;
    } catch {}
  }
  const loopLimit = org.readConfigValue("maxLoopsBeforeEscalate");
  if (loopLimit != null) return loopLimit;
  return MAX_LOOPS;
}

async function checkBudget(runDir, checkpoint, mode, io) {
  const { limit, source } = readBudgetLimit(runDir);
  if (!limit) return;

  const { totOut } = readTokenUsage(runDir);
  if (totOut <= limit) return;

  const n = (v) => v.toLocaleString("en-US");
  const pct = Math.round((totOut / limit) * 100);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${A.yellow("⚠")}  ${A.bold("Budget exceeded")}  ·  ${checkpoint}`);
  console.log(`  Spent:  ${A.yellow(n(totOut))} output tokens`);
  console.log(`  Limit:  ${n(limit)} output tokens  ${A.dim("(" + source + ")")}`);
  console.log(`  Usage:  ${A.yellow(pct + "%")}`);
  console.log(`${"─".repeat(60)}\n`);

  if (mode === "auto" && process.env.DARK_ROOM_IO !== "file") {
    console.log(`  ${A.dim("Auto mode — continuing past budget limit.")}\n`);
    return;
  }

  const answer = await io.turn("Continue anyway? (yes / abort): ", { options: ["yes", "abort"] });
  if (!/^(yes|y)/i.test(answer.trim())) {
    console.log(`\n  ${A.red("✗")}  Aborted by budget limit.\n`);
    process.exit(1);
  }
  console.log(`  ${A.dim("Continuing past budget limit — noted.")}\n`);
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

async function escalate(runDir, reason, context, io) {
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

  const raw = await io.turn("  Your choice: ", { options });
  const answer = raw.trim().toLowerCase();
  logEvent(runDir, { phase: "factory", event: "escalation", reason, answer, context: context.at ?? "" });
  return answer;
}

// ---------------------------------------------------------------------------
// Auto-decision functions
// ---------------------------------------------------------------------------

async function makeCopyReviewDecision(runDir, io, logTokens, managerRoleId, orgProfile) {
  const copyReviewPath = path.join(runDir, "build", "copy-review.txt");
  const copyContent    = readFile(copyReviewPath);
  const brainContent   = org.getBrainForRole(managerRoleId, orgProfile);
  const runBrainPath   = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for Darkroom. You make autonomous decisions at control points using the operator's decision-making profile (brain.md).

Respond with valid JSON only:
- To approve:          {"decision":"approve","confidence":"high"|"medium"|"low","reasoning":"..."}
- To request revision: {"decision":"reject","confidence":"high"|"medium"|"low","feedback":"...specific feedback for the copywriter...","reasoning":"..."}
- To escalate to human (when genuinely uncertain): {"decision":"escalate","reasoning":"...why you cannot decide confidently..."}

Use "escalate" only when the brain does not give you enough signal to decide.
Base your decision on the operator's copy voice preferences and quality bar from the brain.`,
    `## Global Brain\n\n${brainContent}`,
    runBrainContent ? `## Run Brain\n\n${runBrainContent}` : null
  );

  const result = claudeCall(
    systemPrompt,
    `## Decision Point: Copy Review\n\nReview the following copy and decide whether to approve it or request revision.\n\n${copyContent}`,
    (u) => logTokens("Copy Review Decision", u)
  );

  if (result.decision === "escalate" || result.confidence === "low") {
    writeDecision(runDir, { decisionPoint: "copy-review", evidence: copyContent.slice(0, 1000), brainContext: `voice: ${brainContent.match(/## Copy Voice\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().slice(0, 200) ?? "(see brain.md)"}`, decision: "escalate", reasoning: result.reasoning ?? "", humanOverride: false });
    const answer = await escalate(runDir, "Low confidence on copy review", { at: "Build Phase 4 — Copy Review", detail: result.reasoning ?? "The orchestrator could not determine whether this copy matches your voice.", options: ["approve", "reject: <feedback>", "abort"] }, io);
    if (/^abort/i.test(answer)) process.exit(1);
    const humanApproved = /^approve/i.test(answer);
    const humanFeedback = answer.replace(/^reject:\s*/i, "").trim();
    writeDecision(runDir, { decisionPoint: "copy-review", evidence: copyContent.slice(0, 200), brainContext: "(escalated)", decision: humanApproved ? "approve" : "reject", reasoning: "Human override after escalation.", humanOverride: true });
    return humanApproved ? "yes" : (humanFeedback || "Please revise the copy.");
  }

  const approved = result.decision === "approve";
  writeDecision(runDir, { decisionPoint: "copy-review", evidence: copyContent.slice(0, 1000), brainContext: `voice: ${brainContent.match(/## Copy Voice\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim().slice(0, 200) ?? "(see brain.md)"}`, decision: result.decision, reasoning: result.reasoning ?? "", humanOverride: false });
  const confidenceColor = result.confidence === "high" ? A.green : result.confidence === "medium" ? A.yellow : A.red;
  console.log(`\n  ${A.cyan("●")}  Auto decision: copy-review → ${approved ? A.green("approve") : A.yellow("reject")}  ${A.dim("(" + confidenceColor(result.confidence ?? "?") + " confidence)")}`);
  if (result.reasoning) console.log(`  ${A.dim("↳ " + result.reasoning.split(/[.\n]/)[0].trim())}\n`);
  return approved ? "yes" : (result.feedback ?? "Please revise the copy.");
}

async function makeSecurityFindingDecision(runDir, signal, io, logTokens, managerRoleId, orgProfile) {
  const finding        = signal.finding ?? "(finding not available)";
  const brainContent   = org.getBrainForRole(managerRoleId, orgProfile);
  const runBrainPath   = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for Darkroom. Decide whether to accept or fix a high security finding.

Respond with valid JSON only:
- To accept (acknowledge and ship with known risk): {"decision":"accept","confidence":"high"|"medium"|"low","reasoning":"..."}
- To fix (send back for remediation):               {"decision":"fix","confidence":"high"|"medium"|"low","reasoning":"..."}
- To escalate: {"decision":"escalate","reasoning":"..."}

Base your decision on the operator's security posture.`,
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
    const answer = await escalate(runDir, "Low confidence on security finding", { at: "Security Phase 4 — High Finding Review", detail: `Finding:\n${finding.slice(0, 400)}\n\nReason: ${result.reasoning ?? "Unable to determine whether to accept or fix."}`, options: ["accept", "fix", "abort"] }, io);
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

async function makeSecurityFinalApprovalDecision(runDir, io, logTokens, managerRoleId, orgProfile) {
  const brainContent    = org.getBrainForRole(managerRoleId, orgProfile);
  const runBrainPath    = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for Darkroom. All security findings have been reviewed. Decide whether to give final approval.

Respond with valid JSON only:
- {"decision":"approve","confidence":"high"|"medium"|"low","reasoning":"..."}
- {"decision":"escalate","reasoning":"..."}

Only escalate if there is a specific unresolved concern.`,
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
    const answer = await escalate(runDir, "Low confidence on security final approval", { at: "Security Phase 4 — Final Approval", detail: result.reasoning ?? "Uncertain whether all findings have been adequately handled.", options: ["yes (approve)", "no (reject)", "abort"] }, io);
    if (/^abort/i.test(answer)) process.exit(1);
    const humanDecision = /^yes/i.test(answer) ? "yes" : "no";
    writeDecision(runDir, { decisionPoint: "security-final-approval", evidence: "(post-finding review)", brainContext: "(escalated)", decision: humanDecision === "yes" ? "approve" : "reject", reasoning: "Human override after escalation.", humanOverride: true });
    return humanDecision;
  }

  writeDecision(runDir, { decisionPoint: "security-final-approval", evidence: "(post-finding review)", brainContext: "(findings resolved)", decision: "approve", reasoning: result.reasoning ?? "", humanOverride: false });
  console.log(`\n  ${A.cyan("●")}  Auto decision: security-final-approval → ${A.green("approve")}\n`);
  return "yes";
}

async function makeReviewVerdictNoShipDecision(runDir, io, logTokens, managerRoleId, orgProfile) {
  const verdictPath     = path.join(runDir, "review", "verdict-report.md");
  const verdictContent  = fileExists(verdictPath) ? readFile(verdictPath) : "(verdict not available)";
  const brainContent    = org.getBrainForRole(managerRoleId, orgProfile);
  const runBrainPath    = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for Darkroom. The review verdict is NO-SHIP. Decide whether to accept the verdict (route back to build) or override it (ship anyway).

Respond with valid JSON only:
- To accept (route back to build): {"decision":"accept","confidence":"high"|"medium"|"low","reasoning":"..."}
- To override and ship: {"decision":"override","reason":"...logged override reason...","confidence":"high"|"medium"|"low","reasoning":"..."}
- To escalate: {"decision":"escalate","reasoning":"..."}

Overriding should be rare. If in doubt, accept the verdict.`,
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
    const answer = await escalate(runDir, "Low confidence on NO-SHIP verdict", { at: "Review Phase 6 — Verdict", detail: result.reasoning ?? "Unable to determine whether to accept the no-ship verdict or override it.", options: ["accept (route to build)", "override: <reason>", "abort"] }, io);
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

async function makeReviewVerdictShipDecision(runDir, io, logTokens, managerRoleId, orgProfile) {
  const brainContent    = org.getBrainForRole(managerRoleId, orgProfile);
  const runBrainPath    = path.join(runDir, "run-brain.md");
  const runBrainContent = fileExists(runBrainPath) ? readFile(runBrainPath) : null;
  const verdictPath     = path.join(runDir, "review", "verdict-report.md");
  const verdictContent  = fileExists(verdictPath) ? readFile(verdictPath) : "(verdict not available)";

  const systemPrompt = buildSystemPrompt(
    `You are the orchestrator for Darkroom. The review verdict is SHIP. Decide whether to approve and ship.

Respond with valid JSON only:
- {"decision":"approve","confidence":"high"|"medium"|"low","reasoning":"..."}
- {"decision":"escalate","reasoning":"..."}

Only escalate if there is a specific concern. A SHIP verdict should almost always be approved.`,
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
    const answer = await escalate(runDir, "Low confidence on SHIP verdict approval", { at: "Review Phase 6 — Verdict", detail: result.reasoning ?? "Uncertain whether to approve the ship verdict.", options: ["yes (approve and ship)", "no (reject)", "abort"] }, io);
    if (/^abort/i.test(answer)) process.exit(1);
    const humanDecision = /^yes/i.test(answer) ? "yes" : "no";
    writeDecision(runDir, { decisionPoint: "review-verdict-ship", evidence: verdictContent.slice(0, 200), brainContext: "(escalated)", decision: humanDecision === "yes" ? "approve" : "reject", reasoning: "Human override after escalation.", humanOverride: true });
    return humanDecision;
  }

  writeDecision(runDir, { decisionPoint: "review-verdict-ship", evidence: verdictContent.slice(0, 200), brainContext: "(ship verdict)", decision: "approve", reasoning: result.reasoning ?? "", humanOverride: false });
  console.log(`\n  ${A.cyan("●")}  Auto decision: review-verdict-ship → ${A.green("approve")}\n`);
  return "yes";
}

// ---------------------------------------------------------------------------
// Signal handlers (auto mode)
// ---------------------------------------------------------------------------

async function handleBuildSignal(runDir, signal, io, logTokens, managerRoleId, orgProfile) {
  if (signal.point === "copy-review") return makeCopyReviewDecision(runDir, io, logTokens, managerRoleId, orgProfile);
  return handleUnknownSignal(runDir, signal, io);
}

async function handleReviewSignal(runDir, signal, io, logTokens, managerRoleId, orgProfile) {
  if (signal.point === "review-verdict-no-ship") return makeReviewVerdictNoShipDecision(runDir, io, logTokens, managerRoleId, orgProfile);
  if (signal.point === "review-verdict-ship")    return makeReviewVerdictShipDecision(runDir, io, logTokens, managerRoleId, orgProfile);
  return handleUnknownSignal(runDir, signal, io);
}

async function handleSecuritySignal(runDir, signal, io, logTokens, managerRoleId, orgProfile) {
  if (signal.point === "security-block")          return "";
  if (signal.point === "security-finding")        return makeSecurityFindingDecision(runDir, signal, io, logTokens, managerRoleId, orgProfile);
  if (signal.point === "security-final-approval") return makeSecurityFinalApprovalDecision(runDir, io, logTokens, managerRoleId, orgProfile);
  return handleUnknownSignal(runDir, signal, io);
}

async function handleUnknownSignal(runDir, signal, io) {
  console.log(`\n  ${A.yellow("⚠")}  Unknown signal: ${signal.point ?? signal.raw}`);
  await escalate(runDir, `Unhandled signal: ${signal.point ?? signal.raw}`, {
    at: "Division runner",
    detail: "The factory received a decision signal it does not yet handle in auto mode.",
    options: ["continue (pass empty response)", "abort"],
  }, io);
  return "";
}

function getSignalHandler(nodeId, managerRoleId, runDir, io, logTokens, orgProfile) {
  if (nodeId === "build")    return (sig) => handleBuildSignal(runDir, sig, io, logTokens, managerRoleId, orgProfile);
  if (nodeId === "review")   return (sig) => handleReviewSignal(runDir, sig, io, logTokens, managerRoleId, orgProfile);
  if (nodeId === "security") return (sig) => handleSecuritySignal(runDir, sig, io, logTokens, managerRoleId, orgProfile);
  return null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function banner(runDir, nodeId, nodeOrder, note = "") {
  let project = "";
  try {
    project = JSON.parse(fs.readFileSync(
      path.join(runDir, "handoff", "factory-manifest.json"), "utf8"
    )).projectName ?? "";
  } catch {}

  const currentIdx = nodeOrder.indexOf(nodeId);
  const pipeline = nodeOrder.map((id, i) => {
    const label = capitalize(id);
    if (i < currentIdx) return A.green(label);
    if (i === currentIdx) return A.bold(A.cyan(label));
    return A.dim(label);
  }).join(A.dim("  →  "));

  const id = path.basename(runDir);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${A.bold("Darkroom")}${project ? `  ·  ${project}` : ""}  ·  ${A.cyan(id)}`);
  console.log(`  ${pipeline}`);
  if (note) console.log(`  ${A.yellow(note)}`);
  console.log(`${"─".repeat(60)}\n`);
}

function abort(runDir, nodeId, reason, loop) {
  const extra = loop > 1 ? ` (loop ${loop})` : "";
  console.error(`\n${A.red("✗")}  ${capitalize(nodeId)} division failed${extra}. ${reason}`);
  logEvent(runDir, { phase: "factory", event: "aborted", division: nodeId, reason, loop });
  try {
    const dept = nodeId ? nodeId.charAt(0).toUpperCase() + nodeId.slice(1) : "Pipeline";
    fs.appendFileSync(
      path.join(runDir, "activity.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), type: "ticker-fail", label: `${dept} · Failed`, reason: (reason ?? "Unknown error").split("\n")[0] }) + "\n",
      "utf8"
    );
  } catch {}
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Graph executor
// ---------------------------------------------------------------------------

async function runGraph(profile, opts) {
  const { runId, runDir, mode, stopAfter, caveman, io, logTokens, onNodeComplete } = opts;

  // Resolve the org profile for decision routing — fall back gracefully for resumes of old runs
  let orgProfile = null;
  if (profile.orgProfile) {
    try { orgProfile = org.loadProfile(profile.orgProfile); }
    catch { console.warn(`  ⚠  Org chart "${profile.orgProfile}" not found — brain decisions will use any available chart.\n`); }
  }
  if (!orgProfile) {
    try { orgProfile = org.getActiveProfile(); } catch {}
  }

  // Build lookup structures from profile
  const nodeMap = {};
  for (const node of profile.nodes) nodeMap[node.id] = node;

  const edgesFrom = {};
  for (const edge of profile.edges) {
    if (!edgesFrom[edge.from]) edgesFrom[edge.from] = [];
    edgesFrom[edge.from].push(edge);
  }

  const nodeOrder = profile.nodes.map((n) => n.id);

  // Extra CLI args passed to every department runner
  function makeArgs() {
    const args = ["--run-id", runId];
    if (caveman) args.push("--caveman");
    if (mode === "auto") args.push("--mode", "auto");
    return args;
  }

  // Skip-condition check — disabled on backward-edge entries
  function skipReason(node, via) {
    if (!node.runner) return "structural node";
    if (via === "backward") return null;
    if (node.skipIf && fs.existsSync(path.join(runDir, node.skipIf))) return "output found";
    if (node.skipIfEvent && hasLogEvent(runDir, node.skipIfEvent)) return "already complete";
    return null;
  }

  // Track how many times each node has actually run
  const runCounts = {};

  // Walk the graph
  let currentId = nodeOrder[0];
  let via = "start";

  while (currentId) {
    const node = nodeMap[currentId];
    if (!node) throw new Error(`Unknown graph node: ${currentId}`);

    const skip = skipReason(node, via);

    if (skip) {
      console.log(`  ${A.green("✓")}  ${capitalize(node.id)} — ${skip}, skipping\n`);
    } else {
      runCounts[node.id] = (runCounts[node.id] ?? 0) + 1;
      const n = runCounts[node.id];
      const loopNote = n > 1 ? `attempt ${n}` : "";
      banner(runDir, node.id, nodeOrder, loopNote);

      // Write memory context for this node before spawning
      const memBlock = buildMemoryBlock(node);
      const memContextPath = path.join(runDir, "memory-context.md");
      if (memBlock) {
        writeFile(memContextPath, memBlock);
      } else if (fs.existsSync(memContextPath)) {
        fs.unlinkSync(memContextPath);
      }

      // Write io-context.json — resolved input file paths for this node
      writeFile(path.join(runDir, "io-context.json"), JSON.stringify(buildIoContext(node, runDir), null, 2));

      let result;
      if (node.feedbackLoop) {
        // Build has a special feedback loop for exit code 43 (verification needs input)
        result = await runBuildWithFeedback(runId, runDir, mode, io, logTokens, node.manager ?? null, orgProfile);
      } else {
        const handler = mode === "auto" ? getSignalHandler(node.id, node.manager ?? null, runDir, io, logTokens, orgProfile) : null;
        result = handler
          ? await runDivisionAuto(node.runner, makeArgs(), handler, runDir)
          : runDivision(node.runner, makeArgs());
      }

      if (result.code !== 0) abort(runDir, node.id, result.stderr || "Exiting.", n);
      logEvent(runDir, { phase: "factory", event: "division-complete", division: node.id, loop: n });

      // Budget checkpoint — only when the node ran
      if ((profile.budgetCheckpoints ?? []).includes(`after:${node.id}`)) {
        await checkBudget(runDir, `after ${capitalize(node.id)}`, mode, io);
      }
    }

    // Post-node callback (e.g. leadership steps between divisions)
    if (onNodeComplete) await onNodeComplete(node.id);

    // Stop-after check
    if (stopAfter === node.id) {
      logEvent(runDir, { phase: "factory", event: "stopped-after", division: node.id });
      console.log(`Stopped after ${capitalize(node.id)} as requested.\n`);
      return;
    }

    // Determine next node via edge routing
    const outEdges = edgesFrom[node.id] ?? [];
    if (outEdges.length === 0) break; // terminal node

    const log = readLog(runDir);
    let nextEdge = null;
    for (const edge of outEdges) {
      if (!edge.on) { nextEdge = edge; break; }             // unconditional
      if (log.some((e) => e.event === edge.on)) { nextEdge = edge; break; } // event matched
    }

    if (!nextEdge) break; // no matching edge → terminal

    if (nextEdge.type === "backward") {
      const edgeKey = `${nextEdge.from}->${nextEdge.to}`;
      const loopCount = (runCounts[nextEdge.from] ?? 1);
      const limit = readLoopLimit(runDir);

      if (loopCount >= limit) {
        const answer = await escalate(
          runDir,
          `${capitalize(nextEdge.from)} → ${capitalize(nextEdge.to)} loop limit reached (${loopCount} attempt${loopCount !== 1 ? "s" : ""})`,
          {
            at: `${capitalize(nextEdge.from)} → ${capitalize(nextEdge.to)} loop ${loopCount}`,
            detail: `The factory has run ${loopCount} loop(s) without passing.${nextEdge.context ? `\n${nextEdge.context} has pending items.` : ""}`,
            options: ["continue (one more loop)", "abort"],
          },
          io
        );
        if (!/^continue/i.test(answer)) abort(runDir, nextEdge.from, "Escalated — operator chose to abort.", loopCount);
        // Bump the run count so the limit check extends by one next iteration
        runCounts[nextEdge.from] = (runCounts[nextEdge.from] ?? 1) - 1;
      }

      const msg = nextEdge.from === "review"
        ? "Review returned no-ship — routing failure reports back to Build."
        : "Security blocked — routing remediations back to Build.";
      console.log(`\n  ${A.yellow(msg)}\n`);
      logEvent(runDir, { phase: "factory", event: "loop-back", from: nextEdge.from, to: nextEdge.to, loop: loopCount });
      via = "backward";
    } else {
      via = "forward";
    }

    currentId = nextEdge.to;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runGraph, readTokenUsage, readBudgetLimit };

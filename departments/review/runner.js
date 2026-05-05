#!/usr/bin/env node

/**
 * Phase 1 review division runner.
 *
 * Drives the full review workflow:
 *   Phase 1: Runtime standup — verify artifact is runnable
 *   Phase 2: Scenario analysis — produce coverage map
 *   Phase 3: Explorer agents — verify each scenario
 *   Phase 4: Edge case agent — explore implied scenarios
 *   Phase 5: Verdict — ship/no-ship recommendation
 *   Phase 6: Human approval
 *
 * On no-ship: writes structured failure reports for build division routing.
 *
 * Usage:
 *   node departments/review/runner.js --run-id <id>
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createInteraction } = require("../../io/interaction");
const { cliAdapter } = require("../../io/adapters/cli");
const { fileAdapter } = require("../../io/adapters/file");
const { createPhaseDisplay, agentStream, A, formatElapsed, setRunDir } = require("../../lib/display");
const { logTokens, writeTokenTable, logTime, writeTimeTable } = require("../../lib/token-log");
const { readFile, writeFile, readJSON, fileExists, buildSystemPrompt, logEvent, hr, extractCompact } = require("../../lib/runner-utils");
const { claudeCall, claudeToolCallAsync } = require("../../adapters/claude-cli");
const { runReflector } = require("../../lib/memory");
const workers = require("../../lib/workers");
const types = require("../../lib/types");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(__dirname, "..", "..", "agents");
const RUNS_DIR = path.join(__dirname, "..", "..", "runs");
const SHARED_CONVENTIONS = path.join(AGENTS_DIR, "shared", "conventions.md");
const SHARED_OUTPUT_FORMATS = path.join(AGENTS_DIR, "shared", "output-formats.md");

// Memory context — loaded once at startup from memory-context.md written by graph executor.
let memoryContext = null;


// ---------------------------------------------------------------------------
// Phase 1: Runtime standup
// ---------------------------------------------------------------------------

function runtimeStandup(artifactDir, runtimeSpec, runDir) {
  const display = createPhaseDisplay("Review", "Runtime Standup", "1 of 5", "verifying artifact runs...", { onFinish: (ms) => logTime(runDir, "Review", "Runtime Standup", ms) });

  if (!fileExists(artifactDir)) {
    display.finish("artifact directory not found");
    console.error("Run the build division first: node run-build.js --run-id <id>");
    process.exit(1);
  }

  // Extract verification command from runtime spec
  const verifyMatch = runtimeSpec.match(/##\s*Verification[\s\S]*?```(?:bash)?\n([\s\S]*?)```/i);
  if (!verifyMatch) {
    display.finish("no verification command — proceeding");
    return;
  }

  // Find the actual verification command (first non-comment, non-empty line in the block).
  // Strip bash-style semicolon chaining — cmd.exe on Windows doesn't treat ; as a separator,
  // causing the semicolon to be passed as part of the script argument to node.
  const lines = verifyMatch[1].split("\n");
  const rawCmd = lines.find((l) => l.trim() && !l.trim().startsWith("#"));
  const verifyCmd = rawCmd ? rawCmd.split(";")[0].trim() : null;

  if (!verifyCmd) {
    display.finish("could not parse verification command — proceeding");
    return;
  }

  display.update(`running: ${verifyCmd.trim()}`);
  const result = spawnSync(verifyCmd.trim(), [], {
    shell: true,
    cwd: artifactDir,
    encoding: "utf8",
  });

  // Fail only if the process couldn't be spawned at all, or if stderr shows a hard Node.js
  // crash (broken artifact) rather than an intentional exit (e.g. TTY check, missing args).
  const hardCrash = result.error ||
    /Cannot find module|SyntaxError:|ReferenceError:|\.js:\d+\n/.test(result.stderr ?? "");

  if (hardCrash) {
    display.finish("standup check failed");
    console.error("stderr:", result.stderr);
    console.error("stdout:", result.stdout);
    if (result.error) console.error("error:", result.error.message);
    process.exit(1);
  }

  // Strip private-mode control sequences (cursor show/hide, alternate screen, etc.)
  // but leave color codes intact so the output renders correctly.
  const stripControls = (s) => s.replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "");
  if (result.stdout.trim()) display.log("  " + stripControls(result.stdout).trim());
  if (result.stderr.trim()) display.log("  " + stripControls(result.stderr).trim());
  display.finish("artifact is running");
}

// ---------------------------------------------------------------------------
// Phase 2: Scenario analysis
// ---------------------------------------------------------------------------

function runScenarioAnalyst(reviewDir, reviewSpec, runtimeSpec, runDir) {
  const coverageMapPath = path.join(reviewDir, "coverage-map.json");

  if (fileExists(coverageMapPath)) {
    const display = createPhaseDisplay("Review", "Scenario Analysis", "2 of 5", "loading cached coverage map...", { onFinish: (ms) => logTime(runDir, "Review", "Scenario Analyst", ms) });
    const cached = readJSON(coverageMapPath);
    display.finish(`${cached.scenarioCount} scenarios (cached)`);
    return cached;
  }

  const display = createPhaseDisplay("Review", "Scenario Analysis", "2 of 5", "mapping coverage...", { onFinish: (ms) => logTime(runDir, "Review", "Scenario Analyst", ms) });

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    workers.resolveSlotPrompt(runDir, "review.scenario-analyst"),
    memoryContext
  );

  const userMessage = [
    `## Review Spec\n\n${reviewSpec}`,
    `## Runtime Spec\n\n${runtimeSpec}`,
  ].join("\n\n---\n\n");

  const result = claudeCall(systemPrompt, userMessage, (u) => logTokens(runDir, "Review", "Scenario Analyst", u));
  const output = result.output ?? result;

  if (!output.scenarios || output.scenarios.length === 0) {
    display.finish("no scenarios returned");
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  writeFile(coverageMapPath, JSON.stringify(output, null, 2));
  display.finish(`${output.scenarioCount} scenarios`);
  return output;
}

// ---------------------------------------------------------------------------
// Phase 3: Explorer agents
// ---------------------------------------------------------------------------

async function runExplorers(reviewDir, coverageMap, reviewSpec, runtimeSpec, artifactDir, runDir, caveman) {
  const total = coverageMap.scenarios.length;
  const reportsDir = path.join(reviewDir, "scenario-reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const runtimeProfile = extractRuntimeProfile(runtimeSpec, artifactDir);

  const cached  = coverageMap.scenarios.filter((s) =>  fileExists(path.join(reportsDir, `${s.id}.json`)));
  const pending = coverageMap.scenarios.filter((s) => !fileExists(path.join(reportsDir, `${s.id}.json`)));

  const subtitle = pending.length === 0
    ? "all scenarios cached"
    : `0 of ${pending.length} complete  ·  up to 4 parallel`;

  const display = createPhaseDisplay("Review", "Explorers", "3 of 5", subtitle,
    { onFinish: (ms) => logTime(runDir, "Review", "Explorers", ms) });

  for (const s of cached) {
    const r = readJSON(path.join(reportsDir, `${s.id}.json`));
    display.log(`  ${A.dim("–")} [${s.id}] ${s.name} — ${r.status} (cached)`);
  }

  if (pending.length === 0) {
    display.finish(`${total} scenarios (all cached)`);
    return;
  }

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    workers.resolveSlotPrompt(runDir, "review.tester"),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "scenario-result.md")) : null,
    memoryContext
  );

  let completed = 0;

  async function runOne(scenario) {
    const reportPath = path.join(reportsDir, `${scenario.id}.json`);
    const t0 = Date.now();

    const userMessage = [
      `## Review Spec\n\n${reviewSpec}`,
      `## Scenario Assignment\n\n${JSON.stringify(scenario, null, 2)}`,
      `## Runtime Profile\n\n${runtimeProfile}`,
      `## Artifact Directory\n\n${artifactDir}`,
      `## Review Working Directory\n\n${reviewDir}`,
    ].join("\n\n---\n\n");

    try {
      await claudeToolCallAsync(systemPrompt, userMessage, artifactDir,
        (u) => logTokens(runDir, "Review", `Explorer [${scenario.id}]`, u));
    } catch (err) {
      display.log(`  ${A.red("✗")} [${scenario.id}] ${scenario.name} — agent error: ${err.message.slice(0, 80)}`);
    }

    if (!fileExists(reportPath)) {
      writeFile(reportPath, JSON.stringify({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        status: "inconclusive",
        observations: "Explorer agent did not write a report file.",
        evidence: { command: "", stdout: "", stderr: "", filesCreated: [], exitedWithError: false },
        passCriteriaEvaluation: "No report written.",
        severity: "n/a",
      }, null, 2));
    }

    const result = readJSON(reportPath);
    const elapsed = formatElapsed(Date.now() - t0);
    logTime(runDir, "Review", `Explorer [${scenario.id}]`, Date.now() - t0);

    completed++;
    display.update(`${completed} of ${pending.length} complete  ·  up to 4 parallel`);

    const icon = result.status === "pass" ? A.green("✓")
      : result.status === "fail" ? A.red("✗")
      : A.yellow("?");
    display.log(`  ${icon} [${scenario.id}] ${scenario.name} — ${result.status}  ${A.dim(elapsed)}`);
    logEvent(runDir, { phase: "review", event: "scenario-complete", scenarioId: scenario.id });
  }

  // Worker pool — up to 4 concurrent explorers
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < pending.length) {
      await runOne(pending[idx++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  const counts = coverageMap.scenarios.reduce((acc, s) => {
    try {
      const status = readJSON(path.join(reportsDir, `${s.id}.json`)).status;
      acc[status] = (acc[status] ?? 0) + 1;
    } catch {}
    return acc;
  }, {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ");
  display.finish(`${total} scenarios — ${summary}`);
}

// ---------------------------------------------------------------------------
// Phase 4: Edge case agent — planner + parallel runners
// ---------------------------------------------------------------------------

async function runEdgeCaseAgent(reviewDir, coverageMap, reviewSpec, runtimeSpec, artifactDir, runDir, caveman) {
  const summaryPath = path.join(reviewDir, "edge-case-summary.md");
  const planPath    = path.join(reviewDir, "edge-case-plan.json");

  if (fileExists(summaryPath)) {
    console.log("Edge case summary found — skipping.\n");
    return;
  }

  const runtimeProfile = extractRuntimeProfile(runtimeSpec, artifactDir);
  const reportsDir = path.join(reviewDir, "scenario-reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const display = createPhaseDisplay("Review", "Edge Cases", "4 of 5", "planning...",
    { onFinish: (ms) => logTime(runDir, "Review", "Edge Cases", ms) });

  // --- Plan (cached) ---
  let plan;
  if (fileExists(planPath)) {
    plan = readJSON(planPath);
    display.log(`  ${A.dim("–")} plan loaded from cache (${plan.edgeCases.length} cases)`);
  } else {
    const plannerPrompt = buildSystemPrompt(
      readFile(SHARED_CONVENTIONS),
      readFile(SHARED_OUTPUT_FORMATS),
      workers.resolveSlotPrompt(runDir, "review.tester"),
      memoryContext
    );

    const scenarioList = coverageMap.scenarios.map((s) => `- [${s.id}] ${s.name}`).join("\n");
    const plannerMessage = [
      `## Review Spec\n\n${reviewSpec}`,
      `## Covered Scenarios\n\n${scenarioList}`,
    ].join("\n\n---\n\n");

    const t0 = Date.now();
    plan = claudeCall(plannerPrompt, plannerMessage, (u) => logTokens(runDir, "Review", "Edge Case Planner", u));
    logTime(runDir, "Review", "Edge Case Planner", Date.now() - t0);
    if (!plan?.edgeCases?.length) {
      display.finish("planner returned no edge cases");
      writeFile(summaryPath, "# Edge Case Summary\n\nNo edge cases identified.\n");
      return;
    }
    writeFile(planPath, JSON.stringify(plan, null, 2));
  }

  // --- Runners (parallel) ---
  const pending = plan.edgeCases.filter((ec) => !fileExists(path.join(reportsDir, `${ec.id}.json`)));
  const cached  = plan.edgeCases.filter((ec) =>  fileExists(path.join(reportsDir, `${ec.id}.json`)));

  for (const ec of cached) {
    const r = readJSON(path.join(reportsDir, `${ec.id}.json`));
    display.log(`  ${A.dim("–")} [${ec.id}] ${ec.name} — ${r.status} (cached)`);
  }

  display.update(`0 of ${pending.length} complete  ·  up to 4 parallel`);

  const runnerPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    workers.resolveSlotPrompt(runDir, "review.tester"),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "edge-case-result.md")) : null,
    memoryContext
  );

  let completed = 0;

  async function runOne(ec) {
    const reportPath = path.join(reportsDir, `${ec.id}.json`);
    const t0 = Date.now();

    const userMessage = [
      `## Edge Case Assignment\n\n${JSON.stringify(ec, null, 2)}`,
      `## Runtime Profile\n\n${runtimeProfile}`,
      `## Artifact Directory\n\n${artifactDir}`,
      `## Review Working Directory\n\n${reviewDir}`,
    ].join("\n\n---\n\n");

    try {
      await claudeToolCallAsync(runnerPrompt, userMessage, artifactDir,
        (u) => logTokens(runDir, "Review", `Edge Case Runner [${ec.id}]`, u));
    } catch (err) {
      display.log(`  ${A.red("✗")} [${ec.id}] ${ec.name} — agent error: ${err.message.slice(0, 80)}`);
    }

    if (!fileExists(reportPath)) {
      writeFile(reportPath, JSON.stringify({
        scenarioId: ec.id, scenarioName: ec.name, status: "inconclusive",
        observations: "Runner did not write a report file.",
        evidence: { command: "", stdout: "", stderr: "", filesCreated: [], exitedWithError: false },
        passCriteriaEvaluation: "No report written.", severity: "n/a",
      }, null, 2));
    }

    const result = readJSON(reportPath);
    const elapsed = formatElapsed(Date.now() - t0);
    logTime(runDir, "Review", `Edge Case Runner [${ec.id}]`, Date.now() - t0);

    completed++;
    display.update(`${completed} of ${pending.length} complete  ·  up to 4 parallel`);

    const icon = result.status === "pass" ? A.green("✓")
      : result.status === "fail" ? A.red("✗")
      : A.yellow("?");
    display.log(`  ${icon} [${ec.id}] ${ec.name} — ${result.status}  ${A.dim(elapsed)}`);
    logEvent(runDir, { phase: "review", event: "edge-case-complete", edgeCaseId: ec.id });
  }

  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() { while (idx < pending.length) await runOne(pending[idx++]); }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  // --- Synthesize summary (no LLM call) ---
  const allCases = plan.edgeCases;
  const summaryLines = ["# Edge Case Summary\n"];
  for (const ec of allCases) {
    const reportPath = path.join(reportsDir, `${ec.id}.json`);
    const r = fileExists(reportPath) ? readJSON(reportPath) : null;
    summaryLines.push(`## ${ec.id}: ${ec.name}`);
    summaryLines.push(`**Description:** ${ec.description}`);
    if (r) {
      summaryLines.push(`**Status:** ${r.status}`);
      summaryLines.push(`**Observations:** ${r.observations}`);
      summaryLines.push(`**Severity:** ${r.severity}`);
    } else {
      summaryLines.push("**Status:** not run");
    }
    summaryLines.push("");
  }
  writeFile(summaryPath, summaryLines.join("\n"));

  const counts = allCases.reduce((acc, ec) => {
    try { const s = readJSON(path.join(reportsDir, `${ec.id}.json`)).status; acc[s] = (acc[s] ?? 0) + 1; } catch {}
    return acc;
  }, {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ");
  display.finish(`${allCases.length} edge cases — ${summary}`);
}

// ---------------------------------------------------------------------------
// Phase 5: Verdict
// ---------------------------------------------------------------------------

async function runVerdictAgent(reviewDir, coverageMap, reviewSpec, runDir, caveman) {
  const verdictPath = path.join(reviewDir, "verdict-report.md");

  if (fileExists(verdictPath)) {
    console.log("Verdict report found — skipping.\n");
    return readFile(verdictPath);
  }

  const display = createPhaseDisplay("Review", "Verdict", "5 of 5", "reading scenario reports", { onFinish: (ms) => logTime(runDir, "Review", "Verdict", ms) });

  // Collect all scenario reports
  const reportsDir = path.join(reviewDir, "scenario-reports");
  const reportFiles = fileExists(reportsDir)
    ? fs.readdirSync(reportsDir).filter((f) => f.endsWith(".json"))
    : [];

  const scenarioReports = reportFiles
    .map((f) => {
      try { return readJSON(path.join(reportsDir, f)); } catch { return null; }
    })
    .filter(Boolean);

  const edgeSummaryPath = path.join(reviewDir, "edge-case-summary.md");
  const edgeSummary = fileExists(edgeSummaryPath) ? readFile(edgeSummaryPath) : "(no edge case summary)";

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(__dirname, "verdict.md")),
    memoryContext
  );

  const scenarioContext = caveman
    ? scenarioReports.map((r) => r.compact ?? `${r.status} | ${r.scenarioId} | ${r.scenarioName} | ${r.observations?.slice(0, 120) ?? "no observations"}`).join("\n")
    : JSON.stringify(scenarioReports, null, 2);

  const userMessage = [
    `## Review Spec\n\n${reviewSpec}`,
    `## Scenario Coverage Map\n\n${JSON.stringify(coverageMap, null, 2)}`,
    `## Scenario Reports\n\n${scenarioContext}`,
    `## Edge Case Summary\n\n${edgeSummary}`,
    `## Review Working Directory\n\n${reviewDir}`,
  ].join("\n\n---\n\n");

  await agentStream(systemPrompt, userMessage, reviewDir, display, { onUsage: (u) => logTokens(runDir, "Review", "Verdict", u) });
  logEvent(runDir, { phase: "review", event: "verdict-complete" });

  if (!fileExists(verdictPath)) {
    display.finish("no report produced");
    console.error("Verdict agent did not write a report.");
    process.exit(1);
  }

  const verdict = readFile(verdictPath).match(/^#\s*Verdict:\s*(\S.*)/im)?.[1] ?? "done";
  display.finish(verdict);

  return readFile(verdictPath);
}

// ---------------------------------------------------------------------------
// Phase 6: Human approval
// ---------------------------------------------------------------------------

async function humanApproval(io, verdictReport, reviewDir, runDir) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  VERDICT — Human Approval Required");
  console.log(`${"=".repeat(60)}\n`);
  console.log(verdictReport);
  console.log(`\n${"=".repeat(60)}\n`);

  const isNoShip = verdictReport.match(/^#\s*Verdict:\s*NO-SHIP/im);

  if (isNoShip) {
    console.log("The verdict is NO-SHIP.\n");
    console.log("  [enter]   Accept verdict — write failure reports and route back to build");
    console.log("  override  Override verdict — ship anyway (requires reason)\n");

    let resolved = false;
    while (!resolved) {
      if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"review-verdict-no-ship"}\n');
      const input = await io.turn("Choice: ", { options: ["accept", "override"], context: "Verdict is NO-SHIP. Accept to route back to build, or override to ship anyway (you will be asked for a reason)." });
      const trimmed = input.trim().toLowerCase();

      if (trimmed === "" || trimmed === "accept") {
        writeFailureReports(reviewDir, runDir);
        logEvent(runDir, { phase: "review", event: "ship-rejected-no-ship" });
        return false;
      } else if (trimmed.startsWith("override")) {
        // Supports both "override" (interactive) and "override: <reason>" (orchestrator inline)
        const inlineReason = trimmed.slice("override".length).replace(/^[\s:]+/, "").trim();
        const reason = inlineReason || (await io.turn("Override reason (will be logged): ")).trim();
        if (!reason) {
          console.log("A reason is required to override.\n");
          continue;
        }
        logEvent(runDir, { phase: "review", event: "ship-approved-override", verdictOverridden: "NO-SHIP", reason });
        console.log("\nVerdict overridden. Shipping.\n");
        return true;
      }
    }
  }

  let approved = false;
  while (!approved) {
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"review-verdict-ship"}\n');
    const input = await io.turn("Approve and ship? (yes / no): ", { options: ["yes", "no"] });
    const trimmed = input.trim().toLowerCase();

    if (trimmed === "yes" || trimmed === "y") {
      approved = true;
      logEvent(runDir, { phase: "review", event: "ship-approved" });
      console.log("\nShip approved.\n");
    } else if (trimmed === "no" || trimmed === "n") {
      const reason = await io.turn("Reason (will be logged): ");
      logEvent(runDir, { phase: "review", event: "ship-rejected", reason });
      writeFailureReports(reviewDir, runDir);
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Failure report writer (routes back to build division)
// ---------------------------------------------------------------------------

function writeFailureReports(reviewDir, runDir) {
  const reportsDir = path.join(reviewDir, "scenario-reports");
  if (!fileExists(reportsDir)) return;

  const failures = fs.readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return readJSON(path.join(reportsDir, f)); } catch { return null; }
    })
    .filter((r) => r && r.status === "fail");

  if (failures.length === 0) {
    console.log("No failing scenarios to report.\n");
    return;
  }

  const failureReportsDir = path.join(runDir, "failure-reports");
  fs.mkdirSync(failureReportsDir, { recursive: true });

  for (const failure of failures) {
    const report = {
      scenarioReference: failure.scenarioId,
      scenarioName: failure.scenarioName,
      observedBehavior: failure.observations,
      expectedBehavior: failure.passCriteriaEvaluation,
      severity: failure.severity || "blocking",
      reproduction: failure.evidence?.command
        ? `Run: ${failure.evidence.command}`
        : "See scenario report for reproduction steps",
    };

    writeFile(
      path.join(failureReportsDir, `failure-${failure.scenarioId}.json`),
      JSON.stringify(report, null, 2)
    );
  }

  console.log(`\nFailure reports written to runs/${path.basename(runDir)}/failure-reports/`);
  console.log(`${failures.length} scenario(s) failed. Route these to the build division:\n`);
  for (const f of failures) {
    console.log(`  [${f.severity?.toUpperCase() || "FAIL"}] ${f.scenarioId}: ${f.scenarioName}`);
  }
  console.log(`\nTo re-run build: node run-build.js --run-id ${path.basename(runDir)}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRuntimeProfile(runtimeSpec, artifactDir) {
  // Pull the run command and any relevant environment info from the runtime spec
  const runCmdMatch = runtimeSpec.match(/##\s*Run command[\s\S]*?```(?:bash)?\n([\s\S]*?)```/i);
  const runCmd = runCmdMatch ? runCmdMatch[1].trim() : "(see runtime spec)";

  return [
    `Artifact directory: ${artifactDir}`,
    `Run command pattern:\n${runCmd}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const runIdIndex = args.indexOf("--run-id");
  if (runIdIndex < 0 || !args[runIdIndex + 1]) {
    console.error("Usage: node departments/review/runner.js --run-id <id>");
    process.exit(1);
  }

  const id = args[runIdIndex + 1];
  const caveman = args.includes("--caveman") || process.env.FACTORY_CAVEMAN === "1";
  const runDir = path.join(RUNS_DIR, id);
  setRunDir(runDir);
  const reviewDir = path.join(runDir, "review");

  fs.mkdirSync(reviewDir, { recursive: true });

  const ioCtxPath = path.join(runDir, "io-context.json");
  const inputs = fileExists(ioCtxPath)
    ? readJSON(ioCtxPath).inputs
    : types.resolve(["review-spec", "runtime-spec", "factory-manifest", "build-artifact"], runDir);
  const artifactDir = path.dirname(inputs["build-artifact"]);

  // Verify required inputs exist
  for (const [typeName, filePath] of Object.entries(inputs)) {
    if (!fileExists(filePath)) {
      console.error(`Missing required input "${typeName}": ${filePath}`);
      process.exit(1);
    }
  }

  const reviewSpec = readFile(inputs["review-spec"]);
  const runtimeSpec = readFile(inputs["runtime-spec"]);
  const factoryManifest = readJSON(inputs["factory-manifest"]);

  const memCtxPath = path.join(runDir, "memory-context.md");
  memoryContext = fileExists(memCtxPath) ? readFile(memCtxPath) : null;

  logEvent(runDir, { phase: "review", event: "start" });

  // Phase 1: Runtime standup
  runtimeStandup(artifactDir, runtimeSpec, runDir);

  // Phase 2: Scenario analysis
  const coverageMap = runScenarioAnalyst(reviewDir, reviewSpec, runtimeSpec, runDir);

  // Phase 3: Explorer agents
  await runExplorers(reviewDir, coverageMap, reviewSpec, runtimeSpec, artifactDir, runDir, caveman);

  // Phase 4: Edge case agent
  await runEdgeCaseAgent(reviewDir, coverageMap, reviewSpec, runtimeSpec, artifactDir, runDir, caveman);

  // Phase 5: Verdict
  const verdictReport = await runVerdictAgent(reviewDir, coverageMap, reviewSpec, runDir, caveman);

  // Phase 6: Human approval
  const io = process.env.DARK_ROOM_IO === "file"
    ? createInteraction(fileAdapter(runDir))
    : createInteraction(cliAdapter());
  const shipped = await humanApproval(io, verdictReport, reviewDir, runDir);
  io.close();

  writeTokenTable(runDir);
  writeTimeTable(runDir);

  const coverageMapPath = path.join(reviewDir, "coverage-map.json");
  const coverageMap2 = fileExists(coverageMapPath) ? readJSON(coverageMapPath) : { scenarios: [] };
  const reportsDir2 = path.join(reviewDir, "scenario-reports");
  const scenarioPassed = fileExists(reportsDir2)
    ? fs.readdirSync(reportsDir2).filter((f) => f.endsWith(".json"))
        .map((f) => { try { return readJSON(path.join(reportsDir2, f)); } catch { return null; } })
        .filter(Boolean).filter((r) => r.status === "pass").length
    : 0;
  const scenarioFailed = (coverageMap2.scenarios?.length ?? 0) - scenarioPassed;
  const verdictPath2 = path.join(reviewDir, "verdict-report.md");
  const verdictText = fileExists(verdictPath2) ? readFile(verdictPath2).match(/^#\s*Verdict:\s*(\S.*)/im)?.[1] ?? "unknown" : "unknown";
  const reviewManifest = inputs["factory-manifest"] && fileExists(inputs["factory-manifest"]) ? readJSON(inputs["factory-manifest"]) : {};

  const reflCtx = [
    `## Run ID\n\n${id}`,
    `## Factory Manifest\n\n${JSON.stringify(reviewManifest, null, 2)}`,
    `## Outcome\n\n${shipped ? "Ship approved." : "No-ship — failure reports written."}`,
    `## Verdict\n\n${verdictText}`,
    `## Scenario Results\n\n${scenarioPassed} passed, ${Math.max(0, scenarioFailed)} failed out of ${coverageMap2.scenarios?.length ?? 0} total`,
  ].join("\n\n---\n\n");
  await runReflector("review", runDir, reflCtx, (u) => logTokens(runDir, "Review", "Wiki Reflector", u));

  if (shipped) {
    console.log(`\n${hr()}`);
    console.log("  Review Division complete. Ship approved.");
    console.log(`  Run: ${id}`);
    console.log(`  Artifact: runs/${id}/artifact/`);
    console.log(`${hr()}\n`);
    logEvent(runDir, { phase: "review", event: "review-division-complete", shipped: true });
  } else {
    logEvent(runDir, { phase: "review", event: "review-division-complete", shipped: false });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
 *   node run-review.js --run-id <id>
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createPhaseDisplay, agentStream, A, formatElapsed } = require("./display");
const { logTokens, writeTokenTable, logTime, writeTimeTable } = require("./token-log");
const { readFile, writeFile, readJSON, fileExists, buildSystemPrompt, logEvent, question, hr, claudeCall, claudeToolCallAsync, extractCompact } = require("./runner-utils");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(__dirname, "agents");
const RUNS_DIR = path.join(__dirname, "runs");
const SHARED_CONVENTIONS = path.join(AGENTS_DIR, "shared", "conventions.md");
const SHARED_OUTPUT_FORMATS = path.join(AGENTS_DIR, "shared", "output-formats.md");


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

  // Find the actual verification command (first non-comment, non-empty line in the block)
  const lines = verifyMatch[1].split("\n");
  const verifyCmd = lines.find((l) => l.trim() && !l.trim().startsWith("#"));

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

  if (result.error || result.status !== 0) {
    display.finish("standup check failed");
    console.error("stderr:", result.stderr);
    console.error("stdout:", result.stdout);
    if (result.error) console.error("error:", result.error.message);
    process.exit(1);
  }

  if (result.stdout.trim()) display.log("  " + result.stdout.trim());
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
    readFile(path.join(AGENTS_DIR, "review", "scenario-analyst.md"))
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
    readFile(path.join(AGENTS_DIR, "review", "explorer.md")),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "scenario-result.md")) : null
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
// Phase 4: Edge case agent
// ---------------------------------------------------------------------------

async function runEdgeCaseAgent(reviewDir, coverageMap, runtimeSpec, artifactDir, runDir) {
  const summaryPath = path.join(reviewDir, "edge-case-summary.md");

  if (fileExists(summaryPath)) {
    console.log("Edge case summary found — skipping.\n");
    return;
  }

  const display = createPhaseDisplay("Review", "Edge Case Exploration", "4 of 5", "finding implied scenarios", { onFinish: (ms) => logTime(runDir, "Review", "Edge Case Exploration", ms) });
  const runtimeProfile = extractRuntimeProfile(runtimeSpec, artifactDir);

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "review", "edge-case.md"))
  );

  const scenarioList = coverageMap.scenarios
    .map((s) => `- [${s.id}] ${s.name}`)
    .join("\n");

  const userMessage = [
    `## Covered Scenarios\n\nThe following scenarios are already assigned to explorer agents. Do not duplicate them.\n\n${scenarioList}`,
    `## Runtime Profile\n\n${runtimeProfile}`,
    `## Artifact Directory\n\n${artifactDir}`,
    `## Review Working Directory\n\n${reviewDir}`,
  ].join("\n\n---\n\n");

  await agentStream(systemPrompt, userMessage, artifactDir, display, { onUsage: (u) => logTokens(runDir, "Review", "Edge Case", u) });

  const count = fileExists(path.join(reviewDir, "scenario-reports"))
    ? fs.readdirSync(path.join(reviewDir, "scenario-reports")).filter((f) => f.startsWith("edge-")).length
    : 0;
  display.finish(`${count} edge case${count === 1 ? "" : "s"} explored`);
  logEvent(runDir, { phase: "review", event: "edge-case-complete" });
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
    readFile(path.join(AGENTS_DIR, "review", "verdict.md"))
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

async function humanApproval(verdictReport, reviewDir, runDir) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  VERDICT — Human Approval Required");
  console.log(`${"=".repeat(60)}\n`);
  console.log(verdictReport);
  console.log(`\n${"=".repeat(60)}\n`);

  const isNoShip = verdictReport.match(/^#\s*Verdict:\s*NO-SHIP/im);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (isNoShip) {
    console.log("The verdict is NO-SHIP.\n");
    console.log("  [enter]   Accept verdict — write failure reports and route back to build");
    console.log("  override  Override verdict — ship anyway (requires reason)\n");

    let resolved = false;
    while (!resolved) {
      if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"review-verdict-no-ship"}\n');
      const input = await question(rl, "Choice: ");
      const trimmed = input.trim().toLowerCase();

      if (trimmed === "" || trimmed === "accept") {
        rl.close();
        writeFailureReports(reviewDir, runDir);
        logEvent(runDir, { phase: "review", event: "ship-rejected-no-ship" });
        return false;
      } else if (trimmed.startsWith("override")) {
        // Supports both "override" (interactive) and "override: <reason>" (orchestrator inline)
        const inlineReason = trimmed.slice("override".length).replace(/^[\s:]+/, "").trim();
        const reason = inlineReason || (await question(rl, "Override reason (will be logged): ")).trim();
        if (!reason) {
          console.log("A reason is required to override.\n");
          continue;
        }
        logEvent(runDir, { phase: "review", event: "ship-approved-override", verdictOverridden: "NO-SHIP", reason });
        console.log("\nVerdict overridden. Shipping.\n");
        rl.close();
        return true;
      }
    }
  }

  let approved = false;
  while (!approved) {
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"review-verdict-ship"}\n');
    const input = await question(rl, "Approve and ship? (yes / no): ");
    const trimmed = input.trim().toLowerCase();

    if (trimmed === "yes" || trimmed === "y") {
      approved = true;
      logEvent(runDir, { phase: "review", event: "ship-approved" });
      console.log("\nShip approved.\n");
    } else if (trimmed === "no" || trimmed === "n") {
      const reason = await question(rl, "Reason (will be logged): ");
      logEvent(runDir, { phase: "review", event: "ship-rejected", reason });
      writeFailureReports(reviewDir, runDir);
      rl.close();
      return false;
    }
  }

  rl.close();
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
    console.error("Usage: node run-review.js --run-id <id>");
    process.exit(1);
  }

  const id = args[runIdIndex + 1];
  const caveman = args.includes("--caveman") || process.env.FACTORY_CAVEMAN === "1";
  const runDir = path.join(RUNS_DIR, id);
  const handoffDir = path.join(runDir, "handoff");
  const artifactDir = path.join(runDir, "artifact");
  const reviewDir = path.join(runDir, "review");

  fs.mkdirSync(reviewDir, { recursive: true });

  // Verify inputs
  for (const f of ["review-spec.md", "runtime-spec.md", "factory-manifest.json"]) {
    if (!fileExists(path.join(handoffDir, f))) {
      console.error(`Missing handoff artifact: ${f}`);
      process.exit(1);
    }
  }

  const reviewSpec = readFile(path.join(handoffDir, "review-spec.md"));
  const runtimeSpec = readFile(path.join(handoffDir, "runtime-spec.md"));
  const factoryManifest = readJSON(path.join(handoffDir, "factory-manifest.json"));

  logEvent(runDir, { phase: "review", event: "start" });

  // Phase 1: Runtime standup
  runtimeStandup(artifactDir, runtimeSpec, runDir);

  // Phase 2: Scenario analysis
  const coverageMap = runScenarioAnalyst(reviewDir, reviewSpec, runtimeSpec, runDir);

  // Phase 3: Explorer agents
  await runExplorers(reviewDir, coverageMap, reviewSpec, runtimeSpec, artifactDir, runDir, caveman);

  // Phase 4: Edge case agent
  await runEdgeCaseAgent(reviewDir, coverageMap, runtimeSpec, artifactDir, runDir);

  // Phase 5: Verdict
  const verdictReport = await runVerdictAgent(reviewDir, coverageMap, reviewSpec, runDir, caveman);

  // Phase 6: Human approval
  const shipped = await humanApproval(verdictReport, reviewDir, runDir);

  writeTokenTable(runDir);
  writeTimeTable(runDir);
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

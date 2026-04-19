#!/usr/bin/env node

/**
 * Phase 1 security division runner.
 *
 * Drives the full security workflow:
 *   Phase 1: Static analysis — source code review
 *   Phase 2: Dynamic testing — adversarial runtime testing
 *   Phase 3: Verdict — consolidated security assessment
 *   Phase 4: Human checkpoint — default block, explicit approval required
 *
 * On BLOCK or human rejection: writes remediation requests for build division.
 *
 * Usage:
 *   node run-security.js --run-id <id>
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createPhaseDisplay, agentStream } = require("./display");
const { logTokens, writeTokenTable, logTime, writeTimeTable } = require("./token-log");
const { readFile, writeFile, readJSON, fileExists, buildSystemPrompt, logEvent, question, hr, claudeCall, collectSourceFiles, extractCompact } = require("./runner-utils");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(__dirname, "agents");
const RUNS_DIR = path.join(__dirname, "runs");
const SHARED_CONVENTIONS = path.join(AGENTS_DIR, "shared", "conventions.md");
const SHARED_OUTPUT_FORMATS = path.join(AGENTS_DIR, "shared", "output-formats.md");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hr2() { return "=".repeat(60); }

// ---------------------------------------------------------------------------
// Phase 1: Static analysis
// ---------------------------------------------------------------------------

async function runStaticAnalyst(securityDir, artifactDir, runtimeSpec, caveman) {
  const reportPath = path.join(securityDir, "static-analysis-report.md");

  if (fileExists(reportPath)) {
    console.log("Static analysis report found — skipping.\n");
    return readFile(reportPath);
  }

  const display = createPhaseDisplay("Security", "Static Analysis", "1 of 3", "reading source files", { onFinish: (ms) => logTime(path.dirname(securityDir), "Security", "Static Analysis", ms) });

  const artifactSource = collectSourceFiles(artifactDir);

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "security", "static-analyst.md")),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "static-analysis.md")) : null
  );

  const userMessage = [
    `## Artifact Source\n\n${artifactSource}`,
    `## Runtime Spec\n\n${runtimeSpec}`,
    `## Security Working Directory\n\n${securityDir}`,
  ].join("\n\n---\n\n");

  const runDir = path.dirname(securityDir);
  display.update("scanning for vulnerabilities");
  await agentStream(systemPrompt, userMessage, securityDir, display, { onUsage: (u) => logTokens(runDir, "Security", "Static Analysis", u) });

  if (!fileExists(reportPath)) {
    display.finish("no report produced");
    console.error("Static analyst did not write a report.");
    process.exit(1);
  }

  const summary = readFile(reportPath).match(/Overall assessment:\s*(\S+)/i)?.[1] ?? "done";
  display.finish(summary);
  return readFile(reportPath);
}

// ---------------------------------------------------------------------------
// Phase 2: Dynamic testing — plan approval then streaming execution
// ---------------------------------------------------------------------------

function buildRuntimeProfile(runtimeSpec, artifactDir) {
  const runCmdMatch = runtimeSpec.match(/##\s*Run command[\s\S]*?```(?:bash)?\n([\s\S]*?)```/i);
  const runCmd = runCmdMatch ? runCmdMatch[1].trim() : "(see runtime spec)";
  return [`Artifact directory: ${artifactDir}`, `Run command pattern:\n${runCmd}`].join("\n\n");
}

async function runDynamicTester(securityDir, artifactDir, runtimeSpec, staticReport, caveman) {
  const reportPath = path.join(securityDir, "dynamic-test-report.md");

  if (fileExists(reportPath)) {
    console.log("Dynamic test report found — skipping.\n");
    return readFile(reportPath);
  }

  const runtimeProfile = buildRuntimeProfile(runtimeSpec, artifactDir);
  const staticContext = caveman ? (extractCompact(staticReport) ?? staticReport) : staticReport;

  const display = createPhaseDisplay("Security", "Dynamic Testing", "2 of 3", "planning tests...", { onFinish: (ms) => logTime(path.dirname(securityDir), "Security", "Dynamic Testing", ms) });

  const testerPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "security", "dynamic-tester.md")),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "dynamic-testing.md")) : null
  );

  const testerMessage = [
    `## Runtime Profile\n\n${runtimeProfile}`,
    `## Artifact Directory\n\n${artifactDir}`,
    `## Static Analysis Report\n\n${staticContext}`,
    `## Security Working Directory\n\n${securityDir}`,
  ].join("\n\n---\n\n");

  await agentStream(testerPrompt, testerMessage, artifactDir, display, { onUsage: (u) => logTokens(path.dirname(securityDir), "Security", "Dynamic Tester", u) });

  if (!fileExists(reportPath)) {
    display.finish("no report produced");
    console.error("\nDynamic tester did not write a report.");
    process.exit(1);
  }

  const summary = readFile(reportPath).match(/Overall assessment:\s*(\S+)/i)?.[1] ?? "done";
  display.finish(summary);
  return readFile(reportPath);
}

// ---------------------------------------------------------------------------
// Phase 3: Verdict
// ---------------------------------------------------------------------------

async function runVerdictAgent(securityDir, staticReport, dynamicReport, caveman) {
  const verdictPath = path.join(securityDir, "security-verdict-report.md");

  if (fileExists(verdictPath)) {
    console.log("Security verdict found — skipping.\n");
    return readFile(verdictPath);
  }

  const display = createPhaseDisplay("Security", "Verdict", "3 of 3", "consolidating findings", { onFinish: (ms) => logTime(path.dirname(securityDir), "Security", "Verdict", ms) });

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "security", "verdict.md"))
  );

  const staticContext  = caveman ? (extractCompact(staticReport)  ?? staticReport)  : staticReport;
  const dynamicContext = caveman ? (extractCompact(dynamicReport) ?? dynamicReport) : dynamicReport;

  const userMessage = [
    `## Static Analysis Report\n\n${staticContext}`,
    `## Dynamic Test Report\n\n${dynamicContext}`,
    `## Security Working Directory\n\n${securityDir}`,
  ].join("\n\n---\n\n");

  await agentStream(systemPrompt, userMessage, securityDir, display, { onUsage: (u) => logTokens(path.dirname(securityDir), "Security", "Verdict", u) });

  if (!fileExists(verdictPath)) {
    display.finish("no report produced");
    console.error("Verdict agent did not write a report.");
    process.exit(1);
  }

  const verdict = readFile(verdictPath).match(/^#\s*Security Verdict:\s*(\S.*)/im)?.[1] ?? "done";
  display.finish(verdict);
  return readFile(verdictPath);
}

// ---------------------------------------------------------------------------
// Phase 4: Human checkpoint
// ---------------------------------------------------------------------------

async function humanCheckpoint(verdictReport, securityDir, runDir) {
  // Parse verdict from report
  const verdictMatch = verdictReport.match(/^#\s*Security Verdict:\s*(PASS|CONDITIONAL PASS|BLOCK)/im);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "BLOCK";

  console.log(`\n${hr2()}`);
  console.log("  SECURITY REVIEW — Human Approval Required");
  console.log(`${hr2()}\n`);
  console.log(verdictReport);
  console.log(`\n${hr2()}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (verdict === "BLOCK") {
    console.log("⚠  Security verdict is BLOCK. Critical findings must be resolved before shipping.\n");
    console.log("The build division will receive remediation requests.\n");
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"security-block"}\n');
    await question(rl, "Press Enter to write remediation requests and exit: ");
    rl.close();
    writeRemediationRequests(verdictReport, securityDir, runDir);
    return false;
  }

  if (verdict === "CONDITIONAL PASS") {
    console.log("⚠  Security verdict is CONDITIONAL PASS. High findings require your explicit sign-off.\n");
    console.log("Review each high finding above. Type 'accept' to accept a finding or 'fix' to send it back.\n");

    const highFindings = extractHighFindings(verdictReport);
    const accepted = [];
    const toFix = [];

    for (const finding of highFindings) {
      console.log(`\n--- High Finding ---\n${finding}\n`);
      if (process.env.FACTORY_AUTO === "1") {
        process.stdout.write(`FACTORY_SIGNAL:${JSON.stringify({ point: "security-finding", finding: finding.slice(0, 300) })}\n`);
      }
      const decision = await question(rl, "Accept this finding or send for fix? (accept / fix): ");
      if (decision.trim().toLowerCase() === "accept") {
        accepted.push(finding);
        logEvent(runDir, { phase: "security", event: "high-finding-accepted", finding: finding.slice(0, 100) });
      } else {
        toFix.push(finding);
        logEvent(runDir, { phase: "security", event: "high-finding-rejected", finding: finding.slice(0, 100) });
      }
    }

    if (toFix.length > 0) {
      console.log(`\n${toFix.length} finding(s) sent back for remediation.\n`);
      writeRemediationRequests(verdictReport, securityDir, runDir, toFix);
      rl.close();
      return false;
    }

    console.log("\nAll high findings accepted. Proceeding to final approval.\n");
  }

  // Final ship approval
  let approved = false;
  while (!approved) {
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"security-final-approval"}\n');
    const input = await question(rl, "Approve security review and proceed? (yes / no): ");
    const trimmed = input.trim().toLowerCase();

    if (trimmed === "yes" || trimmed === "y") {
      approved = true;
      logEvent(runDir, { phase: "security", event: "security-approved" });
      console.log("\nSecurity review approved.\n");
    } else if (trimmed === "no" || trimmed === "n") {
      const reason = await question(rl, "Reason (will be logged): ");
      logEvent(runDir, { phase: "security", event: "security-rejected", reason });
      writeRemediationRequests(verdictReport, securityDir, runDir);
      rl.close();
      return false;
    }
  }

  rl.close();
  return true;
}

// ---------------------------------------------------------------------------
// Remediation request writer
// ---------------------------------------------------------------------------

function writeRemediationRequests(verdictReport, securityDir, runDir, specificFindings = null) {
  const remediationDir = path.join(runDir, "security-remediations");
  fs.mkdirSync(remediationDir, { recursive: true });

  const content = specificFindings
    ? `# Security Remediation Requests\n\nThe following security findings require resolution before shipping.\n\n${specificFindings.join("\n\n---\n\n")}`
    : `# Security Remediation Requests\n\nThe full security verdict report is below. All blocking and flagged findings must be resolved.\n\n${verdictReport}`;

  writeFile(path.join(remediationDir, "remediation-requests.md"), content);

  const id = path.basename(runDir);
  console.log(`\nRemediation requests written to runs/${id}/security-remediations/`);
  console.log(`\nTo re-run build after fixes: node run-build.js --run-id ${id}`);
  console.log(`Then re-run security: node run-security.js --run-id ${id}\n`);
}

function extractHighFindings(verdictReport) {
  // Extract the High Findings section content
  const match = verdictReport.match(/##\s*High Findings[\s\S]*?(?=##|$)/i);
  if (!match) return [];
  // Split into individual findings by ### headers
  return match[0]
    .split(/\n(?=###)/)
    .filter((s) => s.trim() && !s.match(/^##\s*High/))
    .map((s) => s.trim());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const runIdIndex = args.indexOf("--run-id");
  if (runIdIndex < 0 || !args[runIdIndex + 1]) {
    console.error("Usage: node run-security.js --run-id <id>");
    process.exit(1);
  }

  const id = args[runIdIndex + 1];
  const caveman = args.includes("--caveman") || process.env.FACTORY_CAVEMAN === "1";
  const runDir = path.join(RUNS_DIR, id);
  const handoffDir = path.join(runDir, "handoff");
  const artifactDir = path.join(runDir, "artifact");
  const securityDir = path.join(runDir, "security");

  fs.mkdirSync(securityDir, { recursive: true });

  // Verify inputs
  if (!fileExists(artifactDir)) {
    console.error(`Artifact directory not found: ${artifactDir}`);
    console.error("Run the build division first: node run-build.js --run-id <id>");
    process.exit(1);
  }

  if (!fileExists(path.join(handoffDir, "runtime-spec.md"))) {
    console.error("Missing runtime-spec.md in handoff directory.");
    process.exit(1);
  }

  const runtimeSpec = readFile(path.join(handoffDir, "runtime-spec.md"));
  const factoryManifest = fileExists(path.join(handoffDir, "factory-manifest.json"))
    ? readJSON(path.join(handoffDir, "factory-manifest.json"))
    : { projectName: "unknown" };

  console.log(`\nSoftware Factory — Security Division`);
  console.log(`Run: ${id}`);
  console.log(`Project: ${factoryManifest.projectName}\n`);
  console.log(`Default stance: BLOCK. Explicit approval required to proceed.\n`);

  logEvent(runDir, { phase: "security", event: "start" });

  // Phase 1: Static analysis
  const staticReport = await runStaticAnalyst(securityDir, artifactDir, runtimeSpec, caveman);

  // Phase 2: Dynamic testing
  const dynamicReport = await runDynamicTester(securityDir, artifactDir, runtimeSpec, staticReport, caveman);

  // Phase 3: Verdict
  const verdictReport = await runVerdictAgent(securityDir, staticReport, dynamicReport, caveman);

  // Phase 4: Human checkpoint
  const approved = await humanCheckpoint(verdictReport, securityDir, runDir);

  writeTokenTable(runDir);
  writeTimeTable(runDir);
  if (approved) {
    console.log(`\n${hr()}`);
    console.log("  Security Division complete. Approved.");
    console.log(`  Run: ${id}`);
    console.log(`${hr()}\n`);
    logEvent(runDir, { phase: "security", event: "security-division-complete", approved: true });
  } else {
    logEvent(runDir, { phase: "security", event: "security-division-complete", approved: false });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
 *   node departments/security/runner.js --run-id <id>
 */

const fs = require("fs");
const path = require("path");
const { createInteraction } = require("../../io/interaction");
const { cliAdapter } = require("../../io/adapters/cli");
const { fileAdapter } = require("../../io/adapters/file");
const { createPhaseDisplay, agentStream, setRunDir } = require("../../lib/display");
const { logTokens, writeTokenTable, logTime, writeTimeTable } = require("../../lib/token-log");
const { readFile, writeFile, readJSON, fileExists, buildSystemPrompt, logEvent, hr, collectSourceFiles, extractCompact } = require("../../lib/runner-utils");
const { claudeCall } = require("../../adapters/claude-cli");
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
let _runDir = null;

// Memory context — loaded once at startup from memory-context.md written by graph executor.
let memoryContext = null;

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
    workers.resolveSlotPrompt(_runDir, "security.static-analyst"),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "static-analysis.md")) : null,
    memoryContext
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
    workers.resolveSlotPrompt(_runDir, "security.dynamic-tester"),
    caveman ? readFile(path.join(AGENTS_DIR, "caveman", "dynamic-testing.md")) : null,
    memoryContext
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
    readFile(path.join(__dirname, "verdict.md")),
    memoryContext
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

async function humanCheckpoint(io, verdictReport, securityDir, runDir) {
  // Parse verdict from report
  const verdictMatch = verdictReport.match(/^#\s*Security Verdict:\s*(PASS|CONDITIONAL PASS|BLOCK)/im);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "BLOCK";

  console.log(`\n${hr2()}`);
  console.log("  SECURITY REVIEW — Human Approval Required");
  console.log(`${hr2()}\n`);
  console.log(verdictReport);
  console.log(`\n${hr2()}\n`);

  if (verdict === "BLOCK") {
    console.log("⚠  Security verdict is BLOCK. Critical findings must be resolved before shipping.\n");
    console.log("The build division will receive remediation requests.\n");
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"security-block"}\n');
    await io.turn("Press Enter to write remediation requests and exit: ", { options: ["continue"] });
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
      const decision = await io.turn("Accept this finding or send for fix? (accept / fix): ", { options: ["accept", "fix"], context: finding });
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
      return false;
    }

    console.log("\nAll high findings accepted. Proceeding to final approval.\n");
  }

  // Final ship approval
  let approved = false;
  while (!approved) {
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"security-final-approval"}\n');
    const input = await io.turn("Approve security review and proceed? (yes / no): ", { options: ["yes", "no"] });
    const trimmed = input.trim().toLowerCase();

    if (trimmed === "yes" || trimmed === "y") {
      approved = true;
      logEvent(runDir, { phase: "security", event: "security-approved" });
      console.log("\nSecurity review approved.\n");
    } else if (trimmed === "no" || trimmed === "n") {
      const reason = await io.turn("Reason (will be logged): ");
      logEvent(runDir, { phase: "security", event: "security-rejected", reason });
      writeRemediationRequests(verdictReport, securityDir, runDir);
      return false;
    }
  }

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
  console.log(`\nTo re-run build after fixes: node departments/run-build.js --run-id ${id}`);
  console.log(`Then re-run security: node departments/run-security.js --run-id ${id}\n`);
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
    console.error("Usage: node departments/security/runner.js --run-id <id>");
    process.exit(1);
  }

  const id = args[runIdIndex + 1];
  const caveman = args.includes("--caveman") || process.env.FACTORY_CAVEMAN === "1";
  const runDir = path.join(RUNS_DIR, id);
  _runDir = runDir;
  setRunDir(runDir);
  const securityDir = path.join(runDir, "security");

  fs.mkdirSync(securityDir, { recursive: true });

  const ioCtxPath = path.join(runDir, "io-context.json");
  const inputs = fileExists(ioCtxPath)
    ? readJSON(ioCtxPath).inputs
    : types.resolve(["runtime-spec", "factory-manifest", "build-artifact"], runDir);
  const artifactDir = path.dirname(inputs["build-artifact"]);

  // Verify required inputs exist
  for (const [typeName, filePath] of Object.entries(inputs)) {
    if (!fileExists(filePath)) {
      console.error(`Missing required input "${typeName}": ${filePath}`);
      if (typeName === "build-artifact") console.error("Run the build division first: node departments/build/runner.js --run-id <id>");
      process.exit(1);
    }
  }

  const runtimeSpec = readFile(inputs["runtime-spec"]);
  const factoryManifest = inputs["factory-manifest"] && fileExists(inputs["factory-manifest"])
    ? readJSON(inputs["factory-manifest"])
    : { projectName: "unknown" };

  console.log(`\nSoftware Factory — Security Division`);
  console.log(`Run: ${id}`);
  console.log(`Project: ${factoryManifest.projectName}\n`);
  console.log(`Default stance: BLOCK. Explicit approval required to proceed.\n`);

  const memCtxPath = path.join(runDir, "memory-context.md");
  memoryContext = fileExists(memCtxPath) ? readFile(memCtxPath) : null;

  logEvent(runDir, { phase: "security", event: "start" });

  // Phase 1: Static analysis
  const staticReport = await runStaticAnalyst(securityDir, artifactDir, runtimeSpec, caveman);

  // Phase 2: Dynamic testing
  const dynamicReport = await runDynamicTester(securityDir, artifactDir, runtimeSpec, staticReport, caveman);

  // Phase 3: Verdict
  const verdictReport = await runVerdictAgent(securityDir, staticReport, dynamicReport, caveman);

  // Phase 4: Human checkpoint
  const io = process.env.DARK_ROOM_IO === "file"
    ? createInteraction(fileAdapter(runDir))
    : createInteraction(cliAdapter());
  const approved = await humanCheckpoint(io, verdictReport, securityDir, runDir);
  io.close();

  writeTokenTable(runDir);
  writeTimeTable(runDir);

  const verdictReportPath = path.join(securityDir, "security-verdict-report.md");
  const verdictText2 = fileExists(verdictReportPath)
    ? readFile(verdictReportPath).match(/^#\s*Security Verdict:\s*(\S.*)/im)?.[1] ?? "unknown"
    : "unknown";
  const secManifest = inputs["factory-manifest"] && fileExists(inputs["factory-manifest"]) ? readJSON(inputs["factory-manifest"]) : {};
  const staticReportPath = path.join(securityDir, "static-analysis-report.md");
  const dynamicReportPath = path.join(securityDir, "dynamic-test-report.md");

  const reflCtxSec = [
    `## Run ID\n\n${id}`,
    `## Factory Manifest\n\n${JSON.stringify(secManifest, null, 2)}`,
    `## Outcome\n\n${approved ? "Security approved." : "Security blocked — remediation requests written."}`,
    `## Verdict\n\n${verdictText2}`,
    fileExists(staticReportPath) ? `## Static Analysis Summary\n\n${readFile(staticReportPath).slice(0, 800)}` : null,
    fileExists(dynamicReportPath) ? `## Dynamic Test Summary\n\n${readFile(dynamicReportPath).slice(0, 800)}` : null,
  ].filter(Boolean).join("\n\n---\n\n");
  await runReflector("security", runDir, reflCtxSec, (u) => logTokens(runDir, "Security", "Wiki Reflector", u));

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

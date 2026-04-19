#!/usr/bin/env node

/**
 * Phase 1 build division runner.
 *
 * Drives the full build workflow:
 *   Phase 1: Architect interview → locked plan + task graph
 *   Phase 2: Sequential task execution (implementation agents)
 *   Phase 3: Integration
 *   Phase 4: Copy writer + human approval
 *   Phase 5: Verification (with retry budget)
 *   Phase 6: Packaging
 *
 * Reads from runs/{run-id}/handoff/ (design division outputs).
 * Writes to runs/{run-id}/build/ and runs/{run-id}/artifact/.
 *
 * Usage:
 *   node run-build.js --run-id <id>
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createPhaseDisplay, agentStream, createTicker, A } = require("./display");
const { logTokens, writeTokenTable, logTime, writeTimeTable } = require("./token-log");
const { readFile, writeFile, readJSON, writeJSON, fileExists, buildSystemPrompt, clipForDisplay, logEvent, question, hr, claudeRaw, claudeCall, claudeToolCall, collectSourceFiles } = require("./runner-utils");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(__dirname, "agents");
const RUNS_DIR = path.join(__dirname, "runs");
const SHARED_CONVENTIONS = path.join(AGENTS_DIR, "shared", "conventions.md");
const SHARED_OUTPUT_FORMATS = path.join(AGENTS_DIR, "shared", "output-formats.md");
const RETRY_BUDGET = 3;


// For interactive interview turns
function claudeTurn(systemPrompt, history) {
  const turns = history
    .map((m) => `${m.role === "assistant" ? "Agent" : "User"}: ${m.content}`)
    .join("\n\n");
  const input = history.length === 0 ? "Begin." : `${turns}\n\nRespond as the Agent.`;
  return claudeRaw(["-p", "--system-prompt", systemPrompt], input);
}

// ---------------------------------------------------------------------------
// Architect interview
// ---------------------------------------------------------------------------

async function runArchitectInterview(runDir, buildSpec, factoryManifest) {
  const transcriptPath = path.join(runDir, "architect-transcript.md");
  const planPath = path.join(runDir, "build", "architecture-plan.md");

  if (fileExists(planPath)) {
    console.log("Architecture plan found — skipping architect interview.\n");
    const taskGraphPath = path.join(runDir, "build", "task-graph.json");
    return { architecturePlan: readFile(planPath), taskGraph: readJSON(taskGraphPath) };
  }

  writeFile(transcriptPath, "# Architect Interview Transcript\n");

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "architect.md")),
    `## Build Spec\n\n${buildSpec}`,
    `## Factory Manifest\n\n${JSON.stringify(factoryManifest, null, 2)}`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];

  const display = createPhaseDisplay("Build", "Architect Interview", "1 of 6", "thinking...", { onFinish: (ms) => logTime(runDir, "Build", "Architect Interview", ms) });
  display.log('\n  When you are satisfied with the plan, type "lock" to finalize.\n');

  // Opening presentation
  let agentTurn = claudeTurn(systemPrompt, history);
  display.update("your turn");
  display.log(`\nArchitect: ${clipForDisplay(agentTurn)}\n`);
  fs.appendFileSync(transcriptPath, `\n## Architect\n\n${agentTurn.trim()}\n`);
  history.push({ role: "assistant", content: agentTurn });

  let lockedOutput = null;

  // Shared lock step — builds structured output from the current transcript.
  async function executeLock() {
    display.update("locking plan...");
    const lockPrompt = buildSystemPrompt(
      readFile(SHARED_CONVENTIONS),
      readFile(SHARED_OUTPUT_FORMATS),
      readFile(path.join(AGENTS_DIR, "build", "architect.md")),
      `## Build Spec\n\n${buildSpec}`,
      `## Factory Manifest\n\n${JSON.stringify(factoryManifest, null, 2)}`,
      `## Interview transcript\n\n${readFile(transcriptPath)}`
    );
    const result = claudeCall(lockPrompt,
      "The user has confirmed. Produce the locked architecture plan and task graph now as specified in your output format.",
      (u) => logTokens(runDir, "Build", "Architect", u)
    );
    return result.output ?? result;
  }

  if (process.env.FACTORY_AUTO === "1") {
    // Auto mode: lock immediately after opening presentation — no human review.
    rl.close();
    lockedOutput = await executeLock();
  } else {
    while (true) {
      const userInput = await question(rl, "You: ");
      if (!userInput.trim()) continue;

      // User-initiated lock — no need to wait for agent to say the magic phrase.
      if (/^(lock|done|finalize)$/i.test(userInput.trim())) {
        lockedOutput = await executeLock();
        break;
      }

      fs.appendFileSync(transcriptPath, `\n## User\n\n${userInput.trim()}\n`);
      history.push({ role: "user", content: userInput });

      display.update("thinking...");
      agentTurn = claudeTurn(systemPrompt, history);
      display.update("your turn");
      display.log(`\nArchitect: ${clipForDisplay(agentTurn)}\n`);
      fs.appendFileSync(transcriptPath, `\n## Architect\n\n${agentTurn.trim()}\n`);
      history.push({ role: "assistant", content: agentTurn });

      // Agent-initiated lock — case-insensitive, no exact-phrase dependency.
      if (/ready to lock the plan/i.test(agentTurn)) {
        const confirm = await question(rl, "Lock the plan? (yes / keep discussing): ");
        fs.appendFileSync(transcriptPath, `\n## User\n\n${confirm.trim()}\n`);
        history.push({ role: "user", content: confirm });

        if (/^(yes|y|lock|ok|do it|go|proceed)/i.test(confirm.trim())) {
          lockedOutput = await executeLock();
          break;
        }
        // Otherwise fall through and keep discussing
      }
    }

    rl.close();
  }

  if (!lockedOutput || !lockedOutput.architecturePlan || !lockedOutput.taskGraph) {
    console.error("Architect did not produce a valid locked output.");
    console.error(JSON.stringify(lockedOutput, null, 2));
    process.exit(1);
  }

  fs.mkdirSync(path.join(runDir, "build"), { recursive: true });
  writeFile(planPath, lockedOutput.architecturePlan);
  writeJSON(path.join(runDir, "build", "task-graph.json"), lockedOutput.taskGraph);
  logEvent(runDir, { phase: "build", event: "architect-interview-complete", taskCount: lockedOutput.taskGraph.length });

  display.finish(`${lockedOutput.taskGraph.length} tasks`);
  return lockedOutput;
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

function getTaskInputFiles(task, buildDir) {
  if (!task.dependsOn || task.dependsOn.length === 0) return "";
  const parts = [];
  for (const depId of task.dependsOn) {
    // Find files produced by the dependency task
    const depTaskPath = path.join(buildDir, `task-${depId}-outputs.json`);
    if (fileExists(depTaskPath)) {
      const outputs = readJSON(depTaskPath);
      for (const filePath of outputs) {
        const fullPath = path.join(buildDir, "src", filePath);
        if (fileExists(fullPath)) {
          parts.push(`### ${filePath}\n\`\`\`\n${readFile(fullPath)}\n\`\`\``);
        }
      }
    }
  }
  return parts.length > 0 ? `## Relevant Interfaces\n\n${parts.join("\n\n")}` : "";
}

async function executeTask(task, buildDir, buildSpec, architecturePlan, runDir, attempt = 1, previousFailure = null) {
  const taskStatusPath = path.join(buildDir, `task-${task.id}-status.json`);

  if (fileExists(taskStatusPath)) {
    const status = readJSON(taskStatusPath);
    if (status.status === "complete") {
      console.log(`  [${task.id}] ${task.name} — already complete, skipping`);
      return true;
    }
  }

  const ticker = createTicker(`[${task.id}] ${task.name}${attempt > 1 ? ` (attempt ${attempt}/${RETRY_BUDGET})` : ""}`);;

  const srcDir = path.join(buildDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });

  const relevantInterfaces = getTaskInputFiles(task, buildDir);

  const retryContext = previousFailure
    ? `## Previous Attempt Failure\n\n${previousFailure}`
    : "";

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "implementation.md"))
  );

  const userMessage = [
    `## Build Spec\n\n${buildSpec}`,
    `## Architecture Plan\n\n${architecturePlan}`,
    `## Your Task\n\n${JSON.stringify(task, null, 2)}`,
    relevantInterfaces,
    retryContext,
    `## Working Directory\n\nWrite all output files to: ${srcDir}\n\nThe paths in expectedOutputs are relative to this directory.`,
  ].filter(Boolean).join("\n\n---\n\n");

  claudeToolCall(systemPrompt, userMessage, srcDir);

  // Verify expected outputs exist
  const missing = [];
  for (const expectedPath of task.expectedOutputs) {
    const fullPath = path.join(srcDir, expectedPath);
    if (!fileExists(fullPath)) {
      missing.push(expectedPath);
    }
  }

  if (missing.length > 0) {
    ticker.fail(`missing outputs: ${missing.join(", ")}`);
    writeJSON(taskStatusPath, { status: "failed", missing, attempt });
    logEvent(runDir, { phase: "build", event: "task-failed", taskId: task.id, missing, attempt });
    return false;
  }

  // Record completed outputs for downstream tasks
  writeJSON(path.join(buildDir, `task-${task.id}-outputs.json`), task.expectedOutputs);
  writeJSON(taskStatusPath, { status: "complete", attempt });
  logEvent(runDir, { phase: "build", event: "task-complete", taskId: task.id, attempt });
  ticker.done(task.expectedOutputs.join(", "));
  return true;
}

async function runTaskGraph(taskGraph, buildDir, buildSpec, architecturePlan, runDir) {
  const display = createPhaseDisplay(
    "Build", "Implementation", "2 of 6",
    `${taskGraph.length} task${taskGraph.length === 1 ? "" : "s"}`,
    { onFinish: (ms) => logTime(runDir, "Build", "Implementation", ms) }
  );

  const completed = new Set();
  const failed = new Map(); // taskId → attempt count

  // Build execution order respecting dependencies
  function getReadyTasks() {
    return taskGraph.filter((task) => {
      if (completed.has(task.id)) return false;
      if ((failed.get(task.id) || 0) >= RETRY_BUDGET) return false;
      return (task.dependsOn || []).every((dep) => completed.has(dep));
    });
  }

  let progress = true;
  while (progress) {
    progress = false;
    const ready = getReadyTasks();
    if (ready.length === 0) break;

    for (const task of ready) {
      const attemptNum = (failed.get(task.id) || 0) + 1;
      const previousFailure = failed.has(task.id)
        ? `Task ${task.id} failed on attempt ${failed.get(task.id)}. Expected outputs were missing or incomplete.`
        : null;

      display.update(`[${task.id}] ${task.name}${attemptNum > 1 ? ` (attempt ${attemptNum}/${RETRY_BUDGET})` : ""}`);
      const success = await executeTask(task, buildDir, buildSpec, architecturePlan, runDir, attemptNum, previousFailure);
      progress = true;

      if (success) {
        completed.add(task.id);
      } else {
        failed.set(task.id, attemptNum);
        if (attemptNum >= RETRY_BUDGET) {
          display.log(A.red(`  [${task.id}] Retry budget exhausted after ${RETRY_BUDGET} attempts.`));
          logEvent(runDir, { phase: "build", event: "task-budget-exhausted", taskId: task.id });
        }
      }
    }
  }

  display.finish(`${completed.size}/${taskGraph.length} tasks`);

  const exhausted = taskGraph.filter((t) => (failed.get(t.id) || 0) >= RETRY_BUDGET && !completed.has(t.id));

  if (exhausted.length > 0) {
    console.error(`\nBuild blocked: ${exhausted.length} task(s) failed after ${RETRY_BUDGET} attempts.`);
    console.error(`Failed tasks: ${exhausted.map((t) => t.id).join(", ")}`);
    logEvent(runDir, { phase: "build", event: "build-blocked", failedTasks: exhausted.map((t) => t.id) });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const decision = await question(rl, "\nPress Enter to exit and inspect, or type 'continue' to proceed with partial build: ");
    rl.close();
    if (!decision.trim().toLowerCase().startsWith("continue")) {
      process.exit(1);
    }
  }

  return completed.size === taskGraph.length;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

async function runIntegration(buildDir, buildSpec, architecturePlan, runDir) {
  const reportPath = path.join(buildDir, "integration-report.md");

  if (fileExists(reportPath)) {
    console.log("Integration report found — skipping.\n");
    return;
  }

  console.log(`\n${hr()}`);
  console.log("  Phase 3: Integration");
  console.log(`${hr()}\n`);

  const srcDir = path.join(buildDir, "src");
  const sourceFiles = collectSourceFiles(srcDir);

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "integration.md"))
  );

  const userMessage = [
    `## Build Spec\n\n${buildSpec}`,
    `## Architecture Plan\n\n${architecturePlan}`,
    `## Source Files\n\n${sourceFiles}`,
    `## Working Directory\n\n${buildDir}`,
  ].join("\n\n---\n\n");

  const display = createPhaseDisplay("Build", "Integration", "3 of 6", "checking source files", { onFinish: (ms) => logTime(runDir, "Build", "Integration", ms) });
  await agentStream(systemPrompt, userMessage, buildDir, display, { onUsage: (u) => logTokens(runDir, "Build", "Integration", u) });
  const status = fileExists(path.join(buildDir, "integration-report.md"))
    ? readFile(path.join(buildDir, "integration-report.md")).match(/Status:\s*(\w+)/i)?.[1] ?? "done"
    : "done";
  display.finish(status);
  logEvent(runDir, { phase: "build", event: "integration-complete" });
}

// ---------------------------------------------------------------------------
// Copy writer + human approval
// ---------------------------------------------------------------------------

async function runCopyWriter(buildDir, buildSpec, runDir) {
  const copyApprovedPath = path.join(buildDir, "copy-approved.flag");
  if (fileExists(copyApprovedPath)) {
    console.log("Copy already approved — skipping.\n");
    return;
  }

  const copyReviewPath = path.join(buildDir, "copy-review.txt");

  if (!fileExists(copyReviewPath)) {
    const srcDir = path.join(buildDir, "src");
    const sourceFiles = collectSourceFiles(srcDir);

    const systemPrompt = buildSystemPrompt(
      readFile(SHARED_CONVENTIONS),
      readFile(SHARED_OUTPUT_FORMATS),
      readFile(path.join(AGENTS_DIR, "build", "copywriter.md"))
    );

    const userMessage = [
      `## Build Spec\n\n${buildSpec}`,
      `## Source Files\n\n${sourceFiles}`,
      `## Working Directory\n\n${buildDir}`,
    ].join("\n\n---\n\n");

    const display = createPhaseDisplay("Build", "Copy Review", "4 of 6", "collecting user-facing strings", { onFinish: (ms) => logTime(runDir, "Build", "Copy Review", ms) });
    await agentStream(systemPrompt, userMessage, buildDir, display, { onUsage: (u) => logTokens(runDir, "Build", "Copy Review", u) });
    display.finish("ready for approval");
    logEvent(runDir, { phase: "build", event: "copy-review-ready" });
  }

  // Human approval
  console.log(`\n${"=".repeat(60)}`);
  console.log("  COPY REVIEW — Approval Required");
  console.log(`${"=".repeat(60)}\n`);
  console.log(readFile(copyReviewPath));
  console.log(`\n${"=".repeat(60)}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let approved = false;

  while (!approved) {
    if (process.env.FACTORY_AUTO === "1") process.stdout.write('FACTORY_SIGNAL:{"point":"copy-review"}\n');
    const input = await question(rl, "Approve copy? (yes / no + feedback): ");
    const trimmed = input.trim().toLowerCase();

    if (trimmed === "yes" || trimmed === "y") {
      approved = true;
      writeFile(copyApprovedPath, new Date().toISOString());
      logEvent(runDir, { phase: "build", event: "copy-approved" });
    } else {
      console.log("\nFeedback noted. Revising copy...\n");

      const systemPrompt = buildSystemPrompt(
        readFile(SHARED_CONVENTIONS),
        readFile(SHARED_OUTPUT_FORMATS),
        readFile(path.join(AGENTS_DIR, "build", "copywriter.md"))
      );

      const srcDir = path.join(buildDir, "src");
      const sourceFiles = collectSourceFiles(srcDir);

      const userMessage = [
        `## Build Spec\n\n${buildSpec}`,
        `## Source Files\n\n${sourceFiles}`,
        `## Working Directory\n\n${buildDir}`,
        `## Human Feedback on Previous Review\n\n${input}`,
        `## Previous Copy Review\n\n${readFile(copyReviewPath)}`,
        "Revise the copy-review.txt based on the human feedback.",
      ].join("\n\n---\n\n");

      // Delete old copy review so agent rewrites it
      fs.unlinkSync(copyReviewPath);
      const revDisplay = createPhaseDisplay("Build", "Copy Review", "4 of 6", "revising copy", { onFinish: (ms) => logTime(runDir, "Build", "Copy Review (revision)", ms) });
      await agentStream(systemPrompt, userMessage, buildDir, revDisplay, { onUsage: (u) => logTokens(runDir, "Build", "Copy Review (revision)", u) });
      revDisplay.finish("ready for approval");
      console.log("\n" + readFile(copyReviewPath) + "\n");
    }
  }

  rl.close();
  console.log("\nCopy approved.\n");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function runVerification(buildDir, buildSpec, runDir) {
  const reportPath = path.join(buildDir, "verification-report.json");
  let previousReport = null;

  if (fileExists(reportPath)) {
    previousReport = readJSON(reportPath);
    const { passed, total, failed } = previousReport.summary;
    if (failed === 0) {
      console.log(`  Verification already complete — ${passed}/${total} passed.\n`);
      return true;
    }
    console.log(`  Resuming verification — ${failed} previously failed criteria.\n`);
  }

  // Count criteria for subtitle
  const criteriaCount = (buildSpec.match(/^\d+\./gm) || []).length;
  const subtitle = previousReport
    ? `${previousReport.summary.failed} of ${previousReport.summary.total} re-running`
    : criteriaCount > 0 ? `${criteriaCount} criteria` : "";

  const display = createPhaseDisplay("Build", "Verification", "5 of 6", subtitle, { onFinish: (ms) => logTime(runDir, "Build", "Verification", ms) });

  const srcDir = path.join(buildDir, "src");

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "verification.md"))
  );

  const failingContext = previousReport
    ? `## Previously failing criteria\n\nRun these first:\n${
        previousReport.results
          .filter((r) => r.status === "fail")
          .map((r) => `- Criterion ${r.criterionId}: ${r.description}`)
          .join("\n")
      }`
    : "";

  const userMessage = [
    `## Build Spec\n\n${buildSpec}`,
    `## Build Directory\n\n${buildDir}`,
    `## Source Directory\n\n${srcDir}`,
    `## Run Command\n\nSee Runtime Spec. For CLI artifacts: node <entry-point> [flags]`,
    failingContext,
    `## Working Directory\n\n${buildDir}`,
  ].filter(Boolean).join("\n\n---\n\n");

  await agentStream(systemPrompt, userMessage, buildDir, display, { onUsage: (u) => logTokens(runDir, "Build", "Verification", u) });

  if (!fileExists(reportPath)) {
    display.finish("no report produced");
    console.error("Verification agent did not produce a report.");
    return false;
  }

  const report = readJSON(reportPath);
  logEvent(runDir, {
    phase: "build",
    event: "verification-complete",
    passed: report.summary.passed,
    total: report.summary.total,
    failed: report.summary.failed,
  });

  if (report.summary.failed > 0) {
    display.finish(`${report.summary.failed} failed, ${report.summary.passed} passed`);
    console.log("");
    for (const r of report.results.filter((r) => r.status === "fail")) {
      console.log(`  [FAIL] Criterion ${r.criterionId}: ${r.description}`);
      console.log(`         Expected: ${r.expected}`);
      console.log(`         Observed: ${r.observed}\n`);
    }
    return false;
  }

  display.finish(`${report.summary.total}/${report.summary.total} passed`);
  return true;
}

// ---------------------------------------------------------------------------
// Verification loop with human checkpoint
// ---------------------------------------------------------------------------

async function runVerificationLoop(buildDir, buildSpecPath, runDir) {
  while (true) {
    const currentSpec = readFile(buildSpecPath);
    const passed = await runVerification(buildDir, currentSpec, runDir);
    if (passed) return;

    // Human checkpoint
    const reportPath = path.join(buildDir, "verification-report.json");
    const report = readJSON(reportPath);
    const failures = report.results.filter((r) => r.status === "fail");

    console.log(`\n${"=".repeat(60)}`);
    console.log("  VERIFICATION FAILURES — Human Input Required");
    console.log(`${"=".repeat(60)}\n`);

    for (const f of failures) {
      console.log(`  [FAIL] Criterion ${f.criterionId}: ${f.description}`);
      console.log(`         Expected: ${f.expected}`);
      console.log(`         Observed: ${f.observed}\n`);
    }

    console.log("Describe what needs to be fixed.");
    console.log("Examples:");
    console.log("  - 'Criterion 5 is wrong — HeLLo should produce UrYYb, not UryYb'");
    console.log("  - 'The ROT13 logic is broken for uppercase letters'");
    console.log("  - 'Both: criterion 5 has the wrong expected value, and criterion 7 has a code bug'\n");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const feedback = await question(rl, "Your feedback: ");
    rl.close();

    if (!feedback.trim()) {
      console.log("No feedback provided. Exiting.");
      process.exit(1);
    }

    logEvent(runDir, { phase: "build", event: "verification-human-feedback", feedback });

    await runFixAgent(buildDir, buildSpecPath, report, feedback, runDir);

    // Clear report so verification re-runs fresh
    if (fileExists(reportPath)) fs.unlinkSync(reportPath);
  }
}

async function runFixAgent(buildDir, buildSpecPath, verificationReport, humanFeedback, runDir) {
  const srcDir = path.join(buildDir, "src");
  const sourceFiles = collectSourceFiles(srcDir);
  const currentSpec = readFile(buildSpecPath);

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "fix.md"))
  );

  const userMessage = [
    `## Build Spec\n\n${currentSpec}`,
    `## Source Files\n\n${sourceFiles}`,
    `## Verification Report\n\n${JSON.stringify(verificationReport, null, 2)}`,
    `## Human Feedback\n\n${humanFeedback}`,
    `## Build Spec Path\n\n${buildSpecPath}`,
    `## Source Directory\n\n${srcDir}`,
    `## Working Directory\n\n${buildDir}`,
  ].join("\n\n---\n\n");

  const display = createPhaseDisplay("Build", "Fix", "5 of 6", "applying fixes", { onFinish: (ms) => logTime(runDir, "Build", "Fix", ms) });
  await agentStream(systemPrompt, userMessage, buildDir, display, { onUsage: (u) => logTokens(runDir, "Build", "Fix", u) });
  display.finish("fixes applied");
  logEvent(runDir, { phase: "build", event: "fix-applied", feedback: humanFeedback });
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

async function runPackager(buildDir, artifactDir, runtimeSpec, runDir) {
  const manifestPath = path.join(artifactDir, "MANIFEST.txt");

  if (fileExists(manifestPath)) {
    console.log("Artifact already packaged — skipping.\n");
    return;
  }

  fs.mkdirSync(artifactDir, { recursive: true });

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "packager.md"))
  );

  const userMessage = [
    `## Runtime Spec\n\n${runtimeSpec}`,
    `## Build Directory\n\n${buildDir}`,
    `## Artifact Directory\n\n${artifactDir}`,
    `## Working Directory\n\n${artifactDir}`,
  ].join("\n\n---\n\n");

  const display = createPhaseDisplay("Build", "Packaging", "6 of 6", "copying runtime files", { onFinish: (ms) => logTime(runDir, "Build", "Packaging", ms) });
  await agentStream(systemPrompt, userMessage, buildDir, display, { onUsage: (u) => logTokens(runDir, "Build", "Packager", u) });

  const fileCount = fileExists(manifestPath)
    ? readFile(manifestPath).split("\n").filter(Boolean).length
    : 0;
  display.finish(fileCount > 0 ? `${fileCount} files` : "done");
  logEvent(runDir, { phase: "build", event: "packaging-complete" });
}

// ---------------------------------------------------------------------------
// Incoming failure detection and fix mode
// ---------------------------------------------------------------------------

function collectIncomingFailures(runDir) {
  const failures = [];

  const reviewDir = path.join(runDir, "failure-reports");
  if (fileExists(reviewDir)) {
    for (const f of fs.readdirSync(reviewDir).filter((f) => f.endsWith(".json"))) {
      try {
        const report = readJSON(path.join(reviewDir, f));
        failures.push({ source: "review", label: `${report.scenarioReference}: ${report.scenarioName}`, report, file: path.join(reviewDir, f) });
      } catch {}
    }
  }

  const securityDir = path.join(runDir, "security-remediations", "remediation-requests.md");
  if (fileExists(securityDir)) {
    failures.push({ source: "security", label: "Security remediation requests", report: readFile(securityDir), file: securityDir });
  }

  return failures;
}

function clearStaleReviewResults(runDir) {
  const reviewDir = path.join(runDir, "review");
  const toDelete = [
    path.join(reviewDir, "scenario-reports"),
    path.join(reviewDir, "edge-case-summary.md"),
    path.join(reviewDir, "verdict-report.md"),
  ];
  for (const p of toDelete) {
    if (!fileExists(p)) continue;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) fs.rmSync(p, { recursive: true });
    else fs.unlinkSync(p);
  }
}

async function runIncomingFixMode(buildDir, buildSpecPath, incomingFailures, runDir) {
  console.log(`\n${hr()}`);
  console.log("  Fix Mode — Applying fixes from other divisions");
  console.log(`${hr()}\n`);

  const srcDir = path.join(buildDir, "src");
  const sourceFiles = collectSourceFiles(srcDir);
  const currentSpec = readFile(buildSpecPath);

  // Format failure context for the fix agent
  const failureContext = incomingFailures.map((f) => {
    const content = typeof f.report === "string" ? f.report : JSON.stringify(f.report, null, 2);
    return `### From ${f.source} division\n\n${content}`;
  }).join("\n\n---\n\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const humanNotes = await question(rl, "Any additional guidance for the fix agent? (press Enter to skip): ");
  rl.close();

  const display = createPhaseDisplay(
    "Build", "Fix Mode", "", `${incomingFailures.length} failure report(s)`,
    { onFinish: (ms) => logTime(runDir, "Build", "Fix Mode", ms) }
  );

  const systemPrompt = buildSystemPrompt(
    readFile(SHARED_CONVENTIONS),
    readFile(SHARED_OUTPUT_FORMATS),
    readFile(path.join(AGENTS_DIR, "build", "fix.md"))
  );

  const userMessage = [
    `## Build Spec\n\n${currentSpec}`,
    `## Source Files\n\n${sourceFiles}`,
    `## Failure Reports\n\n${failureContext}`,
    `## Human Notes\n\n${humanNotes || "(none)"}`,
    `## Build Spec Path\n\n${buildSpecPath}`,
    `## Source Directory\n\n${srcDir}`,
    `## Working Directory\n\n${buildDir}`,
  ].join("\n\n---\n\n");

  await agentStream(systemPrompt, userMessage, buildDir, display, { onUsage: (u) => logTokens(runDir, "Build", "Fix Mode", u) });
  display.finish("fixes applied");
  logEvent(runDir, { phase: "build", event: "incoming-fixes-applied" });

  // Mark incoming failure reports as resolved by moving them
  const resolvedDir = path.join(runDir, "resolved-failures");
  fs.mkdirSync(resolvedDir, { recursive: true });
  for (const f of incomingFailures) {
    if (fileExists(f.file)) {
      fs.renameSync(f.file, path.join(resolvedDir, path.basename(f.file)));
    }
  }

  // Re-run verification after fixes
  const reportPath = path.join(buildDir, "verification-report.json");
  if (fileExists(reportPath)) fs.unlinkSync(reportPath);
  await runVerificationLoop(buildDir, buildSpecPath, runDir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const runIdIndex = args.indexOf("--run-id");
  if (runIdIndex < 0 || !args[runIdIndex + 1]) {
    console.error("Usage: node run-build.js --run-id <id>");
    process.exit(1);
  }

  const id = args[runIdIndex + 1];
  const runDir = path.join(RUNS_DIR, id);
  const handoffDir = path.join(runDir, "handoff");
  const buildDir = path.join(runDir, "build");
  const artifactDir = path.join(runDir, "artifact");

  // Verify handoff artifacts exist
  for (const f of ["build-spec.md", "factory-manifest.json", "runtime-spec.md"]) {
    if (!fileExists(path.join(handoffDir, f))) {
      console.error(`Missing handoff artifact: ${f}`);
      console.error("Run the design division first: node run-design.js");
      process.exit(1);
    }
  }

  const buildSpec = readFile(path.join(handoffDir, "build-spec.md"));
  const runtimeSpec = readFile(path.join(handoffDir, "runtime-spec.md"));
  const factoryManifest = readJSON(path.join(handoffDir, "factory-manifest.json"));

  console.log(`\nSoftware Factory — Build Division`);
  console.log(`Run: ${id}`);
  console.log(`Project: ${factoryManifest.projectName}\n`);

  logEvent(runDir, { phase: "build", event: "start" });

  const buildSpecPath = path.join(handoffDir, "build-spec.md");

  // Check for incoming failure reports from review or security divisions.
  // If present and a prior build exists, skip straight to fix mode.
  const incomingFailures = collectIncomingFailures(runDir);
  const priorBuildExists = fileExists(path.join(buildDir, "architecture-plan.md"));

  if (incomingFailures.length > 0 && priorBuildExists) {
    console.log(`Found ${incomingFailures.length} incoming failure report(s) from other divisions.\n`);
    for (const f of incomingFailures) console.log(`  [${f.source}] ${f.label}`);
    console.log("");

    await runIncomingFixMode(buildDir, buildSpecPath, incomingFailures, runDir);

    // Delete old artifact and re-package after fixes
    const manifestPath = path.join(artifactDir, "MANIFEST.txt");
    if (fileExists(manifestPath)) fs.unlinkSync(manifestPath);
    await runPackager(buildDir, artifactDir, runtimeSpec, runDir);

    clearStaleReviewResults(runDir);

    writeTokenTable(runDir);
    writeTimeTable(runDir);
    console.log(`\n${hr()}`);
    console.log("  Build Division complete (fixes applied).");
    console.log(`  Run: ${id}`);
    console.log(`  Artifact: runs/${id}/artifact/`);
    console.log(`${hr()}\n`);
    console.log("Proceed to review: node run-review.js --run-id " + id + "\n");
    logEvent(runDir, { phase: "build", event: "build-division-complete", mode: "fix" });
    return;
  }

  // Phase 1: Architect interview
  const { architecturePlan, taskGraph } = await runArchitectInterview(runDir, buildSpec, factoryManifest);

  // Phase 2: Task execution
  await runTaskGraph(taskGraph, buildDir, buildSpec, architecturePlan, runDir);

  // Phase 3: Integration
  await runIntegration(buildDir, buildSpec, architecturePlan, runDir);

  // Phase 4: Copy writer + human approval
  await runCopyWriter(buildDir, buildSpec, runDir);

  // Phase 5: Verification with human-in-the-loop checkpoint
  await runVerificationLoop(buildDir, buildSpecPath, runDir);

  // Phase 6: Packaging
  await runPackager(buildDir, artifactDir, runtimeSpec, runDir);

  clearStaleReviewResults(runDir);

  writeTokenTable(runDir);
  writeTimeTable(runDir);
  console.log(`\n${hr()}`);
  console.log("  Build Division complete.");
  console.log(`  Run: ${id}`);
  console.log(`  Artifact: runs/${id}/artifact/`);
  console.log(`${hr()}\n`);
  console.log("Proceed to review: node run-review.js --run-id " + id + "\n");

  logEvent(runDir, { phase: "build", event: "build-division-complete" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * inspect.js — Run state inspector.
 *
 * Infers phase completion from the filesystem and summarises token usage
 * and any pending action items (failure reports, security remediations).
 *
 * Usage:
 *   node inspect.js <run-id>   # detailed view for one run
 *   node inspect.js            # list all runs with brief status
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { A } = require("./display");

const RUNS_DIR = path.join(__dirname, "runs");

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function dirFiles(p, ext) {
  if (!fileExists(p)) return [];
  return fs.readdirSync(p).filter((f) => f.endsWith(ext));
}

// ---------------------------------------------------------------------------
// Per-division status inference
// ---------------------------------------------------------------------------

function designStatus(runDir) {
  if (fileExists(path.join(runDir, "handoff", "build-spec.md"))) {
    return { status: "complete", detail: "specs generated" };
  }
  if (fileExists(path.join(runDir, "clarification-transcript.md"))) {
    return { status: "in-progress", detail: "spec generation pending" };
  }
  if (fileExists(path.join(runDir, "experience-transcript.md"))) {
    return { status: "in-progress", detail: "consistency check pending" };
  }
  if (fileExists(path.join(runDir, "functional-transcript.md"))) {
    return { status: "in-progress", detail: "experience interview pending" };
  }
  return { status: "not-started" };
}

function buildStatus(runDir) {
  const buildDir = path.join(runDir, "build");
  const artifactDir = path.join(runDir, "artifact");

  if (!fileExists(path.join(buildDir, "architecture-plan.md"))) {
    return { status: "not-started" };
  }

  // Task summary
  const taskGraphPath = path.join(buildDir, "task-graph.json");
  let taskSummary = "";
  if (fileExists(taskGraphPath)) {
    const graph = readJSON(taskGraphPath);
    const done = graph.filter((t) => {
      const sp = path.join(buildDir, `task-${t.id}-status.json`);
      return fileExists(sp) && readJSON(sp).status === "complete";
    }).length;
    taskSummary = `${done}/${graph.length} tasks`;
  }

  if (fileExists(path.join(artifactDir, "MANIFEST.txt"))) {
    const pending = pendingActionItems(runDir);
    const note = pending.length > 0 ? ` · ${pending.length} fix(es) pending` : "";
    return { status: "complete", detail: `${taskSummary} · packaged${note}` };
  }
  if (fileExists(path.join(buildDir, "verification-report.json"))) {
    const r = readJSON(path.join(buildDir, "verification-report.json"));
    return { status: "in-progress", detail: `${taskSummary} · ${r.summary.passed}/${r.summary.total} verified · packaging pending` };
  }
  if (fileExists(path.join(buildDir, "copy-approved.flag"))) {
    return { status: "in-progress", detail: `${taskSummary} · copy approved · verification pending` };
  }
  if (fileExists(path.join(buildDir, "copy-review.txt"))) {
    return { status: "in-progress", detail: `${taskSummary} · copy review awaiting approval` };
  }
  if (fileExists(path.join(buildDir, "integration-report.md"))) {
    return { status: "in-progress", detail: `${taskSummary} · integrated · copy review pending` };
  }
  return { status: "in-progress", detail: taskSummary || "tasks running" };
}

function reviewStatus(runDir) {
  const reviewDir = path.join(runDir, "review");
  if (!fileExists(reviewDir)) return { status: "not-started" };

  const verdictPath = path.join(reviewDir, "verdict-report.md");
  if (fileExists(verdictPath)) {
    const raw = readText(verdictPath).match(/^#\s*Verdict:\s*(\S.*)/im)?.[1] ?? "done";
    const isNoShip = /no.?ship/i.test(raw);
    const pending = pendingActionItems(runDir).filter((p) => p.source === "review");
    const note = pending.length > 0 ? ` · ${pending.length} failure(s) pending build fix` : "";
    return { status: isNoShip ? "no-ship" : "ship", detail: `${raw}${note}` };
  }
  if (fileExists(path.join(reviewDir, "edge-case-summary.md"))) {
    return { status: "in-progress", detail: "verdict pending" };
  }
  const reportsDir = path.join(reviewDir, "scenario-reports");
  if (fileExists(reportsDir)) {
    const done = dirFiles(reportsDir, ".json").length;
    const coverageMap = path.join(reviewDir, "coverage-map.json");
    const total = fileExists(coverageMap) ? (readJSON(coverageMap).scenarios?.length ?? "?") : "?";
    return { status: "in-progress", detail: `${done}/${total} scenarios · edge cases pending` };
  }
  if (fileExists(path.join(reviewDir, "coverage-map.json"))) {
    return { status: "in-progress", detail: "scenario exploration pending" };
  }
  return { status: "in-progress", detail: "scenario analysis running" };
}

function securityStatus(runDir) {
  const secDir = path.join(runDir, "security");
  if (!fileExists(secDir)) return { status: "not-started" };

  const verdictPath = path.join(secDir, "security-verdict-report.md");
  if (fileExists(verdictPath)) {
    const raw = readText(verdictPath).match(/^#\s*Security Verdict:\s*(\S.*)/im)?.[1] ?? "done";
    const isBlock = /block/i.test(raw);
    const hasRem = fileExists(path.join(runDir, "security-remediations", "remediation-requests.md"));
    const note = hasRem ? " · remediations pending build fix" : "";
    return { status: isBlock ? "blocked" : "approved", detail: `${raw}${note}` };
  }
  if (fileExists(path.join(secDir, "dynamic-test-report.md"))) {
    return { status: "in-progress", detail: "verdict pending" };
  }
  if (fileExists(path.join(secDir, "approved-test-plan.json"))) {
    return { status: "in-progress", detail: "dynamic testing running" };
  }
  if (fileExists(path.join(secDir, "static-analysis-report.md"))) {
    return { status: "in-progress", detail: "dynamic test planning pending" };
  }
  return { status: "in-progress", detail: "static analysis running" };
}

// ---------------------------------------------------------------------------
// Pending action items
// ---------------------------------------------------------------------------

function pendingActionItems(runDir) {
  const items = [];

  const failDir = path.join(runDir, "failure-reports");
  for (const f of dirFiles(failDir, ".json")) {
    try {
      const r = readJSON(path.join(failDir, f));
      items.push({ source: "review", label: `${r.scenarioReference}: ${r.scenarioName}`, severity: r.severity ?? "blocking" });
    } catch { /* skip malformed */ }
  }

  if (fileExists(path.join(runDir, "security-remediations", "remediation-requests.md"))) {
    items.push({ source: "security", label: "see security-remediations/remediation-requests.md", severity: "blocking" });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

function tokenSummary(runDir) {
  const logPath = path.join(runDir, "token-usage.jsonl");
  if (!fileExists(logPath)) return null;

  const entries = fs.readFileSync(logPath, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (entries.length === 0) return null;

  const byPhase = {};
  let totIn = 0, totOut = 0, totRead = 0;

  for (const e of entries) {
    if (!byPhase[e.phase]) byPhase[e.phase] = { input: 0, output: 0, cacheRead: 0, agents: [] };
    byPhase[e.phase].input     += e.input;
    byPhase[e.phase].output    += e.output;
    byPhase[e.phase].cacheRead += e.cacheRead;
    byPhase[e.phase].agents.push({ label: e.label, input: e.input, output: e.output, cacheRead: e.cacheRead });
    totIn   += e.input;
    totOut  += e.output;
    totRead += e.cacheRead;
  }

  return { byPhase, totIn, totOut, totRead };
}

// ---------------------------------------------------------------------------
// Time usage
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function timeSummary(runDir) {
  const logPath = path.join(runDir, "time-usage.jsonl");
  if (!fileExists(logPath)) return null;

  const entries = fs.readFileSync(logPath, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (entries.length === 0) return null;

  const byPhase = {};
  let totMs = 0;

  for (const e of entries) {
    if (!byPhase[e.phase]) byPhase[e.phase] = { total: 0, agents: [] };
    byPhase[e.phase].total += e.elapsedMs;
    byPhase[e.phase].agents.push({ label: e.label, ms: e.elapsedMs });
    totMs += e.elapsedMs;
  }

  return { byPhase, totMs };
}

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

function readDecisionLog(runDir) {
  const logPath = path.join(runDir, "decision-log.jsonl");
  if (!fileExists(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const STATUS_ICON = {
  complete:    A.green("✓"),
  ship:        A.green("✓"),
  approved:    A.green("✓"),
  "no-ship":   A.red("✗"),
  blocked:     A.red("✗"),
  "in-progress": A.yellow("◌"),
  "not-started": A.dim("—"),
};

function icon(status) { return STATUS_ICON[status] ?? A.dim("?"); }
function col(s, w)    { return String(s).padEnd(w); }
function n(v)         { return v.toLocaleString("en-US"); }

// ---------------------------------------------------------------------------
// Detailed view
// ---------------------------------------------------------------------------

function inspectRun(id, detail = false) {
  const runDir = path.join(RUNS_DIR, id);
  if (!fileExists(runDir)) {
    console.error(`Run not found: ${id}`);
    process.exit(1);
  }

  const manifestPath = path.join(runDir, "handoff", "factory-manifest.json");
  const manifest = fileExists(manifestPath) ? readJSON(manifestPath) : null;

  console.log("");
  console.log(`${A.bold("Software Factory")} — Run Inspector`);
  console.log(`Run:     ${A.cyan(id)}`);
  if (manifest?.projectName) console.log(`Project: ${manifest.projectName}`);
  console.log("");

  const divisions = [
    { name: "Design",   state: designStatus(runDir)   },
    { name: "Build",    state: buildStatus(runDir)     },
    { name: "Review",   state: reviewStatus(runDir)    },
    { name: "Security", state: securityStatus(runDir)  },
  ];

  for (const { name, state } of divisions) {
    const note = state.detail ? `  ${A.dim(state.detail)}` : "";
    console.log(`  ${icon(state.status)}  ${col(name, 10)}${col(state.status, 12)}${note}`);
  }

  // Token usage
  const tokens = tokenSummary(runDir);
  if (tokens) {
    console.log("");
    console.log(A.dim("  Token usage"));
    for (const [phase, p] of Object.entries(tokens.byPhase)) {
      console.log(`  ${A.dim("·")}  ${col(phase, 10)}${col(n(p.input) + " in", 14)}/ ${col(n(p.output) + " out", 14)}/ ${n(p.cacheRead)} cache`);
      if (detail) {
        for (const a of p.agents) {
          console.log(`       ${A.dim(col(a.label, 28))}${A.dim(col(n(a.input) + " in", 12))}/ ${A.dim(col(n(a.output) + " out", 12))}/ ${A.dim(n(a.cacheRead) + " cache")}`);
        }
      }
    }
    console.log(`     ${col("Total", 10)}${A.bold(col(n(tokens.totIn) + " in", 14))}/ ${A.bold(n(tokens.totOut) + " out")}`);
  }

  // Time usage
  const times = timeSummary(runDir);
  if (times) {
    console.log("");
    console.log(A.dim("  Time per phase"));
    for (const [phase, p] of Object.entries(times.byPhase)) {
      console.log(`  ${A.dim("·")}  ${col(phase, 10)}${fmtMs(p.total)}`);
      if (detail) {
        for (const a of p.agents) {
          console.log(`       ${A.dim(col(a.label, 28))}${A.dim(fmtMs(a.ms))}`);
        }
      }
    }
    console.log(`     ${col("Total", 10)}${A.bold(fmtMs(times.totMs))}`);
  }

  // Decision log
  const decisions = readDecisionLog(runDir);
  if (decisions.length > 0) {
    const overrides = decisions.filter((d) => d.humanOverride).length;
    console.log("");
    console.log(A.dim(`  Orchestrator decisions  (${decisions.length} auto${overrides > 0 ? `, ${overrides} overridden` : ""})`));
    for (const d of decisions) {
      const time = new Date(d.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const override = d.humanOverride ? A.yellow(" [overridden]") : "";
      const decisionColor = /approve|accept|pass|ship/i.test(d.decision) ? A.green(d.decision) : A.red(d.decision);
      console.log(`  ${A.dim("·")}  ${A.dim(time)}  ${col(d.decisionPoint, 18)}${decisionColor}${override}`);
      if (d.reasoning) {
        const summary = d.reasoning.split(/[.\n]/)[0].trim().slice(0, 100);
        console.log(`          ${A.dim("↳ " + summary)}`);
      }
    }
  }

  // Pending action items
  const pending = pendingActionItems(runDir);
  if (pending.length > 0) {
    console.log("");
    console.log(A.yellow("  Pending action items"));
    for (const item of pending) {
      const sev = item.severity === "blocking" ? A.red(`[${item.severity}]`) : A.yellow(`[${item.severity}]`);
      console.log(`  ${A.dim("↳")} ${sev} ${A.dim(item.source + ":")} ${item.label}`);
    }
    console.log("");
    console.log(`  ${A.dim("To apply fixes:")} node run-build.js --run-id ${id}`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function listRuns() {
  if (!fileExists(RUNS_DIR)) {
    console.log("No runs directory found.");
    return;
  }

  const ids = fs.readdirSync(RUNS_DIR)
    .filter((f) => fs.statSync(path.join(RUNS_DIR, f)).isDirectory())
    .sort();

  if (ids.length === 0) {
    console.log("No runs found.");
    return;
  }

  console.log("");
  console.log(`${A.bold("Software Factory")} — All Runs`);
  console.log(A.dim(`  ${"D  B  R  S".padEnd(12)}Run ID       Project`));
  console.log("");

  for (const id of ids) {
    const runDir = path.join(RUNS_DIR, id);
    const manifestPath = path.join(runDir, "handoff", "factory-manifest.json");
    const projectName = fileExists(manifestPath) ? (readJSON(manifestPath).projectName ?? "") : "";

    const icons = [designStatus, buildStatus, reviewStatus, securityStatus]
      .map((fn) => icon(fn(runDir).status))
      .join("  ");

    const project = projectName ? `  ${A.dim(projectName)}` : "";
    console.log(`  ${icons}  ${A.cyan(id)}${project}`);
  }

  console.log("");
  console.log(A.dim("  D = Design  B = Build  R = Review  S = Security"));
  console.log(A.dim("  node inspect.js <run-id> for details"));
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const detail = args.includes("--detail") || args.includes("-d");
const id = args.find((a) => !a.startsWith("-"));
if (id) inspectRun(id, detail);
else listRuns();

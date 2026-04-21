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

function readRunMeta(runDir) {
  const p = path.join(runDir, "run-meta.json");
  if (!fileExists(p)) return null;
  try { return readJSON(p); } catch { return null; }
}

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
  const meta = readRunMeta(runDir);

  console.log("");
  console.log(`${A.bold("Software Factory")} — Run Inspector`);
  console.log(`Run:     ${A.cyan(id)}${meta?.tag ? `  ·  ${A.bold(meta.tag)}` : ""}`);
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

    const meta = readRunMeta(runDir);
    const tagStr = meta?.tag ? `  ${A.bold(meta.tag)}` : "";
    const project = projectName ? `  ${A.dim(projectName)}` : "";
    console.log(`  ${icons}  ${A.cyan(id)}${tagStr}${project}`);
  }

  console.log("");
  console.log(A.dim("  D = Design  B = Build  R = Review  S = Security"));
  console.log(A.dim("  node inspect.js <run-id> for details"));
  console.log("");
}

// ---------------------------------------------------------------------------
// Run comparison
// ---------------------------------------------------------------------------

function compareRuns(id1, id2, detail = false) {
  const runDir1 = path.join(RUNS_DIR, id1);
  const runDir2 = path.join(RUNS_DIR, id2);

  for (const [id, dir] of [[id1, runDir1], [id2, runDir2]]) {
    if (!fileExists(dir)) { console.error(`Run not found: ${id}`); process.exit(1); }
  }

  function projectName(dir) {
    const p = path.join(dir, "handoff", "factory-manifest.json");
    return fileExists(p) ? (readJSON(p).projectName ?? "") : "";
  }

  const proj1 = projectName(runDir1);
  const proj2 = projectName(runDir2);
  const meta1 = readRunMeta(runDir1);
  const meta2 = readRunMeta(runDir2);

  function runLabel(id, proj, meta) {
    const tag = meta?.tag ? `  ${A.bold(meta.tag)}` : "";
    const p = proj ? `  ${A.dim(proj)}` : "";
    return `${A.cyan(id)}${tag}${p}`;
  }

  console.log("");
  console.log(`${A.bold("Software Factory")} — Run Comparison`);
  console.log(`  ${runLabel(id1, proj1, meta1)}  →  ${runLabel(id2, proj2, meta2)}`);

  function deltaStr(a, b, fmtFn) {
    if (a == null || b == null) return A.dim("—");
    const d = b - a;
    const pct = a > 0 ? Math.round((d / a) * 100) : 0;
    const sign = d > 0 ? "+" : "";
    const str = `${sign}${fmtFn(d)}  ${sign}${pct}%`;
    return d < 0 ? A.green(str) : d > 0 ? A.red(str) : A.dim(str);
  }

  // Token comparison (output tokens only — the primary metric)
  const tok1 = tokenSummary(runDir1);
  const tok2 = tokenSummary(runDir2);
  if (tok1 || tok2) {
    console.log("");
    console.log(A.dim("  Output tokens") + A.dim(`${" ".repeat(18)}${col(id1.slice(0, 8), 12)}${col(id2.slice(0, 8), 12)}delta`));

    const phases = [...new Set([
      ...Object.keys(tok1?.byPhase ?? {}),
      ...Object.keys(tok2?.byPhase ?? {}),
    ])];

    for (const phase of phases) {
      const v1 = tok1?.byPhase[phase]?.output ?? null;
      const v2 = tok2?.byPhase[phase]?.output ?? null;
      const c1 = v1 != null ? col(n(v1), 12) : col("—", 12);
      const c2 = v2 != null ? col(n(v2), 12) : col("—", 12);
      console.log(`  ${A.dim("·")}  ${col(phase, 10)}${A.dim(c1)}${A.dim(c2)}${deltaStr(v1, v2, (d) => n(Math.abs(d)))}`);

      if (detail) {
        const agents1 = Object.fromEntries((tok1?.byPhase[phase]?.agents ?? []).map((a) => [a.label, a.output]));
        const agents2 = Object.fromEntries((tok2?.byPhase[phase]?.agents ?? []).map((a) => [a.label, a.output]));
        const labels = [...new Set([...Object.keys(agents1), ...Object.keys(agents2)])];
        for (const label of labels) {
          const a1 = agents1[label] ?? null;
          const a2 = agents2[label] ?? null;
          const ac1 = a1 != null ? col(n(a1), 12) : col("—", 12);
          const ac2 = a2 != null ? col(n(a2), 12) : col("—", 12);
          console.log(`       ${A.dim(col(label, 28))}${A.dim(ac1)}${A.dim(ac2)}${A.dim(deltaStr(a1, a2, (d) => n(Math.abs(d))))}`);
        }
      }
    }

    const t1 = tok1?.totOut ?? null;
    const t2 = tok2?.totOut ?? null;
    const tc1 = t1 != null ? col(n(t1), 12) : col("—", 12);
    const tc2 = t2 != null ? col(n(t2), 12) : col("—", 12);
    console.log(`     ${col("Total", 10)}${A.bold(tc1)}${A.bold(tc2)}${deltaStr(t1, t2, (d) => n(Math.abs(d)))}`);
  }

  // Time comparison
  const tim1 = timeSummary(runDir1);
  const tim2 = timeSummary(runDir2);
  if (tim1 || tim2) {
    console.log("");
    console.log(A.dim("  Time") + A.dim(`${" ".repeat(25)}${col(id1.slice(0, 8), 12)}${col(id2.slice(0, 8), 12)}delta`));

    const phases = [...new Set([
      ...Object.keys(tim1?.byPhase ?? {}),
      ...Object.keys(tim2?.byPhase ?? {}),
    ])];

    for (const phase of phases) {
      const v1 = tim1?.byPhase[phase]?.total ?? null;
      const v2 = tim2?.byPhase[phase]?.total ?? null;
      const c1 = v1 != null ? col(fmtMs(v1), 12) : col("—", 12);
      const c2 = v2 != null ? col(fmtMs(v2), 12) : col("—", 12);
      console.log(`  ${A.dim("·")}  ${col(phase, 10)}${A.dim(c1)}${A.dim(c2)}${deltaStr(v1, v2, (d) => fmtMs(Math.abs(d)))}`);

      if (detail) {
        const agents1 = Object.fromEntries((tim1?.byPhase[phase]?.agents ?? []).map((a) => [a.label, a.ms]));
        const agents2 = Object.fromEntries((tim2?.byPhase[phase]?.agents ?? []).map((a) => [a.label, a.ms]));
        const labels = [...new Set([...Object.keys(agents1), ...Object.keys(agents2)])];
        for (const label of labels) {
          const a1 = agents1[label] ?? null;
          const a2 = agents2[label] ?? null;
          const ac1 = a1 != null ? col(fmtMs(a1), 12) : col("—", 12);
          const ac2 = a2 != null ? col(fmtMs(a2), 12) : col("—", 12);
          console.log(`       ${A.dim(col(label, 28))}${A.dim(ac1)}${A.dim(ac2)}${A.dim(deltaStr(a1, a2, (d) => fmtMs(Math.abs(d))))}`);
        }
      }
    }

    const t1 = tim1?.totMs ?? null;
    const t2 = tim2?.totMs ?? null;
    const tc1 = t1 != null ? col(fmtMs(t1), 12) : col("—", 12);
    const tc2 = t2 != null ? col(fmtMs(t2), 12) : col("—", 12);
    console.log(`     ${col("Total", 10)}${A.bold(tc1)}${A.bold(tc2)}${deltaStr(t1, t2, (d) => fmtMs(Math.abs(d)))}`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Trend view
// ---------------------------------------------------------------------------

function trendView(limit, detail = false) {
  if (!fileExists(RUNS_DIR)) { console.log("No runs directory found."); return; }

  let ids = fs.readdirSync(RUNS_DIR)
    .filter((f) => fs.statSync(path.join(RUNS_DIR, f)).isDirectory())
    .sort();

  if (ids.length === 0) { console.log("No runs found."); return; }

  function runStartTime(runDir) {
    const logPath = path.join(runDir, "log.jsonl");
    if (!fileExists(logPath)) return null;
    const first = fs.readFileSync(logPath, "utf8").trim().split("\n").find(Boolean);
    try { return new Date(JSON.parse(first).ts); } catch { return null; }
  }

  ids.sort((a, b) => {
    const ta = runStartTime(path.join(RUNS_DIR, a));
    const tb = runStartTime(path.join(RUNS_DIR, b));
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return ta - tb;
  });

  if (limit) ids = ids.slice(-limit);

  function loopCount(runDir) {
    const logPath = path.join(runDir, "log.jsonl");
    if (!fileExists(logPath)) return 1;
    const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return 1 + entries.filter((e) => e.event === "loop-back" && e.from === "review").length;
  }

  const TAG_W = 20;

  const rows = ids.map((id) => {
    const runDir   = path.join(RUNS_DIR, id);
    const meta     = readRunMeta(runDir);
    const tokens   = tokenSummary(runDir);
    const times    = timeSummary(runDir);
    const revSt    = reviewStatus(runDir);
    const divIcons = [designStatus, buildStatus, reviewStatus, securityStatus]
      .map((fn) => icon(fn(runDir).status)).join("  ");
    const verdict  = revSt.status === "ship" ? "SHIP"
      : revSt.status === "no-ship" ? "NO-SHIP"
      : revSt.status === "not-started" ? "—"
      : "pending";
    return { id, divIcons, tag: meta?.tag ?? "", startTime: runStartTime(runDir),
             totOut: tokens?.totOut ?? null, totMs: times?.totMs ?? null,
             tokensByPhase: tokens?.byPhase ?? {}, timesByPhase: times?.byPhase ?? {},
             verdict, loops: loopCount(runDir) };
  });

  console.log("");
  console.log(`${A.bold("Software Factory")} — Run Trend  (${ids.length} run${ids.length === 1 ? "" : "s"})`);
  console.log("");
  console.log(A.dim(`  ${"D  B  R  S".padEnd(12)}${"Run".padEnd(10)}${"Tag".padEnd(TAG_W + 2)}${"Date".padEnd(14)}${"Tokens".padStart(9)}  ${"Time".padEnd(8)}Verdict`));
  console.log("");

  for (const r of rows) {
    const dateStr = r.startTime
      ? r.startTime.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
        r.startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "—";
    const tokStr    = r.totOut != null ? n(r.totOut).padStart(9) : "        —";
    const timeStr   = r.totMs  != null ? fmtMs(r.totMs) : "—";
    const loopStr   = r.loops > 1 ? A.yellow(` ×${r.loops}`) : "";
    const tagPadded = r.tag ? r.tag.slice(0, TAG_W).padEnd(TAG_W) : " ".repeat(TAG_W);
    const verdictStr = r.verdict === "SHIP"    ? A.green("SHIP")
      : r.verdict === "NO-SHIP" ? A.red("NO-SHIP")
      : A.dim(r.verdict);

    console.log(`  ${r.divIcons}  ${A.cyan(r.id.slice(0, 8))}  ${A.bold(tagPadded)}  ${A.dim(col(dateStr, 14))}${A.dim(tokStr)}  ${A.dim(col(timeStr, 8))}${verdictStr}${loopStr}`);
  }

  // Summary stats
  const completed  = rows.filter((r) => r.verdict === "SHIP" || r.verdict === "NO-SHIP");
  const shipped    = completed.filter((r) => r.verdict === "SHIP");
  const multiLoop  = rows.filter((r) => r.loops > 1);
  const withTokens = rows.filter((r) => r.totOut != null);
  const withTime   = rows.filter((r) => r.totMs  != null);

  console.log("");
  if (completed.length > 0) {
    const pct = Math.round((shipped.length / completed.length) * 100);
    const loopNote = multiLoop.length > 0 ? A.dim(`  ·  ${multiLoop.length} needed multiple loops`) : "";
    console.log(`  ${A.dim("Ship rate:")}   ${A.bold(`${shipped.length}/${completed.length}`)}  ${A.dim(`(${pct}%)`)}${loopNote}`);
  }
  if (withTokens.length > 0) {
    const avg   = Math.round(withTokens.reduce((s, r) => s + r.totOut, 0) / withTokens.length);
    const best  = Math.min(...withTokens.map((r) => r.totOut));
    const worst = Math.max(...withTokens.map((r) => r.totOut));
    console.log(`  ${A.dim("Avg tokens:")}  ${A.bold(n(avg))}  ${A.dim(`best ${n(best)}  ·  worst ${n(worst)}`)}`);
    if (detail) {
      const phases = [...new Set(rows.flatMap((r) => Object.keys(r.tokensByPhase)))];
      for (const phase of phases) {
        const vals = rows.map((r) => r.tokensByPhase[phase]?.output).filter((v) => v != null);
        if (vals.length === 0) continue;
        const pavg  = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
        const pbest = Math.min(...vals);
        const pworst = Math.max(...vals);
        console.log(`    ${A.dim(col(phase, 12))}${A.dim(`avg ${n(pavg).padStart(7)}  best ${n(pbest).padStart(7)}  ·  worst ${n(pworst)}`)}`);
      }
    }
  }
  if (withTime.length > 0) {
    const avg   = Math.round(withTime.reduce((s, r) => s + r.totMs, 0) / withTime.length);
    const best  = Math.min(...withTime.map((r) => r.totMs));
    const worst = Math.max(...withTime.map((r) => r.totMs));
    console.log(`  ${A.dim("Avg time:")}    ${A.bold(fmtMs(avg))}  ${A.dim(`best ${fmtMs(best)}  ·  worst ${fmtMs(worst)}`)}`);
    if (detail) {
      const phases = [...new Set(rows.flatMap((r) => Object.keys(r.timesByPhase)))];
      for (const phase of phases) {
        const vals = rows.map((r) => r.timesByPhase[phase]?.total).filter((v) => v != null);
        if (vals.length === 0) continue;
        const pavg  = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
        const pbest = Math.min(...vals);
        const pworst = Math.max(...vals);
        console.log(`    ${A.dim(col(phase, 12))}${A.dim(`avg ${fmtMs(pavg).padStart(6)}  best ${fmtMs(pbest).padStart(6)}  ·  worst ${fmtMs(pworst)}`)}`);
      }
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const detail = args.includes("--detail") || args.includes("-d");
const trend  = args.includes("--trend");
const positional = args.filter((a) => !a.startsWith("-"));

if (trend) {
  const limit = positional.length > 0 ? parseInt(positional[0], 10) : null;
  trendView(isNaN(limit) ? null : limit, detail);
} else if (positional.length >= 2) {
  compareRuns(positional[0], positional[1], detail);
} else if (positional.length === 1) {
  inspectRun(positional[0], detail);
} else {
  listRuns();
}

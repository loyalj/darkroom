#!/usr/bin/env node

/**
 * GUI server for the Dark Software Factory.
 *
 * Serves a web dashboard that watches run directories and streams live
 * factory progress to the browser via SSE. The factory itself is unchanged —
 * this process just observes the filesystem.
 *
 * Usage:
 *   node run-gui.js [--port 4242]
 */

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const RUNS_DIR = path.join(__dirname, "runs");
const PUBLIC_DIR = path.join(__dirname, "public");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 4242;

const app = express();
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim());
}

function parseJsonLines(filePath) {
  return readLines(filePath).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

function allRunIds() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function runMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "run-meta.json"), "utf8")); } catch { return null; }
}

function readBudgetLimit(dir) {
  try {
    const runCfg = path.join(dir, "run-config.json");
    if (fs.existsSync(runCfg)) {
      const cfg = JSON.parse(fs.readFileSync(runCfg, "utf8"));
      if (cfg.tokenLimit != null && cfg.tokenLimit !== 0) return { limit: cfg.tokenLimit, source: "run brain" };
      if (cfg.tokenLimit === 0) return { limit: null, source: null };
    }
  } catch {}
  try {
    const brainCfg = path.join(__dirname, "brain-config.json");
    if (fs.existsSync(brainCfg)) {
      const cfg = JSON.parse(fs.readFileSync(brainCfg, "utf8"));
      if (cfg.tokenLimitPerRun != null) return { limit: cfg.tokenLimitPerRun, source: "global brain" };
    }
  } catch {}
  return { limit: null, source: null };
}

function runSummary(id) {
  const dir = path.join(RUNS_DIR, id);
  const logEvents = parseJsonLines(path.join(dir, "log.jsonl"));
  const tokens = parseJsonLines(path.join(dir, "token-usage.jsonl"));
  const times = parseJsonLines(path.join(dir, "time-usage.jsonl"));
  const meta = runMeta(dir);

  const startEvent = logEvents.find((e) => e.phase === "factory" && e.event === "start");
  const lastEvent = logEvents[logEvents.length - 1];
  const complete = logEvents.some((e) => e.event === "pipeline-complete");
  const shipped = logEvents.some((e) => e.event === "ship-approved");
  const blocked = logEvents.some((e) => e.event === "ship-blocked");
  const secApproved = logEvents.some((e) => e.event === "security-approved");
  const secBlocked = logEvents.some((e) => e.event === "security-blocked");

  let verdict = "running";
  if (complete) {
    if (secBlocked) verdict = "blocked";
    else if (secApproved && shipped) verdict = "shipped";
    else if (blocked) verdict = "blocked";
    else verdict = "complete";
  }

  const totalTokens = tokens.reduce((s, t) => s + (t.input || 0) + (t.output || 0), 0);
  const totalMs = times.reduce((s, t) => s + (t.durationMs || 0), 0);

  return {
    id,
    tag: meta?.tag ?? null,
    startTs: startEvent?.ts ?? lastEvent?.ts ?? null,
    verdict,
    totalTokens,
    totalMs,
    eventCount: logEvents.length,
    lastEvent: lastEvent ?? null,
  };
}

function runDetail(id) {
  const dir = path.join(RUNS_DIR, id);
  const logEvents = parseJsonLines(path.join(dir, "log.jsonl"));
  const tokens = parseJsonLines(path.join(dir, "token-usage.jsonl"));
  const times = parseJsonLines(path.join(dir, "time-usage.jsonl"));
  const decisions = parseJsonLines(path.join(dir, "decision-log.jsonl"));
  const meta = runMeta(dir);
  const { limit: tokenLimit, source: tokenLimitSource } = readBudgetLimit(dir);
  return { id, meta, logEvents, tokens, times, decisions, tokenLimit, tokenLimitSource };
}

// Build the viewable file manifest for a run directory.
// Returns an array of { label, files: [{ key, label, relPath, type, ext? }] }
function getRunFiles(runDir) {
  const knownCategories = [
    {
      label: "Transcripts",
      files: [
        { key: "transcript-functional",    label: "Functional",   relPath: "functional-transcript.md",   type: "transcript" },
        { key: "transcript-experience",    label: "Experience",   relPath: "experience-transcript.md",   type: "transcript" },
        { key: "transcript-clarification", label: "Clarification",relPath: "clarification-transcript.md",type: "transcript" },
        { key: "transcript-architect",     label: "Architect",    relPath: "architect-transcript.md",    type: "transcript" },
      ],
    },
    {
      label: "Specs",
      files: [
        { key: "spec-run-brain",  label: "Run Brain",   relPath: "run-brain.md",              type: "markdown" },
        { key: "spec-build",      label: "Build Spec",  relPath: "handoff/build-spec.md",     type: "markdown" },
        { key: "spec-review",     label: "Review Spec", relPath: "handoff/review-spec.md",    type: "markdown" },
        { key: "spec-runtime",    label: "Runtime Spec",relPath: "handoff/runtime-spec.md",   type: "markdown" },
        { key: "spec-arch-plan",  label: "Arch Plan",   relPath: "build/architecture-plan.md",type: "markdown" },
      ],
    },
    {
      label: "Reports",
      files: [
        { key: "report-copy",       label: "Copy Review",      relPath: "build/copy-review.txt",                    type: "text" },
        { key: "report-integration",label: "Integration",      relPath: "build/integration-report.md",              type: "markdown" },
        { key: "report-verdict",    label: "Review Verdict",   relPath: "review/verdict-report.md",                 type: "markdown" },
        { key: "report-edge-cases", label: "Edge Cases",       relPath: "review/edge-case-summary.md",              type: "markdown" },
        { key: "report-static",     label: "Static Analysis",  relPath: "security/static-analysis-report.md",       type: "markdown" },
        { key: "report-dynamic",    label: "Dynamic Tests",    relPath: "security/dynamic-test-report.md",          type: "markdown" },
        { key: "report-security",   label: "Security Verdict", relPath: "security/security-verdict-report.md",      type: "markdown" },
      ],
    },
  ];

  const result = [];

  for (const cat of knownCategories) {
    const existing = cat.files.filter((f) => fs.existsSync(path.join(runDir, f.relPath)));
    if (existing.length > 0) result.push({ label: cat.label, files: existing });
  }

  // Walk artifact directory for built source files
  const artifactDir = path.join(runDir, "artifact");
  if (fs.existsSync(artifactDir)) {
    const artifactFiles = [];
    function walkArtifact(dir, base) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { walkArtifact(path.join(dir, entry.name), rel); continue; }
        if (entry.name === "MANIFEST.txt") continue;
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        artifactFiles.push({
          key: `artifact-${rel.replace(/[/\\]/g, "-")}`,
          label: rel,
          relPath: `artifact/${rel}`,
          type: "code",
          ext,
        });
      }
    }
    walkArtifact(artifactDir, "");
    if (artifactFiles.length > 0) result.push({ label: "Artifact", files: artifactFiles });
  }

  return result;
}

// Derive pipeline state from log events.
function deriveState(logEvents) {
  const phases = { design: "pending", build: "pending", review: "pending", security: "pending" };
  let currentStep = "Initializing";
  let loops = 0;
  let verdict = null;

  for (const ev of logEvents) {
    const { phase, event: e } = ev;

    if (phase === "design") {
      if (phases.design === "pending") phases.design = "active";
      if (e === "start") { phases.design = "active"; currentStep = "Design · Functional Interview"; }
      else if (e === "functional-interview-complete") currentStep = "Design · Experience Interview";
      else if (e === "experience-interview-complete") currentStep = "Design · Consistency Check";
      else if (e === "consistency-check-complete") currentStep = ev.issueCount > 0 ? "Design · Clarification" : "Design · Spec Generation";
      else if (e === "clarification-round-complete") currentStep = "Design · Spec Generation";
      else if (e === "design-division-complete") { phases.design = "done"; currentStep = "Design · Complete"; }
    } else if (phase === "build") {
      if (phases.build === "pending") phases.build = "active";
      if (e === "start") { phases.build = "active"; currentStep = "Build · Architect Interview"; }
      else if (e === "architect-interview-complete") currentStep = "Build · Building";
      else if (e === "task-complete") currentStep = `Build · Task ${ev.taskId ?? ""}`;
      else if (e === "integration-complete") currentStep = "Build · Copy Review";
      else if (e === "copy-approved") currentStep = "Build · Verification";
      else if (e === "verification-complete") currentStep = "Build · Packaging";
      else if (e === "build-division-complete") { phases.build = "done"; currentStep = "Build · Complete"; }
    } else if (phase === "review") {
      if (phases.review === "pending") phases.review = "active";
      if (e === "start") { phases.review = "active"; currentStep = "Review · Running Scenarios"; }
      else if (e === "scenario-complete") currentStep = `Review · Scenario ${ev.scenarioId ?? ""}`;
      else if (e === "edge-case-complete") currentStep = "Review · Verdict";
      else if (e === "verdict-complete") currentStep = "Review · Verdict";
      else if (e === "ship-approved") currentStep = "Review · Shipped";
      else if (e === "ship-blocked") currentStep = "Review · Blocked";
      else if (e === "review-division-complete") { phases.review = "done"; currentStep = "Review · Complete"; }
    } else if (phase === "security") {
      if (phases.security === "pending") phases.security = "active";
      if (e === "start") { phases.security = "active"; currentStep = "Security · Running"; }
      else if (e === "security-approved") { currentStep = "Security · Approved"; verdict = "shipped"; }
      else if (e === "security-blocked") { currentStep = "Security · Blocked"; verdict = "blocked"; }
      else if (e === "security-division-complete") { phases.security = "done"; }
    } else if (phase === "factory") {
      if (e === "division-complete" && ev.loop) loops = Math.max(loops, ev.loop);
      if (e === "pipeline-complete") { verdict = verdict ?? "complete"; currentStep = "Pipeline Complete"; }
    }
  }

  return { phases, currentStep, loops, verdict };
}

// ---------------------------------------------------------------------------
// Active run detection
// ---------------------------------------------------------------------------

function mostActiveRunId() {
  const ids = allRunIds();
  if (ids.length === 0) return null;

  let newest = null;
  let newestMtime = 0;

  for (const id of ids) {
    const logPath = path.join(RUNS_DIR, id, "log.jsonl");
    if (!fs.existsSync(logPath)) continue;
    const mtime = fs.statSync(logPath).mtimeMs;
    if (mtime > newestMtime) { newestMtime = mtime; newest = id; }
  }

  if (!newest) return null;

  // Only return the run if it hasn't completed yet
  const logEvents = parseJsonLines(path.join(RUNS_DIR, newest, "log.jsonl"));
  const isComplete = logEvents.some((e) => e.event === "pipeline-complete");
  return isComplete ? null : newest;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

function sseSend(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

// ---------------------------------------------------------------------------
// File watchers — polling-based, reliable on Windows
// ---------------------------------------------------------------------------

// Watches a file for appended lines; calls back with new lines only.
function createTailWatcher(filePath, onNewLines) {
  let offset = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  const timer = setInterval(() => {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = stat.size;
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    if (lines.length > 0) onNewLines(lines);
  }, 500);

  return () => clearInterval(timer);
}

// Watches a file path for any change (including first appearance); calls back when changed.
function createFileWatcher(filePath, onChanged) {
  let mtime = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
  const timer = setInterval(() => {
    if (!fs.existsSync(filePath)) return;
    const m = fs.statSync(filePath).mtimeMs;
    if (m !== mtime) { mtime = m; onChanged(); }
  }, 500);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/runs", (req, res) => {
  const ids = allRunIds();
  const runs = ids.map((id) => {
    try { return runSummary(id); } catch { return { id, error: true }; }
  });
  runs.sort((a, b) => (b.startTs ?? "").localeCompare(a.startTs ?? ""));
  res.json(runs);
});

app.get("/api/runs/:id", (req, res) => {
  const { id } = req.params;
  const dir = path.join(RUNS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "not found" });
  try { res.json(runDetail(id)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/runs/:id/files", (req, res) => {
  const { id } = req.params;
  const dir = path.join(RUNS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "not found" });
  res.json(getRunFiles(dir));
});

// Serve a single file's content — path traversal protected.
app.get("/api/runs/:id/file", (req, res) => {
  const { id } = req.params;
  const relPath = req.query.p;
  if (!relPath) return res.status(400).json({ error: "missing p" });

  const runDir = path.resolve(path.join(RUNS_DIR, id));
  const filePath = path.resolve(runDir, relPath);

  // Must stay inside the run directory
  if (!filePath.startsWith(runDir + path.sep) && filePath !== runDir) {
    return res.status(403).json({ error: "forbidden" });
  }

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const ext = path.extname(filePath).slice(1).toLowerCase();
    res.json({ content, ext, relPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/active", (req, res) => {
  res.json({ id: mostActiveRunId() });
});

// SSE stream — sends snapshot then streams changes for a specific run.
app.get("/api/runs/:id/stream", (req, res) => {
  const { id } = req.params;
  const dir = path.join(RUNS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).end();

  sseSetup(res);

  const logEvents = parseJsonLines(path.join(dir, "log.jsonl"));
  const tokens = parseJsonLines(path.join(dir, "token-usage.jsonl"));
  const decisions = parseJsonLines(path.join(dir, "decision-log.jsonl"));
  const state = deriveState(logEvents);
  const files = getRunFiles(dir);
  const { limit: tokenLimit, source: tokenLimitSource } = readBudgetLimit(dir);

  // Initial snapshot — includes file manifest and active transcript name
  sseSend(res, "snapshot", { id, logEvents, tokens, decisions, state, files, tokenLimit, tokenLimitSource });

  // Send the name of the most recently modified transcript so client auto-loads it
  function sendActiveTranscript() {
    const transcriptMap = { functional: "functional-transcript.md", experience: "experience-transcript.md", clarification: "clarification-transcript.md", architect: "architect-transcript.md" };
    let latest = null; let latestMtime = 0;
    for (const [name, rel] of Object.entries(transcriptMap)) {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) continue;
      const m = fs.statSync(p).mtimeMs;
      if (m > latestMtime) { latestMtime = m; latest = name; }
    }
    if (latest) sseSend(res, "transcript", { name: latest });
  }

  sendActiveTranscript();

  // Re-send file manifest whenever a new file appears (tabs update live)
  function sendFiles() {
    sseSend(res, "files", { files: getRunFiles(dir) });
  }

  // Watch log.jsonl
  const stopLog = createTailWatcher(path.join(dir, "log.jsonl"), (lines) => {
    const newEvents = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const allEvents = parseJsonLines(path.join(dir, "log.jsonl"));
    sseSend(res, "log", { newEvents, state: deriveState(allEvents) });
  });

  // Watch token-usage.jsonl
  const stopTokens = createTailWatcher(path.join(dir, "token-usage.jsonl"), (lines) => {
    const newTokens = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    sseSend(res, "tokens", { newTokens });
  });

  // Watch decision-log.jsonl
  const stopDecisions = createTailWatcher(path.join(dir, "decision-log.jsonl"), (lines) => {
    const newDecisions = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    sseSend(res, "decisions", { newDecisions });
  });

  // Watch each transcript — send name on change so client re-fetches
  const transcriptNames = ["functional", "experience", "clarification", "architect"];
  const stopTranscripts = transcriptNames.map((name) =>
    createFileWatcher(path.join(dir, `${name}-transcript.md`), () => {
      sseSend(res, "transcript", { name });
      sendFiles(); // tabs may need to appear
    })
  );

  // Watch all other known file paths so tabs appear as files are generated
  const watchedFilePaths = [
    "run-brain.md", "handoff/build-spec.md", "handoff/review-spec.md", "handoff/runtime-spec.md",
    "build/architecture-plan.md", "build/copy-review.txt", "build/integration-report.md",
    "review/verdict-report.md", "review/edge-case-summary.md",
    "security/static-analysis-report.md", "security/dynamic-test-report.md", "security/security-verdict-report.md",
  ];
  const stopFileWatchers = watchedFilePaths.map((rel) =>
    createFileWatcher(path.join(dir, rel), sendFiles)
  );

  // Also watch the artifact directory for new files
  const stopArtifactWatch = createFileWatcher(path.join(dir, "artifact"), sendFiles);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    stopLog(); stopTokens(); stopDecisions();
    stopTranscripts.forEach((s) => s());
    stopFileWatchers.forEach((s) => s());
    stopArtifactWatch();
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\nSoftware Factory — GUI`);
  console.log(`Open: http://localhost:${PORT}\n`);
});

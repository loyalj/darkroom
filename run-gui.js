#!/usr/bin/env node

/**
 * GUI server for Darkroom.
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
const { spawn } = require("child_process");
const crypto = require("crypto");

const org     = require("./lib/org");
const workers = require("./lib/workers");

const activeProcesses  = new Map(); // runId → pid (factory runs only)
const activeHrSession  = { runId: null, pid: null, type: null, roleId: null };

const RUNS_DIR         = path.join(__dirname, "runs");
const HR_SESSIONS_DIR  = path.join(__dirname, "org", "sessions");
const PUBLIC_DIR = path.join(__dirname, "public");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 4242;

const app = express();
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ---------------------------------------------------------------------------
// Process tracking helpers
// ---------------------------------------------------------------------------

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidFilePath(runId) { return path.join(RUNS_DIR, runId, "run.pid"); }

function writePidFile(runId, pid) {
  try { fs.writeFileSync(pidFilePath(runId), String(pid), "utf8"); } catch {}
}

function removePidFile(runId) {
  try { fs.unlinkSync(pidFilePath(runId)); } catch {}
}

function readPidFile(runId) {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath(runId), "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

// On startup, restore any processes that were alive when the server last ran.
function recoverActiveProcesses() {
  for (const id of allRunIds()) {
    const pid = readPidFile(id);
    if (pid == null) continue;
    if (isAlive(pid)) { activeProcesses.set(id, pid); } else { removePidFile(id); }
  }
}

// ---------------------------------------------------------------------------
// HR session tracking helpers
// ---------------------------------------------------------------------------

function hrPidFilePath(runId) { return path.join(HR_SESSIONS_DIR, runId, "run.pid"); }

function writeHrPidFile(runId, pid) {
  try { fs.writeFileSync(hrPidFilePath(runId), String(pid), "utf8"); } catch {}
}

function removeHrPidFile(runId) {
  try { fs.unlinkSync(hrPidFilePath(runId)); } catch {}
}

function readHrPidFile(runId) {
  try {
    const pid = parseInt(fs.readFileSync(hrPidFilePath(runId), "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function clearHrSession() {
  activeHrSession.runId = null;
  activeHrSession.pid   = null;
  activeHrSession.type  = null;
  activeHrSession.roleId = null;
}

function recoverHrSession() {
  if (!fs.existsSync(HR_SESSIONS_DIR)) return;
  for (const entry of fs.readdirSync(HR_SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id  = entry.name;
    const pid = readHrPidFile(id);
    if (pid == null) continue;
    if (!isAlive(pid)) { removeHrPidFile(id); continue; }
    const events    = parseJsonLines(path.join(HR_SESSIONS_DIR, id, "log.jsonl"));
    const designEv  = events.find((e) => e.event === "role-design-start");
    const interviewEv = events.find((e) => e.event === "interview-start");
    activeHrSession.runId  = id;
    activeHrSession.pid    = pid;
    activeHrSession.type   = designEv ? "create-role" : "interview";
    activeHrSession.roleId = interviewEv?.role ?? null;
    break; // only one HR session at a time
  }
}

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
    const tokenLimit = org.readConfigValue("tokenLimitPerRun");
    if (tokenLimit != null) return { limit: tokenLimit, source: "global brain" };
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
  const profileName = startEvent?.profile ?? "full";
  const lastEvent = logEvents[logEvents.length - 1];
  const complete = logEvents.some((e) => e.event === "pipeline-complete");
  const aborted  = !complete && logEvents.some((e) => e.event === "aborted");
  const shipped = logEvents.some((e) => e.event === "ship-approved" || e.event === "ship-approved-override");
  const blocked = logEvents.some((e) => e.event === "ship-rejected-no-ship" || e.event === "ship-rejected");
  const secApproved = logEvents.some((e) => e.event === "security-approved");
  const secBlocked = logEvents.some((e) => e.event === "security-rejected");

  const pid = activeProcesses.get(id) ?? readPidFile(id);
  const alive = pid != null && isAlive(pid);

  let verdict;
  if (alive) {
    verdict = "running";
  } else if (complete) {
    if (secBlocked) verdict = "blocked";
    else if (secApproved && shipped) verdict = "shipped";
    else if (blocked) verdict = "blocked";
    else verdict = "complete";
  } else {
    verdict = "failed";
  }

  const totalTokens = tokens.reduce((s, t) => s + (t.input || 0) + (t.output || 0), 0);
  const totalMs = times.reduce((s, t) => s + (t.durationMs || 0), 0);

  return {
    id,
    tag: meta?.tag ?? null,
    profile: profileName,
    startTs: startEvent?.ts ?? lastEvent?.ts ?? null,
    verdict,
    totalTokens,
    totalMs,
    eventCount: logEvents.length,
    lastEvent: lastEvent ?? null,
    alive,
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
        { key: "report-tokens",     label: "Tokens",           relPath: "token-usage.md",                           type: "markdown" },
        { key: "report-time",       label: "Time",             relPath: "time-usage.md",                            type: "markdown" },
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
  const startEvent = logEvents.find((e) => e.phase === "factory" && e.event === "start");
  const profileName = startEvent?.profile ?? "full";
  let profileNodes = ["design", "build", "review", "security"];
  try {
    const profilePath = path.join(__dirname, "profiles", `${profileName}.json`);
    if (fs.existsSync(profilePath)) {
      const p = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      profileNodes = p.nodes.map((n) => n.id);
    }
  } catch {}

  const phases = {};
  for (const id of profileNodes) phases[id] = "pending";

  let currentStep = "Initializing";
  let loops = 0;
  let verdict = null;
  let failReason = null;

  for (const ev of logEvents) {
    const { phase, event: e } = ev;

    if (phase === "hr") {
      if (e === "role-design-start") currentStep = "HR · Role Design";
      else if (e === "role-design-complete") currentStep = `HR · Role Created (${ev.role ?? ""})`;
      else if (e === "interview-start") currentStep = `HR · ${ev.role ?? "Role"} Interview`;
      else if (e === "interview-complete") currentStep = `HR · ${ev.role ?? "Role"} Brain Complete`;
    } else if (phase === "leadership") {
      if (e === "run-brain-start") currentStep = "Leadership · Run Brain";
    } else if (phase === "design") {
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
      else if (e === "build-blocked") {
        phases.build = "failed";
        verdict = "failed";
        failReason = "All build tasks exhausted retries";
        currentStep = "Build · Tasks Failed";
      }
    } else if (phase === "review") {
      if (phases.review === "pending") phases.review = "active";
      if (e === "start") { phases.review = "active"; currentStep = "Review · Running Scenarios"; }
      else if (e === "scenario-complete") currentStep = `Review · Scenario ${ev.scenarioId ?? ""}`;
      else if (e === "edge-case-complete") currentStep = "Review · Verdict";
      else if (e === "verdict-complete") currentStep = "Review · Verdict";
      else if (e === "ship-approved" || e === "ship-approved-override") currentStep = "Review · Shipped";
      else if (e === "ship-rejected-no-ship" || e === "ship-rejected") currentStep = "Review · Blocked";
      else if (e === "review-division-complete") { phases.review = "done"; currentStep = "Review · Complete"; }
    } else if (phase === "security") {
      if (phases.security === "pending") phases.security = "active";
      if (e === "start") { phases.security = "active"; currentStep = "Security · Running"; }
      else if (e === "security-approved") { currentStep = "Security · Approved"; verdict = "shipped"; }
      else if (e === "security-rejected") { currentStep = "Security · Blocked"; verdict = "blocked"; }
      else if (e === "security-division-complete") { phases.security = "done"; }
    } else if (phase === "factory") {
      if (e === "resume") {
        // A new attempt is starting — wipe the previous abort/failure state so the
        // header and pipeline bar reflect the current attempt, not the old one.
        verdict = null;
        failReason = null;
        for (const divId of Object.keys(phases)) {
          if (phases[divId] === "failed") phases[divId] = "pending";
        }
      }
      if (e === "division-complete" && ev.loop) loops = Math.max(loops, ev.loop);
      if (e === "pipeline-complete") { verdict = verdict ?? "complete"; currentStep = "Pipeline Complete"; }
      if (e === "aborted" && verdict !== "complete" && verdict !== "shipped" && verdict !== "blocked") {
        const div = ev.division;
        if (div && phases[div] !== undefined) phases[div] = "failed";
        verdict = "failed";
        failReason = ev.reason && ev.reason !== "Exiting." ? ev.reason : null;
        currentStep = div ? `${div.charAt(0).toUpperCase() + div.slice(1)} · Failed` : "Pipeline Failed";
      }
    }
  }

  return { phases, currentStep, loops, verdict, profileNodes, failReason };
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

  // Only return the run if it hasn't reached a terminal state
  const logEvents = parseJsonLines(path.join(RUNS_DIR, newest, "log.jsonl"));
  const isComplete = logEvents.some((e) => e.event === "pipeline-complete");
  const isAborted  = !isComplete && logEvents.some((e) => e.event === "aborted");
  return (isComplete || isAborted) ? null : newest;
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
function createFileWatcher(filePath, onChanged, onDeleted = null) {
  let existed = fs.existsSync(filePath);
  let mtime = existed ? fs.statSync(filePath).mtimeMs : 0;
  const timer = setInterval(() => {
    const exists = fs.existsSync(filePath);
    if (!exists) {
      if (existed && onDeleted) { existed = false; mtime = 0; onDeleted(); }
      return;
    }
    if (!existed) existed = true;
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

// Returns runs eligible as a source for a given requiresRun profile.
// A run is eligible when, for every department node in the profile:
//   - all of that department's declared inputs are present on disk (prerequisites met)
//   - at least one declared output is absent (there is still work to do)
// Alive runs are always excluded.
app.get("/api/runs/eligible", (req, res) => {
  const profileName = req.query.profile;
  if (!profileName || !/^[\w-]+$/.test(profileName)) {
    return res.status(400).json({ error: "profile required" });
  }

  const profilePath = path.join(__dirname, "profiles", `${profileName}.json`);
  if (!fs.existsSync(profilePath)) return res.status(404).json({ error: "profile not found" });

  let profile, depts;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    depts   = JSON.parse(fs.readFileSync(path.join(__dirname, "departments.json"), "utf8"));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const eligible = [];

  for (const id of allRunIds()) {
    const runDir = path.join(RUNS_DIR, id);

    // Exclude runs with a live process
    const pid = activeProcesses.get(id) ?? readPidFile(id);
    if (pid != null && isAlive(pid)) continue;

    let allInputsPresent = true;
    let anyOutputMissing = false;

    for (const node of profile.nodes) {
      const dept = depts[node.id];
      if (!dept) continue;

      const inputs  = dept.inputs  ?? [];
      const outputs = dept.outputs ?? [];

      if (!inputs.every((rel) => fs.existsSync(path.join(runDir, rel)))) {
        allInputsPresent = false;
        break;
      }

      if (outputs.some((rel) => !fs.existsSync(path.join(runDir, rel)))) {
        anyOutputMissing = true;
      }
    }

    if (allInputsPresent && anyOutputMissing) {
      try { eligible.push(runSummary(id)); } catch {}
    }
  }

  eligible.sort((a, b) => (b.startTs ?? "").localeCompare(a.startTs ?? ""));
  res.json(eligible);
});

app.get("/api/runs/:id", (req, res) => {
  const { id } = req.params;
  const dir = path.join(RUNS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "not found" });
  try { res.json(runDetail(id)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/runs/:id/activity", (req, res) => {
  const { id } = req.params;
  const actPath = path.join(RUNS_DIR, id, "activity.jsonl");
  if (!fs.existsSync(actPath)) return res.json({ entries: [] });
  try { res.json({ entries: parseJsonLines(actPath) }); } catch (e) { res.status(500).json({ error: e.message }); }
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

// Submit a response to the factory's pending input point.
app.post("/api/runs/:id/respond", (req, res) => {
  const { id } = req.params;
  const { response } = req.body ?? {};
  if (typeof response !== "string") return res.status(400).json({ error: "response required" });

  const dir = path.join(RUNS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "not found" });

  const responsePath = path.join(dir, "input-response.json");
  try {
    fs.writeFileSync(responsePath, JSON.stringify({ response }), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

  // Extract run mode from the start event — used by the client to lock the chat pane in auto mode
  const startEvent = logEvents.find((e) => e.phase === "factory" && e.event === "start");
  const runMode = startEvent?.mode ?? "manual";

  // Check for a pending factory input point at snapshot time
  let pendingInput = null;
  const pendingInputPath = path.join(dir, "pending-input.json");
  if (fs.existsSync(pendingInputPath)) {
    try { pendingInput = JSON.parse(fs.readFileSync(pendingInputPath, "utf8")); } catch {}
  }

  // Recent activity lines for the live feed (last 80 events)
  const activityPath = path.join(dir, "activity.jsonl");
  const recentActivity = parseJsonLines(activityPath).slice(-80);

  // Initial snapshot — includes file manifest and active transcript name
  sseSend(res, "snapshot", { id, logEvents, tokens, decisions, state, files, tokenLimit, tokenLimitSource, pendingInput, recentActivity, runMode });

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
    "token-usage.md", "time-usage.md",
    "build/architecture-plan.md", "build/copy-review.txt", "build/integration-report.md",
    "review/verdict-report.md", "review/edge-case-summary.md",
    "security/static-analysis-report.md", "security/dynamic-test-report.md", "security/security-verdict-report.md",
  ];
  const stopFileWatchers = watchedFilePaths.map((rel) =>
    createFileWatcher(path.join(dir, rel), sendFiles)
  );

  // Also watch the artifact directory for new files
  const stopArtifactWatch = createFileWatcher(path.join(dir, "artifact"), sendFiles);

  // Watch run-config.json — push budget when run brain writes it
  const stopBudget = createFileWatcher(path.join(dir, "run-config.json"), () => {
    const { limit, source } = readBudgetLimit(dir);
    sseSend(res, "budget", { tokenLimit: limit, tokenLimitSource: source });
  });

  // Watch activity.jsonl — push new lines as they arrive
  const stopActivity = createTailWatcher(activityPath, (lines) => {
    const newActivity = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    sseSend(res, "activity", { newActivity });
  });

  // Watch for pending factory input points
  const stopPendingInput = createFileWatcher(
    pendingInputPath,
    () => {
      if (!fs.existsSync(pendingInputPath)) return;
      try {
        const data = JSON.parse(fs.readFileSync(pendingInputPath, "utf8"));
        sseSend(res, "pending-input", { prompt: data.prompt, inputType: data.type ?? "text", options: data.options ?? null, escalation: data.escalation ?? false, runMode });
      } catch {}
    },
    () => sseSend(res, "input-cleared", {})
  );

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    stopLog(); stopTokens(); stopDecisions();
    stopTranscripts.forEach((s) => s());
    stopFileWatchers.forEach((s) => s());
    stopArtifactWatch();
    stopBudget();
    stopActivity();
    stopPendingInput();
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

app.get("/api/profiles", (req, res) => {
  const profilesDir = path.join(__dirname, "profiles");
  const orgProfilesDir = path.join(__dirname, "org", "profiles");
  if (!fs.existsSync(profilesDir)) return res.json([]);
  const files = fs.readdirSync(profilesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      try {
        const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, f), "utf8"));
        const orgProfile = profile.orgProfile ?? null;
        const orgProfileValid = orgProfile
          ? fs.existsSync(path.join(orgProfilesDir, `${orgProfile}.json`))
          : false;
        return { name, description: profile.description ?? "", requiresRun: profile.requiresRun ?? false, nodeCount: profile.nodes?.length ?? 0, nodes: profile.nodes?.map((n) => n.id) ?? [], orgProfile, orgProfileValid };
      } catch {
        return { name, nodeCount: 0, nodes: [], error: true, orgProfile: null, orgProfileValid: false };
      }
    });
  res.json(files);
});

app.get("/api/org-profiles", (req, res) => {
  try {
    org.reloadAll();
    res.json(org.loadProfiles());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/org-profiles", express.json(), (req, res) => {
  try {
    const { name, description } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: "name required" });
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id) return res.status(400).json({ error: "invalid name" });
    const profilePath = path.join(__dirname, "org", "profiles", `${id}.json`);
    if (fs.existsSync(profilePath)) return res.status(409).json({ error: `Profile "${id}" already exists` });
    const profile = { id, name: name.trim(), description: (description ?? "").trim(), nodes: [] };
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/org-profiles/:id", express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, nodes } = req.body ?? {};
    if (!Array.isArray(nodes)) return res.status(400).json({ error: "nodes must be an array" });
    const validNodes = nodes.filter((n) => n && typeof n.roleId === "string" && n.roleId.trim());
    if (validNodes.length !== nodes.length) return res.status(400).json({ error: "each node must have a roleId string" });
    org.saveProfile(id, { id, name: name ?? id, description: description ?? "", nodes: validNodes });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/org-profiles/:id", (req, res) => {
  try {
    const { id } = req.params;
    const profilePath = path.join(__dirname, "org", "profiles", `${id}.json`);
    if (!fs.existsSync(profilePath)) return res.status(404).json({ error: "Not found" });
    fs.unlinkSync(profilePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/org/roles", (req, res) => {
  try {
    const roles = org.reloadRoles();
    res.json(Object.values(roles).map((r) => ({ id: r.id, name: r.name, description: r.description ?? "" })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/profiles/:name", (req, res) => {
  const { name } = req.params;
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: "invalid name" });
  const filePath = path.join(__dirname, "profiles", `${name}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });
  try {
    res.json({ name, content: fs.readFileSync(filePath, "utf8") });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/profiles/:name", (req, res) => {
  const { name } = req.params;
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: "invalid name" });
  const { content } = req.body ?? {};
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try { JSON.parse(content); } catch (e) {
    return res.status(400).json({ error: `Invalid JSON: ${e.message}` });
  }
  try {
    fs.writeFileSync(path.join(__dirname, "profiles", `${name}.json`), content, "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

app.get("/api/special-nodes", (req, res) => {
  const p = path.join(__dirname, "special-nodes.json");
  if (!fs.existsSync(p)) return res.json({});
  try { res.json(JSON.parse(fs.readFileSync(p, "utf8"))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/departments", (req, res) => {
  const p = path.join(__dirname, "departments.json");
  let base = {};
  if (fs.existsSync(p)) {
    try { base = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  // Merge typed inputs/outputs from each dept's schema.json (Phase 9)
  for (const id of Object.keys(base)) {
    const schemaPath = path.join(__dirname, "departments", id, "schema.json");
    if (fs.existsSync(schemaPath)) {
      try {
        const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        base[id].inputs      = schema.inputs      ?? [];
        base[id].outputs     = schema.outputs     ?? [];
        base[id].slots       = schema.slots       ?? [];
        base[id].description = schema.description ?? "";
      } catch {}
    }
  }
  res.json(base);
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

app.post("/api/launch", (req, res) => {
  const { profile, mode = "manual", tag, caveman, stopAfter, runId: resumeId } = req.body ?? {};
  const runId = resumeId ?? crypto.randomBytes(4).toString("hex");

  // Prevent two processes running against the same run directory
  const existingPid = activeProcesses.get(runId) ?? readPidFile(runId);
  if (existingPid != null && isAlive(existingPid)) {
    return res.status(409).json({ error: "Run is already in progress", runId });
  }

  // When resuming an existing run, always inherit the original run's profile and mode
  // from its log — never let the launch UI override them.
  let resolvedProfile = profile ?? "full";
  let resolvedMode = mode;
  if (resumeId) {
    const logPath = path.join(RUNS_DIR, resumeId, "log.jsonl");
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.phase === "factory" && ev.event === "start") {
            if (ev.profile) resolvedProfile = ev.profile;
            if (ev.mode)    resolvedMode    = ev.mode;
            break;
          }
        } catch {}
      }
    }
  }

  // Validate org chart for new runs (resumes inherit the already-validated run)
  if (!resumeId) {
    const profilePath = path.join(__dirname, "profiles", `${resolvedProfile}.json`);
    if (fs.existsSync(profilePath)) {
      let factoryProfile;
      try { factoryProfile = JSON.parse(fs.readFileSync(profilePath, "utf8")); } catch {}
      if (!factoryProfile?.orgProfile) {
        return res.status(400).json({ error: `Profile "${resolvedProfile}" has no org chart configured. Set one in Factory Profiles before launching.` });
      }
      const orgProfilePath = path.join(__dirname, "org", "profiles", `${factoryProfile.orgProfile}.json`);
      if (!fs.existsSync(orgProfilePath)) {
        return res.status(400).json({ error: `Org chart "${factoryProfile.orgProfile}" no longer exists. Update the profile's org chart before launching.` });
      }
    }
  }

  const args = [path.join(__dirname, "run-factory.js"), "--run-id", runId];
  args.push("--profile", resolvedProfile);

  if (!resumeId) {
    if (tag) args.push("--tag", tag);
    if (stopAfter) args.push("--stop-after", stopAfter);
  }
  if (resolvedMode === "auto") args.push("--mode", "auto");
  if (caveman) args.push("--caveman");

  if (resumeId) {
    const ts = new Date().toISOString();
    const logPath = path.join(RUNS_DIR, resumeId, "log.jsonl");
    fs.appendFileSync(logPath, JSON.stringify({ ts, phase: "factory", event: "resume" }) + "\n", "utf8");
    // Write a visual separator to the activity log so resumed attempts are clearly distinct.
    const activityPath = path.join(RUNS_DIR, resumeId, "activity.jsonl");
    fs.appendFileSync(activityPath, JSON.stringify({ ts, type: "separator", label: "── resumed ──" }) + "\n", "utf8");
  }

  try {
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, DARK_ROOM_IO: "file" },
      stdio: "ignore",
      windowsHide: true,
    });
    activeProcesses.set(runId, child.pid);
    writePidFile(runId, child.pid);
    child.on("exit", () => {
      activeProcesses.delete(runId);
      removePidFile(runId);
    });
    child.unref();
    res.json({ ok: true, runId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

app.get("/api/roles", (req, res) => {
  try {
    org.reloadAll();
    const roles = org.loadRoles();
    const result = Object.values(roles).map((role) => ({
      id:          role.id,
      name:        role.name,
      description: role.description,
      hasBrain:    org.brainExists(role),
      brainContent: org.brainExists(role) ? org.readBrain(role) : null,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

app.get("/api/workers", (req, res) => {
  try {
    workers.reloadWorkers();
    const all = workers.loadWorkers();
    const result = Object.values(all).map((w) => ({
      id:           w.id,
      name:         w.name,
      description:  w.description,
      slotType:     w.slotType,
      department:   w.department,
      created:      w.created,
      hasPrompt:    workers.promptExists(w),
      promptContent: workers.promptExists(w) ? workers.readPrompt(w) : null,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/workers/slots", (req, res) => {
  try {
    res.json(workers.listSlotTypes());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

function spawnHrSession(spawnArgs, runId, type, roleId, res) {
  const sessionDir = path.join(HR_SESSIONS_DIR, runId);
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    const child = spawn(process.execPath, spawnArgs, {
      cwd: __dirname,
      env: { ...process.env, DARK_ROOM_IO: "file" },
      stdio: "ignore",
      windowsHide: true,
    });
    activeHrSession.runId  = runId;
    activeHrSession.pid    = child.pid;
    activeHrSession.type   = type;
    activeHrSession.roleId = roleId;
    writeHrPidFile(runId, child.pid);
    child.on("exit", () => { removeHrPidFile(runId); clearHrSession(); });
    child.unref();
    res.json({ ok: true, runId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/api/org/roles/create", (req, res) => {
  if (activeHrSession.runId && activeHrSession.pid && isAlive(activeHrSession.pid))
    return res.status(409).json({ error: "An HR session is already running", runId: activeHrSession.runId });

  const runId = crypto.randomBytes(4).toString("hex");
  spawnHrSession(
    [path.join(__dirname, "departments", "hr", "run.js"), "--create-role", "--run-id", runId],
    runId, "create-role", null, res
  );
});

app.post("/api/workers/create", (req, res) => {
  if (activeHrSession.runId && activeHrSession.pid && isAlive(activeHrSession.pid))
    return res.status(409).json({ error: "An HR session is already running", runId: activeHrSession.runId });

  const runId = crypto.randomBytes(4).toString("hex");
  spawnHrSession(
    [path.join(__dirname, "departments", "hr", "run.js"), "--create-worker", "--run-id", runId],
    runId, "create-worker", null, res
  );
});

app.post("/api/org/:id/interview", (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: "invalid role id" });

  if (activeHrSession.runId && activeHrSession.pid && isAlive(activeHrSession.pid))
    return res.status(409).json({ error: "An HR session is already running", runId: activeHrSession.runId });

  org.reloadAll();
  const roles = org.loadRoles();
  if (!roles[id]) return res.status(404).json({ error: "role not found" });

  const runId = crypto.randomBytes(4).toString("hex");
  spawnHrSession(
    [path.join(__dirname, "departments", "hr", "run.js"), "--role", id, "--run-id", runId],
    runId, "interview", id, res
  );
});

app.get("/api/org/session", (req, res) => {
  if (!activeHrSession.runId || !activeHrSession.pid || !isAlive(activeHrSession.pid))
    return res.json({ active: false });

  const { runId, type, roleId } = activeHrSession;
  const dir = path.join(HR_SESSIONS_DIR, runId);

  const pendingPath = path.join(dir, "pending-input.json");
  let pendingInput = null;
  if (fs.existsSync(pendingPath)) {
    try { pendingInput = JSON.parse(fs.readFileSync(pendingPath, "utf8")); } catch {}
  }

  res.json({ active: true, runId, type, roleId, pendingInput });
});

app.delete("/api/org/session", (req, res) => {
  if (!activeHrSession.runId) return res.json({ ok: true });
  const { pid, runId } = activeHrSession;
  if (pid && isAlive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  removeHrPidFile(runId);
  clearHrSession();
  res.json({ ok: true });
});

app.post("/api/hr-session/:id/respond", (req, res) => {
  const { id } = req.params;
  const { response } = req.body ?? {};
  if (typeof response !== "string") return res.status(400).json({ error: "response required" });

  const dir = path.join(HR_SESSIONS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "not found" });

  try {
    fs.writeFileSync(path.join(dir, "input-response.json"), JSON.stringify({ response }), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/hr-session/:id/stream", (req, res) => {
  const { id } = req.params;
  const dir = path.join(HR_SESSIONS_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).end();

  sseSetup(res);

  // Determine session type. Use activeHrSession directly when this is the current session —
  // avoids a race condition where the SSE stream connects before log.jsonl is written.
  let sessionType, roleId;
  if (activeHrSession.runId === id) {
    sessionType = activeHrSession.type ?? "interview";
    roleId      = activeHrSession.roleId ?? null;
  } else {
    const events         = parseJsonLines(path.join(dir, "log.jsonl"));
    const interviewEv    = events.find((e) => e.event === "interview-start");
    const designEv       = events.find((e) => e.event === "role-design-start");
    const workerDesignEv = events.find((e) => e.event === "worker-design-start");
    sessionType = designEv ? "create-role" : workerDesignEv ? "create-worker" : "interview";
    roleId      = interviewEv?.role ?? null;
  }

  let transcriptPath = null;
  if (sessionType === "interview" && roleId) {
    try {
      const roles = org.loadRoles();
      const role  = roles[roleId];
      if (role) transcriptPath = path.join(__dirname, role.transcriptPath);
    } catch {}
  } else if (sessionType === "create-role") {
    transcriptPath = path.join(dir, "role-design-transcript.md");
  } else if (sessionType === "create-worker") {
    transcriptPath = path.join(dir, "worker-design-transcript.md");
  }

  const pendingPath = path.join(dir, "pending-input.json");
  let pendingInput  = null;
  if (fs.existsSync(pendingPath)) {
    try { pendingInput = JSON.parse(fs.readFileSync(pendingPath, "utf8")); } catch {}
  }
  const transcript = transcriptPath && fs.existsSync(transcriptPath)
    ? fs.readFileSync(transcriptPath, "utf8") : null;

  sseSend(res, "snapshot", { type: sessionType, roleId, transcript, pendingInput });

  const stopLog = createTailWatcher(path.join(dir, "log.jsonl"), (lines) => {
    const newEvents = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    sseSend(res, "log", { newEvents });
    if (newEvents.some((e) => e.event === "pipeline-complete"))
      sseSend(res, "session-complete", {});
  });

  const stopPendingInput = createFileWatcher(
    pendingPath,
    () => {
      if (!fs.existsSync(pendingPath)) return;
      try {
        const data = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
        sseSend(res, "pending-input", { prompt: data.prompt, inputType: data.type ?? "text", options: data.options ?? null });
      } catch {}
    },
    () => sseSend(res, "input-cleared", {})
  );

  let stopTranscript = () => {};
  if (transcriptPath) {
    stopTranscript = createFileWatcher(transcriptPath, () => {
      if (!fs.existsSync(transcriptPath)) return;
      try { sseSend(res, "transcript", { content: fs.readFileSync(transcriptPath, "utf8") }); } catch {}
    });
  }

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { stopLog(); stopPendingInput(); stopTranscript(); clearInterval(heartbeat); });
});

app.get("/api/org", (req, res) => {
  try {
    org.reloadAll();
    const profileName = req.query.profile ?? null;
    if (profileName) org.setActiveProfile(profileName);
    const profile  = org.getActiveProfile();
    const profiles = org.loadProfiles();
    const nodes = profile.nodes
      .filter((n) => n.role != null)
      .map((n) => ({
        roleId:      n.roleId,
        escalatesTo: n.escalatesTo ?? null,
        role: {
          id:          n.role.id,
          name:        n.role.name,
          description: n.role.description,
          domains:     n.role.domains     ?? [],
          contextFile: n.role.contextFile ?? null,
        },
        hasBrain:    org.brainExists(n.role),
        brainContent: org.brainExists(n.role) ? org.readBrain(n.role) : null,
      }));
    res.json({
      activeProfile:   profile.id,
      profileMeta:     { id: profile.id, name: profile.name ?? profile.id, description: profile.description ?? "" },
      profiles,
      nodes,
      decisionRouting: profile.decisionRouting ?? {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

app.put("/api/memory/:dept/wiki", express.json(), (req, res) => {
  const { dept } = req.params;
  const { content } = req.body ?? {};
  if (!["design", "build", "review", "security"].includes(dept)) return res.status(400).json({ error: "Unknown dept" });
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  const wikiPath = path.join(__dirname, "memory", dept, "wiki.md");
  fs.mkdirSync(path.dirname(wikiPath), { recursive: true });
  fs.writeFileSync(wikiPath, content, "utf8");
  res.json({ ok: true });
});

app.delete("/api/memory/:dept/runs/:runId", (req, res) => {
  const { dept, runId } = req.params;
  if (!["design", "build", "review", "security"].includes(dept)) return res.status(400).json({ error: "Unknown dept" });
  const runsPath = path.join(__dirname, "memory", dept, "runs.jsonl");
  if (!fs.existsSync(runsPath)) return res.status(404).json({ error: "Not found" });
  const lines = fs.readFileSync(runsPath, "utf8").trim().split("\n").filter(Boolean);
  const filtered = lines.filter((l) => { try { return JSON.parse(l).runId !== runId; } catch { return true; } });
  fs.writeFileSync(runsPath, filtered.join("\n") + (filtered.length ? "\n" : ""), "utf8");
  res.json({ ok: true });
});

app.get("/api/memory", (req, res) => {
  const memoryDir = path.join(__dirname, "memory");
  const deptIds = ["design", "build", "review", "security"];
  const data = {};
  for (const dept of deptIds) {
    const deptDir = path.join(memoryDir, dept);
    const wikiPath = path.join(deptDir, "wiki.md");
    const runsPath = path.join(deptDir, "runs.jsonl");
    const wiki = fs.existsSync(wikiPath) ? fs.readFileSync(wikiPath, "utf8") : null;
    const runs = fs.existsSync(runsPath) ? parseJsonLines(runsPath) : [];
    data[dept] = { wiki, runs };
  }
  res.json({ departments: deptIds, data });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

recoverActiveProcesses();
recoverHrSession();

const server = app.listen(PORT, () => {
  console.log(`\nDarkroom — GUI`);
  console.log(`Open: http://localhost:${PORT}\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Error: port ${PORT} is already in use.\n  Stop the other process and try again, or use --port to pick a different port.\n`);
  } else {
    console.error(`\n  Server error: ${err.message}\n`);
  }
  process.exit(1);
});

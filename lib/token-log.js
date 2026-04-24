/**
 * token-log.js — Per-run token usage tracking.
 *
 * Appends one JSONL entry per Claude call to runs/{id}/token-usage.jsonl.
 * writeTokenTable() renders the accumulated log as a Markdown table.
 *
 * Usage:
 *   const { logTokens, writeTokenTable } = require("./token-log");
 *   logTokens(runDir, "Build", "Integration", usage);   // called per agent
 *   writeTokenTable(runDir);                             // called at run end
 */

"use strict";

const fs = require("fs");
const path = require("path");

function logTokens(runDir, phase, label, usage) {
  if (!usage) return;
  const entry = {
    ts: new Date().toISOString(),
    phase,
    label,
    input:      usage.input_tokens                 ?? 0,
    output:     usage.output_tokens                ?? 0,
    cacheRead:  usage.cache_read_input_tokens      ?? 0,
    cacheWrite: usage.cache_creation_input_tokens  ?? 0,
  };
  fs.appendFileSync(
    path.join(runDir, "token-usage.jsonl"),
    JSON.stringify(entry) + "\n",
    "utf8"
  );
}

function writeTokenTable(runDir) {
  const logPath = path.join(runDir, "token-usage.jsonl");
  if (!fs.existsSync(logPath)) return;

  const entries = fs.readFileSync(logPath, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));

  if (entries.length === 0) return;

  let totInput = 0, totOutput = 0, totRead = 0, totWrite = 0;
  const n = (v) => v.toLocaleString("en-US");

  const rows = entries.map((e) => {
    totInput  += e.input;
    totOutput += e.output;
    totRead   += e.cacheRead;
    totWrite  += e.cacheWrite;
    return `| ${e.phase} | ${e.label} | ${n(e.input)} | ${n(e.output)} | ${n(e.cacheRead)} | ${n(e.cacheWrite)} |`;
  });

  const table = [
    "# Token Usage",
    "",
    "| Phase | Agent | Input | Output | Cache Read | Cache Write |",
    "|-------|-------|------:|-------:|-----------:|------------:|",
    ...rows,
    `| | **Total** | **${n(totInput)}** | **${n(totOutput)}** | **${n(totRead)}** | **${n(totWrite)}** |`,
  ].join("\n");

  fs.writeFileSync(path.join(runDir, "token-usage.md"), table + "\n", "utf8");
}

function logTime(runDir, phase, label, elapsedMs) {
  const entry = { ts: new Date().toISOString(), phase, label, elapsedMs };
  fs.appendFileSync(
    path.join(runDir, "time-usage.jsonl"),
    JSON.stringify(entry) + "\n",
    "utf8"
  );
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function writeTimeTable(runDir) {
  const logPath = path.join(runDir, "time-usage.jsonl");
  if (!fs.existsSync(logPath)) return;

  const entries = fs.readFileSync(logPath, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));

  if (entries.length === 0) return;

  let totMs = 0;
  const rows = entries.map((e) => {
    totMs += e.elapsedMs;
    return `| ${e.phase} | ${e.label} | ${fmtMs(e.elapsedMs)} |`;
  });

  const table = [
    "# Time Usage",
    "",
    "| Phase | Agent | Elapsed |",
    "|-------|-------|--------:|",
    ...rows,
    `| | **Total** | **${fmtMs(totMs)}** |`,
  ].join("\n");

  fs.writeFileSync(path.join(runDir, "time-usage.md"), table + "\n", "utf8");
}

module.exports = { logTokens, writeTokenTable, logTime, writeTimeTable };

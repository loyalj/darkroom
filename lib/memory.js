"use strict";

/**
 * lib/memory.js — Department memory wiki read/write utilities.
 *
 * Each department has two memory files under memory/{dept}/:
 *   runs.jsonl  — structured run record appended every run (always written)
 *   wiki.md     — narrative craft knowledge appended only when there is a genuine insight
 *
 * The graph executor calls buildMemoryBlock(node) before spawning each department.
 * The result is written to runs/{id}/memory-context.md and injected by the runner
 * into every agent call via buildSystemPrompt.
 *
 * At the end of each department run, runReflector() calls a wiki-reflector agent
 * that produces the JSONL record and an optional wiki paragraph.
 */

const fs   = require("fs");
const path = require("path");

const MEMORY_DIR  = path.join(__dirname, "..", "memory");
const AGENTS_DIR  = path.join(__dirname, "..", "agents");
const RECENT_RUNS = 20;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function wikiPath(dept) { return path.join(MEMORY_DIR, dept, "wiki.md"); }
function runsPath(dept) { return path.join(MEMORY_DIR, dept, "runs.jsonl"); }

function safeRead(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function readWiki(dept) {
  return safeRead(wikiPath(dept));
}

function readRecentRuns(dept, n = RECENT_RUNS) {
  const p = runsPath(dept);
  if (!fs.existsSync(p)) return [];
  try {
    const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// buildMemoryBlock — called by graph executor before spawning each node
// ---------------------------------------------------------------------------

function buildMemoryBlock(node) {
  const mem = node.memory;
  if (!mem) return null;

  const sections = [];

  // Wiki sections (narrative, inject for all agent types)
  const wikiDepts = mem.readWiki ?? [];
  if (wikiDepts.length > 0) {
    const wikiParts = [];
    for (const dept of wikiDepts) {
      const content = readWiki(dept);
      if (content) {
        wikiParts.push(`### ${capitalize(dept)} Department\n\n${content}`);
      }
    }
    if (wikiParts.length > 0) {
      sections.push(`## Factory Memory — Department Wikis\n\n${wikiParts.join("\n\n")}`);
    }
  }

  // Run history sections (structured summary, inject for non-interview agents)
  const runsDepts = mem.readRuns ?? [];
  if (runsDepts.length > 0) {
    const runParts = [];
    for (const dept of runsDepts) {
      const runs = readRecentRuns(dept);
      if (runs.length > 0) {
        const lines = runs.map((r) => {
          const date    = (r.ts ?? "").slice(0, 10) || "?";
          const project = r.projectName || "unnamed";
          const outcome = r.outcome     || "?";
          const note    = r.notes       ? `  — ${r.notes}` : "";
          return `- ${date} · ${project} · ${outcome}${note}`;
        }).join("\n");
        runParts.push(`### ${capitalize(dept)} Department (last ${runs.length} run${runs.length !== 1 ? "s" : ""})\n\n${lines}`);
      }
    }
    if (runParts.length > 0) {
      sections.push(`## Factory Memory — Recent Run History\n\n${runParts.join("\n\n")}`);
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

function appendRunRecord(dept, record) {
  const p = runsPath(dept);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
}

function appendWikiEntry(dept, text) {
  if (!text || !text.trim()) return;
  const p = wikiPath(dept);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const separator = fs.existsSync(p) && fs.statSync(p).size > 0 ? "\n\n---\n\n" : "";
  fs.appendFileSync(p, `${separator}${text.trim()}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// runReflector — called at end of each department run
// ---------------------------------------------------------------------------

async function runReflector(dept, runDir, context, onUsage) {
  const { claudeCall } = require("../adapters/claude-cli");

  const reflectorPromptPath = path.join(AGENTS_DIR, dept, "wiki-reflector.md");
  if (!fs.existsSync(reflectorPromptPath)) return;

  const systemPrompt = fs.readFileSync(reflectorPromptPath, "utf8");

  let result;
  try {
    result = claudeCall(systemPrompt, context, onUsage);
  } catch (err) {
    // Reflector failure is non-fatal — log and continue
    console.error(`  [memory] Reflector error for ${dept}: ${err.message}`);
    return;
  }

  const output = result?.output ?? result;
  if (!output || typeof output !== "object") return;

  if (output.record && typeof output.record === "object") {
    appendRunRecord(dept, { runId: path.basename(runDir), ...output.record });
  }

  if (output.wikiEntry && typeof output.wikiEntry === "string") {
    appendWikiEntry(dept, output.wikiEntry);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildMemoryBlock, readWiki, readRecentRuns, appendRunRecord, appendWikiEntry, runReflector };

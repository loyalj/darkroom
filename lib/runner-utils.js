/**
 * runner-utils.js — Shared utilities for all division runners.
 *
 * File I/O helpers, string utilities, logging helpers, and the
 * runLockableInterview loop. No execution logic — Claude calls
 * live in adapters/claude-cli.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { claudeTurn } = require("../adapters/claude-cli");

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readFile(p) {
  return fs.readFileSync(p, "utf8");
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function readJSON(p) {
  return JSON.parse(readFile(p));
}

function writeJSON(p, obj) {
  writeFile(p, JSON.stringify(obj, null, 2));
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildSystemPrompt(...parts) {
  return parts.filter(Boolean).join("\n\n---\n\n");
}

function stripCodeFence(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logEvent(runDir, event) {
  const logPath = path.join(runDir, "log.jsonl");
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
}

// Record an autonomous orchestrator decision.
// entry fields: decisionPoint, evidence, brainContext, decision, reasoning, humanOverride
function writeDecision(runDir, entry) {
  const logPath = path.join(runDir, "decision-log.jsonl");
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function hr() { return "─".repeat(60); }

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// Shared interactive interview loop — handles opening turn, user input, user/agent-initiated lock.
// Returns the result of executeLock().
async function runLockableInterview({ systemPrompt, transcriptPath, display, io, agentName, lockSignalRe, lockConfirmPrompt, executeLock, onUsage }) {
  const history = [];

  display.update("thinking...");
  let agentTurn = claudeTurn(systemPrompt, history, onUsage);
  display.update("your turn");
  display.log(`\n${agentName}: ${clipForDisplay(agentTurn)}\n`, { subtype: "interview" });
  fs.appendFileSync(transcriptPath, `\n## ${agentName}\n\n${agentTurn.trim()}\n`);
  history.push({ role: "assistant", content: agentTurn });

  while (true) {
    const userInput = await io.turn("You: ", { context: agentTurn, options: ["lock the plan"], hybrid: true });
    if (!userInput.trim()) continue;

    if (/^\s*(lock|done|finalize)\b.*$/i.test(userInput.trim())) {
      return await executeLock();
    }

    fs.appendFileSync(transcriptPath, `\n## User\n\n${userInput.trim()}\n`);
    history.push({ role: "user", content: userInput });

    display.update("thinking...");
    agentTurn = claudeTurn(systemPrompt, history, onUsage);
    display.update("your turn");
    display.log(`\n${agentName}: ${clipForDisplay(agentTurn)}\n`, { subtype: "interview" });
    fs.appendFileSync(transcriptPath, `\n## ${agentName}\n\n${agentTurn.trim()}\n`);
    history.push({ role: "assistant", content: agentTurn });

    if (lockSignalRe.test(agentTurn)) {
      const confirm = await io.turn(`${lockConfirmPrompt} (yes / keep discussing): `, { context: `${agentTurn}\n\n${lockConfirmPrompt}?`, options: ["yes", "keep discussing"] });
      fs.appendFileSync(transcriptPath, `\n## User\n\n${confirm.trim()}\n`);
      history.push({ role: "user", content: confirm });

      if (/^(yes|y|lock|ok|do it|go|proceed)/i.test(confirm.trim())) {
        return await executeLock();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Source file collector (used by build and security divisions)
// Excludes MANIFEST.txt (packaging artifact, not source).
// ---------------------------------------------------------------------------

function collectSourceFiles(dir) {
  if (!fileExists(dir)) return "(no source files found)";
  const files = [];
  function walk(d, base = "") {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name !== "MANIFEST.txt") {
        files.push({ rel, full });
      }
    }
  }
  walk(dir);
  return files
    .map((f) => `### ${f.rel}\n\`\`\`\n${readFile(f.full)}\n\`\`\``)
    .join("\n\n");
}

// Clip agent turn text for display — full response still goes to transcript file.
function clipForDisplay(text, max = 800) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n  … (full response in transcript)";
}

// Extract the COMPACT block appended by caveman-mode agents.
// Returns the block text (starting from "COMPACT | ...") or null if not present.
function extractCompact(content) {
  const idx = content.indexOf("\nCOMPACT |");
  return idx >= 0 ? content.slice(idx + 1).trim() : null;
}

module.exports = {
  readFile, writeFile, readJSON, writeJSON, fileExists,
  buildSystemPrompt, stripCodeFence, clipForDisplay,
  logEvent, writeDecision,
  hr, question,
  runLockableInterview,
  collectSourceFiles,
  extractCompact,
};

/**
 * runner-utils.js — Shared utilities for all division runners.
 *
 * Provides file I/O helpers, Claude subprocess wrappers, and terminal
 * formatting used identically across run-design.js, run-build.js,
 * run-review.js, and run-security.js.
 */

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

// ---------------------------------------------------------------------------
// Claude subprocess wrappers
// ---------------------------------------------------------------------------

// Low-level — pass args array and stdin string, returns stdout string.
function claudeRaw(args, input) {
  const result = spawnSync("claude", args, {
    input,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `claude exited with status ${result.status}`);
  return result.stdout.trim();
}

// Structured JSON call — returns parsed response, optionally reports usage.
function claudeCall(systemPrompt, userMessage, onUsage) {
  const raw = claudeRaw(
    ["-p", "--system-prompt", systemPrompt, "--output-format", "json"],
    userMessage
  );
  const envelope = JSON.parse(raw);
  if (onUsage && envelope.usage) onUsage(envelope.usage);
  let text = envelope.result ?? envelope;
  if (typeof text === "string") {
    text = stripCodeFence(text);
    try { return JSON.parse(text); } catch {
      // Agent may have wrapped JSON in surrounding text — extract the outermost object/array
      const m = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (m) { try { return JSON.parse(m[1]); } catch {} }
      return text;
    }
  }
  return text;
}

// Async tool-use call — non-blocking, resolves when claude exits. Reports usage via callback.
function claudeToolCallAsync(appendSystemPrompt, userMessage, cwd, onUsage) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--dangerously-skip-permissions", "--append-system-prompt", appendSystemPrompt,
       "--output-format", "json"],
      { cwd, stdio: ["pipe", "pipe", "pipe"] }
    );

    proc.stdin.write(userMessage, "utf8");
    proc.stdin.end();

    let stdout = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.stderr.on("data", () => {});

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with status ${code}`));
      } else {
        try {
          const envelope = JSON.parse(stdout.trim());
          if (onUsage && envelope.usage) onUsage(envelope.usage);
        } catch {}
        resolve();
      }
    });

    proc.on("error", reject);
  });
}

// Tool-use call — uses --dangerously-skip-permissions, writes files via tools.
function claudeToolCall(appendSystemPrompt, userMessage, cwd) {
  const result = spawnSync(
    "claude",
    ["-p", "--dangerously-skip-permissions", "--append-system-prompt", appendSystemPrompt],
    { input: userMessage, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, cwd }
  );
  if (result.error) throw result.error;
  return result.stdout.trim();
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
  claudeRaw, claudeCall, claudeToolCall, claudeToolCallAsync,
  collectSourceFiles,
  extractCompact,
};

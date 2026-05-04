"use strict";

/**
 * adapters/claude-cli.js — Execution adapter for the Claude CLI.
 *
 * The single module that knows how to invoke Claude as a subprocess.
 * All Claude calls in the factory go through here.
 *
 * Future adapters (claude-api.js, local.js) implement the same interface:
 *   claudeRaw(args, input) → string
 *   claudeCall(systemPrompt, userMessage, onUsage) → parsed JSON
 *   claudeTurn(systemPrompt, history, onUsage) → string
 *   claudeToolCall(appendSystemPrompt, userMessage, cwd) → string
 *   claudeToolCallAsync(appendSystemPrompt, userMessage, cwd, onUsage) → Promise<void>
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Windows command-line limit is 32,767 chars. Keep well below it.
const WIN_CMDLINE_LIMIT = 28000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripCodeFence(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

const CLAUDE_TIMEOUT_MS = 8 * 60 * 1000;  // 8 minutes  (structured JSON calls)
const CLAUDE_TOOL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes (tool-use / coder calls)
const CLAUDE_MAX_RETRIES = 2;

// Build args, writing system prompt to a temp file if it exceeds the Windows command line limit.
function buildArgs(baseArgs) {
  if (process.platform !== "win32") return { args: baseArgs, cleanup: () => {} };
  const spIdx = baseArgs.indexOf("--system-prompt");
  if (spIdx === -1) return { args: baseArgs, cleanup: () => {} };
  const prompt = baseArgs[spIdx + 1];
  if (!prompt || (baseArgs.join(" ").length < WIN_CMDLINE_LIMIT)) return { args: baseArgs, cleanup: () => {} };
  const tmp = path.join(os.tmpdir(), `claude-sp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmp, prompt, "utf8");
  const newArgs = [...baseArgs];
  newArgs.splice(spIdx, 2, "--system-prompt-file", tmp);
  return { args: newArgs, cleanup: () => { try { fs.unlinkSync(tmp); } catch {} } };
}

// Low-level — pass args array and stdin string, returns stdout string.
function claudeRaw(args, input, attempt = 1) {
  const { args: resolvedArgs, cleanup } = buildArgs(args);
  const result = spawnSync("claude", resolvedArgs, {
    input,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    timeout: CLAUDE_TIMEOUT_MS,
  });
  cleanup();
  if (result.error) {
    if (result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      if (attempt < CLAUDE_MAX_RETRIES) {
        process.stderr.write(`[claude-cli] Call timed out after ${CLAUDE_TIMEOUT_MS / 1000}s — retrying (attempt ${attempt + 1}/${CLAUDE_MAX_RETRIES})…\n`);
        return claudeRaw(args, input, attempt + 1);
      }
      throw new Error(`claude CLI timed out after ${CLAUDE_MAX_RETRIES} attempts`);
    }
    throw result.error;
  }
  if (result.signal === "SIGTERM") {
    if (attempt < CLAUDE_MAX_RETRIES) {
      process.stderr.write(`[claude-cli] Call timed out after ${CLAUDE_TIMEOUT_MS / 1000}s — retrying (attempt ${attempt + 1}/${CLAUDE_MAX_RETRIES})…\n`);
      return claudeRaw(args, input, attempt + 1);
    }
    throw new Error(`claude CLI timed out after ${CLAUDE_MAX_RETRIES} attempts`);
  }
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

// Multi-turn interview call — plain text response with optional usage tracking.
function claudeTurn(systemPrompt, history, onUsage) {
  const turns = history
    .map((m) => `${m.role === "assistant" ? "Agent" : "User"}: ${m.content}`)
    .join("\n\n");
  const input = history.length === 0 ? "Begin." : `${turns}\n\nRespond as the Agent.`;
  const raw = claudeRaw(["-p", "--system-prompt", systemPrompt, "--output-format", "json"], input);
  const envelope = JSON.parse(raw);
  if (onUsage && envelope.usage) onUsage(envelope.usage);
  const text = envelope.result ?? "";
  return typeof text === "string" ? text.trim() : String(text);
}

// Sync tool-use call — uses --dangerously-skip-permissions, writes files via tools.
function claudeToolCall(appendSystemPrompt, userMessage, cwd) {
  const result = spawnSync(
    "claude",
    ["-p", "--dangerously-skip-permissions", "--append-system-prompt", appendSystemPrompt],
    { input: userMessage, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, cwd, windowsHide: true, timeout: CLAUDE_TIMEOUT_MS }
  );
  if (result.error) throw result.error;
  return result.stdout.trim();
}

// Async structured JSON call — same interface as claudeCall but non-blocking.
// Use this when the calling process has no console (e.g. launched with stdio:"ignore").
function claudeCallAsync(systemPrompt, userMessage, onUsage) {
  return new Promise((resolve, reject) => {
    const { args, cleanup } = buildArgs(["-p", "--system-prompt", systemPrompt, "--output-format", "json"]);
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    proc.stdin.write(userMessage, "utf8");
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.stderr.on("data", (c) => { stderr += c; });

    proc.on("close", (code) => {
      if (code !== 0) { reject(new Error(`claude exited with status ${code}: ${stderr.trim().slice(0, 500)}`)); return; }
      try {
        const envelope = JSON.parse(stdout.trim());
        if (onUsage && envelope.usage) onUsage(envelope.usage);
        let text = envelope.result ?? envelope;
        if (typeof text === "string") {
          text = stripCodeFence(text);
          try { resolve(JSON.parse(text)); return; } catch {}
          const m = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
          if (m) { try { resolve(JSON.parse(m[1])); return; } catch {} }
          resolve(text);
        } else {
          resolve(text);
        }
      } catch (e) { reject(e); }
    });

    proc.on("error", (e) => { cleanup(); reject(e); });
  });
}

// Async tool-use call — non-blocking, resolves when claude exits.
function claudeToolCallAsync(appendSystemPrompt, userMessage, cwd, onUsage) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--dangerously-skip-permissions", "--append-system-prompt", appendSystemPrompt,
       "--output-format", "json"],
      { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );

    proc.stdin.write(userMessage, "utf8");
    proc.stdin.end();

    let stdout = "";
    let settled = false;
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.stderr.on("data", () => {});

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`claude CLI timed out after ${CLAUDE_TOOL_TIMEOUT_MS / 1000}s`));
    }, CLAUDE_TOOL_TIMEOUT_MS);

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { claudeRaw, claudeCall, claudeCallAsync, claudeTurn, claudeToolCall, claudeToolCallAsync };

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripCodeFence(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Adapter interface
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
    { input: userMessage, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, cwd }
  );
  if (result.error) throw result.error;
  return result.stdout.trim();
}

// Async tool-use call — non-blocking, resolves when claude exits.
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

module.exports = { claudeRaw, claudeCall, claudeTurn, claudeToolCall, claudeToolCallAsync };

/**
 * display.js — Terminal display helpers for factory runners.
 *
 * Provides a pinned header with a live timer and a scroll region below it.
 * The header stays fixed at the top while agent output streams underneath.
 *
 * Usage:
 *   const { createPhaseDisplay, agentStream } = require('./display');
 *
 *   const display = createPhaseDisplay('Phase 5: Verification', '17 criteria');
 *   await agentStream(systemPrompt, userMessage, cwd, display);
 *   display.finish('17/17 passed');
 */

const { spawn } = require("child_process");

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b";
const A = {
  saveCursor:        `${ESC}7`,
  restoreCursor:     `${ESC}8`,
  moveTo:    (r, c) => `${ESC}[${r};${c}H`,
  clearLine:         `${ESC}[2K`,
  clearToEnd:        `${ESC}[J`,
  scrollRegion: (t, b) => `${ESC}[${t};${b}r`,
  resetScroll:       `${ESC}[r`,
  bold:   (s) => `${ESC}[1m${s}${ESC}[0m`,
  dim:    (s) => `${ESC}[2m${s}${ESC}[0m`,
  cyan:   (s) => `${ESC}[36m${s}${ESC}[0m`,
  green:  (s) => `${ESC}[32m${s}${ESC}[0m`,
  yellow: (s) => `${ESC}[33m${s}${ESC}[0m`,
  red:    (s) => `${ESC}[31m${s}${ESC}[0m`,
};

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[mGKHJr]/g, "").replace(/\x1b[78]/g, "");
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const HEADER_ROWS = 5; // rows reserved: divider, dept, phase+timer, status, divider

// ---------------------------------------------------------------------------
// Phase display — pinned header with live timer
// ---------------------------------------------------------------------------

// createPhaseDisplay(department, phaseName, phaseStep, subtitle)
//   department  "Build" | "Review" | "Security" | "Design"
//   phaseName   e.g. "Verification", "Explorer"
//   phaseStep   e.g. "5 of 6"  (overall phase position, shown dim)
//   subtitle    initial status line text (updatable via display.update())
function createPhaseDisplay(department, phaseName, phaseStep = "", subtitle = "", opts = {}) {
  const startTime = Date.now();
  const rows = process.stdout.rows || 40;
  let currentStatus = subtitle;
  let finished = false;

  function width() { return process.stdout.columns || 100; }

  function renderHeader(overrideStatus) {
    const w = width();
    const elapsed = formatElapsed(Date.now() - startTime);
    const status = overrideStatus !== undefined ? overrideStatus : currentStatus;

    // Row 2: department
    const deptLine = `  ${A.bold(department)} Department`;

    // Row 3: phase name + step counter (left) and timer (right)
    const phaseLeft  = `  ${A.bold(phaseName)}${phaseStep ? `  ${A.dim(phaseStep)}` : ""}`;
    const phaseRight = `  ⏱  ${A.cyan(elapsed)}  `;
    const phaseGap   = Math.max(1, w - stripAnsi(phaseLeft).length - stripAnsi(phaseRight).length);

    // Row 4: status / sub-step
    const statusLine = status ? `  ${A.dim("↪")} ${A.dim(status)}` : "";

    process.stdout.write(
      A.saveCursor +
      A.moveTo(1, 1) + A.clearLine + "─".repeat(w) +
      A.moveTo(2, 1) + A.clearLine + deptLine +
      A.moveTo(3, 1) + A.clearLine + phaseLeft + " ".repeat(phaseGap) + phaseRight +
      A.moveTo(4, 1) + A.clearLine + statusLine +
      A.moveTo(5, 1) + A.clearLine + "─".repeat(w) +
      A.restoreCursor
    );
  }

  // Initial draw — reset any prior scroll region, clear top, print header, set scroll region
  process.stdout.write(
    A.resetScroll +
    A.moveTo(1, 1) + A.clearToEnd
  );
  renderHeader();
  process.stdout.write(
    A.scrollRegion(HEADER_ROWS + 1, rows) +
    A.moveTo(HEADER_ROWS + 1, 1)
  );

  const interval = setInterval(() => { if (!finished) renderHeader(); }, 1000);

  // Restore terminal on exit so the shell prompt isn't broken
  function cleanup() {
    clearInterval(interval);
    process.removeListener("SIGINT", sigintHandler);
    process.stdout.write(A.resetScroll + A.moveTo(rows, 1) + "\n");
  }
  function sigintHandler() {
    cleanup();
    process.exit(130); // conventional exit code for Ctrl+C
  }
  process.once("exit", cleanup);
  process.on("SIGINT", sigintHandler);

  return {
    update(status) {
      currentStatus = status;
      renderHeader();
    },

    log(line) {
      // Write a line to the scroll region (cursor is already there)
      process.stdout.write(line + "\n");
    },

    finish(summary) {
      finished = true;
      clearInterval(interval);
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", sigintHandler);
      const elapsedMs = Date.now() - startTime;
      const elapsed = formatElapsed(elapsedMs);
      if (opts.onFinish) opts.onFinish(elapsedMs);
      // Show ✓ summary on the status line (row 4) by passing as overrideStatus
      currentStatus = `${A.green("✓")} ${summary || "done"}  —  ${elapsed}`;
      renderHeader(currentStatus);
      // Reset scroll region so the next phase (or plain console output) starts clean.
      process.stdout.write(A.resetScroll + A.moveTo(rows, 1) + "\n");
    },

    stop() {
      finished = true;
      clearInterval(interval);
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", sigintHandler);
      process.stdout.write(A.resetScroll + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming agent call — stream-json parsed into readable lines
// ---------------------------------------------------------------------------

function agentStream(appendSystemPrompt, userMessage, cwd, display, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--verbose", "--dangerously-skip-permissions",
       "--append-system-prompt", appendSystemPrompt,
       "--output-format", "stream-json"],
      { cwd, stdio: ["pipe", "pipe", "pipe"] }
    );

    proc.stdin.write(userMessage, "utf8");
    proc.stdin.end();

    let buf = "";

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          formatStreamEvent(event, display);
          if (event.type === "result" && event.usage && opts.onUsage) {
            opts.onUsage(event.usage);
          }
        } catch {
          if (line.trim()) display.log(A.dim("  " + line.trim()));
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      display.log(A.red("  " + chunk.toString().trim()));
    });

    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited with status ${code}`));
      else resolve();
    });

    proc.on("error", reject);
  });
}

function formatStreamEvent(event, display) {
  switch (event.type) {
    case "system":
      // Skip init noise
      break;

    case "assistant": {
      const content = event.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          for (const line of block.text.trim().split("\n")) {
            if (line.trim()) display.log(A.dim("  " + line.trim()));
          }
        } else if (block.type === "tool_use") {
          const name = block.name;
          const input = block.input ?? {};
          let detail = "";
          if (name === "Bash") {
            detail = (input.command || "").split("\n")[0].slice(0, 120);
          } else if (name === "Write" || name === "Edit") {
            detail = input.file_path ?? input.path ?? "";
          } else if (name === "Read") {
            detail = input.file_path ?? input.path ?? "";
          } else {
            detail = JSON.stringify(input).slice(0, 100);
          }
          display.log(`  ${A.dim("→")} ${A.cyan(name)}: ${detail}`);
        }
      }
      break;
    }

    case "tool": {
      const tool = event.tool ?? event;
      const name = tool.name ?? event.name;
      const input = tool.input ?? event.input ?? {};
      let detail = "";

      if (name === "Bash") {
        detail = (input.command || "").split("\n")[0].slice(0, 120);
      } else if (name === "Write" || name === "Edit") {
        detail = input.file_path ?? input.path ?? "";
      } else if (name === "Read") {
        detail = input.file_path ?? input.path ?? "";
      } else {
        detail = JSON.stringify(input).slice(0, 100);
      }

      display.log(`  ${A.dim("→")} ${A.cyan(name)}: ${detail}`);
      break;
    }

    case "tool_result": {
      const content = Array.isArray(event.content)
        ? event.content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("")
        : String(event.content ?? "");
      const isError = event.is_error === true || content.toLowerCase().startsWith("error");
      const preview = content.split("\n").filter(Boolean)[0]?.slice(0, 120) ?? "(no output)";
      const symbol = isError ? A.red("✗") : A.green("✓");
      display.log(`  ${symbol} ${A.dim(preview)}`);
      break;
    }

    case "result":
      // Final result line — agent's last output
      if (event.result?.trim()) {
        display.log(`\n  ${A.bold(event.result.trim())}`);
      }
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Simple ticker for phases without a full display (non-interactive blocking)
// ---------------------------------------------------------------------------

function createTicker(label) {
  const start = Date.now();
  process.stdout.write(`  ${label}...`);
  const interval = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${label}... ${s}s`);
  }, 1000);

  return {
    done(summary) {
      clearInterval(interval);
      const s = Math.floor((Date.now() - start) / 1000);
      process.stdout.write(`\r  ${A.green("✓")} ${summary || label} (${s}s)\n`);
    },
    fail(reason) {
      clearInterval(interval);
      process.stdout.write(`\r  ${A.red("✗")} ${reason}\n`);
    },
  };
}

module.exports = { createPhaseDisplay, agentStream, createTicker, A, formatElapsed };

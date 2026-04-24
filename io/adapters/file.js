"use strict";

const fs = require("fs");
const path = require("path");

function fileAdapter(runDir) {
  const pendingPath = path.join(runDir, "pending-input.json");
  const responsePath = path.join(runDir, "input-response.json");
  let pollTimer = null;

  return {
    turn(prompt, opts = {}) {
      const display = opts.context ?? prompt;
      const payload = { prompt: display, ts: new Date().toISOString() };
      if (opts.options && opts.options.length > 0) {
        payload.type = opts.hybrid ? "hybrid" : "options";
        payload.options = opts.options;
      } else {
        payload.type = "text";
      }
      fs.writeFileSync(pendingPath, JSON.stringify(payload), "utf8");

      return new Promise((resolve) => {
        pollTimer = setInterval(() => {
          if (!fs.existsSync(responsePath)) return;
          try {
            const data = JSON.parse(fs.readFileSync(responsePath, "utf8"));
            clearInterval(pollTimer);
            pollTimer = null;
            try { fs.unlinkSync(pendingPath); } catch {}
            try { fs.unlinkSync(responsePath); } catch {}
            resolve(data.response ?? "");
          } catch {
            // File not fully written yet — keep polling
          }
        }, 500);
      });
    },

    close() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      try { if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath); } catch {}
    },
  };
}

module.exports = { fileAdapter };

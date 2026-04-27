"use strict";

/**
 * workers.js — Worker agent data layer for the Software Factory.
 *
 * Workers live in workers/<id>/worker.json + workers/<id>/prompt.md.
 * They fill named slots in department schemas (e.g. "build.coder").
 * At runtime, a factory profile's workerAssignments maps slot keys to
 * worker IDs; the dept runner reads worker-assignments.json from the
 * run dir to resolve which prompt to use for each slot.
 */

const fs   = require("fs");
const path = require("path");

const ROOT        = path.join(__dirname, "..");
const WORKERS_DIR = path.join(ROOT, "workers");

let _workers = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadWorkers() {
  if (_workers) return _workers;
  _workers = {};
  if (!fs.existsSync(WORKERS_DIR)) return _workers;
  for (const id of fs.readdirSync(WORKERS_DIR)) {
    const wjson = path.join(WORKERS_DIR, id, "worker.json");
    if (!fs.existsSync(wjson)) continue;
    try {
      const w = JSON.parse(fs.readFileSync(wjson, "utf8"));
      _workers[w.id] = w;
    } catch {}
  }
  return _workers;
}

function reloadWorkers() {
  _workers = null;
  return loadWorkers();
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function promptPath(workerOrId) {
  const id = typeof workerOrId === "string" ? workerOrId : workerOrId.id;
  return path.join(WORKERS_DIR, id, "prompt.md");
}

// Resolves the full path to a worker's prompt, respecting sourceFile for
// built-in workers that point back to a dept .md file.
function resolvedPromptPath(worker) {
  if (typeof worker === "string") {
    const loaded = loadWorkers()[worker];
    if (!loaded) return promptPath(worker);
    worker = loaded;
  }
  if (worker.sourceFile) return path.join(ROOT, worker.sourceFile);
  return promptPath(worker);
}

function promptExists(workerOrId) {
  if (typeof workerOrId === "string") {
    const w = loadWorkers()[workerOrId];
    if (w) return fs.existsSync(resolvedPromptPath(w));
    return fs.existsSync(promptPath(workerOrId));
  }
  return fs.existsSync(resolvedPromptPath(workerOrId));
}

function readPrompt(workerOrId) {
  return fs.readFileSync(resolvedPromptPath(workerOrId), "utf8");
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function addWorker(workerData) {
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
  const dir = path.join(WORKERS_DIR, workerData.id);
  if (fs.existsSync(dir)) throw new Error(`Worker already exists: ${workerData.id}`);
  fs.mkdirSync(dir, { recursive: true });

  const worker = {
    id:          workerData.id,
    name:        workerData.name,
    description: workerData.description ?? "",
    slotType:    workerData.slotType,
    department:  workerData.department ?? null,
    created:     new Date().toISOString(),
  };

  fs.writeFileSync(path.join(dir, "worker.json"), JSON.stringify(worker, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "prompt.md"), workerData.prompt ?? "", "utf8");

  _workers = null;
  return worker;
}

// ---------------------------------------------------------------------------
// Runtime slot resolution
// ---------------------------------------------------------------------------

// Returns the prompt content for a given slot key (e.g. "build.coder").
//
// Resolution order:
//   1. Profile worker assignment from runs/<runId>/worker-assignments.json
//   2. Slot's default worker from the dept schema.json
//
// Throws if no prompt can be resolved — fail fast rather than silently.
function resolveSlotPrompt(runDir, slotKey) {
  // 1. Check profile assignment
  try {
    const assignPath = path.join(runDir, "worker-assignments.json");
    if (fs.existsSync(assignPath)) {
      const assignments = JSON.parse(fs.readFileSync(assignPath, "utf8"));
      const workerId = assignments[slotKey];
      if (workerId && promptExists(workerId)) return readPrompt(workerId);
    }
  } catch {}

  // 2. Schema default worker
  const [dept, slotId] = slotKey.split(".");
  try {
    const schemaPath = path.join(ROOT, "departments", dept, "schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const slot = (schema.slots ?? []).find((s) => s.id === slotId);
    if (slot?.default && promptExists(slot.default)) return readPrompt(slot.default);
  } catch {}

  throw new Error(`No prompt found for slot "${slotKey}" — check schema.json default and workers/ directory.`);
}

// ---------------------------------------------------------------------------
// Slot catalogue (from dept schemas)
// ---------------------------------------------------------------------------

function listSlotTypes() {
  const deptsDir = path.join(ROOT, "departments");
  const slots = [];
  if (!fs.existsSync(deptsDir)) return slots;
  for (const dept of fs.readdirSync(deptsDir)) {
    const schemaPath = path.join(deptsDir, dept, "schema.json");
    if (!fs.existsSync(schemaPath)) continue;
    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      for (const slot of (schema.slots ?? [])) {
        slots.push({ ...slot, department: dept, key: `${dept}.${slot.id}` });
      }
    } catch {}
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Context builder for HR interviews
// ---------------------------------------------------------------------------

function buildCreateWorkerContext() {
  const slots = listSlotTypes();
  const workers = loadWorkers();

  const workersBySlot = {};
  for (const w of Object.values(workers)) {
    const key = `${w.department}.${w.slotType}`;
    if (!workersBySlot[key]) workersBySlot[key] = [];
    workersBySlot[key].push(w);
  }

  const slotLines = slots.map((s) => {
    const existing = (workersBySlot[s.key] ?? []).map((w) => w.name).join(", ");
    const note = existing ? `  *(existing: ${existing})*` : "";
    return `- **${s.key}** — ${s.name}: ${s.description}${note}`;
  });

  return [
    "## Factory Context",
    "",
    "### Available Slots",
    "",
    slotLines.join("\n") || "_(no slots defined yet)_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadWorkers,
  reloadWorkers,
  addWorker,
  promptPath,
  promptExists,
  readPrompt,
  resolveSlotPrompt,
  listSlotTypes,
  buildCreateWorkerContext,
  WORKERS_DIR,
};

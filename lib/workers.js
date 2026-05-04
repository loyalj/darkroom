"use strict";

/**
 * workers.js — Worker agent data layer for Darkroom.
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

function resolvedPromptPath(worker) {
  if (typeof worker === "string") {
    const loaded = loadWorkers()[worker];
    if (!loaded) return promptPath(worker);
    worker = loaded;
  }
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

// Reads the slot base prompt from departments/{dept}/{slotId}.base.md, if it exists.
function readSlotBase(dept, slotId) {
  const basePath = path.join(ROOT, "departments", dept, `${slotId}.base.md`);
  return fs.existsSync(basePath) ? fs.readFileSync(basePath, "utf8") : null;
}

// Merges a slot base prompt with a custom worker persona.
// Base covers factory I/O; persona covers character, expertise, and style.
function mergeBaseAndPersona(base, persona) {
  if (!base) return persona;
  return `${base.trimEnd()}\n\n---\n\n${persona.trimStart()}`;
}

// Returns the merged prompt for a given slot key (e.g. "build.coder").
// Resolution order:
//   1. Profile worker assignment from runs/<runId>/worker-assignments.json
//   2. Slot's default worker from the dept schema.json
// Every worker's prompt.md is persona-only; the slot's base.md is prepended at runtime.
// Throws if no prompt can be resolved — fail fast rather than silently.
function resolveSlotPrompt(runDir, slotKey) {
  const [dept, slotId] = slotKey.split(".");

  // 1. Check profile assignment
  try {
    const assignPath = path.join(runDir, "worker-assignments.json");
    if (fs.existsSync(assignPath)) {
      const assignments = JSON.parse(fs.readFileSync(assignPath, "utf8"));
      const workerId = assignments[slotKey];
      if (workerId) {
        const worker = loadWorkers()[workerId];
        if (worker && promptExists(worker)) {
          return mergeBaseAndPersona(readSlotBase(dept, slotId), readPrompt(worker));
        }
      }
    }
  } catch {}

  // 2. Schema default worker
  try {
    const schemaPath = path.join(ROOT, "departments", dept, "schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const slot = (schema.slots ?? []).find((s) => s.id === slotId);
    if (slot?.default) {
      const worker = loadWorkers()[slot.default];
      if (worker && promptExists(worker)) {
        return mergeBaseAndPersona(readSlotBase(dept, slotId), readPrompt(worker));
      }
    }
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
    const existingNote = existing ? `  *(existing: ${existing})*` : "";
    const hasBase = fs.existsSync(path.join(ROOT, "departments", s.department, `${s.id}.base.md`));
    const baseNote = hasBase ? " ✓" : "";
    return `- **${s.key}**${baseNote} — ${s.name}: ${s.description}${existingNote}`;
  });

  return [
    "## Factory Context",
    "",
    "### Available Slots",
    "",
    "Slots marked ✓ have factory I/O already defined — inputs, output format, and completion signals are",
    "injected automatically at runtime. For these slots, **design only the persona**: the worker's",
    "expertise, character, work style, and specific technical opinions. Do not describe how inputs",
    "arrive or how to signal completion — that is handled by the factory infrastructure.",
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

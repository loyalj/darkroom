# Software Factory — Roadmap

A living document tracking planned structural changes and feature evolution.
Update this as decisions are made or plans change.

---

## Context

The factory is a multi-agent Claude pipeline: concept → shippable artifact across four hardcoded
divisions (Design, Build, Review, Security). A `brain.md` profile drives autonomous decisions with
human escalation as fallback. The work below is in two categories: **cleanup** (restructuring what
exists) and **evolution** (new capabilities).

---

## Target Directory Structure

```
dark-room/
  run-factory.js              ← user entry point
  run-gui.js                  ← user entry point
  inspect.js                  ← user entry point

  profiles/                   ← pipeline graph templates
    full.json
    incremental.json          (Build → Review → Security)
    security-audit.json
    code-review.json

  departments/                ← division runners (spawned by factory, not run directly)
    run-design.js
    run-build.js
    run-review.js
    run-security.js

  agents/                     ← agent prompts (unchanged)
    build/ design/ review/ security/ leadership/ shared/ caveman/

  lib/                        ← shared internal library
    runner-utils.js           (file IO, string helpers, interview loop — no execution logic)
    display.js
    token-log.js

  io/                         ← user I/O adapters (unchanged structure)
    adapters/cli.js
    adapters/file.js
    interaction.js

  adapters/                   ← execution adapters (how agents are invoked)
    claude-cli.js             (current behavior, extracted from runner-utils)
    claude-api.js             (future)
    local.js                  (future)

  org/                        ← org chart: brain definitions + role memory
    ceo/
      brain.md                (current brain.md — cross-cutting decisions)
      brain-config.json       (generated from interview)
      brain.example.md
      memory/                 (role decision ledger)
    cto/                      (future — technical decisions)
      memory/
    cmo/                      (future — copy/brand decisions)
      memory/

  memory/                     ← department craft wikis (persistent, accumulated per run)
    design/
    build/
    review/
    security/

  public/                     ← frontend (unchanged)
    app.js  index.html  style.css

  runs/                       ← runtime data (gitignored)
  accounts/                   ← token ledger (gitignored)

  package.json  README.md  ORCHESTRATOR.md  ROADMAP.md
```

---

## Phased Plan

### Phase 1 — Directory Restructure ✓ COMPLETE
**Type:** Pure mechanical repositioning. No logic changes, no behavior changes.
**Risk:** Low. Fully reviewable as a single diff.
**Completed:** 2026-04-24

Steps completed:
- Created `departments/`, moved `run-design/build/review/security.js` into it
- Created `lib/`, moved `runner-utils.js`, `display.js`, `token-log.js` into it
- Created `org/ceo/`, moved `brain.md`, `brain-config.json`, `brain.example.md`,
  `brain-transcript.md`, `brain-token-usage.jsonl` into it
- Created empty `profiles/`, `adapters/`, `memory/{design,build,review,security}/`,
  `org/cto/`, `org/cmo/`
- Updated all `require()` paths in every runner and entry point
- Updated `run-factory.js` spawn references: `"run-build.js"` → `"departments/run-build.js"` etc.
- Updated `BRAIN_PATH`, `AGENTS_DIR`, `RUNS_DIR` constants in all affected files
- Updated `run-gui.js` `brain-config.json` path → `org/ceo/brain-config.json`
- Updated user-facing help text in department runners (remediation/next-step messages)

Everything runs identically after this phase. Clean stopping point.

---

### Phase 2 — Execution Adapter Extraction ✓ COMPLETE
**Type:** Refactor with a clear seam. Prerequisite for future adapter swapping.
**Risk:** Medium. Significant file movement but no logic changes.
**Depends on:** Phase 1
**Completed:** 2026-04-24

Steps completed:
- Created `adapters/claude-cli.js` with `claudeRaw`, `claudeCall`, `claudeTurn`,
  `claudeToolCall`, `claudeToolCallAsync`; `stripCodeFence` kept as internal helper
- Removed all Claude functions from `lib/runner-utils.js`; removed `spawn`/`spawnSync` imports
- `runner-utils.js` now requires `claudeTurn` from the adapter internally (for `runLockableInterview`)
- Updated all 5 consumers to split their require: IO/utils from `lib/runner-utils`,
  Claude calls from `adapters/claude-cli`
  - `run-factory.js`: `claudeRaw`, `claudeCall`, `claudeTurn`
  - `departments/run-build.js`: `claudeRaw`, `claudeCall`, `claudeTurn`, `claudeToolCallAsync`
  - `departments/run-design.js`: `claudeCall`, `claudeTurn`
  - `departments/run-review.js`: `claudeCall`, `claudeToolCallAsync`
  - `departments/run-security.js`: `claudeCall`

---

### Phase 3 — Pipeline Graph: Schema Design
**Type:** Design work. No code.
**Depends on:** Phase 1 complete, clear head

The goal is to encode the hardcoded Design → Build → Review → Security sequence as a
data-driven directed graph. Before coding, the schema and routing protocol need to be decided.

#### Current hardcoded handoffs to make explicit

**What Design produces** (consumed by downstream departments):
```
handoff/factory-manifest.json   → factory, build, review, security
handoff/build-spec.md           → build
handoff/review-spec.md          → review
handoff/runtime-spec.md         → review, security
```

**What Build produces**:
```
artifact/                       → review, security
artifact/MANIFEST.txt           → factory skip signal ("build already done")
```

**Backward edge context** (failure loops):
```
failure-reports/*.json          → review → build
security-remediations/remediation-requests.md  → security → build
```

These contracts are implicit conventions across all runners. They need to be captured in the
schema — at minimum as skip conditions and edge context annotations.

#### Routing protocol decision

Two mechanisms already exist for signaling department outcomes:
- **Exit codes**: 0 = success, 1 = blocked, 43 = verification needs human input
- **Log events**: `ship-approved`, `ship-rejected-no-ship`, `security-rejected`, etc.

**Decision: use log events as edge routing conditions.** They are already semantic, already
written by departments before exit, and already the source of truth the factory reads. Mapping
edge conditions to log event names gives the executor a clean protocol without adding new surface
area to departments.

#### Recommended schema approach: shallow graph (Option A)

The profile defines execution order and routing conditions. Departments still reach into
`runs/{id}/` with their own knowledge of what to look for. Contracts are annotated but not
enforced by the executor (that comes later if needed).

```json
{
  "id": "full",
  "name": "Full Factory Run",
  "nodes": [
    { "id": "design",   "runner": "departments/run-design.js",   "skipIf": "handoff/build-spec.md" },
    { "id": "build",    "runner": "departments/run-build.js",    "skipIf": "artifact/MANIFEST.txt" },
    { "id": "review",   "runner": "departments/run-review.js" },
    { "id": "security", "runner": "departments/run-security.js" }
  ],
  "edges": [
    { "from": "design",   "to": "build",    "type": "forward" },
    { "from": "build",    "to": "review",   "type": "forward" },
    { "from": "review",   "to": "security", "type": "forward",  "on": "ship-approved" },
    { "from": "review",   "to": "build",    "type": "backward", "on": "ship-rejected-no-ship", "context": "failure-reports/" },
    { "from": "security", "to": "build",    "type": "backward", "on": "security-rejected",      "context": "security-remediations/", "maxLoops": "config.maxLoopsBeforeEscalate" }
  ],
  "budgetCheckpoints": ["after:build", "after:review", "after:security"]
}
```

Open questions to resolve during schema design:
- How is `--stop-after` expressed in the graph model? (Probably a runtime flag, not a profile property)
- How does the `verification-feedback` loop (exit code 43, build-internal) fit? It's a loop
  *inside* a node rather than between nodes — may stay as internal runner logic
- How are `budgetCheckpoints` declared — per edge, per node, or a separate list?
- Does `skipIf` check file existence, or should it read the log for a completion event?

---

### Phase 4 — Pipeline Graph: Executor + `full.json`
**Type:** Implementation.
**Depends on:** Phase 3 schema finalized

Build the graph executor in `lib/graph.js` (or `lib/graph/` if it grows):

Responsibilities:
- Load and validate a profile JSON
- Walk nodes in topological order
- Check skip conditions before running each node
- Run each node via `runDivision` / `runDivisionAuto` (same as current)
- After each node exits, read the log to determine which outgoing edge to follow
- Track backward edge loop counts; fire escalation when limit hit
- Fire budget checkpoints at declared points

`run-factory.js` becomes thin: parse args, load profile, hand to executor.

Translate the current hardcoded factory sequence into `profiles/full.json`. All existing behavior
must be preserved exactly — this is a refactor, not a feature.

---

### Phase 5 — Pipeline Graph: Second Profile Validation
**Type:** Validation.
**Depends on:** Phase 4

Add `profiles/incremental.json` (Build → Review → Security — no Design node). If implementing
this profile requires touching department runners, the handoff contracts aren't clean enough and
need to be addressed before more profiles are added.

This phase proves the graph generalizes. If it's clean, the graph model is correct. If it
requires hacks, Phase 3 needs revisiting.

---

### Phase 6 — Memory Wiki Infrastructure
**Type:** New feature. Non-breaking addition.
**Depends on:** Phase 1 (directories exist)

Add read/write logic for department memory wikis (`memory/{dept}/`) and role memory
(`org/{role}/memory/`). At the end of each run, departments append to their wiki with patterns,
gotchas, and outcomes. At the start of each run, relevant wiki entries are injected into agent
context.

Design questions to resolve:
- What format? Append-only `.md` files, or structured `.jsonl` for queryability?
- What triggers a write? End of department run, or specific agent signal?
- How is context injection scoped — full wiki, or a recency/relevance slice?
- Memory hygiene: how does stale or noisy content get pruned?

---

### Phase 7 — Org Chart: Specialist Brains
**Type:** New feature. Extends brain system.
**Depends on:** Phase 6 (role memory infrastructure exists)

Introduce specialist brains alongside the current CEO-brain:

- **CTO-brain** (`org/cto/brain.md`) — technical decisions: architecture, stack, patterns
- **CMO-brain** (`org/cmo/brain.md`) — copy voice, brand, UX decisions
- **CEO-brain** (`org/ceo/brain.md`) — cross-cutting calls (current `brain.md`, unchanged)

The pipeline agent escalates to the domain-appropriate specialist rather than always to the
CEO-brain. Most decisions never leave their domain. The CEO-brain and human are last resort.

Each specialist brain has its own memory wiki (role decision ledger) that sharpens through use.
The same specialist brains built here carry into the control plane when that layer is built —
same entities, broader invocation context.

---

## Evolution Concepts (Future Horizons)

These are not scheduled. Documented here for context on why the above decisions were made the way
they were.

**Adapter abstraction** — Phase 2 lays the groundwork. Once `adapters/claude-cli.js` exists,
routing cheap tasks to a local model or expensive ones to the API is an import swap. Cost routing
becomes practical.

**Control plane** — A persistent task queue (SQLite) and ticket-triggered runs. The GUI launcher
is the first piece (in progress). Extends the org chart and specialist brains from the Factory
track — same brains, broader invocation context.

**Run profiles as shareable artifacts** — well-tuned profiles ("SaaS MVP", "security audit for
Express apps") have distribution value. Natural story once the graph model is stable.

**Self-improvement** — The factory running a modification on its own pipeline code or agent
prompts, then validating against a test harness. Prerequisites: modularity (Phases 1–2), memory
wiki (Phase 6), org chart governance (Phase 7), and a curated benchmark of known-good runs.
Agent prompts in `agents/` are already discrete markdown files — they are natural artifacts for a
self-improvement run profile to treat as the thing being reviewed and improved.

**Versioning and migration** — persistent memory wikis and brain profiles are stateful data
outside the codebase. Format changes need migration strategies. Worth establishing a light
convention before state accumulates (Phase 6 is the right time).

**Observability** — a structured decision log spanning both pipeline and org chart layers,
queryable after the fact. The current `decision-log.jsonl` per run is the seed. Worth designing
intentionally as the system becomes more autonomous.

---

## Sequencing Summary

```
Phase 1  Directory restructure              low risk    standalone
Phase 2  Execution adapter extraction       medium      after Phase 1
Phase 3  Pipeline graph schema design       design      after Phase 1, no code
Phase 4  Graph executor + full.json         medium      after Phase 3
Phase 5  Second profile validation          low         after Phase 4
Phase 6  Memory wiki infrastructure         medium      after Phase 1
Phase 7  Org chart / specialist brains      high        after Phase 6
```

Phases 1–2 are cleanup. Phases 3–5 are the graph. Phases 6–7 are evolution features.
Each phase leaves the system in a fully working state.

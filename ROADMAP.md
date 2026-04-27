# Software Factory — Roadmap

A living document tracking planned structural changes and feature evolution.
Update this as decisions are made or plans change.

---

## Context

The factory is a multi-agent Claude pipeline: concept → shippable artifact across four divisions
(Design, Build, Review, Security), driven by a data-driven graph profile. Autonomous decisions are
routed through an org chart of role brains; human escalation is the fallback. The system has two
peer orchestrators — `run-factory.js` (production pipeline) and `run-hr.js` (org management) —
that share infrastructure but operate independently. The work below is in two categories:
**cleanup** (restructuring what exists) and **evolution** (new capabilities).

---

## Current Directory Structure

```
dark-room/
  run-factory.js              ← production pipeline entry point
  run-hr.js                   ← HR entry point (role design + brain interviews)
  run-gui.js                  ← GUI server entry point

  profiles/                   ← pipeline graph templates
    full.json                 (Design → Build → Review → Security)
    lean.json                 (Design → Build → Review)

  departments/                ← division runners (spawned by factory, not run directly)
    run-design.js
    run-build.js
    run-review.js
    run-security.js

  agents/                     ← agent prompts
    build/ design/ review/ security/ leadership/ shared/ caveman/
    hr/
      brain-interviewer.md    (generic role brain interviewer)
      role-designer.md        (conversational role spec designer)

  lib/                        ← shared internal library
    runner-utils.js
    display.js
    token-log.js
    graph.js                  (profile-driven graph executor)
    org.js                    (org chart data layer)
    memory.js                 (memory wiki read/write/inject)

  io/                         ← user I/O adapters
    adapters/cli.js
    adapters/file.js
    interaction.js

  adapters/                   ← execution adapters
    claude-cli.js
    claude-api.js             (future)
    local.js                  (future)

  org/                        ← org chart definition + per-role brain files
    chart.json                (data-driven role definitions — add roles here, no code changes)
    <roleId>/                 (one directory per defined role, created by HR)
      brain.md
      brain-transcript.md
      brain-token-usage.jsonl

  memory/                     ← department craft wikis (persistent, accumulated per run)
    design/  build/  review/  security/

  public/                     ← frontend
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

### Phase 3 — Pipeline Graph: Schema Design ✓ COMPLETE
**Type:** Design work. No code.
**Depends on:** Phase 1 complete, clear head
**Completed:** 2026-04-24

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

Open questions resolved:
- `--stop-after`: Runtime flag only, not in profile. Executor exits after named node.
- Exit code 43 loop: `"feedbackLoop": true` on build node; executor wraps it in `runBuildWithFeedback`.
- `budgetCheckpoints`: Top-level list with `"after:{nodeId}"` syntax.
- `skipIf`: File existence (relative to run dir). `skipIfEvent`: Log event name.
  Both skip only on non-backward-edge entry; loopback always runs the node.
- `maxLoops`: Not in profile — executor reads `maxLoopsBeforeEscalate` from run/brain config.

---

### Phase 4 — Pipeline Graph: Executor + `full.json` ✓ COMPLETE
**Type:** Implementation.
**Depends on:** Phase 3 schema finalized
**Completed:** 2026-04-24

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

Steps completed:
- Created `profiles/full.json` with finalized schema (nodes, edges, budgetCheckpoints)
- Created `lib/graph.js`: graph executor, all division runners, budget/loop/escalation logic,
  all auto-decision and signal-handler functions moved from `run-factory.js`
- `run-factory.js` slimmed to ~270 lines: parseArgs, brain interviews, writeLedgerEntry, main
- Leadership steps (run-brain interview) wired via `onNodeComplete("design")` callback

---

### Phase 5 — Pipeline Graph: Second Profile Validation ✓ COMPLETE
**Type:** Validation.
**Depends on:** Phase 4
**Completed:** 2026-04-25

Steps completed:
- Added `--profile <name>` flag to `run-factory.js` (`parseArgs` + dynamic profile load)
- Profile shown in startup banner; defaults to `full` with no behavior change
- Created `profiles/lean.json`: Design → Build → Review (no Security)
  - Exercises terminal routing: review emits `ship-approved` with no forward edge → executor
    exits cleanly via `if (!nextEdge) break`
  - Backward edge (review → build on `ship-rejected-no-ship`) preserved
  - Budget checkpoints after Build and Review only
- No changes to any department runner — handoff contracts held cleanly

---

### Phase 5b — Upgrade Pipeline (Deferred)
**Type:** New feature. Documented but not yet implemented.
**Depends on:** Phase 5
**Deferred until:** Phases 6–7 complete. Factory stays greenfield-only for now.

The factory currently builds software from scratch. Phase 5b introduces a parallel path for
updating existing code, keeping greenfield and brownfield concerns in separate departments.

#### Core concept

A new **Update department** (`departments/run-update.js`) is a brownfield specialist:
- Loads the artifact and specs from a previous run (`--base-run-id <id>`)
- Interviews the user: "what do you want to change, add, or remove?"
- Applies targeted changes to the existing code in the new run directory
- Hands off to Review/Security as normal

**Build stays unchanged** — it remains a greenfield specialist that writes code from scratch.
The profile selects which department runs, not a flag inside build.

New profile `profiles/upgrade.json`:
```
update → review → security
```

The update department is self-contained (owns both the interview and the code modification),
so it does not depend on design running first. The upgrade profile omits design entirely.

#### Longer-term path: GitHub repo maintenance

The upgrade profile is the foundation for a higher-level code maintenance capability:

1. **Analyze department** — reads an external codebase, produces a spec-equivalent manifest.
   Without this, the update interviewer has no understanding of what it's modifying.
   Profile becomes: `analyze → update → review → security`

2. **GitHub adapter** (`adapters/github.js`) — clones a repo into the run directory before
   the pipeline starts. Same adapter pattern as Phase 2. Handles auth, branch selection,
   and optionally pushes results back as a PR.

3. **Scale** — real repos require context chunking, file-tree summarization, and surgical
   (not rewrite) change behavior from the update department.

4. **Control plane integration** — GitHub webhooks trigger runs automatically. The factory
   becomes a background service rather than a CLI tool. This connects to the control plane
   concept already documented in Evolution Concepts below.

The critical bottleneck is the Analyze department: if it cannot produce a reliable
spec-equivalent from unknown code, every downstream step inherits the error.

---

### Phase 6 — Memory Wiki Infrastructure ✓ COMPLETE
**Type:** New feature. Non-breaking addition.
**Depends on:** Phase 1 (directories exist)
**Completed:** 2026-04-25

Each department accumulates two memory files in `memory/{dept}/`:
- `runs.jsonl` — structured run records, always written, every run. Timestamp, run ID, project
  type, tech stack, outcome, loop count, events fired. Machine-queryable; not injected directly.
- `wiki.md` — narrative craft knowledge. Written only when there is a genuine insight: patterns,
  gotchas, things the next run should know. Injected directly into agent system prompts as prose.

The wiki reflector agent (one per department) runs at the end of each department's work. It reads
the run's outputs and produces: (a) a JSONL record always, and (b) a wiki paragraph only if
something worth capturing happened. Empty runs still get a JSONL record; the wiki stays
signal-dense.

#### Memory access: defined in profile schema

Read/write permissions are declared on each node in the profile JSON — not hardcoded in runners.
The graph executor reads the node's `memory` config, builds the memory block before spawning the
department, and writes it to `runs/{id}/memory-{nodeId}.md`. The department runner injects
whatever the executor prepared into every agent call. No hardcoded reads in any runner.

Node schema addition:
```json
{
  "id": "design",
  "memory": {
    "readWiki": ["design", "build", "review", "security"],
    "readRuns": [],
    "write": "design"
  }
}
```

- `readWiki`: departments whose `wiki.md` to include in context
- `readRuns`: departments whose `runs.jsonl` summary to include in context
- `write`: department namespace this node appends to (always own, explicit for graph editors)

Default access by department:
- **design**: `readWiki` all, `readRuns` none — wikis inform interview strategy; run logs are
  too technical for conversational agents
- **build / review / security**: `readWiki` all, `readRuns` all — full picture for analytical agents

#### Injection split

Two injection modes depending on agent role:
- **Interview agents** (design's functional and experience interviewers): wiki MD only.
  Injecting run log summaries risks pulling conversational agents toward metadata pattern-matching.
- **All other agents** (spec writer, architecture, implementation, reviewer, security auditor):
  full block — wiki MD for all declared departments + a summary derived from recent JSONL records.

Cross-department wiki reading is intentional. Example: the security wiki accumulates entries like
"auth systems consistently arrive without rate limiting requirements." The design interviewer reads
this and starts asking about rate limiting thresholds during the functional interview — shifting
security from reactive (post-build finding) to proactive (captured in spec). Wiki reflector prompts
for each department are written with downstream consumers in mind: entries describe patterns and
what questions to ask, not what a specific user answered.

#### Memory hygiene

Manual for now. JSONL metadata supports automated hygiene later (consolidate repeated patterns,
archive stale entries). Not needed until the wiki grows large enough to matter.

#### GUI: Factory Memory viewer

A new left-nav section — "Factory Memory" — peer with Run Viewer and Run Browser.

Two-layer tab UI (same pattern as the run viewer doc panel):
- **Top row**: department pills — Design | Build | Review | Security
- **Second row**: Wiki | Run Log

**Wiki tab**: renders `wiki.md` as markdown (same `marked.js` path as the doc viewer).

**Run Log tab**: JSONL records rendered as a summary list. Each row shows timestamp, run ID,
project name, and outcome. Clicking a row expands it to show the full JSONL record. Run IDs
are clickable and open that run in the Run Viewer.

**Empty state**: when no runs have completed yet and the wikis are empty, show a friendly
placeholder explaining what the Factory Memory section becomes over time. Never leave users on
a blank screen with empty controls.

**Data loading**: memory is global, not run-specific — fetched via `GET /api/memory` when the
user switches to the Factory Memory view. A refresh button covers the case where a run just
completed and the user wants to see what was newly learned. No SSE involvement.

---

### Phase 7 — Org Chart: Specialist Brains ✓ COMPLETE
**Type:** New feature. Extends brain system.
**Depends on:** Phase 6 (role memory infrastructure exists)
**Completed:** 2026-04-26

Built as a generic, data-driven org system rather than hardcoded CTO/CMO roles. The key design
insight: **brains are employees, not factory config.** They are set up by HR before production
starts. The factory consults them at decision points — that is the only relationship.

#### What was built

**`org/chart.json`** — data-driven org chart. A role is a JSON entry with `id`, `name`,
`description`, `decidesOn` (decision points this role owns), `escalatesTo` (parent role ID or
null), `domains` (interview topics), `brainPath`, and optional `contextFile`. Adding a new role
is a data edit — no code changes required.

**`lib/org.js`** — pure data layer. Role lookups, escalation chain walking, brain file helpers,
`getBrainForDecision()` (walks escalation chain until a brain exists), `addRole()` (writes to
`chart.json` and creates the role directory), `buildCreateRoleContext()` (injects current org
state into the role-designer agent).

**`run-hr.js`** — standalone HR orchestrator, peer to `run-factory.js`. Two modes:
- `--role <id>` — brain interview for an existing role
- `--create-role` — role design session (conversational spec) followed immediately by brain interview

The factory does not run HR. It checks for missing brains at startup and warns if in auto mode;
decisions fall back to human input until HR sets the org up.

**`agents/hr/brain-interviewer.md`** — generic role brain interviewer. Reads role name,
description, and domain list from injected context — one agent handles any role.

**`agents/hr/role-designer.md`** — conversational role designer. Walks the operator through
naming the role, assigning decision points, setting escalation, and designing interview domains.
Outputs a locked role spec; `run-hr.js` writes it to `chart.json` then flows into the brain
interview in the same session.

**GUI — Factory Org view** — new left-nav section with role sidebar (status badges), Brain tab
(renders `brain.md` as markdown), and Org tab (description, decision point badges, escalation
chain, domain cards). "Run Interview" / "Re-interview" button in the header launches an HR
session and navigates to the monitor. "+ New Role" button at the bottom of the sidebar starts a
create-role HR session.

**`run-factory.js`** — startup check warns if auto mode and brains are missing; no longer runs
interviews itself. All 5 decision functions route through `org.getBrainForDecision()`. Config
values (`tokenLimitPerRun`, `maxLoopsBeforeEscalate`) read via `org.readConfigValue()`.

---

### Phase 8 — Typed Edges + Department I/O Manifests
**Type:** Schema + refactor. Prerequisite for the visual graph editor.
**Depends on:** Phase 5 (graph executor stable)

Right now departments are coupled through hardcoded file paths scattered across every runner.
Phase 8 codifies the implicit contracts into a type system so departments are fully decoupled
from each other's paths, and the graph editor can enforce compatibility visually.

#### Type registry (`lib/types.js`)

A single map from type name to canonical file path pattern:

```js
module.exports = {
  "design-spec":        "handoff/build-spec.md",
  "review-spec":        "handoff/review-spec.md",
  "build-artifact":     "artifact/MANIFEST.txt",
  "warehouse-snapshot": "handoff/warehouse-snapshot.json",
  // events are not files — they route via log signals
  "event:ship-approved":      null,
  "event:security-approved":  null,
  "event:build-complete":     null,
};
```

#### Department manifests

Each department module exports an I/O declaration alongside its runner:

```js
// departments/run-build.js
module.exports.manifest = {
  inputs:  ["design-spec"],
  outputs: ["build-artifact", "event:build-complete"],
};
```

#### Profile edge schema addition

Edges gain a `"carries"` field declaring what type flows through them:

```json
{ "from": "design", "to": "build", "type": "forward", "carries": "design-spec" }
```

#### Graph executor changes

The executor resolves `context.inputs["design-spec"]` → actual file path via the type registry.
Department runners stop hardcoding paths and read from `context.inputs[typeName]` instead.
One source of truth for where every type lives.

#### Why now

Typed edges are the prerequisite for the visual graph editor's pin enforcement (Phase 9).
Without manifests, the editor has no data to determine which connections are valid.

---

### Phase 9 — Visual Graph Editor (Drawflow)
**Type:** New feature. GUI-first profile authoring.
**Depends on:** Phase 8 (typed edges + manifests)

Replace the current read-only graph preview with a fully interactive node canvas using
[Drawflow](https://github.com/jerosoler/Drawflow) — a zero-dependency, CDN-includable node
editor. The vision is Unreal Engine Blueprints: departments in a palette, drag onto canvas,
connect typed pins. The JSON code view becomes a secondary export path and is on a long-term
retirement track.

#### Drawflow integration

Single CDN include in `index.html`. The graph pane becomes a Drawflow canvas instance instead
of the current HTML/CSS linear renderer.

#### Translation layer

Drawflow has its own internal serialization format. A translation layer handles both directions:
- **Load**: profile JSON → Drawflow node/connection format → canvas render
- **Save**: Drawflow canvas state → profile JSON (written to disk via `PUT /api/profiles/:name`)

Visual layout (x/y node positions) stored in a `layout` block in the profile JSON.
The graph executor ignores unknown keys — no behavioral impact.

```json
{
  "id": "full",
  "nodes": [...],
  "edges": [...],
  "layout": {
    "design":   { "x": 80,  "y": 120 },
    "build":    { "x": 320, "y": 120 },
    "review":   { "x": 560, "y": 80  },
    "security": { "x": 560, "y": 200 }
  }
}
```

#### Department palette

Left sidebar inside the profiles view lists all registered departments (sourced from manifests).
Drag a department card onto the canvas → Drawflow node appears with input/output pins drawn
from the manifest's declared types.

#### Typed pin colors + connection validation

Each pin is colored by its type (same color per type across all nodes — like Blueprint sockets).
Drawflow fires a connection event before completing a wire draw. The handler compares the source
output type against the target input type; incompatible connections are rejected and the wire
snaps back. This is purely frontend — no executor changes.

#### Code view path

Preview/Code toggle remains. Code view shows the profile JSON (with layout block stripped for
readability). Code view is a debug/export tool — not the primary authoring path.

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
Phase 1   Directory restructure              ✓ complete  2026-04-24
Phase 2   Execution adapter extraction       ✓ complete  2026-04-24
Phase 3   Pipeline graph schema design       ✓ complete  2026-04-24
Phase 4   Graph executor + full.json         ✓ complete  2026-04-24
Phase 5   Second profile validation          ✓ complete  2026-04-25
Phase 5b  Upgrade pipeline                   deferred    unblocked — ready when prioritized
Phase 6   Memory wiki infrastructure         ✓ complete  2026-04-25
Phase 7   Org chart / HR / specialist brains ✓ complete  2026-04-26
Phase 8   Typed edges + department manifests next        after Phase 5
Phase 9   Visual graph editor (Drawflow)     planned     after Phase 8
```

Phases 1–2 are cleanup. Phases 3–5 are the graph. Phases 6–7 are evolution features.
Phase 5b (upgrade pipeline) is now unblocked and can be taken before or after Phase 8.
Each phase leaves the system in a fully working state.

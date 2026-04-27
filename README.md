# Software Factory

A multi-agent Claude pipeline that takes a software idea from concept to a shippable artifact. Four divisions run in sequence — Design, Build, Review, and Security — each staffed by Claude agents and coordinated by a data-driven pipeline orchestrator.

---

## Prerequisites

- Node.js
- Claude Code CLI installed and authenticated (`claude` must be available in your PATH)

After cloning, install dependencies:

```
npm install
```

---

## Quick Start — GUI

The web dashboard is the primary way to use the factory. It handles launching runs, monitoring progress in real time, browsing history, managing org brains, and designing workers.

```
node run-gui.js             # start the dashboard at http://localhost:4242
node run-gui.js --port 8080 # custom port
```

From the dashboard you can:

- **Launch Run** — pick a profile, optional source run, mode, and tag; click Launch
- **Run Viewer** — streams live progress, token spend, brain decisions, and agent transcripts for any in-progress run
- **Run Browser** — browse and inspect all completed runs
- **Factory Profiles** — view, edit, and author pipeline profiles; assign workers to slots
- **Factory Staff** — manage org role brains and design custom worker agents
- **Factory Memory** — read accumulated craft knowledge (wikis) and run history per department

---

## Org Setup

Before running in auto mode, set up your org brain. The factory uses it to make autonomous decisions on your behalf.

From the GUI, go to **Factory Staff** and click **New Role** to begin a guided interview for any role that's missing a brain. The CEO role governs all factory-wide decisions by default.

Or from the CLI:

```
node departments/hr/run.js --role ceo          # interview the CEO role
node departments/hr/run.js --create-role       # design a new role, then interview it
node departments/hr/run.js --create-worker     # design a custom worker agent
```

The brain interview takes 10–20 minutes and captures your management style, quality bar, copy voice, security posture, and escalation preferences. Re-run it at any time to update — the existing brain is replaced.

---

## Running the Factory — CLI

If you prefer the terminal, the orchestrator runs the full pipeline directly.

```
node run-factory.js                           # new run, full pipeline (manual mode)
node run-factory.js --mode auto               # fully autonomous
node run-factory.js --run-id <id>             # resume an existing run
node run-factory.js --profile lean            # use a specific profile
node run-factory.js --tag <label>             # attach a label to the run
node run-factory.js --stop-after design       # stop after a specific division
node run-factory.js --stop-after build
node run-factory.js --stop-after review
node run-factory.js --caveman                 # compressed agent context (lower token spend)
```

**Caveman mode** reduces token spend by compressing context passed between agents. Useful for tight budgets. Also available as `FACTORY_CAVEMAN=1 node run-factory.js`.

**Manual vs. auto mode:**

| Mode | What you do |
|------|-------------|
| `manual` (default) | Participate in each division's decision points — architect interview, copy approval, verdict review, security sign-off |
| `auto` | The factory handles all decision points using your org brain. Escalates when confidence is low or loop limits are reached. |

---

## Pipeline Profiles

A profile defines which divisions run and how they connect. Select a profile from the Launch view or pass `--profile` on the CLI.

| Profile | Pipeline | Use when |
|---------|----------|----------|
| `full` (default) | Design → Build → Review → Security | Production quality — full pipeline |
| `lean` | Design → Build → Review | Skips security — faster iteration |
| `rapid` | Design → Build | Design and implement only |
| `audit` | Review → Security | Audit an existing artifact from a previous run |

Profiles live in `profiles/` as JSON and are fully editable from the Factory Profiles view.

---

## Auto Mode and the Org Brain

When running with `--mode auto`, the factory makes decision-point calls autonomously using two context files:

**`org/ceo/brain.md`** — your global decision-making profile. Set up via HR before running auto mode. Captures your management style, quality bar, copy voice, security posture, and escalation preferences.

**`runs/{id}/run-brain.md`** — per-run calibration. Created after Design completes, before Build starts. Grounds the orchestrator in the specific project's intent, priority, constraints, and token budget.

**Decision points handled in auto mode:**

| Division | Decision point |
|----------|---------------|
| Build | Copy review approval |
| Security | Dynamic test plan |
| Security | High finding (conditional pass) |
| Security | Final sign-off |
| Review | No-ship verdict |
| Review | Ship verdict |

**When auto mode escalates to you:**

- Confidence is low on a decision
- A loop limit is reached without resolution
- Budget limit exceeded

Escalation pauses the factory with a report of what happened and the available options.

---

## Workers

Each division has named **slots** — the roles agents fill during a run (e.g. `build.architect`, `design.spec-writer`). By default, every slot is filled by the built-in default worker. Custom workers let you swap in a different agent persona for any slot.

**Designing a worker:** Go to **Factory Staff → + New Worker** in the GUI. The Worker Designer interviews you about the persona — expertise, style, constraints — and writes a system prompt. The worker is saved and immediately available for assignment.

**Assigning workers to a profile:** Go to **Factory Profiles**, select a profile, and click the **Workers** tab. Each slot shows its current worker with a dropdown to reassign. Save the profile to persist the assignment.

**How it works at runtime:** The factory writes `worker-assignments.json` into the run directory before spawning each division. Each runner resolves slot prompts from that file, falling back to schema defaults for any unassigned slots.

---

## Division by Division

### Design Division

Conducts a structured interview to produce the specs that drive everything downstream.

| # | Phase | What happens |
|---|-------|-------------|
| 1 | Functional Interview | Agent asks what your software does — mechanics, rules, data, edge cases |
| 2 | Experience Interview | Agent asks about user journeys and what the experience should feel like |
| 3 | Consistency Check | Agent privately reviews both transcripts for gaps and conflicts |
| 4 | Clarification Round | If issues found, agent asks targeted follow-up questions |
| 5 | Spec Generation | Agent writes four locked artifacts to `runs/{id}/handoff/` |

**Output artifacts written to `runs/{id}/handoff/`:**
- `build-spec.md` — functional requirements and acceptance criteria
- `review-spec.md` — scenario descriptions and expected user experiences
- `runtime-spec.md` — how to run the finished artifact
- `factory-manifest.json` — project metadata

---

### Build Division

Receives the Build Spec and produces a verified, packaged artifact.

| # | Phase | What happens |
|---|-------|-------------|
| 1 | Architect Interview | Agent presents its technical plan and asks any open questions |
| 2 | Implementation | Agents write code to `runs/{id}/build/src/` |
| 3 | Integration | Agent assembles modules and resolves interface issues |
| 4 | Copy Review | Agent audits all user-facing strings; decision point |
| 5 | Verification | Agent runs the build against acceptance criteria; failures route to Fix |
| 6 | Packaging | Agent copies runtime files to `runs/{id}/artifact/` |

**Decision points:**
- **Phase 1 — Architect Interview:** Discuss the plan. Type `lock` to end the interview and begin implementation.
- **Phase 4 — Copy Review:** Type `yes` to approve, or type feedback to request revisions.
- **Phase 5 — Verification failures:** Describe what needs fixing. The Fix agent applies changes and re-verifies.

**Fix mode:** If Review or Security sends failure reports back, re-running build automatically enters Fix Mode — reads the failure reports, applies fixes, and re-verifies.

---

### Review Division

Independently verifies the artifact against the Review Spec. Evaluates the experience, not the source code.

| # | Phase | What happens |
|---|-------|-------------|
| 1 | Runtime Standup | Confirms the artifact is runnable |
| 2 | Scenario Analysis | Agent reads Review Spec and builds a coverage map |
| 3 | Explorer Agents | One agent per scenario interacts with the artifact |
| 4 | Edge Case Exploration | Agent explores implied scenarios the spec doesn't state |
| 5 | Verdict | Agent issues a SHIP or NO-SHIP recommendation |
| 6 | Human Approval | Decision point |

**Decision point — Phase 6:**
- **SHIP verdict:** `yes` to approve, `no` + reason to reject and route back to build
- **NO-SHIP verdict:** Enter to accept (failure reports written), or `override` to ship anyway — a reason is required and logged

---

### Security Division

Performs static and dynamic security testing on the artifact.

| # | Phase | What happens |
|---|-------|-------------|
| 1 | Static Analysis | Agent reviews source code for vulnerabilities |
| 2 | Dynamic Testing | Agent proposes a test plan; decision point; agent executes approved tests |
| 3 | Verdict | Agent consolidates findings into a security verdict |
| 4 | Human Checkpoint | Decision point |

**Decision points:**
- **Phase 2 — Test Plan:** `yes` to run all, `skip <id>` to remove a specific test, `no` to cancel
- **Phase 4 — Checkpoint:**
  - `PASS` — `yes` to proceed or `no` + reason to reject
  - `CONDITIONAL PASS` — review each high finding: `accept` or `fix`
  - `BLOCK` — remediation requests written automatically and routed to build

---

## Inspecting Runs

The Run Browser in the GUI covers most inspection needs. For terminal use:

```
node inspect.js <run-id>              # detailed view
node inspect.js <run-id> --detail     # adds per-agent token and time breakdown
node inspect.js <id1> <id2>           # compare two runs side by side
node inspect.js --trend               # all runs in chronological order
node inspect.js --trend 10 --detail   # last 10 runs with per-phase stats
node inspect.js                       # list all runs
```

The detailed view shows division status, token usage by phase, time per phase, orchestrator decisions, and any pending failure reports or remediations.

---

## Token Budget

Set a spend limit during the brain or run brain interview. The factory checks spend after each division and pauses if the limit is exceeded — you can continue or abort.

Historical token spend per run is recorded in `accounts/ledger.jsonl`.

---

## Run Directory Layout

```
runs/{run-id}/
  handoff/                    Locked specs (Design → Build/Review/Security)
    build-spec.md
    review-spec.md
    runtime-spec.md
    factory-manifest.json
  worker-assignments.json     Resolved worker slot assignments for this run
  build/
    src/                      Generated source code
    architecture-plan.md
    task-graph.json
    verification-report.json
    integration-report.md
  artifact/                   Packaged artifact (input to Review and Security)
    MANIFEST.txt
  review/
    coverage-map.json
    scenario-reports/
    edge-case-summary.md
    verdict-report.md
  security/
    static-analysis-report.md
    proposed-test-plan.json
    approved-test-plan.json
    dynamic-test-report.md
    security-verdict-report.md
  failure-reports/            Written by Review on NO-SHIP → consumed by Build fix mode
  security-remediations/      Written by Security on BLOCK → consumed by Build fix mode
  run-brain.md                Per-run calibration (created post-Design)
  run-config.json             Structured limits extracted from run brain
  run-meta.json               Tag and start timestamp (written if --tag is passed)
  decision-log.jsonl          Every auto decision made by the orchestrator
  log.jsonl                   Append-only event log
  token-usage.jsonl           Raw token usage per agent call
  time-usage.jsonl            Elapsed time per agent call

org/
  chart.json                  Org chart — role definitions and decision point ownership
  ceo/                        CEO role (global brain — governs all factory decisions)
    brain.md
    brain-transcript.md
  {role}/                     One directory per org role

workers/
  {id}/                       One directory per worker
    worker.json               Worker metadata (id, name, slotType, department)
    prompt.md                 Custom system prompt (absent for built-in default workers)

memory/
  design/  build/  review/  security/
    wiki.md                   Accumulated craft knowledge (injected into agent prompts)
    runs.jsonl                Structured run records

profiles/
  full.json    lean.json    rapid.json    audit.json
```

---

## Agent Prompts

Each division's agent prompts live co-located with the runner, in `departments/{dept}/`. Edit them directly to change how any agent thinks. Shared infrastructure prompts are in `agents/shared/` and `agents/leadership/`.

```
departments/
  build/
    architect.md      implementation.md   integration.md
    copywriter.md     verification.md     fix.md   packager.md
  design/
    interviewer.md    experience-interviewer.md
    consistency-checker.md    spec-writer.md
  review/
    scenario-analyst.md   explorer.md   edge-case-runner.md   verdict.md
  security/
    static-analyst.md   dynamic-tester.md   verdict.md
  hr/
    brain-interviewer.md   role-designer.md   worker-designer.md

agents/
  shared/
    conventions.md          Prefixed to every agent's system prompt
    output-formats.md       Structured output schemas
  leadership/
    run-brain-interviewer.md
    architect-reviewer.md
```

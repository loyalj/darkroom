# Software Factory

A multi-agent Claude pipeline that takes a software idea from concept to a shippable artifact. Four divisions run in sequence — Design, Build, Review, and Security — each staffed by Claude agents and coordinated by a pipeline orchestrator.

---

## Prerequisites

- Node.js
- Claude Code CLI installed and authenticated (`claude` must be available in your PATH)

---

## Running the Factory

### Recommended: Pipeline Orchestrator

The orchestrator runs all four divisions in sequence and handles the handoffs between them automatically.

```
node run-factory.js
```

**First run only:** The factory will conduct a one-time brain interview before anything else. This builds `brain.md` — your decision-making profile. The orchestrator uses it to make autonomous calls on your behalf in auto mode. Takes 10–20 minutes. Never runs again once the file exists.

**Options:**

```
node run-factory.js                           # new run, full pipeline (manual mode)
node run-factory.js --mode auto               # fully autonomous — factory makes all decisions
node run-factory.js --run-id <id>             # resume an existing run
node run-factory.js --stop-after design       # stop after a specific division
node run-factory.js --stop-after build
node run-factory.js --stop-after review
```

**Manual vs. auto mode:**

| Mode | What you do |
|------|-------------|
| `manual` (default) | Participate in each division's decision points — architect interview, copy approval, verdict review, security sign-off |
| `auto` | The factory handles all decision points using your brain profile. Escalates to you when confidence is low or loop limits are reached. |

**After a run:**

```
node inspect.js <run-id>    # detailed status, token usage, decisions made
node inspect.js             # list all runs
```

---

### Standalone Runners

Each division can also be run independently. Pass the same `--run-id` across all four to chain them manually.

```
node run-design.js                          # starts a new run, prints the run ID
node run-build.js    --run-id <id>
node run-review.js   --run-id <id>
node run-security.js --run-id <id>
```

Every phase is checkpointed. If a run is interrupted, re-run the same command and it picks up where it left off.

---

## Auto Mode and the Brain

When running with `--mode auto`, the factory makes all decision-point calls autonomously using two context files:

**`brain.md`** (project root) — your global decision-making profile. Created once via interview on first run. Captures your management style, quality bar, copy voice, security posture, and escalation preferences. Edit it directly or re-run the interview by deleting the file.

**`runs/{id}/run-brain.md`** — per-run calibration. Created after Design completes, before Build starts. Grounds the orchestrator in the specific project's intent, priority, constraints, and token budget.

**Decision points handled in auto mode:**

| Division | Decision point | Signal |
|----------|---------------|--------|
| Build | Copy review approval | Approve or request revision based on your copy voice |
| Security | Dynamic test plan | Approve all, skip specific tests, or cancel |
| Security | High finding (conditional pass) | Accept finding or send for remediation |
| Security | Final sign-off | Approve when all findings are resolved |
| Review | No-ship verdict | Accept (route to build) or override with reason |
| Review | Ship verdict | Approve and ship |

**When auto mode escalates to you:**

- Confidence is low on a decision (brain context is insufficient)
- A loop limit is reached without resolution
- An unknown signal type is received
- Budget limit exceeded (asks whether to continue)

Escalation pauses the factory at the CLI with a report of what happened and the options available.

---

## Division by Division

### Design Division

Conducts a structured interview to produce the specs that drive everything downstream.

```
node run-design.js
```

| # | Phase | What happens |
|---|-------|-------------|
| 1 | Functional Interview | Agent asks what your software does — mechanics, rules, data, edge cases |
| 2 | Experience Interview | Agent asks about user journeys and what the experience should feel like |
| 3 | Consistency Check | Agent privately reviews both transcripts for gaps and conflicts |
| 4 | Clarification Round | If issues found, agent asks targeted follow-up questions |
| 5 | Spec Generation | Agent writes four locked artifacts to `runs/{id}/handoff/` |

**Your role:** Answer the interview questions. Phases 1 and 2 end when the agent says it has everything it needs. Phase 4 only appears if Phase 3 found issues.

**Output artifacts written to `runs/{id}/handoff/`:**
- `build-spec.md` — functional requirements and acceptance criteria
- `review-spec.md` — scenario descriptions and expected user experiences
- `runtime-spec.md` — how to run the finished artifact
- `factory-manifest.json` — project metadata

---

### Build Division

Receives the Build Spec and produces a verified, packaged artifact.

```
node run-build.js --run-id <id>
```

| # | Phase | What happens |
|---|-------|-------------|
| 1 | Architect Interview | Agent presents its technical plan and asks any open questions |
| 2 | Implementation | Agents write code to `runs/{id}/build/src/` sequentially |
| 3 | Integration | Agent assembles modules and resolves interface issues |
| 4 | Copy Review | Agent audits all user-facing strings; decision point |
| 5 | Verification | Agent runs the build against acceptance criteria; failures route to Fix |
| 6 | Packaging | Agent copies runtime files to `runs/{id}/artifact/` |

**Decision points:**
- **Phase 1 — Architect Interview:** Discuss the plan. Type `lock` to finalize and begin implementation.
- **Phase 4 — Copy Review:** Type `yes` to approve, or type feedback to request revisions.
- **Phase 5 — Verification failures:** Describe what needs fixing if asked. The Fix agent applies changes and re-verifies.

**Fix mode:** If Review or Security sends failure reports back, re-running build automatically enters Fix Mode — reads the failure reports, applies fixes, and re-verifies.

---

### Review Division

Independently verifies the artifact against the Review Spec. No access to source code — it evaluates the experience.

```
node run-review.js --run-id <id>
```

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

```
node run-security.js --run-id <id>
```

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

```
node inspect.js <run-id>    # detailed view
node inspect.js             # list all runs
```

The detailed view shows:
- Division status (complete / in-progress / not-started / blocked)
- Token usage by phase
- Orchestrator decisions (in auto mode) — what was decided, confidence, reasoning summary
- Pending action items — failure reports or remediations waiting for build

---

## Token Budget

Set a spend limit during the brain or run brain interview. The accountant checks spend after each division and pauses the factory if the limit is exceeded — you can continue or abort.

Historical token spend per run is recorded in `accounts/ledger.jsonl`. Over time this shows what different project types cost.

---

## Run Directory Layout

```
runs/{run-id}/
  handoff/                    Locked specs (Design → Build/Review/Security)
    build-spec.md
    review-spec.md
    runtime-spec.md
    factory-manifest.json
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
    proposed-test-plan.json   Written before approval (orchestrator reads this)
    approved-test-plan.json
    dynamic-test-report.md
    security-verdict-report.md
  failure-reports/            Written by Review on NO-SHIP → consumed by Build fix mode
  security-remediations/      Written by Security on BLOCK → consumed by Build fix mode
  run-brain.md                Per-run calibration (created post-Design in orchestrator)
  run-config.json             Structured limits extracted from run brain
  decision-log.jsonl          Every auto decision made by the orchestrator
  log.jsonl                   Append-only event log
  token-usage.jsonl           Raw token usage (one entry per agent call)

brain.md                      Global brain — your decision-making profile (project root)
brain-config.json             Structured limits extracted from global brain
brain-transcript.md           Brain interview transcript
accounts/ledger.jsonl         Cross-run token spend history
```

---

## Agents Directory

Agent behavior is defined in Markdown files under `agents/`. Edit them directly to change how any agent thinks without touching the runner scripts.

```
agents/
  design/
    interviewer.md
    experience-interviewer.md
    consistency-checker.md
    spec-writer.md
  build/
    architect.md
    implementation.md
    integration.md
    copywriter.md
    verification.md
    fix.md
    packager.md
  review/
    scenario-analyst.md
    explorer.md
    edge-case.md
    verdict.md
  security/
    static-analyst.md
    dynamic-planner.md
    dynamic-tester.md
    verdict.md
  leadership/
    brain-interviewer.md      Conducts the one-time global brain interview
    run-brain-interviewer.md  Conducts the per-run calibration interview
  shared/
    conventions.md            Prefixed to every agent's system prompt
    output-formats.md         Structured output schemas
```

# Darkroom

Describe an app idea. Get working, reviewed, and security-audited code.

Darkroom is a multi-agent Claude pipeline that takes a plain-English idea and runs it through four divisions — Design, Build, Review, and Security — each staffed by Claude agents that interview you, write specs, generate code, test it, and hand off to the next stage.

> **Current scope:** Darkroom produces CLI applications. Web app support is planned for a future release.

---

## What it does

You type what you want to build — a CLI tool, a script, a terminal app. Darkroom's Design division interviews you to nail down the details, writes a locked spec, and hands it to Build. Build plans the architecture with you, writes the code, and packages it. Review stress-tests it against your spec. Security scans it for vulnerabilities.

The whole thing runs from a browser dashboard. You participate at the decision points that matter (or let it run fully autonomous).

---

## Prerequisites

**Node.js 18+** — [nodejs.org](https://nodejs.org)

**Claude Code CLI:**

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

`claude login` opens a browser to authenticate with your Anthropic account. Once done, `claude` is in your PATH and Darkroom can use it.

> A full pipeline run (Design → Build → Review → Security) typically costs $2–8 — about the price of a coffee, depending on project complexity.

---

## Installation

```bash
git clone <repo-url>
cd darkroom
npm install
```

---

## Your first run

Start the dashboard:

```bash
npm start
# → http://localhost:4242
```

Then:

1. Go to **Launch Run**
2. Select **Rapid Prototype** (Design + Build — fastest way to start)
3. Set mode to **Auto** — let Darkroom handle the decision points on its own
4. Click **Launch Run**
5. Switch to **Run Viewer**

The Design agent will ask what you want to build. Not sure what to try? Here's a good starter prompt:

> *"A CLI habit tracker. Log a habit from the terminal, see a streak count, and get a summary of the past 30 days. Store data in a local JSON file. Simple and fast."*

Darkroom will interview itself, write a spec, plan the architecture, write the code, review the copy, and package the result — no input needed from you.

**What you'll get:** a working artifact in `runs/{id}/artifact/`, with specs, source code, and a verification report.

---

## Pipeline profiles

A profile defines which divisions run and in what order. Select one from the **Launch Run** view.

| Profile | Pipeline | Use when |
|---------|----------|----------|
| `rapid` | Design → Build | Fast iteration — design and build only |
| `lean` | Design → Build → Review | Adds quality review, skips security |
| `full` | Design → Build → Review → Security | Full pipeline — production quality |
| `audit` | Review → Security | Audit an artifact from a previous run |

Profiles are fully editable from the **Factory Profiles** view.

---

## Manual vs. Auto mode

| Mode | What happens |
|------|-------------|
| **Auto** | Darkroom handles all decisions using your org brain. Escalates when confidence is low or a loop limit is reached. |
| **Manual** | You participate at each decision point — architect interview, copy approval, verdict review, security sign-off |

Auto mode works out of the box with the default org brain. For real projects, run the HR interview first to tune it to your preferences.

---

## Org setup

The org brain tells Darkroom how to make autonomous decisions on your behalf. The repo ships with a sensible default. To replace it with one tuned to you, go to **Factory Staff** and click **Run Interview** on the CEO role.

The interview takes 15–20 minutes and covers your management style, quality bar, copy voice, security posture, and escalation preferences.

---

## Division reference

### Design

Conducts a structured interview and produces the specs that drive everything downstream.

| Phase | What happens |
|-------|-------------|
| Functional Interview | Agent asks what your software does — mechanics, rules, data, edge cases |
| Experience Interview | Agent asks about user journeys and what the experience should feel like |
| Consistency Check | Agent privately reviews both transcripts for gaps and conflicts |
| Clarification Round | If issues found, agent asks targeted follow-up questions |
| Spec Generation | Agent writes four locked artifacts to `runs/{id}/handoff/` |

Output: `build-spec.md`, `review-spec.md`, `runtime-spec.md`, `factory-manifest.json`

---

### Build

Receives the Build Spec and produces a verified, packaged artifact.

| Phase | What happens |
|-------|-------------|
| Architect Interview | Agent presents its technical plan and locks the approach |
| Implementation | Agents write code to `runs/{id}/build/src/` |
| Integration | Agent assembles modules and resolves interface issues |
| Copy Review | Agent audits all user-facing strings |
| Verification | Agent runs acceptance criteria; failures route to Fix |
| Packaging | Agent copies runtime files to `runs/{id}/artifact/` |

---

### Review

Independently verifies the artifact against the Review Spec. Evaluates the experience, not the source code.

| Phase | What happens |
|-------|-------------|
| Scenario Analysis | Builds a coverage map from the Review Spec |
| Explorer Agents | One agent per scenario interacts with the artifact |
| Edge Case Exploration | Agent probes implied scenarios the spec doesn't state |
| Verdict | Issues SHIP or NO-SHIP |

---

### Security

Performs static and dynamic security testing on the artifact.

| Phase | What happens |
|-------|-------------|
| Static Analysis | Reviews source code for vulnerabilities |
| Dynamic Testing | Proposes and executes a test plan |
| Verdict | Consolidates findings — PASS, CONDITIONAL PASS, or BLOCK |

---

## Workers

Each division has named **slots** — the roles agents fill during a run (e.g. `build.architect`, `design.spec-writer`). By default every slot is filled by the built-in default worker. Custom workers let you swap in a different agent persona for any slot.

**Designing a worker:** Go to **Factory Staff → + New Worker**. The Worker Designer interviews you about the persona and writes a system prompt. The worker is saved and immediately available for assignment.

**Assigning workers:** Go to **Factory Profiles**, select a profile, and click the **Workers** tab. Each slot shows a dropdown to reassign. Save the profile to persist.

---

## Auto mode and the org brain

In Auto mode, Darkroom makes decision-point calls autonomously using two context files:

**`org/ceo/brain.md`** — your global decision-making profile. Set up via the HR interview in **Factory Staff** before relying on auto mode for real projects.

**`runs/{id}/run-brain.md`** — per-run calibration. Created after Design completes. Grounds the orchestrator in the specific project's intent, priority, constraints, and token budget.

**When auto mode escalates to you:**
- Confidence is low on a decision
- A loop limit is reached without resolution
- Budget limit exceeded

---

## Inspecting runs

The **Run Browser** in the dashboard covers most inspection needs — browse artifacts, read reports, and compare runs without leaving the browser.

---

## Token budget

Set a spend limit during the HR interview in **Factory Staff**. Darkroom checks spend after each division and pauses if the limit is exceeded — you can continue or abort.

---

## Run directory layout

```
runs/{run-id}/
  handoff/                    Locked specs from Design
    build-spec.md
    review-spec.md
    runtime-spec.md
    factory-manifest.json
  build/
    src/                      Generated source code
    architecture-plan.md
    verification-report.json
  artifact/                   Packaged artifact (input to Review and Security)
    MANIFEST.txt
  review/
    verdict-report.md
    edge-case-summary.md
  security/
    static-analysis-report.md
    dynamic-test-report.md
    security-verdict-report.md
  run-brain.md                Per-run calibration
  decision-log.jsonl          Every auto decision made by the orchestrator
  log.jsonl                   Append-only event log
  token-usage.jsonl           Raw token usage per agent call

org/
  roles/                      Role definitions
  profiles/                   Org chart profiles (escalation chains)
  {role}/
    brain.md                  Decision-making profile for this role
    brain-config.json         Structured config values (token limits, loop tolerance)

workers/
  {id}/
    worker.json               Worker metadata
    prompt.md                 Custom system prompt

profiles/
  full.json    lean.json    rapid.json    audit.json

memory/                       Accumulated craft knowledge — excluded from git
  design/  build/  review/  security/
    wiki.md                   Injected into agent prompts
    runs.jsonl                Structured run records
```

---

## Agent prompts

Each division's prompts live in `departments/{dept}/`. Edit them directly to change how any agent thinks.

```
departments/
  build/      architect.md  implementation.md  integration.md
              copywriter.md  verification.md  fix.md  packager.md
  design/     interviewer.md  experience-interviewer.md
              consistency-checker.md  spec-writer.md
  review/     scenario-analyst.md  explorer.md  edge-case-runner.md  verdict.md
  security/   static-analyst.md  dynamic-tester.md  verdict.md
  hr/         brain-interviewer.md  role-designer.md  worker-designer.md

agents/
  shared/     conventions.md  output-formats.md
  leadership/ run-brain-interviewer.md  architect-reviewer.md
```

---

## CLI reference

For power users and scripting. All of these are also accessible from the dashboard.

```bash
node run-factory.js                           # new run, full pipeline
node run-factory.js --mode auto               # fully autonomous
node run-factory.js --profile rapid           # specific profile
node run-factory.js --run-id <id>             # resume an existing run
node run-factory.js --tag <label>             # label a run
node run-factory.js --stop-after design       # stop after a specific division
node run-factory.js --caveman                 # compressed context (~30–50% cheaper)
```

```bash
node inspect.js <run-id>              # detailed view
node inspect.js <run-id> --detail     # adds per-agent token and time breakdown
node inspect.js <id1> <id2>           # compare two runs side by side
node inspect.js --trend               # all runs in chronological order
node inspect.js --trend 10 --detail   # last 10 runs with detail
node inspect.js                       # list all runs
```

**Caveman mode** compresses context passed between agents. Roughly 30–50% cheaper with minimal quality loss. Also available as `FACTORY_CAVEMAN=1 node run-factory.js`.

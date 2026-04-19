# Orchestrator Roadmap

The factory runs today as four standalone division runners. The orchestrator
(`run-factory.js`) automates the pipeline between them and, over time, takes
over the human decision points inside each division.

---

## Current State

`run-factory.js` is live in **manual mode only**:
- Runs Design → Build → Review → Security in sequence
- Handles Build↔Review and Build↔Security feedback loops (up to `MAX_LOOPS` attempts)
- Accepts `--run-id` to resume, `--stop-after <division>` to stop early
- Standalone division runners (`run-design.js` etc.) remain fully usable on their own
- `--mode auto` is stubbed and exits with "not yet available"

---

## Architecture: Auto Mode

The orchestrator intercepts human decision points inside runners without
removing them. The runners stay standalone.

**How interception works (Option A — hybrid):**
- Manual mode: runners spawn with `stdio: inherit` — human sees and controls everything
- Auto mode: runners spawn with piped stdio — orchestrator monitors output, detects
  decision point signals, and feeds answers programmatically using the brain

Each human decision point in the runners will emit a recognizable structured
signal line just before the readline prompt. The orchestrator listens for these
and either passes through to the human (manual) or handles them itself (auto).
The runners don't know or care which is on the other end.

**Decision point progression (low risk → high stakes):**
1. Copy review approval (Build Phase 4) ← first target
2. Dynamic test plan approval (Security Phase 2)
3. Security conditional pass — per-finding accept/fix (Security Phase 4)
4. Review no-ship verdict — accept or override (Review Phase 6)
5. Architect interview lock (Build Phase 1) ← furthest out

---

## The Second Brain

Two levels of context the orchestrator uses when making decisions:

### Global Brain (`brain.md`)
- Persists across all runs in the project root (or a configurable location)
- Built via interview on first `run-factory.js` invocation if the file is absent
- Captures management style: risk tolerance, quality bar, copy voice preferences,
  when to accept vs. reject security findings, etc.
- Refined over time by reviewing the decision log together

### Run Brain (`runs/<id>/run-brain.md`)
- Created once per run, after Design completes and before Build starts
- The orchestrator has access to both interview transcripts and all four specs
  at that point, so questions are grounded in what was actually designed
- Captures run-specific intent: internal vs. user-facing, speed vs. correctness
  priority, known constraints, token budget for this run

Both files become context in the orchestrator's system prompt whenever it calls
Claude to make a decision.

---

## Decision Log

Every auto decision is recorded to `runs/<id>/decision-log.jsonl`:

```json
{
  "ts": "2026-04-01T12:00:00Z",
  "decisionPoint": "copy-review",
  "evidence": "...(copy-review.txt content summary)...",
  "brainContext": "...(relevant excerpt from brain)...",
  "decision": "approve",
  "reasoning": "...(orchestrator's reasoning)...",
  "humanOverride": false
}
```

The log is the primary artifact for tuning the brain over time. When you review
it and disagree with a call, you and the orchestrator update `brain.md` together.

---

## Leadership Department

A new division sits above the four existing ones. Lives in `agents/leadership/`.

### Orchestrator (executive agent)
- Reads both brain levels
- Coordinates division sequencing
- Intercepts and handles decision points in auto mode
- Maintains the decision log
- Escalates to human when confidence is low or budget is exceeded

### Accountant (spend monitor)
Two responsibilities:

**Run-time:** Checks token spend at natural break points (before each agent call,
after each loop iteration). Enforces per-run limits (from run brain) or global
defaults (from global brain). Pauses the factory and reports if a fix loop is
burning money.

Limit hierarchy:
```
Global brain defaults  ← applies when nothing more specific is set
        ↓ overridden by
Run brain limits       ← set per project scope
        ↓ enforced by
Accountant             ← pauses factory if exceeded
```

**Historical:** Maintains `accounts/ledger.jsonl` — one entry per completed run:
run ID, project name, brief scope description (from run brain), token totals by
division. Over time this becomes the basis for upfront cost estimation. The
accountant gains insight into what different project types cost.

---

## Escalation Policy

When auto mode loses confidence or hits a loop limit, it pauses and surfaces
to the human on the CLI with a report of what happened and what it needs.

Future: email/Slack notification hooks. Architecture should leave a clear
extension point here (a single `escalate(reason, context)` function).

---

## Build Order

1. **[done]** Orchestrator shell — manual mode, handoffs, loop handling, `--stop-after`
2. **[done]** Global brain interview — agent prompt + `brain.md` file format, triggered on first run
3. **[done]** Run brain interview — triggered post-Design, uses specs as context for targeted questions
4. **[done]** Decision log — JSONL structure, writer utility, included in `inspect.js` output
5. **[done]** First auto decision: copy review approval — signal protocol in runner + orchestrator handler
6. **[done]** Accountant — run-time spend monitor + historical ledger
7. **[done]** Escalation handler — detect low-confidence or loop-limit conditions, surface to human
8. **[done]** Expand auto decisions — test plan approval, security findings, review verdict

---

## Key Files

| File | Purpose |
|------|---------|
| `run-factory.js` | Pipeline orchestrator |
| `brain.md` | Global brain (management style, persists across runs) |
| `runs/<id>/run-brain.md` | Run-level brain (project-specific intent) |
| `runs/<id>/decision-log.jsonl` | Record of all orchestrator decisions |
| `accounts/ledger.jsonl` | Cross-run token spend history (accountant) |
| `agents/leadership/brain-interviewer.md` | Global brain interview agent |
| `agents/leadership/run-brain-interviewer.md` | Per-run brain interview agent |
| `inspect.js` | Run inspector (will surface decision log and brain summary) |

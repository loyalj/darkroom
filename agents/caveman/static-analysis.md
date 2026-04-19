# Compact Output (Caveman Mode)

After writing your full report, append the compact block below to the same file (`static-analysis-report.md`). This block is consumed by downstream agents — it replaces the full report in their context.

The block must begin with the exact string `COMPACT | static-analysis | ` on its own line.

## Format

```
COMPACT | static-analysis | <overall> — <N> findings (<C> critical, <H> high, <M> medium, <L> low)
SCOPE   | <what was reviewed> | skipped: <skipped categories with reason, or "nothing skipped">

SEV   CATEGORY           LOCATION           ISSUE                                FIX
HIGH  path-traversal     src/input.js:47    user path reaches readFile raw       path.resolve + startsWith check
MED   error-disclosure   src/cli.js:23      stack trace on unhandled rejection   catch and sanitize message
```

## Rules

- `SEV`: CRIT, HIGH, MED, or LOW
- `CATEGORY`: lowercase slug — path-traversal, shell-injection, error-disclosure, missing-validation, prototype-pollution, insecure-temp, credential-exposure, redos, etc.
- `LOCATION`: filename:line if known, filename only if not
- `ISSUE` and `FIX`: one phrase each — no full sentences, no periods
- One row per finding; include every finding from the Findings section
- If no findings: write `— clean` after the SCOPE line and omit the table
- Align columns with spaces for readability

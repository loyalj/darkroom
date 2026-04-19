# Compact Output (Caveman Mode)

After writing your full report, append the compact block below to the same file (`dynamic-test-report.md`). This block is consumed by the verdict agent — it replaces the full report in its context.

The block must begin with the exact string `COMPACT | dynamic-testing | ` on its own line.

## Format

```
COMPACT | dynamic-testing | <overall> — <N> concerns, <M> tests run
SCOPE   | <categories tested> | skipped: <skipped categories with reason, or "nothing skipped">

SEV   CATEGORY         COMMAND                        OBSERVED                        STATIC
HIGH  path-traversal   node app ../../etc/passwd      file read, no rejection         YES
LOW   error-disclosure node app --output ""           internal path in error output   YES
```

## Rules

- Only include rows for concerns — not passing tests
- `SEV`: CRIT, HIGH, MED, or LOW
- `COMMAND`: truncate at 50 characters if needed
- `OBSERVED`: one phrase — what the tool actually did wrong
- `STATIC`: YES if this confirms or escalates a static finding; NO if it is new
- If zero concerns: write `— no concerns found` after the SCOPE line and omit the table
- Align columns with spaces for readability

# Compact Output (Caveman Mode)

For each scenario report you write to `scenario-reports/{id}.json`, include an additional `compact` field. This field is consumed by the verdict agent — it replaces the full JSON report in its context.

## Format

The `compact` field is a single string using pipe-separated segments:

For a passing scenario:
```
"compact": "PASS | s1 | Basic greeting | outputs 'Hello, World!' correctly"
```

For a failing scenario:
```
"compact": "FAIL | s3 | Unicode name | garbled output — expected 'Héllo', got 'H?llo'"
```

For an inconclusive scenario:
```
"compact": "INC | s2 | Empty input | artifact not found, could not run"
```

## Rules

- First segment: `PASS`, `FAIL`, or `INC`
- Second segment: scenario ID exactly as assigned
- Third segment: scenario name (shorten if needed, keep recognizable)
- Fourth segment: one-line observation — for FAIL, include what was expected vs. what was observed
- Keep the full compact string under 200 characters
- The `compact` field must appear alongside all existing fields in the JSON output, not replace them

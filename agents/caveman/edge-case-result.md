# Compact Output (Caveman Mode)

When writing your `scenario-reports/{id}.json` file, include an additional `compact` field alongside all existing fields.

## Format

For a passing edge case:
```
"compact": "PASS | edge-1 | Unknown flags | exits with error code 1 and usage message"
```

For a failing edge case:
```
"compact": "FAIL | edge-2 | Ctrl+C at prompt | expected clean exit, got orphaned process"
```

For an inconclusive edge case:
```
"compact": "INC | edge-3 | Empty stdin | artifact not found, could not run"
```

## Rules

- First segment: `PASS`, `FAIL`, or `INC`
- Second segment: edge case id exactly as assigned (e.g. `edge-1`)
- Third segment: edge case name (shorten if needed)
- Fourth segment: one-line observation — for FAIL, include what was expected vs. what was observed
- Keep the full compact string under 200 characters
- The `compact` field must appear alongside all existing fields, not replace them

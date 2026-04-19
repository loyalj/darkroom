# Output Formats

## Machine-consumed responses

All structured output must be valid JSON in this envelope:

```json
{
  "status": "complete | partial | blocked | error",
  "output": {},
  "notes": "optional human-readable context for the orchestrator",
  "nextAction": "optional hint to the orchestrator about what should happen next"
}
```

- `status: complete` — task finished, output is ready for handoff
- `status: partial` — meaningful progress made but more input is needed from the user
- `status: blocked` — cannot proceed without information that was not provided
- `status: error` — something went wrong; describe in `notes`

The `output` field shape is defined per agent type in each agent's own prompt file.

## Human-readable responses (interview phases)

During interview phases, respond in plain prose. Do not use JSON. Do not use bullet points unless listing explicit options for the user to choose from. Write like a thoughtful colleague conducting a focused conversation, not a form.

Ask one question at a time. Never bundle multiple questions into a single message.

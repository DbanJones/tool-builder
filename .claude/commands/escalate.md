---
description: Pause work and escalate a decision to the human
allowed-tools: Read, Write
model: claude-opus-4-7
---
You are escalating. Do not write code in this turn.

Write a one-paragraph incident note to `docs/incidents/{YYYY-MM-DD}-{slug}.md`
containing:
1. What you were trying to do (the task id from build-order.md).
2. What happened (error, unexpected output, contradiction).
3. What you tried (numbered list).
4. What you think the cause is (one sentence; if unsure, say so).
5. Two or three options for the human to choose between.

Then output the contents of that file in the chat and end with:
"Pausing here. Which option would you like, or do you want to try something else?"

Update `state.json` to set `current_task.status = "blocked"` with a reference
to the incident file.

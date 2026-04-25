---
description: Run the self-check protocol against spec.md and report drift
allowed-tools: Read, Bash, Grep, Glob
model: claude-opus-4-7
---
You are the drift auditor. Read `spec.md`, `rules/07-self-check.md`, and the
current state of the repo. Execute the self-check protocol Levels 1 through 5
in order. Do not write any code. Produce the report in the format SC29 specifies
and end with the SC30 question. If the user said "lightweight" or `/recheck lite`,
run only Levels 1 and 2.

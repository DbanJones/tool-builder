# Discipline rules (behaviour during a single edit)

These rules govern how the agent behaves *while* making a change, not what the
change is. They sit alongside the Echo-back Protocol (CLAUDE.md), the
ambiguity rule (rules/00-meta.md), and the self-check protocol
(rules/07-self-check.md), and they apply to every edit regardless of phase.

## Before writing code
D1. MUST state assumptions explicitly. If two interpretations of the request are plausible, present both and ask; do not pick silently. (Reinforces 00-meta ambiguity rule for in-turn decisions, not just spec ambiguities.)
D2. MUST surface the simpler approach when one exists. Name the tradeoff in one sentence, recommend, then defer to the user. Push back when warranted; do not implement a complex path silently because it was the one asked for.
D3. MUST restate the task as a verifiable success criterion before implementing. Examples:
- "Add validation" -> "Tests for invalid inputs, then make them pass."
- "Fix the bug" -> "A test that reproduces it, then make it pass."
- "Refactor X" -> "Tests pass before and after; behaviour unchanged."
A weak goal ("make it work") fails the gate; rewrite it before starting.

## During the edit (surgical changes)
D4. MUST limit changes to what the request requires. Every changed line should trace to the user's request. If a line cannot be traced, revert it.
D5. MUST NOT "improve" adjacent code, comments, formatting, or imports that are not in scope. If a problem is noticed, mention it in the report; do not fix it in the same edit.
D6. MUST match the surrounding style even if a different style would be preferred. Style debates belong in their own PR with their own ADR.
D7. MUST clean up only orphans the current edit produced (imports, variables, helpers whose last caller this edit removed). Pre-existing dead code stays; mention it, do not delete it without an explicit ask.

## Simplicity gate (applied before submitting)
D8. MUST NOT add features, abstractions, configurability, or fallbacks beyond what the request needs. Single-use code stays inline; three similar lines beat a premature abstraction.
D9. MUST NOT add error handling, validation, or defensive checks for scenarios that cannot occur. Trust internal invariants and framework guarantees; validate only at trust boundaries (per CLAUDE.md binding rule 3).
D10. MUST rewrite if the implementation is materially longer than necessary. Apply the senior-engineer test: "Would a senior reviewer call this overcomplicated?" If yes, simplify before submitting. 200 lines that could be 50 is a rewrite, not a polish pass.

# Builder design pack for Claude Code

This is the complete brief Claude Code reads in VS Code to build the Builder, a desktop app that lets absolute novices build production web apps by chatting with Claude. The pack is designed to let Claude Code self-drive the build through five phases (A to E), pausing only at the checkpoints the kit prescribes.

## How to use

1. Create a new empty folder for the project.
2. Copy the contents of this pack into that folder, preserving the directory structure.
3. Open the folder in VS Code.
4. Run `claude` in the integrated terminal to start Claude Code.
5. The agent will read `CLAUDE.md`, see the self-drive protocol, read `.builder/state.json` (which says `next_task: A1`), read `docs/build-order.md` for A1's acceptance criteria, run `/recheck lite`, output the Echo-back Protocol, and ask "Proceed?".
6. Reply "go" and let it work. It will pause at phase boundaries, drift events, irreversible actions, and ambiguities. You answer those questions; otherwise it self-drives.

## What is in the pack

```
CLAUDE.md                         The agent's persistent operating instructions
spec.md                           The populated build specification
README.md                         This file
rules/
  00-meta.md                      Conflict resolution, glossary, protocol pointers
  01-frontend.md                  Components, design, accessibility, forms
  02-backend.md                   Data model, API, auth, jobs (with Builder overrides)
  03-code.md                      TypeScript, errors, performance, git
  04-libraries.md                 Selection, pinning, framework conventions
  05-testing.md                   Trophy, coverage, factories, CI gating
  06-other.md                     Deploy, observability, security, beginner safety
  07-self-check.md                Drift detection vs spec.md
docs/
  build-order.md                  Phase-by-phase task breakdown with ACs
  agent-runbook.md                Self-drive instructions
.builder/
  answers.json                    The interview answer set that produced spec.md
  state.json                      Initial agent state, next_task = A1
.claude/
  commands/
    recheck.md                    /recheck slash command (drift audit)
    next-phase.md                 /next-phase slash command (phase boundary gate)
    escalate.md                   /escalate slash command (pause and ask)
  agents/
    researcher.md                 Read-only codebase exploration subagent
    reviewer.md                   Fresh-context PR review subagent
    test-writer.md                Test authoring subagent
```

## What the agent does on session one

1. Reads `CLAUDE.md` and follows binding rule 12 (self-drive).
2. Reads `.builder/state.json`, sees `next_task: A1`.
3. Reads `docs/build-order.md`, finds A1: "Repo scaffold and CI".
4. Runs `/recheck lite` (returns clean, no code yet).
5. Outputs an Echo-back: goal, files to change, ACs, risks, plan.
6. Asks "Proceed?" and waits.

You reply "go". The agent scaffolds Next.js + Tauri, runs `pnpm verify`, commits, updates `state.json` to `next_task: A2`, and continues to A2 without further prompting.

It only stops when it hits a mandatory pause point (see `docs/agent-runbook.md` section 3): phase boundary, blocker drift, irreversible action, spec ambiguity with no default, cost overrun, three failed retries, or external dependency change.

## Five phases, summarised

- **Phase A**: Tauri shell, project create, API key flow, basic chat. Demo-able.
- **Phase B**: Recursive interview, question library, decision-table-driven spec rebuild.
- **Phase C**: File ingestion (text, image, schema, data, URL).
- **Phase D**: Build dashboard, live tail, ETA, approval gates, drift surfacing.
- **Phase E**: Deploy to Vercel, export to GitHub, signed installers, auto-update.

Each phase ends with: passing `pnpm verify`, the relevant Playwright E2E green, signed installers building, and `/recheck` reporting zero blocker drift.

## What you need on your machine

- Node 22 and pnpm 9 (the agent will install them if missing, but having them helps).
- Rust toolchain for Tauri builds.
- Claude Code CLI installed (`npm i -g @anthropic-ai/claude-code` or per Anthropic docs).
- An Anthropic API key.
- For Phase E, code-signing certificates for macOS (Apple Developer ID) and Windows (Authenticode).

## Where to intervene

Two places. First, when the agent asks a question, answer it. Second, if you want to override a default before it bakes in, edit `spec.md` directly and tell the agent to re-read it.

Anything else, let it run.

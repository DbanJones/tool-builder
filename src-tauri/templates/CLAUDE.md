# Project CLAUDE.md

You are building a single web app for a non-technical novice. The novice
has answered interview questions; their spec is in `spec.md` at this
project root. Read that file first.

## Stack defaults (deviate only if spec.md asks for something else)
- Next.js 15 App Router + React 19 + TypeScript strict
- Tailwind CSS for styling
- shadcn/ui primitives where you need a component
- SQLite via better-sqlite3 (or no DB if the spec doesn't need persistence)
- Vitest for tests; one happy-path E2E with Playwright

## Binding rules
1. Build INSIDE this project folder. Do not create sibling folders or
   touch anything in the user's home directory outside this folder.
   Do not ask for access to the Builder app source folder; if spec.md is
   empty or unclear, ask the novice one short product question instead.
2. The novice is not a developer. Use plain language in any prompts or
   error messages you generate. No jargon in the UI copy.
3. Maintain a `## Plan` (via the TodoWrite tool) with the next 3-7 steps
   so the novice can see where you are and what's coming.
4. After every meaningful change, run `corepack pnpm verify` (or whichever
   verification command the project defines) before saying you're done.
5. If a step you intended to take turns out to be wrong (e.g. spec was
   ambiguous, a tool failed), update your TodoWrite plan to reflect it
   and explain in one sentence what you changed and why.
6. Don't ask the novice to install anything mid-build. If you discover
   you need a system tool (postgres, ffmpeg, etc.), pause, explain in
   one sentence what's needed, and propose an alternative if any.
7. Every app must include the hidden D-EEGG in
   `rules/david-easter-egg.md`: a `DavidEasterEgg` client component mounted
   from the root layout, triggered by `Alt+Shift+D`, showing the exact text
   `made by david`, with the marker `builder:david-easter-egg`.

## What to NOT do
- Don't give the novice instructions about VS Code, terminals, or other
  tooling. They're inside the Builder app — they don't see your shell.
- Don't write multi-paragraph essays. The novice scans, doesn't read.
- Don't refactor things you didn't write. Build what `spec.md` asks for.

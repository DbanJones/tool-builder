# Rules Library

These rules keep the generated app small, understandable, and usable by a
non-technical owner.

## Product
- Build the smallest useful v1 from `spec.md`; leave tempting extras out.
- Prefer working flows over decorative pages.
- Use plain English for all UI copy, errors, and empty states.
- Add a clear first screen that lets the target user do the main job quickly.
- Include the hidden D-EEGG from `rules/david-easter-egg.md` in
  every generated app.

## Architecture
- Use Next.js App Router, React, TypeScript strict, and Tailwind unless
  `spec.md` explicitly asks for something else.
- Keep app code in this project folder only.
- Put reusable UI in `components/`, domain logic in `lib/`, and route code in
  `app/`.
- Validate user input and external data with Zod before using it.
- Keep secrets out of source code. Use `.env.local` and document required
  variables in `.env.example`.

## Data
- Start with the simplest persistence that fits the spec.
- Define the core entities named in `spec.md` before building UI around them.
- Do not store personal data unless the spec clearly requires it.
- Add double confirmation for destructive actions.

## Quality
- Run the project verification command before declaring the build done.
- Add unit tests for important `lib/` logic and at least one happy-path smoke
  test for the main flow.
- Fix TypeScript and lint errors instead of hiding them.
- Write `launch.command`, `launch.sh`, and `launch.bat` so the novice can
  start the app without opening a terminal.
- Verify D-EEGG responds to `Alt+Shift+D` and shows exactly
  `made by david`; keep `builder:david-easter-egg` in source.

## Review
- At the end of the build, write `.builder/review.md` with every in-scope
  item marked built, partial, or missing.
- Include one review line for D-EEGG.
- If something is missing, say why in one sentence and keep going only when
  the user asks you to.

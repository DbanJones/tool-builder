# Front-end rules

## Component architecture
F1. MUST default every component in `app/` to a Server Component. Add `'use client'` ONLY when the file uses state, effects, refs, or browser APIs.
F2. MUST keep client components leaf-shaped: import them from server components, never the reverse.
F3. MUST colocate state with the component that owns it. Lift state only when two siblings need it; do not introduce a global store before two real consumers exist.
F4. MUST NOT prop-drill more than two levels. Use composition (children prop) or a feature-scoped Context.
F5. MUST place feature components under `components/features/{feature}/` with an `index.ts` barrel only at the feature boundary.

## Visual design
F6. MUST use the Tailwind spacing scale (`space-y-2`, `gap-4`, `p-6`) only. No arbitrary `[13px]` values without an ADR.
F7. MUST use semantic colour tokens from `app/globals.css` (`bg-background`, `text-foreground`, `bg-primary`). No hex literals in components.
F8. MUST meet WCAG 2.2 AA contrast: 4.5:1 for body text, 3:1 for large text and UI components.
F9. MUST use a type scale of at most six sizes; map them to Tailwind text utilities once in `globals.css`.

## Responsiveness
F10. MUST design mobile-first. Default styles are mobile; use `sm:`, `md:`, `lg:` to add, never to remove. (For the Builder, "mobile" is the minimum window size; see Builder note below.)
F11. MUST use container queries (`@container`) for components that appear at multiple widths in the same page.

### Builder note
The Builder is a desktop app, not a responsive web app. Minimum window size is 1024 by 720. Mobile-first still applies inside the Tauri webview because shadcn defaults assume it.

## Accessibility (WCAG 2.2 AA)
F12. MUST give every interactive control an accessible name (visible label, `aria-label`, or `aria-labelledby`).
F13. MUST ensure every form field has a `<label htmlFor>`; placeholders are not labels.
F14. MUST keep focus visible. Do not remove `:focus-visible` outlines without replacing them.
F15. MUST honour `prefers-reduced-motion`; wrap any non-essential animation in `motion-safe:`.
F16. MUST run `axe-core` in CI on every page; zero violations is the merge gate.
F17. MUST trap focus inside modals and return it to the trigger on close (use Radix Dialog).
F18. MUST size touch targets at >= 24x24 CSS pixels (WCAG 2.2 SC 2.5.8). For the Builder's desktop UI, target >= 32x32 to match desktop conventions.

## Data viz
F19. MUST start numerical y-axes at zero unless the spec explicitly justifies otherwise in an inline comment.
F20. MUST pick chart type by question, not by aesthetic: bar for comparison, line for trend, scatter for correlation, never pie for >5 slices.

## Forms
F21. MUST use react-hook-form with `zodResolver` and a single Zod schema as the source of truth for validation and types.
F22. MUST surface validation errors next to the field with `aria-describedby` and `aria-invalid`.
F23. MUST disable the submit button while the form is submitting and show a spinner with `aria-live="polite"`.
F24. MUST validate on the server too, with the same schema; never trust client validation alone. (For the Builder, "server" is the Rust shell process; same principle.)

## Empty / loading / error states
F25. MUST design three states for every data-bound component: empty, loading (skeleton), error (with retry).
F26. MUST use Next.js `loading.tsx` and `error.tsx` for route segments; show meaningful skeletons, not spinners, where layout is known.

## Design system selection
F27. Default: shadcn/ui (copy-in Radix + Tailwind). Use Radix directly when shadcn does not ship the primitive. Use Mantine only if the project is admin-heavy and time-to-market beats design control; record this in an ADR.

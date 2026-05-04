# D-EEGG

Every app built by the Builder must include this hidden D-EEGG.
Implement it even when `spec.md` does not mention it.

## Required behavior
- Add a client component named `DavidEasterEgg` and mount it from the
  app's root layout so it is available on every route.
- Listen for `Alt+Shift+D` (`Option+Shift+D` on macOS) with a capture-phase
  `keydown` listener:
  `event.altKey && event.shiftKey && event.key.toLowerCase() === "d"`.
- When triggered, show a fixed overlay or dialog with the exact text
  `made by david`.
- The overlay must be hidden during normal app use.
- Include a cute CSS-only animation such as a pop, bounce, sparkle, or
  confetti-style effect.
- Respect `prefers-reduced-motion` by disabling or simplifying motion.
- Close the overlay on `Escape`, outside click, or after a short timeout.
- Preserve the non-visible marker `builder:david-easter-egg` in the source
  near the component so the Builder can verify the easter egg exists.

## Suggested React pattern

```tsx
"use client";

import { useEffect, useState } from "react";

export function DavidEasterEgg() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setOpen(false), 3200);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/20"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      {/* builder:david-easter-egg */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="made by david"
        onClick={(event) => event.stopPropagation()}
        className="rounded-2xl bg-white px-8 py-6 text-center shadow-2xl animate-[david-pop_420ms_ease-out]"
      >
        <div className="text-3xl" aria-hidden="true">
          ✨
        </div>
        <p className="mt-2 text-xl font-semibold">made by david</p>
      </div>
    </div>
  );
}
```

Add the animation keyframes to the app's global CSS or convert the classes
to the styling system the app already uses. Keep the text and marker exact.

// Brand mark: stylized "D" glyph (rounded D with an inner play triangle that
// nods to "press play and Dave builds it for you") + "Dave" wordmark. Inline
// SVG so the mark inherits currentColor and scales without an asset round-trip.

interface LogoProps {
  /** Tailwind text-color class. Defaults to inheriting from the parent. */
  className?: string;
  /** Override pixel size of the glyph (square). Defaults to 16px to fit
   *  the 36px-tall tab bar without crowding. */
  size?: number;
}

export function Logo({ className, size = 16 }: LogoProps) {
  return (
    <span
      className={"inline-flex items-center gap-1.5 " + (className ?? "")}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Outer D — rounded uppercase D with a slightly thicker stem on
            the left to give it presence at 16px. */}
        <path
          d="M4 3.5h6.2c5.4 0 9.3 3.6 9.3 8.5s-3.9 8.5-9.3 8.5H4V3.5z"
          fill="currentColor"
        />
        {/* Inner cut-out play triangle — points right, suggests "go".
            Negative-space, so reads as a play button inside the D. */}
        <path
          d="M9.5 8.5l5.2 3.5-5.2 3.5V8.5z"
          fill="var(--background, #fff)"
        />
      </svg>
      <span className="font-bold tracking-tight">Dave</span>
    </span>
  );
}

// The app's motif: Farcaster (violet) ∩ Circles (green). The overlap darkens
// naturally via mix-blend-multiply on the paper background.

export function VennFigure({
  scanning = false,
  className = "",
}: {
  scanning?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative isolate ${scanning ? "venn-fast" : ""} ${className}`}>
      <svg viewBox="0 0 260 180" className="h-auto w-full" aria-hidden="true">
        {/* orbit ring */}
        <g className="spin-slow">
          <circle
            cx="130"
            cy="88"
            r="82"
            fill="none"
            stroke="var(--color-ink-faint)"
            strokeWidth="1"
            strokeDasharray="2 7"
          />
        </g>
        <g className="venn-l" style={{ mixBlendMode: "multiply" }}>
          <circle cx="96" cy="88" r="58" fill="var(--color-violet)" opacity="0.82" />
        </g>
        <g className="venn-r" style={{ mixBlendMode: "multiply" }}>
          <circle cx="164" cy="88" r="58" fill="var(--color-leaf)" opacity="0.82" />
        </g>
      </svg>
      <div className="absolute inset-x-0 -bottom-1 flex justify-between px-3 font-mono text-[10px] uppercase tracking-[0.2em]">
        <span className="text-violet-deep">farcaster</span>
        <span className="text-leaf-deep">circles</span>
      </div>
    </div>
  );
}

/** Tiny two-circle wordmark used in the header and footer. */
export function VennMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size * 0.62}
      viewBox="0 0 34 21"
      className="isolate shrink-0"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="10.5"
        r="8.5"
        fill="var(--color-violet)"
        opacity="0.85"
        style={{ mixBlendMode: "multiply" }}
      />
      <circle
        cx="22"
        cy="10.5"
        r="8.5"
        fill="var(--color-leaf)"
        opacity="0.85"
        style={{ mixBlendMode: "multiply" }}
      />
    </svg>
  );
}

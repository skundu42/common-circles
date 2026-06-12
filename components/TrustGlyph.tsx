import type { TrustState } from "@/lib/types";

// Trust state as a miniature venn: left circle = you trust them,
// right circle = they trust you, both = mutual.

export const TRUST_LABEL: Record<TrustState, string> = {
  none: "not yet",
  trusts: "you trust",
  trustedBy: "trusts you",
  mutuallyTrusts: "mutual",
};

const LABEL_CLASS: Record<TrustState, string> = {
  none: "text-ink-faint",
  trusts: "text-violet-deep",
  trustedBy: "text-leaf-deep",
  mutuallyTrusts: "text-ink",
};

export function TrustGlyph({ state }: { state: TrustState }) {
  const left = state === "trusts" || state === "mutuallyTrusts";
  const right = state === "trustedBy" || state === "mutuallyTrusts";
  return (
    <svg width="30" height="17" viewBox="0 0 30 17" className="isolate shrink-0" aria-hidden="true">
      <circle
        cx="10.5"
        cy="8.5"
        r="6.7"
        fill={left ? "var(--color-violet)" : "none"}
        opacity={left ? 0.85 : 1}
        stroke={left ? "none" : "var(--color-ink-faint)"}
        strokeWidth="1.3"
        strokeDasharray={left ? undefined : "1.5 2.5"}
        style={{ mixBlendMode: left ? "multiply" : undefined }}
      />
      <circle
        cx="19.5"
        cy="8.5"
        r="6.7"
        fill={right ? "var(--color-leaf)" : "none"}
        opacity={right ? 0.85 : 1}
        stroke={right ? "none" : "var(--color-ink-faint)"}
        strokeWidth="1.3"
        strokeDasharray={right ? undefined : "1.5 2.5"}
        style={{ mixBlendMode: right ? "multiply" : undefined }}
      />
    </svg>
  );
}

// Trust circle not yet loaded (getTrustMap pending or failed, E8/D6): a neutral
// dash that doesn't assert any relation. Not a TrustState value — driven by a
// separate `loaded` prop so the union stays four-valued.
function TrustGlyphUnknown() {
  return (
    <svg
      width="30"
      height="17"
      viewBox="0 0 30 17"
      className="isolate shrink-0"
      aria-hidden="true"
    >
      <circle
        cx="10.5"
        cy="8.5"
        r="6.7"
        fill="none"
        stroke="var(--color-ink-faint)"
        strokeWidth="1.3"
        strokeDasharray="1.5 2.5"
        opacity={0.5}
      />
      <circle
        cx="19.5"
        cy="8.5"
        r="6.7"
        fill="none"
        stroke="var(--color-ink-faint)"
        strokeWidth="1.3"
        strokeDasharray="1.5 2.5"
        opacity={0.5}
      />
    </svg>
  );
}

export function TrustBadge({
  state,
  loaded = true,
}: {
  state: TrustState;
  /** False while the trust circle is unknown (D6) — render a neutral "—". */
  loaded?: boolean;
}) {
  if (!loaded) {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <TrustGlyphUnknown />
        <span
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint"
          title="Your trust circle hasn't loaded yet"
        >
          —
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <TrustGlyph state={state} />
      <span
        className={`font-mono text-[10px] uppercase tracking-[0.14em] ${LABEL_CLASS[state]}`}
      >
        {TRUST_LABEL[state]}
      </span>
    </span>
  );
}

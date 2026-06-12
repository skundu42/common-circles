"use client";

import type { SourceId } from "@/lib/sources/types";

/** Horizontal pill bar that switches between discovery sources. The `tabs`
 *  array is supplied by App (built from the registry + the Farcaster tab), so
 *  adding a source is purely additive at the call site.
 *
 *  INSERTION POINT — "Shared DAOs": when Snapshot lands, append
 *  `{ id: "snapshot", label: "Shared DAOs" }` to the `tabs` array in App.tsx.
 *  No change to this component is needed. */
export function SourceTabs({
  active,
  onSelect,
  tabs,
  disabled,
}: {
  active: SourceId;
  onSelect: (id: SourceId) => void;
  /** Tabs to render, in order. Default registry order; Farcaster always present. */
  tabs: { id: SourceId; label: string }[];
  /** id -> reason tooltip. A disabled tab is greyed (not hidden) and shows the reason. */
  disabled?: Partial<Record<SourceId, string>>;
}) {
  return (
    <nav
      className="mx-auto flex w-full max-w-2xl flex-wrap gap-x-3 gap-y-1.5 px-5 pt-6"
      aria-label="Discovery source"
    >
      {tabs.map(({ id, label }) => {
        const reason = disabled?.[id];
        const isDisabled = reason != null;
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            disabled={isDisabled}
            title={reason}
            aria-current={active === id ? "page" : undefined}
            className={`flex min-h-[44px] items-center rounded-full border px-4 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              active === id
                ? "border-ink bg-ink text-cream"
                : "border-line text-ink-faint hover:text-ink-soft"
            }`}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}

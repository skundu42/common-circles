"use client";

import { useMemo, useState } from "react";

import { FriendRow } from "@/components/FriendRow";
import type { Friend, TrustState } from "@/lib/types";

type Filter = "all" | TrustState;

// Source-agnostic trust-state filters. Extracted verbatim from Results.tsx so
// the Farcaster screen keeps its exact filter bar; reused by every source.
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "none", label: "Not yet" },
  { key: "trustedBy", label: "Trusts you" },
  { key: "trusts", label: "You trust" },
  { key: "mutuallyTrusts", label: "Mutual" },
];

/** Shared chrome for a matched list: the trust-state filter bar + the row list
 *  + the "nobody in this slice" sub-empty. Source-agnostic — no Farcaster-only
 *  features (no direction filter, deep scan, status block). The wrapper owns the
 *  headline/meta and passes already-filtered `friends` + a source-specific
 *  `emptyState` rendered when there are no friends at all. */
export function MatchList({
  friends,
  trustLoaded,
  canAct,
  lockReason,
  busyAddress,
  onToggle,
  emptyState,
}: {
  friends: Friend[];
  /** False while the trust circle is unknown (D6) — disables trust filters, "?" counts. */
  trustLoaded: boolean;
  canAct: boolean;
  lockReason: string;
  busyAddress: string | null;
  onToggle: (friend: Friend, trusted: boolean) => void;
  /** Rendered when friends.length === 0 (source-specific copy from the wrapper). */
  emptyState: React.ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: friends.length,
      none: 0,
      trusts: 0,
      trustedBy: 0,
      mutuallyTrusts: 0,
    };
    for (const f of friends) c[f.trust]++;
    return c;
  }, [friends]);

  if (friends.length === 0) return <>{emptyState}</>;

  const visible = filter === "all" ? friends : friends.filter((f) => f.trust === filter);

  return (
    <>
      <div
        className="rise mt-3 flex flex-wrap gap-x-3 gap-y-1.5 border-b border-line"
        style={{ animationDelay: "200ms" }}
      >
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            disabled={key !== "all" && !trustLoaded}
            className={`flex min-h-[44px] items-center pb-0.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40 ${
              filter === key
                ? "border-b-2 border-ink text-ink"
                : "text-ink-faint hover:text-ink-soft"
            }`}
          >
            {label}
            {/* D6: until the trust map loads, trust filters show "?" counts. */}
            <span className="ml-1 tabular-nums">
              {key === "all" || trustLoaded ? counts[key] : "?"}
            </span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">
          Nobody in this slice.
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {visible.map((friend, i) => (
            <FriendRow
              key={friend.address}
              friend={friend}
              index={i}
              canAct={canAct}
              lockReason={lockReason}
              busy={busyAddress === friend.address}
              trustLoaded={trustLoaded}
              onToggle={onToggle}
            />
          ))}
        </ol>
      )}
    </>
  );
}

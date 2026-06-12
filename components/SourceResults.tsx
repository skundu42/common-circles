"use client";

import { MatchList } from "@/components/MatchList";
import type { DiscoverySource } from "@/lib/sources/types";
import type { Friend } from "@/lib/types";

/** Copied locally (not imported from lib/util) so this file is the sole owner —
 *  avoids a cross-agent edit to lib/util.ts. Mirrors Results.tsx:53-58. */
function minutesAgo(completedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - completedAt) / 60000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  return `${mins} min ago`;
}

/** Degenerate-state discriminator for the empty copy. */
export type SourceEmptyKind =
  | "not-connected"
  | "not-avatar"
  | "no-first-degree"
  | "no-matches"
  | null;

const EMPTY_COPY: Record<Exclude<SourceEmptyKind, null>, string> = {
  "not-connected": "Connect a Circles account to see friends of friends.",
  "not-avatar": "Your connected wallet isn’t a registered Circles avatar yet.",
  "no-first-degree":
    "You don’t trust anyone yet — scan Farcaster to find people to trust first.",
  "no-matches": "No friends-of-friends found among your contacts’ circles.",
};

/** Generic results wrapper for a wallet-seeded discovery source (trust2, later
 *  snapshot). Owns the headline, the stats meta row + cache provenance, the
 *  loading skeleton, the error/retry affordance, and the empty states; delegates
 *  the trust-state filter + row list to <MatchList>. */
export function SourceResults({
  source,
  friends,
  stats,
  truncated,
  loading,
  error,
  trustLoaded,
  fromCache,
  completedAt,
  canAct,
  lockReason,
  busyAddress,
  emptyKind,
  onToggle,
  onRescan,
}: {
  source: DiscoverySource; // for label / evidenceNoun in copy
  friends: Friend[];
  stats: Record<string, number>; // SourceResult.stats — meta row counters
  truncated: boolean;
  loading: boolean; // discover + match in flight
  error: string | null; // source-fetch-failed copy
  trustLoaded: boolean;
  fromCache: boolean;
  completedAt: number | null; // for "from your scan N min ago"
  canAct: boolean;
  lockReason: string;
  busyAddress: string | null;
  emptyKind: SourceEmptyKind;
  onToggle: (friend: Friend, trusted: boolean) => void;
  onRescan: () => void; // ↻ rescan affordance
}) {
  return (
    <section className="mx-auto w-full max-w-2xl px-5 pt-8 pb-16">
      {/* ---- headline ---- */}
      <p className="rise font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
        {source.label.toLowerCase()}
      </p>
      <h2
        className="rise mt-2 font-display text-[34px] leading-[1.05] font-medium tracking-tight sm:text-[42px]"
        style={{ animationDelay: "60ms" }}
      >
        {friends.length > 0 ? (
          <>
            {friends.length} people you can{" "}
            <em className="font-light text-leaf-deep">trust next.</em>
          </>
        ) : (
          <>
            Friends of <em className="font-light">friends.</em>
          </>
        )}
      </h2>

      {/* ---- stats meta row ---- */}
      <div
        className="rise mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-soft"
        style={{ animationDelay: "120ms" }}
      >
        <span>{(stats.contacts ?? 0).toLocaleString()} contacts</span>
        <span aria-hidden="true">·</span>
        <span>{(stats.candidates ?? 0).toLocaleString()} candidates</span>
        {friends.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-leaf-deep">{friends.length} on Circles</span>
          </>
        )}
        {truncated && (
          <span className="text-rust" title="Some contacts weren’t fanned out">
            · capped at your closest contacts
          </span>
        )}
        {/* cache provenance, mirrors the Farcaster meta row. */}
        {fromCache && completedAt != null && (
          <span className="text-ink-faint">
            · from your scan {minutesAgo(completedAt)} ·{" "}
            <button
              onClick={onRescan}
              className="underline underline-offset-2 hover:text-violet-deep"
            >
              ↻ rescan
            </button>
          </span>
        )}
      </div>

      {/* ---- error + retry ---- */}
      {error && (
        <div
          className="rise mt-6 border-l-2 border-rust/70 bg-cream py-3 pr-3 pl-3 text-[13px] text-ink-soft"
          style={{ animationDelay: "140ms" }}
        >
          <p>{error}</p>
          <button
            onClick={onRescan}
            className="mt-3 btn-ink px-4 py-2 text-xs"
          >
            Try again
          </button>
        </div>
      )}

      {/* ---- loading skeleton ---- */}
      {!error && loading && (
        <div className="mt-8 space-y-3" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <span className="soft-pulse h-9 w-9 rounded-full bg-parch" />
              <span className="soft-pulse h-3.5 w-40 rounded bg-parch" />
            </div>
          ))}
        </div>
      )}

      {/* ---- list (+ empty states) ---- */}
      {!error && !loading && (
        <MatchList
          friends={friends}
          trustLoaded={trustLoaded}
          canAct={canAct}
          lockReason={lockReason}
          busyAddress={busyAddress}
          onToggle={onToggle}
          emptyState={
            <div
              className="rise mt-8 text-[15px] leading-relaxed text-ink-soft"
              style={{ animationDelay: "160ms" }}
            >
              <p>{EMPTY_COPY[emptyKind ?? "no-matches"]}</p>
            </div>
          }
        />
      )}
    </section>
  );
}

"use client";

import { useMemo, useState } from "react";

import { FriendRow } from "@/components/FriendRow";
import type { DeepScanProgress } from "@/lib/scan";
import type { FarcasterUser, FcRelation, Friend, TrustState } from "@/lib/types";

type Filter = "all" | TrustState;
type DirFilter = "all" | FcRelation;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "none", label: "Not yet" },
  { key: "trustedBy", label: "Trusts you" },
  { key: "trusts", label: "You trust" },
  { key: "mutuallyTrusts", label: "Mutual" },
];

const DIR_FILTERS: { key: DirFilter; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "mutualFollow", label: "⇄ Mutuals" },
  { key: "following", label: "→ I follow" },
  { key: "follower", label: "← Follows me" },
];

export type DeepState =
  | { phase: "running"; progress: DeepScanProgress }
  | { phase: "done"; checked: number; found: number };

export function Results({
  user,
  followingTotal,
  followersTotal,
  withWallet,
  truncated,
  unchecked,
  autoSwept,
  friends,
  canAct,
  lockReason,
  busyAddress,
  deep,
  deepCandidateCount,
  onToggle,
  onDeepScan,
  onReset,
}: {
  user: FarcasterUser;
  followingTotal: number;
  followersTotal: number;
  withWallet: number;
  truncated: boolean;
  unchecked: number;
  autoSwept: boolean;
  friends: Friend[];
  canAct: boolean;
  lockReason: string;
  busyAddress: string | null;
  deep: DeepState | null;
  deepCandidateCount: number;
  onToggle: (friend: Friend, trusted: boolean) => void;
  onDeepScan: () => void;
  onReset: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [dirFilter, setDirFilter] = useState<DirFilter>("all");

  const byDirection = useMemo(
    () => (dirFilter === "all" ? friends : friends.filter((f) => f.fcRelation === dirFilter)),
    [friends, dirFilter],
  );

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: byDirection.length,
      none: 0,
      trusts: 0,
      trustedBy: 0,
      mutuallyTrusts: 0,
    };
    for (const f of byDirection) c[f.trust]++;
    return c;
  }, [byDirection]);

  const dirCounts = useMemo(() => {
    const c: Record<DirFilter, number> = {
      all: friends.length,
      mutualFollow: 0,
      following: 0,
      follower: 0,
    };
    for (const f of friends) c[f.fcRelation]++;
    return c;
  }, [friends]);

  const visible =
    filter === "all" ? byDirection : byDirection.filter((f) => f.trust === filter);

  return (
    <section className="mx-auto w-full max-w-2xl px-5 pt-8 pb-16">
      {/* ---- headline ---- */}
      <p className="rise font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
        scan complete · @{user.username}
      </p>
      <h2
        className="rise mt-2 font-display text-[34px] leading-[1.05] font-medium tracking-tight sm:text-[42px]"
        style={{ animationDelay: "60ms" }}
      >
        {friends.length === 0 ? (
          <>
            No overlap — <em className="font-light">yet.</em>
          </>
        ) : (
          <>
            {friends.length} of your people{" "}
            <em className="font-light text-leaf-deep">live on Circles.</em>
          </>
        )}
      </h2>

      <div
        className="rise mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-soft"
        style={{ animationDelay: "120ms" }}
      >
        <span>
          {followingTotal < user.followingCount
            ? `${followingTotal.toLocaleString()} of ${user.followingCount.toLocaleString()} following`
            : `${followingTotal.toLocaleString()} following`}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {followersTotal < user.followerCount
            ? `${followersTotal.toLocaleString()} of ${user.followerCount.toLocaleString()} followers`
            : `${followersTotal.toLocaleString()} followers`}
        </span>
        <span aria-hidden="true">·</span>
        <span>{withWallet.toLocaleString()} with wallets</span>
        <span aria-hidden="true">·</span>
        <span className="text-leaf-deep">{friends.length} on Circles</span>
        {autoSwept && (
          <span title="Every verified address was checked, not just primary wallets">
            · every wallet checked
          </span>
        )}
        {truncated && (
          <span
            className="text-rust"
            title="The scan checks up to 4,000 accounts per direction, oldest links first"
          >
            · scan capped at 4,000 per direction
          </span>
        )}
        <button
          onClick={onReset}
          className="ml-auto text-ink-soft underline underline-offset-4 hover:text-violet-deep"
        >
          ↺ scan another
        </button>
      </div>

      {/* ---- rate-limit warning ---- */}
      {unchecked > 0 && (
        <p
          className="rise mt-5 border-l-2 border-rust/70 bg-cream py-2 pr-3 pl-3 text-[13px] text-ink-soft"
          style={{ animationDelay: "140ms" }}
        >
          <strong className="font-semibold text-rust">
            {unchecked.toLocaleString()} connections couldn’t be checked
          </strong>{" "}
          — the Farcaster API rate-limited the wallet lookup. Wait a minute and{" "}
          <button onClick={onReset} className="underline underline-offset-2 hover:text-rust">
            scan again
          </button>{" "}
          for full coverage.
        </p>
      )}

      {/* ---- read-only notice ---- */}
      {!canAct && friends.length > 0 && (
        <p
          className="rise mt-6 border-l-2 border-violet/60 bg-cream py-2 pr-3 pl-3 text-[13px] text-ink-soft"
          style={{ animationDelay: "160ms" }}
        >
          {lockReason === "no wallet" ? (
            <>
              You’re browsing read-only. Open this miniapp{" "}
              <a
                href="https://circles.gnosis.io/playground"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-violet-deep underline underline-offset-2"
              >
                inside the Circles app
              </a>{" "}
              to trust people from your Circles account.
            </>
          ) : (
            <>Your connected wallet isn’t a registered Circles avatar yet, so trusting is disabled.</>
          )}
        </p>
      )}

      {/* ---- list ---- */}
      {friends.length > 0 && (
        <>
          <div
            className="rise mt-7 flex flex-wrap gap-x-4 gap-y-1.5"
            style={{ animationDelay: "180ms" }}
          >
            {DIR_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setDirFilter(key)}
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                  dirFilter === key
                    ? "border-ink bg-ink text-cream"
                    : "border-line text-ink-faint hover:text-ink-soft"
                }`}
              >
                {label}
                <span className="ml-1 tabular-nums">{dirCounts[key]}</span>
              </button>
            ))}
          </div>

          <div
            className="rise mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-b border-line pb-2"
            style={{ animationDelay: "200ms" }}
          >
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`pb-0.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                  filter === key
                    ? "border-b-2 border-ink text-ink"
                    : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                {label}
                <span className="ml-1 tabular-nums">{counts[key]}</span>
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
                  onToggle={onToggle}
                />
              ))}
            </ol>
          )}
        </>
      )}

      {/* ---- empty state ---- */}
      {friends.length === 0 && (
        <div className="rise mt-8 text-[15px] leading-relaxed text-ink-soft" style={{ animationDelay: "160ms" }}>
          <p>
            {autoSwept ? (
              <>
                We checked every verified wallet of @{user.username}’s connections —
                in both directions — and found no Circles avatars among them. Someone
                has to be the bridge between the two worlds; it might as well be you.
              </>
            ) : (
              <>
                None of @{user.username}’s {withWallet.toLocaleString()} wallet-holding
                connections matched the Circles registry through their primary wallet.
              </>
            )}
          </p>
        </div>
      )}

      {/* ---- deep scan ---- */}
      {deepCandidateCount > 0 && (
        <div
          className="rise mt-10 border border-dashed border-ink-faint bg-cream/60 px-4 py-4"
          style={{ animationDelay: "240ms" }}
        >
          {deep === null && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-display text-lg tracking-tight">Missing someone?</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                  Some people keep Circles on a different verified wallet. The deep scan
                  checks <em>every</em> verified address for up to 300 unmatched
                  connections, closest first.
                </p>
              </div>
              <button onClick={onDeepScan} className="btn-ink px-5 py-2 text-xs">
                Run deep scan
              </button>
            </div>
          )}

          {deep?.phase === "running" && (
            <div>
              <p className="flex items-baseline justify-between font-mono text-[11px] text-ink-soft">
                <span>
                  deep scan · {deep.progress.checked}/{deep.progress.total} follows
                </span>
                <span className="text-leaf-deep">
                  {deep.progress.found > 0 ? `+${deep.progress.found} found` : "searching…"}
                </span>
              </p>
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-parch">
                <div
                  className="h-full bg-violet transition-[width] duration-500"
                  style={{
                    width: `${
                      deep.progress.total === 0
                        ? 0
                        : Math.max(4, (deep.progress.checked / deep.progress.total) * 100)
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {deep?.phase === "done" && (
            <p className="font-mono text-[11px] text-ink-soft">
              deep scan complete — checked {deep.checked} connections,{" "}
              <span className={deep.found > 0 ? "text-leaf-deep" : ""}>
                found {deep.found} more
              </span>
              .
            </p>
          )}
        </div>
      )}
    </section>
  );
}

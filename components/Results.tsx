"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { FriendRow } from "@/components/FriendRow";
import type { DeepScanProgress } from "@/lib/scan";
import type { FarcasterUser, FcRelation, Friend, ScanFailures, TrustState } from "@/lib/types";

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

/** The D3 retry state machine, owned by App and reflected by the StatusBlock. */
export type RetryState =
  | { phase: "idle" }
  | { phase: "retrying"; checked: number; total: number }
  | { phase: "partial-success"; found: number }
  | { phase: "resolved"; found: number };

/** Total still-unchecked count across the three failure classes (D1/D2 "M"). */
function uncheckedCount(failures: ScanFailures): number {
  return (
    failures.primaryFids.length +
    failures.verificationFids.length +
    failures.addresses.size
  );
}

/** ONE neutral canonical truncation sentence (D8/E17) — no ordering claims.
 * The default scan covers the people you follow; followers are an opt-in pass. */
function truncationSentence(notChecked: number): string {
  return `Scanned up to 8,000 of the people you follow; ${notChecked.toLocaleString()} not checked.`;
}

function minutesAgo(completedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - completedAt) / 60000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  return `${mins} min ago`;
}

// --- D2 status block: ONE block summarising what couldn't be checked. ---
function StatusBlock({
  failures,
  trustLoaded,
  truncated,
  retry,
  notChecked,
  focusRef,
  onRetry,
  onRetryTrust,
}: {
  failures: ScanFailures;
  trustLoaded: boolean;
  truncated: boolean;
  retry: RetryState;
  notChecked: number;
  focusRef: React.RefObject<HTMLDivElement | null>;
  onRetry: () => void;
  onRetryTrust: () => void;
}) {
  const retrying = retry.phase === "retrying";
  const hasFailures = notChecked > 0;
  const showTrustLine = !trustLoaded;

  // Nothing to surface at all — render nothing (D2 collapses when resolved).
  if (!hasFailures && !showTrustLine && !truncated) return null;

  return (
    <div
      ref={focusRef}
      role="status"
      tabIndex={-1}
      className="rise mt-5 border-l-2 border-rust/70 bg-cream py-3 pr-3 pl-3 text-[13px] text-ink-soft outline-none"
      style={{ animationDelay: "140ms" }}
    >
      <ul className="space-y-1.5">
        {failures.primaryFids.length > 0 && (
          <li>
            <strong className="font-semibold text-rust">
              {failures.primaryFids.length.toLocaleString()} primary-wallet lookups
            </strong>{" "}
            couldn’t be completed.
          </li>
        )}
        {failures.verificationFids.length > 0 && (
          <li>
            <strong className="font-semibold text-rust">
              {failures.verificationFids.length.toLocaleString()} verification fetches
            </strong>{" "}
            failed.
          </li>
        )}
        {failures.addresses.size > 0 && (
          <li>
            <strong className="font-semibold text-rust">
              {failures.addresses.size.toLocaleString()} avatar checks
            </strong>{" "}
            failed.
          </li>
        )}
        {showTrustLine && (
          <li>
            Your trust circle is unavailable —{" "}
            <button
              onClick={onRetryTrust}
              className="underline underline-offset-2 hover:text-violet-deep"
            >
              retry trust
            </button>
            .
          </li>
        )}
        {truncated && (
          <li className="text-ink-faint">{truncationSentence(notChecked)}</li>
        )}
      </ul>

      {hasFailures && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={onRetry}
            disabled={retrying}
            className="btn-ink px-4 py-2 text-xs disabled:opacity-60"
          >
            Retry failed checks
          </button>
          <span
            aria-live="polite"
            className="font-mono text-[11px] tabular-nums text-ink-soft"
          >
            {retry.phase === "retrying"
              ? `checking ${retry.checked} of ${retry.total}…`
              : retry.phase === "partial-success"
                ? `+${retry.found} found`
                : ""}
          </span>
        </div>
      )}
    </div>
  );
}

// --- opt-in "check your followers" card (dashed, mono progress like the deep
// scan). Mutually exclusive with the deep scan — both ride the same sweep. ---
function FollowersCard({
  followerOnlyCount,
  followersScan,
  emphasize,
  disabled,
  onScanFollowers,
}: {
  followerOnlyCount: number;
  followersScan: DeepState | null;
  emphasize: boolean;
  disabled: boolean;
  onScanFollowers: () => void;
}) {
  return (
    <div
      className={`rise mt-6 border border-dashed bg-cream/60 px-4 py-4 ${
        emphasize ? "border-violet/70" : "border-ink-faint"
      }`}
      style={{ animationDelay: "220ms" }}
    >
      {followersScan === null && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <p className="font-display text-lg tracking-tight">Check your followers</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              {followerOnlyCount.toLocaleString()} people follow you that you don’t
              follow back. Check if any of them already live on Circles.
            </p>
          </div>
          <button
            onClick={onScanFollowers}
            disabled={disabled}
            className="btn-ink px-5 py-2 text-xs disabled:opacity-60"
          >
            Check followers
          </button>
        </div>
      )}

      {followersScan?.phase === "running" && (
        <div>
          <p className="flex items-baseline justify-between font-mono text-[11px] text-ink-soft">
            <span>
              followers · {followersScan.progress.checked}/{followersScan.progress.total}
            </span>
            <span className="text-leaf-deep">
              {followersScan.progress.found > 0
                ? `+${followersScan.progress.found} found`
                : "searching…"}
            </span>
          </p>
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-parch">
            <div
              className="h-full bg-violet transition-[width] duration-500"
              style={{
                width: `${
                  followersScan.progress.total === 0
                    ? 0
                    : Math.max(
                        4,
                        (followersScan.progress.checked / followersScan.progress.total) * 100,
                      )
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {followersScan?.phase === "done" && (
        <p className="font-mono text-[11px] text-ink-soft">
          followers checked — {followersScan.checked} swept,{" "}
          <span className={followersScan.found > 0 ? "text-leaf-deep" : ""}>
            found {followersScan.found} more
          </span>
          .
        </p>
      )}
    </div>
  );
}

export function Results({
  user,
  followingTotal,
  followersTotal,
  withWallet,
  truncated,
  autoSwept,
  friends,
  failures,
  trustLoaded,
  retry,
  fromCache,
  completedAt,
  canAct,
  lockReason,
  busyAddress,
  deep,
  deepCandidateCount,
  deepScanLimit,
  followersScan,
  followerOnlyCount,
  onToggle,
  onDeepScan,
  onScanFollowers,
  onReset,
  onRetry,
  onRetryTrust,
  onRescan,
}: {
  user: FarcasterUser;
  followingTotal: number;
  followersTotal: number;
  withWallet: number;
  truncated: boolean;
  unchecked: number;
  autoSwept: boolean;
  friends: Friend[];
  failures: ScanFailures;
  trustLoaded: boolean;
  retry: RetryState;
  fromCache: boolean;
  completedAt: number;
  canAct: boolean;
  lockReason: string;
  busyAddress: string | null;
  deep: DeepState | null;
  deepCandidateCount: number;
  /** How many unmatched connections the deep scan will actually check. */
  deepScanLimit: number;
  /** Progress state for the opt-in "check your followers" pass. */
  followersScan: DeepState | null;
  /** People who follow you that you don't follow back (the followers-scan set). */
  followerOnlyCount: number;
  onToggle: (friend: Friend, trusted: boolean) => void;
  onDeepScan: () => void;
  onScanFollowers: () => void;
  onReset: () => void;
  onRetry: () => void;
  onRetryTrust: () => void;
  onRescan: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [dirFilter, setDirFilter] = useState<DirFilter>("all");
  const statusRef = useRef<HTMLDivElement | null>(null);

  // D10: when a retry resolves, move focus to the status block.
  const prevRetryPhase = useRef(retry.phase);
  useEffect(() => {
    if (prevRetryPhase.current === "retrying" && retry.phase !== "retrying") {
      statusRef.current?.focus();
    }
    prevRetryPhase.current = retry.phase;
  }, [retry.phase]);

  const notChecked = uncheckedCount(failures);
  const isPartial = notChecked > 0;

  // Followers are an opt-in secondary check. When the main (following) scan
  // surfaced few/no matches, lead with the offer to widen to followers.
  const showFollowersCard = followerOnlyCount > 0 && !isPartial;
  const emphasizeFollowers = showFollowersCard && friends.length < 3;
  const followersBusy = deep?.phase === "running" || retry.phase === "retrying";

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

  const hydrationPending = friends.filter((f) => !f.hydrated).length;

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
        {isPartial ? (
          <>
            Scan incomplete — {friends.length} matched,{" "}
            <em className="font-light text-rust">
              {notChecked.toLocaleString()} couldn’t be checked.
            </em>
          </>
        ) : friends.length === 0 ? (
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

      {/* ---- meta row (D11/D7/D12: stacks on mobile) ---- */}
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
        {/* D11: zero-failure scans say so explicitly. */}
        {!isPartial && (
          <span className="text-leaf-deep">
            · all {(withWallet || friends.length).toLocaleString()} follows checked ✓
          </span>
        )}
        {truncated && (
          <span className="text-rust" title={truncationSentence(notChecked)}>
            · scanned your most recent 8,000 follows
          </span>
        )}
        {/* D7: cache provenance. */}
        {fromCache && (
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
        <button
          onClick={onReset}
          className="ml-auto text-ink-soft underline underline-offset-4 hover:text-violet-deep"
        >
          ↺ scan another
        </button>
      </div>

      {/* ---- D2 status block (replaces the old rate-limit paragraph). Shown
             BEFORE the "no overlap" empty state so it isn't misleading. ---- */}
      <StatusBlock
        failures={failures}
        trustLoaded={trustLoaded}
        truncated={truncated}
        retry={retry}
        notChecked={notChecked}
        focusRef={statusRef}
        onRetry={onRetry}
        onRetryTrust={onRetryTrust}
      />

      {/* ---- followers offer, led up-front when the main scan was thin ---- */}
      {showFollowersCard && emphasizeFollowers && (
        <FollowersCard
          followerOnlyCount={followerOnlyCount}
          followersScan={followersScan}
          emphasize
          disabled={followersBusy}
          onScanFollowers={onScanFollowers}
        />
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
            className="rise mt-7 flex flex-wrap gap-x-3 gap-y-1.5"
            style={{ animationDelay: "180ms" }}
          >
            {DIR_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setDirFilter(key)}
                className={`flex min-h-[44px] items-center rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
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
      )}

      {/* ---- empty state ---- */}
      {friends.length === 0 && !isPartial && (
        <div className="rise mt-8 text-[15px] leading-relaxed text-ink-soft" style={{ animationDelay: "160ms" }}>
          <p>
            {autoSwept ? (
              <>
                We checked every verified wallet of the people @{user.username} follows
                and found no Circles avatars among them. Someone has to be the bridge
                between the two worlds; it might as well be you.
              </>
            ) : (
              <>
                None of the {withWallet.toLocaleString()} wallet-holding accounts
                @{user.username} follows matched the Circles registry through their
                primary wallet.
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
                  checks <em>every</em> verified address for{" "}
                  {deepScanLimit >= deepCandidateCount ? (
                    <>all {deepCandidateCount.toLocaleString()} unmatched follows.</>
                  ) : (
                    <>
                      the closest {deepScanLimit.toLocaleString()} of{" "}
                      {deepCandidateCount.toLocaleString()} unmatched follows.
                    </>
                  )}
                </p>
              </div>
              <button
                onClick={onDeepScan}
                disabled={retry.phase === "retrying" || followersScan?.phase === "running"}
                className="btn-ink px-5 py-2 text-xs disabled:opacity-60"
              >
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

      {/* ---- followers offer, placed after the deep scan when matches were
             plentiful (the emphasized variant up top handles the thin case) ---- */}
      {showFollowersCard && !emphasizeFollowers && (
        <FollowersCard
          followerOnlyCount={followerOnlyCount}
          followersScan={followersScan}
          emphasize={false}
          disabled={followersBusy}
          onScanFollowers={onScanFollowers}
        />
      )}

      {/* ---- D9 scan details (counts only, no table chrome) ---- */}
      <details className="mt-10 font-mono text-[11px] text-ink-faint">
        <summary className="cursor-pointer select-none uppercase tracking-[0.14em] hover:text-ink-soft">
          scan details
        </summary>
        <ul className="mt-3 space-y-1 tabular-nums">
          <li>follows fetched · {(followingTotal + followersTotal).toLocaleString()}</li>
          <li>wallets resolved · {withWallet.toLocaleString()}</li>
          <li>matched · {friends.length.toLocaleString()}</li>
          <li>swept · {autoSwept ? "yes" : "no"}</li>
          <li>unchecked primary · {failures.primaryFids.length.toLocaleString()}</li>
          <li>failed verifications · {failures.verificationFids.length.toLocaleString()}</li>
          <li>failed avatar addresses · {failures.addresses.size.toLocaleString()}</li>
          <li>hydration pending · {hydrationPending.toLocaleString()}</li>
        </ul>
      </details>
    </section>
  );
}

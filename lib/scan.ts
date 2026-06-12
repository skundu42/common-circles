// The scan pipeline: Farcaster follow graph → verified wallets → Circles
// registry → trust circle. Runs entirely client-side against our own API
// routes (Farcaster proxying) and the Circles RPC (via @aboutcircles/sdk).
//
// Matching happens in two passes because most Circles avatars are Safes while
// Farcaster verifications are usually EOAs — the primary wallet alone misses
// people. Pass 1 checks everyone's primary address (cheap bulk endpoint);
// pass 2 sweeps ALL verified addresses (one upstream call per fid). For small
// follow graphs pass 2 runs automatically inside the main scan; for large
// ones it is offered as an explicit "deep scan".

import {
  fetchConnections,
  fetchFarcasterUser,
  fetchFarcasterUsers,
  fetchVerifications,
} from "@/lib/api";
import {
  avatarKind,
  findCirclesAvatars,
  getCirclesProfiles,
  getTrustMap,
} from "@/lib/circles";
import type {
  ConnectionEntry,
  FarcasterUser,
  FcRelation,
  Friend,
  ScanFailures,
  TrustState,
} from "@/lib/types";
import { chunk, shortenAddress } from "@/lib/util";

import type { AvatarInfo, Profile } from "@aboutcircles/sdk-types";

/** Follow graphs up to this size get the full verification sweep inline. */
const AUTO_SWEEP_LIMIT = 400;
/** How many follows the explicit deep scan will pull full verifications for. */
export const DEEP_SCAN_CAP = 300;
/** How many follower-only accounts the opt-in "check your followers" pass will
 * sweep without a bulk provider (one verification call per fid). Mirrors the
 * server's FOLLOW_CAP intent — followers are the lowest-signal direction. */
export const FOLLOWERS_SCAN_CAP = 4000;

export type ScanProgress = {
  /** 0 follow graph · 1 wallets · 2 circles registry · 3 trust circle */
  step: number;
  followingTotal?: number;
  followersTotal?: number;
  withWallet?: number;
  matches?: number;
  /** Set while the inline verification sweep is running. */
  sweep?: { checked: number; total: number };
};

export type TrustMap = Map<string, Exclude<TrustState, "none">>;

export type ScanResult = {
  user: FarcasterUser;
  followingTotal: number;
  followersTotal: number;
  withWallet: number;
  truncated: boolean;
  /** = failures.primaryFids.length — derived convenience for the meta row (C2). */
  unchecked: number;
  /** True when the main scan already swept every verified address. */
  autoSwept: boolean;
  friends: Friend[];
  /** Followed FIDs not matched via their primary wallet — deep-scan candidates. */
  deepScanCandidates: number[];
  /** True when a bulk provider (Neynar) is active — the deep scan then lifts its
   * per-fid cap since verification lookups are no longer one-call-per-fid. */
  bulkProvider: boolean;
  /** Lowercase addresses already checked against the registry. */
  checkedAddresses: Set<string>;
  trustMap: TrustMap;
  /** False when getTrustMap failed; D6/headline read this (E8). */
  trustLoaded: boolean;
  /** Follow direction per fid, for deep-scan hydration. */
  relation: Map<number, FcRelation>;
  /** Unified failure ledger (E5). */
  failures: ScanFailures;
  /** Stamp for cache provenance + retry scanId guard (E5/D7). */
  scanId: number;
  /** ms epoch the scan completed; cache TTL + "N min ago" copy (D7). */
  completedAt: number;
};

/** Monotonic scan id, assigned at runScan start (E5 retry guard). */
let nextScanId = 1;

const TRUST_ORDER: Record<TrustState, number> = {
  trustedBy: 0, // they already trust you — most actionable
  none: 1,
  trusts: 2,
  mutuallyTrusts: 3,
};

export function sortFriends(friends: Friend[]): Friend[] {
  return [...friends].sort(
    (a, b) =>
      TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] ||
      a.displayName.localeCompare(b.displayName),
  );
}

/**
 * Synchronous: build placeholder Friends immediately from matched entries +
 * Circles data, no Farcaster round trip (E15). FC fields are placeholders
 * (`hydrated:false`, username `!fid`, displayName `FID fid`) until
 * `hydrateFriendsStreaming` patches them in by fid.
 */
export function buildFriends(
  matched: ConnectionEntry[],
  avatars: Map<string, AvatarInfo>,
  profiles: Map<string, Profile>,
  trustMap: TrustMap,
  relation: Map<number, FcRelation>,
  viaDeepScan: boolean,
): Friend[] {
  return matched.map((entry) => {
    const info = avatars.get(entry.address);
    const profile = profiles.get(entry.address);
    return {
      fid: entry.fid,
      address: entry.address,
      username: `!${entry.fid}`,
      displayName: `FID ${entry.fid}`,
      pfpUrl: null,
      fcRelation: relation.get(entry.fid) ?? "following",
      circlesName: profile?.name ?? info?.name ?? null,
      circlesImageUrl: profile?.previewImageUrl ?? profile?.imageUrl ?? null,
      kind: info ? avatarKind(info) : "human",
      trust: trustMap.get(entry.address) ?? "none",
      viaDeepScan,
      hydrated: false,
    } satisfies Friend;
  });
}

/**
 * Stream FC profiles for `fids` in 100-chunks, invoking `onHydrated` with a
 * fid→user patch map per chunk so the UI fills placeholders progressively
 * (E15). Hydrates ALL fids (no cap) so the name list never truncates; aborts
 * cleanly on `signal`.
 */
export async function hydrateFriendsStreaming(
  fids: number[],
  onHydrated: (patches: Map<number, FarcasterUser>) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const c of chunk(fids, 100)) {
    if (signal?.aborted) return;
    const users = await fetchFarcasterUsers(c, signal);
    onHydrated(new Map(users.map((u) => [u.fid, u])));
  }
}

/**
 * Apply accumulated FC profile patches to placeholder Friends and mark them
 * hydrated. Returns a NEW array; order is preserved (never re-sorts, D3).
 *
 * Every friend is marked `hydrated` once the hydration pass has run, even if no
 * FC profile came back (deleted/private account) — otherwise an un-resolvable
 * row would pulse as a skeleton forever. For those, fall back to the Circles
 * name or the short address instead of the `FID 1234` placeholder.
 */
function applyHydration(
  friends: Friend[],
  patches: Map<number, FarcasterUser>,
): Friend[] {
  return friends.map((f) => {
    const u = patches.get(f.fid);
    if (u) {
      return {
        ...f,
        username: u.username,
        displayName: u.displayName,
        pfpUrl: u.pfpUrl,
        hydrated: true,
      };
    }
    return {
      ...f,
      hydrated: true,
      displayName: f.circlesName ?? shortenAddress(f.address),
    };
  });
}

/** sweepVerifications result — partial-safe; the sweep NEVER throws (E3). */
export type SweepResult = {
  entries: ConnectionEntry[];
  avatars: Map<string, AvatarInfo>;
  /** FIDs whose verification fetch failed for the whole batch (E3). */
  failedFids: number[];
  /** lowercaseAddress -> fid for avatar batches that failed the RPC (E3/E4). */
  uncheckedAddresses: Map<string, number>;
  checked: number;
};

/**
 * Pass 2: pull ALL verified addresses for `fids` and check the new ones
 * against the registry. Mutates `checkedAddresses` as it goes. Per E3, this
 * NEVER throws — each batch is guarded; a failed verification fetch pushes the
 * whole batch to `failedFids`, and addresses whose avatar RPC failed are left
 * eligible (NOT committed to checkedAddresses) and reported in
 * `uncheckedAddresses` so a retry can re-check them.
 */
async function sweepVerifications(
  fids: number[],
  checkedAddresses: Set<string>,
  onProgress: (checked: number, total: number, found: number) => void,
): Promise<SweepResult> {
  const entries: ConnectionEntry[] = [];
  const avatars = new Map<string, AvatarInfo>();
  const failedFids: number[] = [];
  const uncheckedAddresses = new Map<string, number>();
  let checked = 0;
  onProgress(0, fids.length, 0);

  // 50/batch (under the route's 100 cap): smaller batches report progress about
  // twice as often, so the bar visibly moves instead of sitting at 0 while a big
  // batch grinds through the keyless per-fid pacing.
  for (const batch of chunk(fids, 50)) {
    try {
      const { rows, failedFids: rowFailed } = await fetchVerifications(batch);
      if (rowFailed.length) failedFids.push(...rowFailed);

      // address → fid, first wins; skip anything already checked
      const candidates = new Map<string, number>();
      for (const row of rows) {
        for (const address of row.addresses) {
          if (!checkedAddresses.has(address) && !candidates.has(address)) {
            candidates.set(address, row.fid);
          }
        }
      }

      const { avatars: found, failedAddresses } = await findCirclesAvatars([
        ...candidates.keys(),
      ]);
      const failedSet = new Set(failedAddresses);

      // commit an address to checkedAddresses ONLY if its batch didn't fail;
      // failed addresses stay eligible and are surfaced for retry (E3/E4).
      for (const [address, fid] of candidates) {
        if (failedSet.has(address)) {
          uncheckedAddresses.set(address, fid);
        } else {
          checkedAddresses.add(address);
        }
      }

      const seenFids = new Set<number>();
      for (const [address, fid] of candidates) {
        const info = found.get(address);
        if (info && !seenFids.has(fid)) {
          seenFids.add(fid);
          entries.push({ fid, address });
          avatars.set(address, info);
        }
      }
    } catch {
      // whole-batch verification fetch failed — record the fids, keep going
      failedFids.push(...batch);
    }

    checked += batch.length;
    onProgress(checked, fids.length, entries.length);
  }

  return { entries, avatars, failedFids, uncheckedAddresses, checked };
}

export async function runScan(
  query: string, // @handle, ENS name, or 0x address
  walletAddress: string | null,
  onUser: (user: FarcasterUser) => void,
  onProgress: (progress: ScanProgress) => void,
  onHydrated: (patches: Map<number, FarcasterUser>) => void,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const scanId = nextScanId++;
  onProgress({ step: 0 });
  const user = await fetchFarcasterUser(query);
  onUser(user);

  const connections = await fetchConnections(user.fid, signal);
  const base = {
    followingTotal: connections.followingTotal,
    followersTotal: connections.followersTotal,
    withWallet: connections.withWallet,
  };
  onProgress({
    step: 1,
    followingTotal: base.followingTotal,
    followersTotal: base.followersTotal,
  });
  onProgress({ step: 2, ...base });

  // direction of each connection relative to the scanned account
  const relation = new Map<number, FcRelation>();
  for (const f of connections.followingFids) relation.set(f, "following");
  for (const f of connections.followerFids) {
    relation.set(f, relation.has(f) ? "mutualFollow" : "follower");
  }

  // pass 1: primary addresses (bulk)
  const { avatars, failedAddresses } = await findCirclesAvatars(
    connections.entries.map((e) => e.address),
  );
  const matched = connections.entries.filter((e) => avatars.has(e.address));
  // a failed avatar batch leaves its addresses eligible: don't commit them
  const failedAddrSet = new Set(failedAddresses);
  const checkedAddresses = new Set(
    connections.entries.map((e) => e.address).filter((a) => !failedAddrSet.has(a)),
  );
  // failed pass-1 addresses → failures.addresses (lowercaseAddress -> fid)
  const failureAddresses = new Map<string, number>();
  for (const e of connections.entries) {
    if (failedAddrSet.has(e.address)) failureAddresses.set(e.address, e.fid);
  }
  onProgress({ step: 2, ...base, matches: matched.length });

  // deep-scan candidates are FOLLOWING-only (the default scan scope). entries
  // are already following-only + mutuals-first, so unmatchedWithWallet is too.
  // wallet-holders first (most likely to be on Circles via another verified
  // address), then follows with no primary wallet at all.
  const matchedFids = new Set(matched.map((m) => m.fid));
  const unmatchedWithWallet = connections.entries
    .filter((e) => !matchedFids.has(e.fid))
    .map((e) => e.fid);
  const entryFids = new Set(connections.entries.map((e) => e.fid));
  const withoutWallet = connections.followingFids.filter((fid) => !entryFids.has(fid));
  let candidates = [...unmatchedWithWallet, ...withoutWallet];

  // pass 2 (inline for small graphs): sweep every verified address. Gate on the
  // FOLLOWING size — that's the set actually scanned (followers aren't swept here).
  const autoSwept =
    candidates.length > 0 && connections.followingFids.length <= AUTO_SWEEP_LIMIT;
  let sweptEntries: ConnectionEntry[] = [];
  let sweptAvatars = new Map<string, AvatarInfo>();
  let sweptFailedFids: number[] = [];
  let sweptUnchecked = new Map<string, number>();
  if (autoSwept) {
    const swept = await sweepVerifications(candidates, checkedAddresses, (checked, total, found) =>
      onProgress({
        step: 2,
        ...base,
        matches: matched.length + found,
        sweep: { checked, total },
      }),
    );
    sweptEntries = swept.entries;
    sweptAvatars = swept.avatars;
    sweptFailedFids = swept.failedFids;
    sweptUnchecked = swept.uncheckedAddresses;
    candidates = [];
  }
  onProgress({ step: 3, ...base, matches: matched.length + sweptEntries.length });

  // trust map, guarded: a failure leaves trust unknown (E8) rather than throwing
  let trustMap: TrustMap = new Map();
  let trustLoaded = true;
  let trustUnavailable = false;
  if (walletAddress) {
    try {
      trustMap = await getTrustMap(walletAddress);
    } catch {
      trustMap = new Map();
      trustLoaded = false;
      trustUnavailable = true;
    }
  }

  // Circles profiles for both passes (decorative, degrades to addresses)
  const allMatched = [...matched, ...sweptEntries];
  const profiles = await getCirclesProfiles(allMatched.map((e) => e.address));

  const friends = sortFriends([
    ...buildFriends(matched, avatars, profiles, trustMap, relation, false),
    ...buildFriends(sweptEntries, sweptAvatars, profiles, trustMap, relation, true),
  ]);

  // merge failed avatar addresses from pass 1 + sweep
  const addresses = new Map(failureAddresses);
  for (const [addr, fid] of sweptUnchecked) addresses.set(addr, fid);

  const failures: ScanFailures = {
    primaryFids: connections.uncheckedFids,
    verificationFids: sweptFailedFids,
    addresses,
    trustUnavailable,
  };

  // Hydrate FC profiles. We both stream patches via onHydrated (for any live
  // listener) AND accumulate them so the RETURNED friends are already hydrated —
  // the Results screen only mounts after runScan resolves, so patches emitted
  // mid-scan would otherwise land on an empty list and be lost (skeletons stick).
  const patches = new Map<number, FarcasterUser>();
  await hydrateFriendsStreaming(
    allMatched.map((e) => e.fid),
    (chunkPatches) => {
      for (const [fid, u] of chunkPatches) patches.set(fid, u);
      onHydrated(chunkPatches);
    },
    signal,
  );
  const hydratedFriends = applyHydration(friends, patches);

  return {
    user,
    followingTotal: connections.followingTotal,
    followersTotal: connections.followersTotal,
    withWallet: connections.withWallet,
    truncated: connections.truncated,
    unchecked: failures.primaryFids.length,
    autoSwept,
    friends: hydratedFriends,
    deepScanCandidates: candidates,
    bulkProvider: connections.bulkProvider,
    checkedAddresses,
    trustMap,
    trustLoaded,
    relation,
    failures,
    scanId,
    completedAt: Date.now(),
  };
}

export type DeepScanProgress = { checked: number; total: number; found: number };

/**
 * Explicit second pass for large follow graphs — same verification sweep,
 * returning placeholder friends to append (hydration streams via onHydrated,
 * E15) plus the sweep's own failures to fold into the ledger. The CALLER decides
 * how many candidates to pass (keyless caps at DEEP_SCAN_CAP; a bulk provider
 * passes the whole list), so this scans exactly what it's given.
 */
export async function runDeepScan(
  candidates: number[],
  checkedAddresses: Set<string>,
  trustMap: TrustMap,
  relation: Map<number, FcRelation>,
  onProgress: (progress: DeepScanProgress) => void,
  onHydrated: (patches: Map<number, FarcasterUser>) => void,
  signal?: AbortSignal,
): Promise<{
  friends: Friend[];
  checked: number;
  failures: Pick<ScanFailures, "verificationFids"> & { addresses: Map<string, number> };
}> {
  const fids = candidates;
  const { entries, avatars, failedFids, uncheckedAddresses, checked } =
    await sweepVerifications(fids, checkedAddresses, (done, total, found) =>
      onProgress({ checked: done, total, found }),
    );
  const profiles = await getCirclesProfiles(entries.map((e) => e.address));
  const friends = buildFriends(entries, avatars, profiles, trustMap, relation, true);
  // Accumulate + apply patches so the appended rows arrive hydrated; App appends
  // `friends` to state only after this resolves, so streamed patches alone would
  // miss them (same race as runScan).
  const patches = new Map<number, FarcasterUser>();
  await hydrateFriendsStreaming(
    entries.map((e) => e.fid),
    (chunkPatches) => {
      for (const [fid, u] of chunkPatches) patches.set(fid, u);
      onHydrated(chunkPatches);
    },
    signal,
  );
  return {
    friends: applyHydration(friends, patches),
    checked,
    failures: { verificationFids: failedFids, addresses: uncheckedAddresses },
  };
}

// Targeted retry orchestrator (E2/E5). Rides the verifications sweep for both
// failures.primaryFids and failures.verificationFids (verified ⊇ primary, so
// no new endpoint), re-checks failures.addresses directly via findCirclesAvatars,
// and refetches trust if it was never loaded.
export type RetryOutcome = {
  /** Newly matched entries recovered this retry. */
  entries: ConnectionEntry[];
  avatars: Map<string, AvatarInfo>;
  profiles: Map<string, Profile>;
  /** Failure sets that STILL failed (replaces old sets for those classes). */
  stillFailed: ScanFailures;
  /** Present only if trust was retried. undefined = trust not retried. */
  trustMap?: TrustMap;
  trustLoaded?: boolean;
  /** Echo of the scanId this retry was launched against (E5 mismatch guard). */
  scanId: number;
};

export async function runRetry(
  result: ScanResult,
  onProgress: (checked: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RetryOutcome> {
  const entries: ConnectionEntry[] = [];
  const avatars = new Map<string, AvatarInfo>();

  // sweep both failed primary FIDs and failed verification FIDs together
  // (verified ⊇ primary), re-using a working copy of checkedAddresses so we
  // don't mutate the live result.
  const sweepFids = [
    ...new Set([...result.failures.primaryFids, ...result.failures.verificationFids]),
  ];
  const checkedAddresses = new Set(result.checkedAddresses);
  let sweptFailedFids: number[] = [];
  let sweptUnchecked = new Map<string, number>();
  if (sweepFids.length > 0) {
    const swept = await sweepVerifications(sweepFids, checkedAddresses, (checked, total) =>
      onProgress(checked, total),
    );
    for (const e of swept.entries) {
      entries.push(e);
      const info = swept.avatars.get(e.address);
      if (info) avatars.set(e.address, info);
    }
    sweptFailedFids = swept.failedFids;
    sweptUnchecked = swept.uncheckedAddresses;
  }

  // re-check the failed avatar addresses directly
  const retryAddresses = [...result.failures.addresses.keys()];
  const stillFailedAddresses = new Map<string, number>(sweptUnchecked);
  if (retryAddresses.length > 0) {
    const { avatars: found, failedAddresses } = await findCirclesAvatars(retryAddresses);
    const failedSet = new Set(failedAddresses);
    const seenFids = new Set(entries.map((e) => e.fid));
    for (const [address, fid] of result.failures.addresses) {
      if (failedSet.has(address)) {
        stillFailedAddresses.set(address, fid);
        continue;
      }
      const info = found.get(address);
      if (info && !seenFids.has(fid)) {
        seenFids.add(fid);
        entries.push({ fid, address });
        avatars.set(address, info);
      }
    }
  }

  // which primary FIDs are still unresolved after the sweep
  const recoveredFids = new Set(entries.map((e) => e.fid));
  const stillPrimaryFids = result.failures.primaryFids.filter(
    (fid) => sweptFailedFids.includes(fid) || !recoveredFids.has(fid),
  );

  const profiles = await getCirclesProfiles(entries.map((e) => e.address));

  // Trust refetch (C3) needs the wallet the scan ran against, which is NOT
  // stored on ScanResult. App's wallet-keyed E11 effect owns trust refetch, so
  // runRetry leaves trustMap/trustLoaded undefined ("trust not retried") and
  // preserves the existing trustUnavailable flag. See report decision RD-1.
  const stillFailed: ScanFailures = {
    primaryFids: stillPrimaryFids,
    verificationFids: sweptFailedFids,
    addresses: stillFailedAddresses,
    trustUnavailable: result.failures.trustUnavailable,
  };

  return {
    entries,
    avatars,
    profiles,
    stillFailed,
    trustMap: undefined,
    trustLoaded: undefined,
    scanId: result.scanId,
  };
}

/**
 * PURE reducer (E5): fold a RetryOutcome back into the scan state. No I/O, no
 * mutation of inputs. A scanId mismatch returns the inputs unchanged so a
 * stale/superseded retry can't corrupt current state.
 */
export function applyRetryOutcome(
  result: ScanResult,
  friends: Friend[],
  outcome: RetryOutcome,
): { result: ScanResult; friends: Friend[] } {
  if (outcome.scanId !== result.scanId) return { result, friends };

  const trustMap = outcome.trustMap ?? result.trustMap;

  // append new friends, deduped by address, WITHOUT re-sorting existing rows
  // (D3): keep existing order, sort only the new arrivals among themselves.
  const existingAddresses = new Set(friends.map((f) => f.address));
  const newEntries = outcome.entries.filter((e) => !existingAddresses.has(e.address));
  const newFriends = sortFriends(
    buildFriends(newEntries, outcome.avatars, outcome.profiles, trustMap, result.relation, true),
  );

  // if trust was retried, re-derive trust for the existing rows too
  const existing: Friend[] = outcome.trustMap
    ? friends.map((f) => ({ ...f, trust: trustMap.get(f.address) ?? "none" }))
    : friends;
  const merged = [...existing, ...newFriends];

  const failures: ScanFailures = {
    primaryFids: outcome.stillFailed.primaryFids,
    verificationFids: outcome.stillFailed.verificationFids,
    addresses: outcome.stillFailed.addresses,
    trustUnavailable:
      outcome.trustLoaded !== undefined
        ? !outcome.trustLoaded
        : outcome.stillFailed.trustUnavailable,
  };

  const nextResult: ScanResult = {
    ...result,
    trustMap,
    trustLoaded: outcome.trustLoaded !== undefined ? outcome.trustLoaded : result.trustLoaded,
    failures,
    unchecked: failures.primaryFids.length,
    completedAt: Date.now(),
  };

  return { result: nextResult, friends: merged };
}

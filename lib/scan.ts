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
  TrustState,
} from "@/lib/types";
import { chunk } from "@/lib/util";

import type { AvatarInfo } from "@aboutcircles/sdk-types";

/** How many matched profiles we hydrate from Farcaster (3 × the route cap). */
const HYDRATE_CAP = 300;
/** Follow graphs up to this size get the full verification sweep inline. */
const AUTO_SWEEP_LIMIT = 400;
/** How many follows the explicit deep scan will pull full verifications for. */
export const DEEP_SCAN_CAP = 300;

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
  /** Connections whose wallet lookup failed after retries (rate limit). */
  unchecked: number;
  /** True when the main scan already swept every verified address. */
  autoSwept: boolean;
  friends: Friend[];
  /** Followed FIDs not matched via their primary wallet — deep-scan candidates. */
  deepScanCandidates: number[];
  /** Lowercase addresses already checked against the registry. */
  checkedAddresses: Set<string>;
  trustMap: TrustMap;
  /** Follow direction per fid, for deep-scan hydration. */
  relation: Map<number, FcRelation>;
};

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

/** Merge Farcaster + Circles + trust data for matched entries into Friends. */
async function hydrateFriends(
  matched: ConnectionEntry[],
  avatars: Map<string, AvatarInfo>,
  trustMap: TrustMap,
  relation: Map<number, FcRelation>,
  viaDeepScan: boolean,
): Promise<Friend[]> {
  if (matched.length === 0) return [];

  const fids = matched.map((m) => m.fid).slice(0, HYDRATE_CAP);
  const addresses = matched.map((m) => m.address);

  const [userChunks, profiles] = await Promise.all([
    Promise.all(chunk(fids, 100).map((c) => fetchFarcasterUsers(c))),
    getCirclesProfiles(addresses),
  ]);
  const users = new Map(userChunks.flat().map((u) => [u.fid, u]));

  return matched.map((entry) => {
    const info = avatars.get(entry.address);
    const fc = users.get(entry.fid);
    const profile = profiles.get(entry.address);
    return {
      fid: entry.fid,
      address: entry.address,
      username: fc?.username ?? `!${entry.fid}`,
      displayName: fc?.displayName ?? fc?.username ?? `FID ${entry.fid}`,
      pfpUrl: fc?.pfpUrl ?? null,
      fcRelation: relation.get(entry.fid) ?? "following",
      circlesName: profile?.name ?? info?.name ?? null,
      circlesImageUrl: profile?.previewImageUrl ?? profile?.imageUrl ?? null,
      kind: info ? avatarKind(info) : "human",
      trust: trustMap.get(entry.address) ?? "none",
      viaDeepScan,
    } satisfies Friend;
  });
}

/**
 * Pass 2: pull ALL verified addresses for `fids` and check the new ones
 * against the registry. Mutates `checkedAddresses` as it goes.
 */
async function sweepVerifications(
  fids: number[],
  checkedAddresses: Set<string>,
  onProgress: (checked: number, total: number, found: number) => void,
): Promise<{ entries: ConnectionEntry[]; avatars: Map<string, AvatarInfo>; checked: number }> {
  const entries: ConnectionEntry[] = [];
  const avatars = new Map<string, AvatarInfo>();
  let checked = 0;
  onProgress(0, fids.length, 0);

  for (const batch of chunk(fids, 100)) {
    const rows = await fetchVerifications(batch);

    // address → fid, first wins; skip anything already checked
    const candidates = new Map<string, number>();
    for (const row of rows) {
      for (const address of row.addresses) {
        if (!checkedAddresses.has(address) && !candidates.has(address)) {
          candidates.set(address, row.fid);
        }
      }
    }
    for (const address of candidates.keys()) checkedAddresses.add(address);

    const found = await findCirclesAvatars([...candidates.keys()]);
    const seenFids = new Set<number>();
    for (const [address, fid] of candidates) {
      const info = found.get(address);
      if (info && !seenFids.has(fid)) {
        seenFids.add(fid);
        entries.push({ fid, address });
        avatars.set(address, info);
      }
    }

    checked += batch.length;
    onProgress(checked, fids.length, entries.length);
  }

  return { entries, avatars, checked };
}

export async function runScan(
  query: string, // @handle, ENS name, or 0x address
  walletAddress: string | null,
  onUser: (user: FarcasterUser) => void,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  onProgress({ step: 0 });
  const user = await fetchFarcasterUser(query);
  onUser(user);

  const connections = await fetchConnections(user.fid);
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
  const avatars = await findCirclesAvatars(connections.entries.map((e) => e.address));
  const matched = connections.entries.filter((e) => avatars.has(e.address));
  const checkedAddresses = new Set(connections.entries.map((e) => e.address));
  onProgress({ step: 2, ...base, matches: matched.length });

  // unmatched connections: wallet-holders first (most likely to be on Circles
  // via another verified address; entries are already mutuals-first), then the
  // rest of the union
  const matchedFids = new Set(matched.map((m) => m.fid));
  const unmatchedWithWallet = connections.entries
    .filter((e) => !matchedFids.has(e.fid))
    .map((e) => e.fid);
  const entryFids = new Set(connections.entries.map((e) => e.fid));
  const withoutWallet = [...relation.keys()].filter((fid) => !entryFids.has(fid));
  let candidates = [...unmatchedWithWallet, ...withoutWallet];

  // pass 2 (inline for small graphs): sweep every verified address
  const autoSwept = candidates.length > 0 && relation.size <= AUTO_SWEEP_LIMIT;
  let sweptEntries: ConnectionEntry[] = [];
  let sweptAvatars = new Map<string, AvatarInfo>();
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
    candidates = [];
  }
  onProgress({ step: 3, ...base, matches: matched.length + sweptEntries.length });

  const trustMap: TrustMap = walletAddress ? await getTrustMap(walletAddress) : new Map();
  const friends = sortFriends([
    ...(await hydrateFriends(matched, avatars, trustMap, relation, false)),
    ...(await hydrateFriends(sweptEntries, sweptAvatars, trustMap, relation, true)),
  ]);

  return {
    user,
    followingTotal: connections.followingTotal,
    followersTotal: connections.followersTotal,
    withWallet: connections.withWallet,
    truncated: connections.truncated,
    unchecked: connections.unchecked,
    autoSwept,
    friends,
    deepScanCandidates: candidates,
    checkedAddresses,
    trustMap,
    relation,
  };
}

export type DeepScanProgress = { checked: number; total: number; found: number };

/**
 * Explicit second pass for large follow graphs — same verification sweep,
 * capped, returning hydrated friends to append.
 */
export async function runDeepScan(
  candidates: number[],
  checkedAddresses: Set<string>,
  trustMap: TrustMap,
  relation: Map<number, FcRelation>,
  onProgress: (progress: DeepScanProgress) => void,
): Promise<{ friends: Friend[]; checked: number }> {
  const fids = candidates.slice(0, DEEP_SCAN_CAP);
  const { entries, avatars, checked } = await sweepVerifications(
    fids,
    checkedAddresses,
    (done, total, found) => onProgress({ checked: done, total, found }),
  );
  const friends = await hydrateFriends(entries, avatars, trustMap, relation, true);
  return { friends, checked };
}

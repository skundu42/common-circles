// Generic matcher: candidate addresses (from any DiscoverySource) -> Friend[]
// via the Circles spine, consulted once. Cache-only robustness — no fid, no
// streaming hydration, no failure ledger. Field derivation mirrors
// buildFriends (scan.ts) so onchain rows render identically to Farcaster ones.

import { findCirclesAvatars, getCirclesProfiles, getTrustMap, avatarKind } from "@/lib/circles";
import { shortenAddress } from "@/lib/util";
import { sortMatches } from "@/lib/sources/sort";
import type { Candidate, SourceResult } from "@/lib/sources/types";
import type { Friend } from "@/lib/types";

// One-stop import for consumers: sort + match from a single module.
export { sortMatches } from "@/lib/sources/sort";

/**
 * Generic orchestrator: a SourceResult's candidates -> Friend[]. Steps:
 *  1. Partition preVerified (skip registry) vs toCheck.
 *  2. findCirclesAvatars(toCheck) -> AvatarLookup; use only `avatars`, IGNORE
 *     `failedAddresses` (cache-only: no retry ledger).
 *  3. Keep preVerified OR registry-matched candidates; dedupe by lowercase addr.
 *  4. getCirclesProfiles(matched) for name/image.
 *  5. getTrustMap(connectedAvatar) for trust state (try/catch -> empty Map).
 *  6. Build Friend rows mirroring buildFriends's derivation.
 *  7. sortMatches: trust actionability -> weight desc -> displayName.
 */
export async function matchSource(
  result: SourceResult,
  connectedAvatar: string | null, // for the trust map; usually == the seed (lowercased)
  signal?: AbortSignal,
): Promise<Friend[]> {
  const preVerified: Candidate[] = [];
  const toCheck: Candidate[] = [];
  for (const c of result.candidates) {
    if (c.preVerified) preVerified.push(c);
    else toCheck.push(c);
  }

  // Only consult the registry for the not-yet-verified candidates.
  const { avatars } = await findCirclesAvatars(toCheck.map((c) => c.address.toLowerCase()));

  // Keep preVerified OR registry-matched; dedupe by lowercase address (first wins).
  const matched: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of result.candidates) {
    const addr = c.address.toLowerCase();
    if (seen.has(addr)) continue;
    if (c.preVerified || avatars.has(addr)) {
      seen.add(addr);
      matched.push({ ...c, address: addr });
    }
  }

  const profiles = await getCirclesProfiles(matched.map((c) => c.address));

  // Trust degrades to "none" for every row when getTrustMap fails (never throw).
  let trustMap = new Map<string, Exclude<Friend["trust"], "none">>();
  if (connectedAvatar) {
    try {
      trustMap = await getTrustMap(connectedAvatar.toLowerCase());
    } catch {
      trustMap = new Map();
    }
  }

  if (signal?.aborted) return [];

  const rows: Friend[] = matched.map((c) => {
    const info = avatars.get(c.address); // undefined for preVerified-only rows
    const profile = profiles.get(c.address);
    const circlesName = profile?.name ?? info?.name ?? null;
    return {
      address: c.address,
      displayName: circlesName ?? shortenAddress(c.address),
      source: result.sourceId,
      evidence: c.evidence,
      weight: c.weight,
      circlesName,
      circlesImageUrl: profile?.previewImageUrl ?? profile?.imageUrl ?? null,
      kind: info ? avatarKind(info) : "human",
      trust: trustMap.get(c.address) ?? "none",
    } satisfies Friend;
  });

  return sortMatches(rows);
}

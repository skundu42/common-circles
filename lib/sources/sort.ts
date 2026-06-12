import type { Friend, TrustState } from "@/lib/types";

/** Trust actionability order, lowest first (most actionable first).
 *  Moved verbatim from scan.ts:92 — DO NOT change the numbers (Farcaster
 *  ordering depends on them and reducer/sweep tests assert resulting order). */
export const TRUST_ORDER: Record<TrustState, number> = {
  trustedBy: 0, // they already trust you — most actionable
  none: 1,
  trusts: 2,
  mutuallyTrusts: 3,
};

/** Farcaster sort (UNCHANGED semantics): trust actionability → displayName.
 *  scan.ts's sortFriends delegates here so its behavior is identical. */
export function sortFriends(friends: Friend[]): Friend[] {
  return [...friends].sort(
    (a, b) =>
      TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] ||
      a.displayName.localeCompare(b.displayName),
  );
}

/** Generic source sort: trust actionability → weight DESC → displayName.
 *  Used by matchSource for trust2/snapshot. Distinct from sortFriends, which
 *  has no weight tier (Farcaster rows have no weight). */
export function sortMatches(friends: Friend[]): Friend[] {
  return [...friends].sort(
    (a, b) =>
      TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] ||
      (b.weight ?? 0) - (a.weight ?? 0) ||
      a.displayName.localeCompare(b.displayName),
  );
}

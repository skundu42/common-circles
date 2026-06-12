// Adapt a Farcaster ScanResult to the shared Friend shape at the row boundary,
// so the Farcaster tab can render through the same generic list without folding
// runScan into the DiscoverySource seam. Pure, no I/O — ScanResult is imported
// as a TYPE only (no runtime edge into the Farcaster pipeline / @/lib/api).

import type { ScanResult } from "@/lib/scan";
import type { Friend, FcRelation } from "@/lib/types";

/** Source-native evidence copy from the Farcaster follow direction. */
function evidenceForRelation(relation: FcRelation | undefined): string {
  switch (relation) {
    case "mutualFollow":
      return "You follow each other on Farcaster";
    case "following":
      return "You follow them on Farcaster";
    case "follower":
      return "They follow you on Farcaster";
    default:
      return "On Farcaster";
  }
}

/**
 * Stamp `source:"farcaster"` + `evidence` (from fcRelation) onto a scan's
 * friends. Farcaster-only fields (fid/username/pfpUrl/hydrated/viaDeepScan)
 * pass through unchanged. An existing `evidence` (if a future producer sets it)
 * is preserved.
 */
export function farcasterRowsFromScan(result: ScanResult): Friend[] {
  return result.friends.map((f) => ({
    ...f,
    source: "farcaster",
    evidence: f.evidence ?? evidenceForRelation(f.fcRelation),
  }));
}

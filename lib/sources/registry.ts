// The DiscoverySource registry. Partial because Farcaster is NOT a
// DiscoverySource (adapted at the row boundary in farcasterRow.ts) and Snapshot
// is deferred. App builds the tab list separately; this only holds wallet-seeded
// sources that flow through matchSource.

import type { DiscoverySource, SourceId } from "@/lib/sources/types";
import { trust2Source } from "@/lib/sources/trust2";

export const SOURCES: Partial<Record<SourceId, DiscoverySource>> = {
  trust2: trust2Source,
  // INSERTION POINT: when Snapshot lands, add `snapshot: snapshotSource`.
};

/** Resolve a registered DiscoverySource; throws for unregistered ids
 *  (e.g. "farcaster", which uses runScan, not this seam). */
export function getSource(id: SourceId): DiscoverySource {
  const s = SOURCES[id];
  if (!s) throw new Error(`No DiscoverySource registered for "${id}"`);
  return s;
}

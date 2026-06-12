// The DiscoverySource seam: a source produces candidate addresses + evidence;
// the generic matcher (match.ts) consults the Circles spine once and emits
// Friend[]. Pure types — no imports that touch `window`.

import type { Friend } from "@/lib/types";

/** All discovery sources. "snapshot" is reserved now so the union is stable
 *  when the Snapshot tab lands (no churn in registry/Friend/cache keys). */
export type SourceId = "farcaster" | "trust2" | "snapshot";

/** A discovered person BEFORE the Circles registry is consulted. */
export type Candidate = {
  /** Lowercase ETH address — match key, dedupe key, React list key. */
  address: string;
  /** Why this person surfaced — rendered verbatim as the row's secondary line. */
  evidence: string;
  /** Source-native ranking weight (e.g. # of contacts who trust them). Higher first. */
  weight?: number;
  /** True when the address is ALREADY known to be a Circles human
   *  (skip findCirclesAvatars). trust2 sets this false. */
  preVerified?: boolean;
};

export type SourceResult = {
  sourceId: SourceId;
  candidates: Candidate[];
  /** Headline counters for the meta row, e.g. { contacts: 23, candidates: 140 }. */
  stats: Record<string, number>;
  /** Set when the source hit a cap / partial fetch (informational). */
  truncated?: boolean;
};

export interface DiscoverySource {
  readonly id: SourceId;
  readonly label: string;        // tab label, e.g. "Friends of friends"
  readonly evidenceNoun: string; // empty-state copy, e.g. "trusted contacts"
  /** false → seeded by the connected wallet, no text input (trust2 / snapshot). */
  readonly needsHandle: boolean;
  /** `seed` = connected Circles avatar address (lowercase) for wallet-seeded sources. */
  discover(seed: string, signal?: AbortSignal): Promise<SourceResult>;
}

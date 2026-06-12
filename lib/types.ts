// Shared shapes that cross the client/server boundary.

/** A Farcaster account, normalized from the public client API. */
export type FarcasterUser = {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string | null;
  bio: string;
  followingCount: number;
  followerCount: number;
  /** Verified ethereum addresses (lowercase). Only populated on direct lookups. */
  ethWallets: string[];
};

/** A followed account that has a primary verified ethereum address. */
export type ConnectionEntry = {
  fid: number;
  /** Primary verified ethereum address, lowercase. */
  address: string;
};

/** How a connection relates to the scanned account on Farcaster. */
export type FcRelation = "mutualFollow" | "following" | "follower";

export type ConnectionsResponse = {
  /** Distinct accounts followed (after dedupe / self-removal). */
  followingTotal: number;
  /** Distinct accounts following the scanned fid. */
  followersTotal: number;
  /** How many of the following set have a primary verified ethereum address. */
  withWallet: number;
  /** True when the following direction (the default scan) was capped. */
  truncated: boolean;
  /** Count of follows whose primary-wallet lookup failed (= uncheckedFids.length). */
  unchecked: number;
  /** Identities of those connections — drives targeted retry (E1). */
  uncheckedFids: number[];
  /** True when a bulk provider (Neynar key) is active server-side — lets the
   * client lift the deep-scan cap since lookups are no longer per-fid. */
  bulkProvider: boolean;
  /** People `fid` follows that have a primary wallet, mutual follows first. */
  entries: ConnectionEntry[];
  followingFids: number[];
  followerFids: number[];
};

// VerificationsRow shape UNCHANGED. Route response shape changes (see api.ts/routes).
export type VerificationsRow = { fid: number; addresses: string[] };

/** Trust relation between the connected Safe and a counterparty avatar. */
export type TrustState = "none" | "trusts" | "trustedBy" | "mutuallyTrusts";

export type CirclesAvatarKind = "human" | "group" | "organization";

/** One matched person: a Farcaster follow who is also a Circles avatar. */
export type Friend = {
  fid: number;
  /** The Circles avatar address (lowercase). */
  address: string;
  // Farcaster side
  username: string;
  displayName: string;
  pfpUrl: string | null;
  /** Follow direction relative to the scanned account. */
  fcRelation: FcRelation;
  // Circles side
  circlesName: string | null;
  circlesImageUrl: string | null;
  kind: CirclesAvatarKind;
  // Trust (relative to the connected Safe)
  trust: TrustState;
  /** True when found via the all-verifications deep scan, not the primary address. */
  viaDeepScan: boolean;
  /** False while FC profile fields are still placeholders (E15/D5). */
  hydrated: boolean;
};

/** Unified failure ledger across the scan pipeline (E5). */
export type ScanFailures = {
  /** FIDs whose primary-address lookup failed (from connections.uncheckedFids). */
  primaryFids: number[];
  /** FIDs whose verification fetch failed during a sweep (E3 failedFids). */
  verificationFids: number[];
  /** lowercaseAddress -> fid for avatar batches that failed the RPC (E4). */
  addresses: Map<string, number>;
  /** True when getTrustMap failed and trust is unknown (E8). */
  trustUnavailable: boolean;
};

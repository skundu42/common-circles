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
  /** How many of the union have a primary verified ethereum address. */
  withWallet: number;
  /** True when either direction was larger than the scan cap. */
  truncated: boolean;
  /** Connections whose wallet lookup failed even after retries (rate limit). */
  unchecked: number;
  /** Union of both directions, mutual follows first. */
  entries: ConnectionEntry[];
  followingFids: number[];
  followerFids: number[];
};

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
};

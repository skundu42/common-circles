// Shared shapes that cross the client/server boundary.

import type { SourceId } from "@/lib/sources/types";

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

/** One matched person from ANY discovery source. Farcaster fields are optional
 *  so onchain rows don't fake them; `displayName` stays required (universal). */
export type Friend = {
  /** The Circles avatar address (lowercase). React/dedupe key. UNCHANGED, universal. */
  address: string;
  /** Primary display name — UNIVERSAL & REQUIRED. FriendRow:147 renders it and
   *  App.tsx trust toasts read it (×4). Farcaster: FC displayName. New sources:
   *  `circlesName ?? shortenAddress(address)`. */
  displayName: string;

  // --- NEW: provenance + cross-source enrichment ---
  /** Provenance. OPTIONAL so existing Friend literals (tests) still typecheck;
   *  `undefined` is treated as "farcaster" by FriendRow/MatchList. buildFriends
   *  + farcasterRow set "farcaster"; trust2 sets "trust2". */
  source?: SourceId;
  /** Secondary line for non-Farcaster rows ("Trusted by 4 of your contacts"). */
  evidence?: string;
  /** Source-native ranking weight (e.g. contact count for trust2). */
  weight?: number;
  /** Shared POAP eventIds with the connected wallet (set by future poap enrichment). */
  poapShared?: number[];

  // --- Farcaster-only (now optional) ---
  fid?: number;
  username?: string;           // FC handle; absent for onchain sources
  pfpUrl?: string | null;      // FC avatar
  fcRelation?: FcRelation;     // direction; drives the Farcaster-only dir filter
  hydrated?: boolean;          // FC streaming-hydration flag
  viaDeepScan?: boolean;

  // --- Circles side (all sources) ---
  circlesName: string | null;
  circlesImageUrl: string | null;
  kind: CirclesAvatarKind;
  trust: TrustState;
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

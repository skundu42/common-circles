// HyperSnap provider. A third option on the provider seam in
// `farcaster-server.ts`: when HYPERSNAP_NODE_URL is set (and no Neynar key),
// `getProvider()` returns this. HyperSnap is a Farcaster node serving the SAME
// underlying network data, with a Neynar-v2-shaped bulk endpoint that takes
// hundreds of fids per call — no API key, no per-IP rate limit. It removes both
// bottlenecks the keyless path hits (the rate-limited primary-address lookup in
// the main scan and the one-call-per-fid verifications scan in the deep scan).
//
// Return shapes are identical to the keyless and Neynar providers so callers
// (routes) stay provider-agnostic and parity tests can snapshot all three.
// The bulk-user response is Neynar-v2-shaped, so the field mapping mirrors the
// Neynar provider exactly — the only differences are the base URL and no key.

import { chunk, mapLimit } from "@/lib/util";
import { UpstreamError, type FarcasterProvider } from "@/lib/farcaster-server";
import type { FarcasterUser, VerificationsRow } from "@/lib/types";

/** Default bulk provider: the public HyperSnap reference node (key-free). Set
 * HYPERSNAP_NODE_URL to point at a self-hosted node, or to "" to disable
 * HyperSnap and fall back to the keyless api.farcaster.xyz path. */
const DEFAULT_HYPERSNAP_NODE = "https://haatz.quilibrium.com";
export const HYPERSNAP_NODE_URL = (
  process.env.HYPERSNAP_NODE_URL ?? DEFAULT_HYPERSNAP_NODE
).replace(/\/$/, "");
/** The bulk endpoint serves hundreds per call; 200 keeps a single failed chunk's
 * blast radius small while still being only ~20 calls for a 4,000 cap. */
const BULK_LIMIT = 200;
/** Bounded fan-out across chunks, mirroring the other providers. */
const BULK_CONCURRENCY = 4;
/** Per-request timeout — the node is fast (~1s for 300 fids); cap stragglers. */
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One bulk-user request. Throws UpstreamError on any failure. */
async function fetchBulkOnce(fids: number[]): Promise<any[]> {
  let res: Response;
  try {
    res = await fetch(
      `${HYPERSNAP_NODE_URL}/v2/farcaster/user/bulk?fids=${fids.join(",")}`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    throw new UpstreamError("HyperSnap request failed", 502);
  }
  if (!res.ok) throw new UpstreamError("HyperSnap request failed", res.status);
  try {
    const json = (await res.json()) as any;
    return (json?.users ?? []) as any[];
  } catch {
    throw new UpstreamError("HyperSnap request failed", 502);
  }
}

/** Bulk-user fetch for one chunk, with ONE retry to absorb transient blips. */
async function fetchBulkUsers(fids: number[]): Promise<any[]> {
  if (!HYPERSNAP_NODE_URL) throw new UpstreamError("HyperSnap not configured", 500);
  try {
    return await fetchBulkOnce(fids);
  } catch {
    await sleep(600);
    return fetchBulkOnce(fids);
  }
}

/** Map one HyperSnap (Neynar-v2-shaped) bulk-user object to FarcasterUser. */
function normalizeBulkUser(user: any): FarcasterUser {
  const eth = (user?.verified_addresses?.eth_addresses ?? []) as string[];
  return {
    fid: user.fid,
    username: user.username ?? String(user.fid),
    displayName: user.display_name || user.username || String(user.fid),
    pfpUrl: user.pfp_url ?? null,
    bio: user?.profile?.bio?.text ?? "",
    followingCount: user.following_count ?? 0,
    followerCount: user.follower_count ?? 0,
    ethWallets: eth.map((a) => a.toLowerCase()),
  };
}

export const hypersnapProvider: FarcasterProvider = {
  // Bulk hydration — a failed chunk skips its fids rather than sinking the page.
  async getUsersByFids(fids) {
    const batches = chunk(fids, BULK_LIMIT);
    const results = await mapLimit(batches, BULK_CONCURRENCY, async (batch) => {
      try {
        return await fetchBulkUsers(batch);
      } catch {
        return [] as any[];
      }
    });
    return results.flat().map(normalizeBulkUser);
  },

  // ALL verified eth addresses per fid, from the SAME bulk response. A failed
  // chunk pushes its fids to failedFids; returned fids (even with no addresses)
  // yield rows — "partial over throw", matching the keyless contract.
  async getVerificationsByFids(fids) {
    const batches = chunk(fids, BULK_LIMIT);
    const failedFids: number[] = [];
    const results = await mapLimit(batches, BULK_CONCURRENCY, async (batch) => {
      try {
        return await fetchBulkUsers(batch);
      } catch {
        failedFids.push(...batch);
        return [] as any[];
      }
    });
    const rows = results.flat().map((user): VerificationsRow => {
      const eth = (user?.verified_addresses?.eth_addresses ?? []) as string[];
      return { fid: user.fid, addresses: eth.map((a) => a.toLowerCase()) };
    });
    return { rows, failedFids };
  },

  // Primary verified eth address per fid, from the bulk response's
  // `verified_addresses.primary.eth_address`. fids whose chunk failed are
  // reported in uncheckedFids — never silently dropped.
  async getPrimaryAddresses(fids) {
    const batches = chunk(fids, BULK_LIMIT);
    const uncheckedFids: number[] = [];
    const results = await mapLimit(batches, BULK_CONCURRENCY, async (batch) => {
      try {
        return await fetchBulkUsers(batch);
      } catch {
        uncheckedFids.push(...batch);
        return [] as any[];
      }
    });
    const addresses = new Map<number, string>();
    for (const user of results.flat()) {
      const primary = user?.verified_addresses?.primary?.eth_address;
      if (typeof user?.fid === "number" && typeof primary === "string") {
        addresses.set(user.fid, primary.toLowerCase());
      }
    }
    return { addresses, uncheckedFids };
  },
};

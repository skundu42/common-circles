// Neynar provider (E9). The OTHER side of the two-provider seam in
// `farcaster-server.ts`: when NEYNAR_API_KEY is set, `getProvider()` returns
// this instead of the keyless Snapchain/client-API path. It is a QUOTA SWAP,
// not an escape hatch — the follow graph still rides Snapchain (E9); this only
// covers profile/address hydration via Neynar's bulk endpoints.
//
// Return shapes are byte-for-byte identical to the keyless provider so callers
// (routes) stay provider-agnostic and parity tests (B4) can snapshot both.
//
// The API key lives in the `x-api-key` header ONLY — never in a URL, never
// logged, never echoed. Upstream failures throw/skip with a FIXED generic
// message so a key can never leak through an error body.

import { chunk, mapLimit } from "@/lib/util";
import { UpstreamError, type FarcasterProvider } from "@/lib/farcaster-server";
import type { FarcasterUser, VerificationsRow } from "@/lib/types";

const NEYNAR_API = "https://api.neynar.com/v2/farcaster";
/** Neynar's bulk user endpoint accepts at most 100 fids per call. */
const BULK_LIMIT = 100;
/** Mirror the keyless path's bounded fan-out across chunks. */
const BULK_CONCURRENCY = 4;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Bulk-user fetch for one ≤100-fid chunk. Throws UpstreamError on any failure. */
async function fetchBulkUsers(fids: number[]): Promise<any[]> {
  const key = process.env.NEYNAR_API_KEY;
  if (!key) throw new UpstreamError("Neynar request failed", 500);
  let res: Response;
  try {
    res = await fetch(`${NEYNAR_API}/user/bulk?fids=${fids.join(",")}`, {
      headers: { accept: "application/json", "x-api-key": key },
      cache: "no-store",
    });
  } catch {
    // network error — fixed message, never include the cause (could echo the URL/key)
    throw new UpstreamError("Neynar request failed", 502);
  }
  if (!res.ok) {
    // Deliberately drop the upstream body: it can contain the key or echo it back.
    throw new UpstreamError("Neynar request failed", res.status);
  }
  try {
    const json = (await res.json()) as any;
    return (json?.users ?? []) as any[];
  } catch {
    throw new UpstreamError("Neynar request failed", 502);
  }
}

/** Map one Neynar bulk-user object to the normalized FarcasterUser shape. */
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

export const neynarProvider: FarcasterProvider = {
  // Bulk hydration — chunk to ≤100 and fan out like the keyless path. A failed
  // chunk skips its fids (mirrors keyless dropping a failed profile) rather than
  // sinking the whole page.
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

  // ALL verified eth addresses per fid, derived from the SAME bulk response —
  // one call serves both users and verifications. A failed chunk pushes its
  // fids to failedFids; successful fids (even with no addresses) yield rows,
  // matching the keyless contract's "partial over throw" failure semantics.
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
  // reported in uncheckedFids — never silently dropped (keyless parity).
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

// Server-only helpers for the public Farcaster APIs. Two upstreams:
//
//   https://api.farcaster.xyz       — client API: rich user objects, bulk
//                                     primary addresses, verifications
//   https://snap.farcaster.xyz:3381 — public Snapchain node: the raw follow
//                                     graph in huge pages (1–2 requests for
//                                     thousands of follows vs 50/page above)
//
// Neither requires an API key. Called only from route handlers so the browser
// never deals with CORS or upstream quirks.

import { chunk, mapLimit } from "@/lib/util";
import { neynarProvider } from "@/lib/providers/neynar";
import { hypersnapProvider, HYPERSNAP_NODE_URL } from "@/lib/providers/hypersnap";
import type { FarcasterUser, VerificationsRow } from "@/lib/types";

const CLIENT_API = "https://api.farcaster.xyz";
const SNAPCHAIN = "https://snap.farcaster.xyz:3381";

/** Hard cap on the follower direction (the opt-in secondary "check your
 * followers" pass). Followers are the lowest-signal, highest-volume direction. */
export const FOLLOW_CAP = 4000;
/** Hard cap on the following direction — the default scan. Higher than
 * FOLLOW_CAP since people you follow are the relevant set worth covering fully. */
export const FOLLOWING_CAP = 8000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** ms to wait before retrying, parsed from a Retry-After header (E6). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Parse a `Retry-After` header (seconds, or an HTTP date) into ms. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.errors?.[0]?.message ?? body?.details ?? "";
    } catch {
      // non-JSON error body — keep the status only
    }
    throw new UpstreamError(
      detail || `upstream responded ${res.status}`,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  return res.json();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `/fc/primary-addresses` is rate-limited to 20 requests / 10 s per IP
 * (measured: the 429 body says so). Pace our calls to stay under it —
 * a silently dropped batch means people never get checked at all.
 */
const PRIMARY_WINDOW_MS = 10_500;
const PRIMARY_MAX_IN_WINDOW = 16;

/** `/v2/verifications` is gentler but still per-IP — pace it too (E6). The
 * endpoint comfortably serves 30+ concurrent requests (measured, no 429s), so
 * this is set well below the real ceiling to leave headroom for other users. */
const VERIFICATIONS_WINDOW_MS = 10_500;
const VERIFICATIONS_MAX_IN_WINDOW = 80;

/**
 * Serialized in-instance pacing queue (C6/E6). Each acquirer joins a single
 * module-level promise chain, takes its turn, and only resolves once the
 * sliding window has room — so concurrent callers can never burst past the
 * window even though `mapLimit` fires them in parallel. Per-instance only;
 * a 429 that survives retries is counted as a failed batch upstream.
 */
function makePacer(windowMs: number, maxInWindow: number): () => Promise<void> {
  let stamps: number[] = [];
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const turn = tail.then(async () => {
      for (;;) {
        const now = Date.now();
        stamps = stamps.filter((t) => now - t < windowMs);
        if (stamps.length < maxInWindow) {
          stamps.push(now);
          return;
        }
        await sleep(stamps[0] + windowMs - now + 50);
      }
    });
    // keep the chain alive even if a turn rejects (it shouldn't)
    tail = turn.catch(() => undefined);
    return turn;
  };
}

const pacePrimary = makePacer(PRIMARY_WINDOW_MS, PRIMARY_MAX_IN_WINDOW);
const paceVerifications = makePacer(VERIFICATIONS_WINDOW_MS, VERIFICATIONS_MAX_IN_WINDOW);

/** getJson with retries on 429 / 5xx / network errors. */
async function getJsonRetry(
  url: string,
  { attempts = 4, pace }: { attempts?: number; pace?: () => Promise<void> } = {},
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (pace) await pace();
    try {
      return await getJson(url);
    } catch (err) {
      lastError = err;
      const status = err instanceof UpstreamError ? err.status : 0;
      const retriable = status === 429 || status >= 500 || status === 0;
      if (!retriable || attempt === attempts - 1) throw err;
      // Honor an explicit Retry-After when the upstream sent one (E6); else
      // 429s wait out the window, other transient errors linear-backoff.
      const retryAfterMs = err instanceof UpstreamError ? err.retryAfterMs : undefined;
      await sleep(
        retryAfterMs ?? (status === 429 ? PRIMARY_WINDOW_MS : 1500 * (attempt + 1)),
      );
    }
  }
  throw lastError;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeUser(json: any): FarcasterUser {
  const user = json?.result?.user;
  if (!user?.fid) throw new UpstreamError("malformed user response", 502);
  const extras = json?.result?.extras ?? {};
  return {
    fid: user.fid,
    username: user.username ?? String(user.fid),
    displayName: user.displayName || user.username || String(user.fid),
    pfpUrl: user.pfp?.url ?? null,
    bio: user.profile?.bio?.text ?? "",
    followingCount: user.followingCount ?? 0,
    followerCount: user.followerCount ?? 0,
    ethWallets: ((extras.ethWallets ?? []) as string[]).map((a) => a.toLowerCase()),
  };
}

export async function getUserByUsername(username: string): Promise<FarcasterUser> {
  const json = await getJson(
    `${CLIENT_API}/v2/user-by-username?username=${encodeURIComponent(username)}`,
  );
  return normalizeUser(json);
}

export async function getUserByFid(fid: number): Promise<FarcasterUser> {
  const json = await getJson(`${CLIENT_API}/v2/user?fid=${fid}`);
  return normalizeUser(json);
}

const ENSDATA = "https://api.ensdata.net";

/**
 * Address/ENS → Farcaster account via ensdata.net (free, no key). The official
 * client API has no key-free address→FID endpoint (`user-by-verification`
 * requires auth), so this rides on reverse-ENS + ensdata's Farcaster index.
 * The fid is then re-fetched from the official API for canonical data.
 */
async function resolveViaEnsdata(addressOrEns: string): Promise<FarcasterUser> {
  let fid: unknown;
  try {
    const res = await fetch(`${ENSDATA}/${encodeURIComponent(addressOrEns)}?farcaster=true`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      fid = json?.farcaster?.fid;
    }
  } catch {
    // treat timeouts/network errors as "not found" — caller has the message
  }
  if (typeof fid !== "number") {
    throw new UpstreamError(`no Farcaster account found for ${addressOrEns}`, 404);
  }
  return getUserByFid(fid);
}

/**
 * Resolve whatever the user typed — @handle, ENS name, or 0x address — to a
 * Farcaster account. Handles are tried as usernames first (Farcaster usernames
 * can BE ens names, e.g. hellno.eth); dotted names fall back to ENS resolution.
 */
export async function resolveFarcasterUser(query: string): Promise<FarcasterUser> {
  const input = query.trim().replace(/^@/, "").toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(input)) return resolveViaEnsdata(input);
  try {
    return await getUserByUsername(input);
  } catch (err) {
    const notFound =
      err instanceof UpstreamError && (err.status === 400 || err.status === 404);
    if (notFound && input.includes(".")) return resolveViaEnsdata(input);
    throw err;
  }
}

/**
 * Paginate a Snapchain link-store endpoint and collect one fid per message.
 * Pages are large (often thousands per request), so this is 1–2 round trips
 * for typical graphs.
 */
async function collectLinkFids(
  baseUrl: string,
  extractFid: (message: any) => unknown,
  selfFid: number,
  cap: number,
): Promise<{ fids: number[]; truncated: boolean }> {
  const fids = new Set<number>();
  let pageToken = "";
  let truncated = false;
  do {
    const url = baseUrl + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const json: any = await getJson(url);
    for (const message of json?.messages ?? []) {
      const other = extractFid(message);
      // the store can contain self-follow rows — drop them
      if (typeof other === "number" && other !== selfFid) fids.add(other);
    }
    pageToken = json?.nextPageToken ?? "";
    if (fids.size >= cap) {
      truncated = pageToken !== "";
      break;
    }
  } while (pageToken !== "");
  return { fids: [...fids].slice(0, cap), truncated };
}

/** All FIDs `fid` follows. */
export function getFollowingFids(fid: number, cap = FOLLOWING_CAP) {
  return collectLinkFids(
    `${SNAPCHAIN}/v1/linksByFid?fid=${fid}&link_type=follow&pageSize=1000`,
    (m) => m?.data?.linkBody?.targetFid,
    fid,
    cap,
  );
}

/** All FIDs following `fid` (the message author is the follower). */
export function getFollowerFids(fid: number, cap = FOLLOW_CAP) {
  return collectLinkFids(
    `${SNAPCHAIN}/v1/linksByTargetFid?target_fid=${fid}&link_type=follow&pageSize=1000`,
    (m) => m?.data?.fid,
    fid,
    cap,
  );
}

/**
 * Primary verified ethereum address per FID, via the only key-free bulk
 * endpoint (100 fids per call, paced + retried against its 20-req/10-s
 * limit). FIDs without an address are absent from the map; FIDs whose batch
 * still failed after retries are reported in `uncheckedFids` — never
 * silently dropped.
 */
export async function getPrimaryEthAddresses(
  fids: number[],
): Promise<{ addresses: Map<number, string>; uncheckedFids: number[] }> {
  const batches = chunk(fids, 100);
  const uncheckedFids: number[] = [];
  const results = await mapLimit(batches, 4, async (batch) => {
    try {
      const json: any = await getJsonRetry(
        `${CLIENT_API}/fc/primary-addresses?fids=${batch.join(",")}&protocol=ethereum`,
        { pace: pacePrimary },
      );
      return (json?.result?.addresses ?? []) as any[];
    } catch {
      uncheckedFids.push(...batch);
      return [];
    }
  });
  const addresses = new Map<number, string>();
  for (const rows of results) {
    for (const row of rows) {
      const address = row?.success ? row?.address?.address : null;
      const rowFid = row?.fid ?? row?.address?.fid;
      if (typeof address === "string" && typeof rowFid === "number") {
        addresses.set(rowFid, address.toLowerCase());
      }
    }
  }
  return { addresses, uncheckedFids };
}

/** Every verified ethereum address for one FID (used by the deep scan). */
export async function getAllEthVerifications(fid: number): Promise<string[]> {
  const json: any = await getJsonRetry(`${CLIENT_API}/v2/verifications?fid=${fid}`, {
    attempts: 3,
    pace: paceVerifications,
  });
  return ((json?.result?.verifications ?? []) as any[])
    .filter((v) => v?.protocol === "ethereum" && typeof v?.address === "string")
    .map((v) => v.address.toLowerCase());
}

export function parseFids(raw: string | null, cap: number): number[] | null {
  if (!raw) return null;
  const fids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (fids.length === 0) return null;
  return [...new Set(fids)].slice(0, cap);
}

/**
 * Provider adapter (E9). The keyless path wraps the existing Snapchain /
 * client-API helpers; a Neynar path (B1) will branch in behind the same
 * interface. Routes stay provider-agnostic and layer their own failedFids
 * accounting (so failure bookkeeping lives in ONE place: the route).
 */
export interface FarcasterProvider {
  /** Bulk profile hydration (fixes the per-fid N+1 in the users route). */
  getUsersByFids(fids: number[]): Promise<FarcasterUser[]>;
  /**
   * ALL verified ethereum addresses per FID. Per-fid success (even an empty
   * address list) yields a row; a fid whose fetch failed lands in `failedFids`
   * so a "no verifications" result stays distinct from a "fetch failed" one (bug #2).
   */
  getVerificationsByFids(
    fids: number[],
  ): Promise<{ rows: VerificationsRow[]; failedFids: number[] }>;
  getPrimaryAddresses(fids: number[]): Promise<{
    addresses: Map<number, string>;
    uncheckedFids: number[];
  }>;
}

const keylessProvider: FarcasterProvider = {
  async getUsersByFids(fids) {
    const users = await mapLimit(fids, 8, async (fid) => {
      try {
        return await getUserByFid(fid);
      } catch {
        return null; // one failed profile shouldn't sink the page
      }
    });
    return users.filter((u): u is FarcasterUser => u !== null);
  },
  async getVerificationsByFids(fids) {
    const rows: VerificationsRow[] = [];
    const failedFids: number[] = [];
    // per-fid: success (even empty addresses) → row; failure → failedFids,
    // so "no verifications" stays distinct from "fetch failed" (bug #2).
    await mapLimit(fids, 12, async (fid) => {
      try {
        rows.push({ fid, addresses: await getAllEthVerifications(fid) });
      } catch {
        failedFids.push(fid);
      }
    });
    return { rows, failedFids };
  },
  getPrimaryAddresses(fids) {
    return getPrimaryEthAddresses(fids);
  },
};

/**
 * Select the active provider. When `NEYNAR_API_KEY` is set, hydration rides
 * Neynar's bulk endpoints (a quota SWAP, not an escape hatch — the follow graph
 * still uses Snapchain, E9); otherwise the key-free Snapchain/client-API path.
 */
export function getProvider(): FarcasterProvider {
  if (process.env.NEYNAR_API_KEY) return neynarProvider;
  if (HYPERSNAP_NODE_URL) return hypersnapProvider;
  return keylessProvider;
}

/** True when a bulk provider (Neynar or HyperSnap) is active — surfaced to the
 * client so it can lift the deep-scan cap (bulk lookups aren't per-fid).
 * Server-side only. */
export function hasBulkProvider(): boolean {
  return !!process.env.NEYNAR_API_KEY || !!HYPERSNAP_NODE_URL;
}

/**
 * Per-IP token bucket — only active when NEYNAR_API_KEY is set (E13). Key-free
 * deployments never throttle (the public upstreams self-pace via the queues
 * above). In-instance only: a Map of IP -> refilling bucket; on exhaustion a
 * 429, else null (request proceeds).
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const buckets = new Map<string, { tokens: number; resetAt: number }>();

export function rateLimitByIp(request: Request): Response | null {
  if (!process.env.NEYNAR_API_KEY) return null;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(ip, { tokens: RATE_MAX - 1, resetAt: now + RATE_WINDOW_MS });
    return null;
  }
  if (bucket.tokens <= 0) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  bucket.tokens -= 1;
  return null;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof UpstreamError) {
    const status = err.status >= 500 ? 502 : err.status;
    return Response.json({ error: err.message }, { status });
  }
  return Response.json(
    { error: err instanceof Error ? err.message : "unexpected error" },
    { status: 500 },
  );
}

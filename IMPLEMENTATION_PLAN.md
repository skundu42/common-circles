# IMPLEMENTATION PLAN — Friend-Scan Reliability + UX (Common Circles)

Single source of truth for executor agents. Binding scope: E1-E17, D1-D12 from
`main-friend-scan-reliability-plan.md`. E-items SUPERSEDE conflicting R/U wording.
Already done: `getPrimaryEthAddresses` returns `uncheckedFids` (server); connections
route surfaces it as a COUNT only (this plan upgrades it to the array).

Every signature below is one coherent contract. Do not deviate.

---

## 0. Contract decisions made here (not fully specified upstream)

- **C1 — `ScanFailures.addresses` value semantics:** `Map<string, number>` is
  `lowercaseAddress -> fid`. Matches sweep's existing `candidates` map direction and
  E3's `uncheckedAddresses: Map<address,fid>`. The reducer needs the fid to know which
  friend row a recovered address belongs to.
- **C2 — `unchecked` field kept AND augmented.** `ScanResult.unchecked: number` stays
  (back-compat for the meta row), but is now a DERIVED convenience equal to
  `failures.primaryFids.length`. The authoritative source is `failures`. Components read
  `failures` for the D2 block; the meta row may keep reading `unchecked`.
- **C3 — Retry is a single client orchestrator `runRetry`** that rides the verifications
  sweep (E2) for BOTH `failures.primaryFids` and `failures.verificationFids` (verified ⊇
  primary), re-checks `failures.addresses` directly via `findCirclesAvatars`, and (if
  `!trustLoaded`) refetches the trust map. It returns a `RetryOutcome` consumed by the
  pure reducer `applyRetryOutcome`. No new server endpoint.
- **C4 — `trustLoaded` lives on `ScanResult`** (not a TrustState union extension, per E8).
  `getTrustMap` failure → `trustMap: new Map()`, `trustLoaded: false`.
- **C5 — Provider adapter is internal to `farcaster-server.ts`** plus one new file
  `lib/providers/neynar.ts`. Routes stay provider-agnostic (E9). The keyless path is the
  existing Snapchain/client-API code wrapped behind the same interface.
- **C6 — Pacing queue is a module-level serialized promise chain** (per-instance, E6/CEO
  decision #3). Not a cross-instance guarantee; 429 after retries → batch counted as failed.
- **C7 — Cache is `sessionStorage`, keyed per scanned fid**, version-gated, TTL on read,
  trustMap excluded (E7/R8). Cache module is pure (no React).
- **C8 — Truncation copy is neutral (E17):** do not assert "oldest" or "most recent"
  ordering unless empirically verified during implementation against Snapchain timestamps.
  Default sentence in D8 below.
- **C9 — `onHydrated` patch granularity:** keyed by `fid` (a Friend row's stable identity
  for patching FC fields is its fid; `address` remains the React list key since it is unique
  per matched entry). Hydration patches `username/displayName/pfpUrl` + sets `hydrated:true`.

---

## 1. EXACT CONTRACT SIGNATURES

### 1.1 `lib/types.ts`

```ts
// ConnectionsResponse: replace count-only with the array (E1). Keep `unchecked` count.
export type ConnectionsResponse = {
  followingTotal: number;
  followersTotal: number;
  withWallet: number;
  truncated: boolean;
  /** Count of connections whose primary-wallet lookup failed (= uncheckedFids.length). */
  unchecked: number;
  /** Identities of those connections — drives targeted retry (E1). NEW. */
  uncheckedFids: number[];
  entries: ConnectionEntry[];
  followingFids: number[];
  followerFids: number[];
};

// VerificationsRow shape UNCHANGED. Route response shape changes (see 1.6/1.7).
export type VerificationsRow = { fid: number; addresses: string[] };

// Friend gains a hydration flag (E15). NEW field.
export type Friend = {
  fid: number;
  address: string;
  username: string;
  displayName: string;
  pfpUrl: string | null;
  fcRelation: FcRelation;
  circlesName: string | null;
  circlesImageUrl: string | null;
  kind: CirclesAvatarKind;
  trust: TrustState;
  viaDeepScan: boolean;
  /** False while FC profile fields are still placeholders (E15/D5). NEW. */
  hydrated: boolean;
};

// Unified failure state (E5). NEW.
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
```

### 1.2 `lib/circles.ts`

```ts
// E4: report failed batches instead of a bare Map. try/catch + ONE retry per batch.
export type AvatarLookup = {
  avatars: Map<string, AvatarInfo>;
  /** lowercase addresses whose batch failed after the retry. */
  failedAddresses: string[];
};
export async function findCirclesAvatars(addresses: string[]): Promise<AvatarLookup>;

// getCirclesProfiles: UNCHANGED (already try/catch, decorative).

// getTrustMap: signature UNCHANGED. Callers (scan.ts / runRetry) wrap in try/catch and
// set trustLoaded=false / failures.trustUnavailable=true on throw (E8). Do NOT swallow
// inside getTrustMap — callers need to distinguish empty-trust from failed-fetch.
export async function getTrustMap(
  avatar: string,
): Promise<Map<string, Exclude<TrustState, "none">>>;
```

Migration note: EVERY current caller of `findCirclesAvatars` (scan.ts pass-1 line 206,
sweep line 157) must destructure `{ avatars, failedAddresses }`.

### 1.3 `lib/scan.ts`

```ts
export type TrustMap = Map<string, Exclude<TrustState, "none">>;

// ScanResult: add failures + trustLoaded; keep unchecked (C2). NEW/CHANGED fields flagged.
export type ScanResult = {
  user: FarcasterUser;
  followingTotal: number;
  followersTotal: number;
  withWallet: number;
  truncated: boolean;
  unchecked: number;                 // = failures.primaryFids.length (C2)
  autoSwept: boolean;
  friends: Friend[];
  deepScanCandidates: number[];
  checkedAddresses: Set<string>;
  trustMap: TrustMap;
  /** False when getTrustMap failed; D6/headline read this (E8). NEW. */
  trustLoaded: boolean;
  relation: Map<number, FcRelation>;
  /** Unified failure ledger (E5). NEW. */
  failures: ScanFailures;
  /** Stamp for cache provenance + retry scanId guard (E5/D7). NEW. */
  scanId: number;
  /** ms epoch the scan completed; cache TTL + "N min ago" copy (D7). NEW. */
  completedAt: number;
};

// sweepVerifications: NEVER throws (E3). Returns partial. CHANGED return type.
export type SweepResult = {
  entries: ConnectionEntry[];
  avatars: Map<string, AvatarInfo>;
  /** FIDs whose verification fetch failed for the whole batch (E3). */
  failedFids: number[];
  /** lowercaseAddress -> fid for avatar batches that failed the RPC (E3/E4). */
  uncheckedAddresses: Map<string, number>;
  checked: number;
};
async function sweepVerifications(
  fids: number[],
  checkedAddresses: Set<string>,
  onProgress: (checked: number, total: number, found: number) => void,
): Promise<SweepResult>;
// Per batch (E3 contract): (a) fetchVerifications failure -> push whole batch to
// failedFids, continue; (b) build candidates skipping checkedAddresses; (c) call
// findCirclesAvatars(candidates) -> {avatars,failedAddresses}; (d) commit an address into
// checkedAddresses ONLY if it is NOT in failedAddresses (failed addrs stay eligible),
// failed addrs -> uncheckedAddresses; (e) matched -> entries/avatars.

// Streaming hydration (E15). hydrateFriends restructured into two steps.
/** Synchronous: build placeholder Friends immediately from entries + Circles data. */
export function buildFriends(
  matched: ConnectionEntry[],
  avatars: Map<string, AvatarInfo>,
  profiles: Map<string, Profile>,
  trustMap: TrustMap,
  relation: Map<number, FcRelation>,
  viaDeepScan: boolean,
): Friend[]; // hydrated:false, username=`!fid`, displayName=`FID fid` until patched
/** Streams FC profiles in 100-chunks, invoking onHydrated per chunk (E15). */
export async function hydrateFriendsStreaming(
  fids: number[],
  onHydrated: (patches: Map<number, FarcasterUser>) => void,
  signal?: AbortSignal,
): Promise<void>;

export async function runScan(
  query: string,
  walletAddress: string | null,
  onUser: (user: FarcasterUser) => void,
  onProgress: (progress: ScanProgress) => void,
  onHydrated: (patches: Map<number, FarcasterUser>) => void,  // NEW (E15)
  signal?: AbortSignal,                                       // NEW (E10)
): Promise<ScanResult>;

export type DeepScanProgress = { checked: number; total: number; found: number };
export async function runDeepScan(
  candidates: number[],
  checkedAddresses: Set<string>,
  trustMap: TrustMap,
  relation: Map<number, FcRelation>,
  onProgress: (progress: DeepScanProgress) => void,
  onHydrated: (patches: Map<number, FarcasterUser>) => void,  // NEW (E15)
  signal?: AbortSignal,                                       // NEW (E10)
): Promise<{ friends: Friend[]; checked: number; failures: Pick<ScanFailures,
  "verificationFids"> & { addresses: Map<string, number> } }>; // surface sweep failures

// Targeted retry orchestrator (E2/E5). NEW.
export type RetryOutcome = {
  /** Newly matched entries recovered this retry. */
  entries: ConnectionEntry[];
  avatars: Map<string, AvatarInfo>;
  profiles: Map<string, Profile>;
  /** Failure sets that STILL failed (replaces old sets for those classes). */
  stillFailed: ScanFailures;
  /** Present only if trust was retried. undefined = trust not retried. */
  trustMap?: TrustMap;
  trustLoaded?: boolean;
  /** Echo of the scanId this retry was launched against (E5 mismatch guard). */
  scanId: number;
};
export async function runRetry(
  result: ScanResult,
  onProgress: (checked: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RetryOutcome>;

// PURE reducer (E5) — the most valuable unit test. No I/O, no mutation of inputs.
export function applyRetryOutcome(
  result: ScanResult,
  friends: Friend[],
  outcome: RetryOutcome,
): { result: ScanResult; friends: Friend[] };
// Contract: if outcome.scanId !== result.scanId -> return inputs unchanged. Else:
// - append new Friends built from outcome.entries (dedupe by address, never re-sort
//   existing rows; new rows appended then the WHOLE list re-sorted ONCE is FORBIDDEN by
//   D3 — instead: keep existing order, append new sorted-among-themselves).
// - failures.primaryFids/verificationFids/addresses replaced by outcome.stillFailed.*
// - unchecked recomputed = stillFailed.primaryFids.length.
// - if outcome.trustMap provided: set trustMap, trustLoaded, failures.trustUnavailable,
//   and re-derive each friend.trust from the new map.
// - completedAt updated to Date.now().
```

### 1.4 `lib/farcaster-server.ts`

```ts
export class UpstreamError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number); // E6
}

// E6: serialized in-instance pacing queue (C6). Replaces pacePrimary array.
// Module-level promise chain; each acquire waits its turn then enforces the window.
function pacePrimary(): Promise<void>;          // kept name; internals rewritten
function paceVerifications(): Promise<void>;     // NEW — getAllEthVerifications now paced (E6)

// getJsonRetry: honor UpstreamError.retryAfterMs when present (E6). Signature unchanged.
async function getJsonRetry(
  url: string,
  opts?: { attempts?: number; pace?: () => Promise<void> },
): Promise<Record<string, unknown>>;

// E9 provider adapter — interface + selection. NEW.
export interface FarcasterProvider {
  getUsersByFids(fids: number[]): Promise<FarcasterUser[]>;      // bulk (fixes users N+1)
  getVerificationsByFids(fids: number[]): Promise<VerificationsRow[]>; // includes failedFids? no:
  getPrimaryAddresses(fids: number[]): Promise<{
    addresses: Map<number, string>;
    uncheckedFids: number[];
  }>;
}
// getVerificationsByFids returns rows only; the route layers failedFids (1.7) by catching
// per-fid in the keyless path. Neynar path maps its bulk response; on whole-call failure the
// route catches and reports failedFids. Keep failure accounting in ONE place: the route.
export function getProvider(): FarcasterProvider; // branches on process.env.NEYNAR_API_KEY
// Keyless impl wraps existing getUserByFid/getAllEthVerifications/getPrimaryEthAddresses.
// Neynar impl lives in lib/providers/neynar.ts; error bodies mapped to fixed strings.

// E13: per-IP token bucket, ONLY when NEYNAR_API_KEY set. NEW.
export function rateLimitByIp(request: Request): Response | null; // 429 Response or null

// existing exports unchanged: FOLLOW_CAP, parseFids, errorResponse, resolveFarcasterUser,
// getFollowingFids, getFollowerFids, getUserByFid, getUserByUsername.
```

```ts
// E12: each route file adds:
export const maxDuration = 60; // seconds; connections may use 60, others 30
```

### 1.5 `lib/cache.ts` (NEW, E7)

```ts
import type { ScanResult } from "@/lib/scan";

const CACHE_VERSION = 1;
const TTL_MS = 30 * 60 * 1000; // 30 min
const keyFor = (fid: number) => `common-circles:scan:v${CACHE_VERSION}:${fid}`;

// DTO with Sets->arrays, Maps->entries, trustMap EXCLUDED. friends serialized as-is (plain).
type ScanResultDTO = {
  version: number;
  completedAt: number;
  result: Omit<ScanResult,
    "checkedAddresses" | "trustMap" | "relation" | "failures" | "trustLoaded"> & {
    checkedAddresses: string[];
    relation: [number, FcRelation][];
    failures: {
      primaryFids: number[];
      verificationFids: number[];
      addresses: [string, number][];
      trustUnavailable: boolean;
    };
  };
};

export function serialize(result: ScanResult): ScanResultDTO;   // pure
export function deserialize(dto: ScanResultDTO): ScanResult;    // revives Set/Map;
//   trustMap = new Map(), trustLoaded = false (always refetched per E7/D7).
//   numeric Map keys (relation, failures.addresses values) revived as numbers.
export function readCache(fid: number): ScanResult | null;
//   getItem -> JSON.parse -> version check -> TTL check (Date.now()-completedAt>TTL => null
//   + remove) -> deserialize. Any throw -> return null.
export function writeCache(result: ScanResult): void;
//   try { setItem(serialize) } catch { /* quota/private mode: ignore */ } (E7)
export function clearCache(fid: number): void;
```

Serialization trap (E7): `JSON.stringify(scanResult)` would silently emit `{}` for
`checkedAddresses` (Set), `trustMap`/`relation`/`failures.addresses` (Maps). The DTO is
mandatory. Numeric Map keys come back as strings from `JSON.parse`; `deserialize` MUST
`Number(k)` for `relation` keys.

### 1.6 `lib/api.ts`

```ts
export function fetchFarcasterUser(query: string): Promise<FarcasterUser>;       // unchanged
export function fetchConnections(fid: number, signal?: AbortSignal): Promise<ConnectionsResponse>;
//   ^ now carries uncheckedFids[] in the body (E1); add optional signal (E10)
export async function fetchFarcasterUsers(fids: number[], signal?: AbortSignal): Promise<FarcasterUser[]>;
// CHANGED return: failedFids surfaced (E2/R2).
export async function fetchVerifications(
  fids: number[],
  signal?: AbortSignal,
): Promise<{ rows: VerificationsRow[]; failedFids: number[] }>;
// internal getJson<T> gains optional signal param.
```

### 1.7 Routes

```ts
// app/api/farcaster/connections/route.ts
export const maxDuration = 60;
// body now includes uncheckedFids: union.filter(f => !addresses.has(f) && <was attempted>)
//   -> in practice: uncheckedFids from getProvider().getPrimaryAddresses(); ALSO keep
//   `unchecked: uncheckedFids.length`. (E1, E12)
// optional E13: const limited = rateLimitByIp(request); if (limited) return limited;

// app/api/farcaster/verifications/route.ts
export const maxDuration = 30;
// returns { rows, failedFids }: per-fid try/catch pushes failed fid to failedFids
//   instead of returning {fid, addresses:[]} (R2/E3 source). parseFids cap 100. (E13 guard)

// app/api/farcaster/users/route.ts
export const maxDuration = 30;
// uses getProvider().getUsersByFids(fids) (bulk; E9). parseFids cap 150. (E13 guard)

// app/api/farcaster/user/route.ts
export const maxDuration = 30; // otherwise unchanged
```

---

## 2. COMPONENT CHANGE SPEC (D1-D12)

State source of truth in `App.tsx`: `result: ScanResult` (holds `failures`,
`trustLoaded`, `scanId`, `completedAt`), `friends: Friend[]` (patched by onHydrated +
applyRetryOutcome), and a new `retry: RetryState`.

| D# | Component | Reads from | Behavior |
|----|-----------|-----------|----------|
| D1 | Results (headline `<h2>`) | `failures` (any non-empty / `trustUnavailable` EXCLUDED per E16), `friends.length` | 3 variants. partial = `primaryFids.length + verificationFids.length + addresses.size > 0`. Copy: complete+matches `"{N} of your people live on Circles."`; complete+zero `"No overlap — yet."`; partial `"Scan incomplete — {N} matched, {M} couldn't be checked."` where M = primaryFids+verificationFids count + addresses.size. Partial REPLACES the other two. trust-unavailable alone does NOT trigger partial (E8/E16). |
| D2 | Results (new `StatusBlock`, role="status") | `failures`, `trustLoaded`, `truncated`, `retry` | ONE block, line items: unchecked primary lookups (count = primaryFids.length); failed verification fetches (count = verificationFids.length); trust circle unavailable (when `!trustLoaded`); truncation note (informational, C8 copy). One primary CTA "Retry failed checks" (covers primaryFids+verificationFids+addresses via runRetry). Trust line has its OWN inline "retry trust" link. REPLACES Results.tsx:163-177 rate-limit paragraph entirely. |
| D3 | StatusBlock CTA + App.runRetry | `retry: RetryState` | State machine: `idle -> retrying` (CTA disabled, mono live "checking {k} of {m}…" from onProgress) `-> partial-success` ("+{K} found", counts update via applyRetryOutcome, CTA re-enabled if anything still failed) `-> resolved` (block collapses; new rows animate in; existing rows NEVER re-sort — see applyRetryOutcome contract). Retry mutually exclusive with deep scan (disable both while either runs). |
| D4 | App.tsx + ScanProgress | `scanError`, `progress.step` | Hard failure keeps ScanProgress mounted; failed stage marked error + "Try again" button. REMOVE App.tsx:128-132 bounce-to-idle on catch; instead set an error on the progress view (new `progress.failedStep?: number` + `scanError`). Transient failures never amber the progress screen (they live in D2). |
| D5 | FriendRow + Results list | `friend.hydrated` | When `!hydrated`, render skeleton geometry (avatar pair, two text lines, 88px action slot) but keep Trust button ACTIVE (address known). Stable order: list sorted ONCE at match time (buildFriends + sortFriends); hydration patches in place by fid, never reorders. |
| D6 | StatusBlock + FriendRow/TrustBadge + Results filters | `trustLoaded` | When `!trustLoaded`: D2 shows "trust circle unavailable — retry"; TrustBadge renders neutral "—" (add a TrustBadge `unknown` rendering path keyed off a new `loaded` prop, NOT a TrustState value, per E8); Trust button stays ENABLED; filter tabs show "?" counts and are disabled until map loads. |
| D7 | Results meta row + App | `completedAt`, cache | When rendered from cache: meta row gains "from your scan {N} min ago · ↻ rescan". Retry operates on cached failure sets; rescan clears cache + reruns. |
| D8 | Results truncation chip + ScanProgress + Hero + README | `truncated` | ONE canonical neutral sentence (C8/E17): "Scanned up to 4,000 connections per direction; {M} not checked." Reuse in chip/tooltip/Hero. Fix Hero.tsx:54 "Sweep your whole … circle" -> drop "whole". |
| D9 | Results (`<details>` at bottom) | `result` counters | mono `<details>` collapsed, summary "scan details", counts only (follows fetched, wallets resolved, matched, swept, unchecked primary, failed verifications, failed avatar addrs, hydration pending). No table chrome. |
| D10 | Results / FriendRow / StatusBlock | — | aria-live="polite" on stage progress + retry counter; StatusBlock role="status"; retry/filter touch targets ≥44px (fix the 10-11px filter buttons in Results.tsx:211-244); move focus to StatusBlock when retry completes. |
| D11 | Results meta row | `failures` empty | Zero-failure scans add "all {N} connections checked ✓" to the meta row. |
| D12 | Results StatusBlock + meta row | — | single-column stacking on mobile; no new fixed widths beyond existing 88px action slot. |

`App.tsx` orchestration changes:
- Thread `onHydrated` (patch friends by fid, set hydrated:true) + `AbortController` into
  `runScan`/`runDeepScan`/`runRetry`; `handleCancel` aborts the controller (E10).
- Add `runRetry` handler driving `retry` state + `applyRetryOutcome` (D3).
- Remove bounce-to-idle (D4); cache read on mount-by-fid + write after scan/retry (D7).
- Fix wallet-change trust race (E11): effect keys on `phase + result?.scanId`, record the
  wallet the scan used, refetch only on mismatch; on success set trustLoaded=true.

---

## 3. PARALLEL DECOMPOSITION (file-ownership boundaries)

### PHASE A — CONTRACT SPINE (sequential, ONE owner). Must compile + `tsc --noEmit` clean before Phase B.
Owns and edits, in this order:
1. `lib/types.ts` — add ScanFailures, uncheckedFids, Friend.hydrated, VerificationsRow note.
2. `lib/circles.ts` — AvatarLookup return for findCirclesAvatars (+try/catch+retry);
   update its two in-repo callers' destructuring is NOT here (callers are in scan.ts, done in step 4).
3. `lib/farcaster-server.ts` — UpstreamError.retryAfterMs, pacing queue + paceVerifications,
   getJsonRetry Retry-After, FarcasterProvider interface + getProvider keyless impl ONLY
   (Neynar impl + rateLimitByIp are STUBS returning keyless/no-op so it compiles), maxDuration
   helper N/A.
4. `lib/scan.ts` — ScanResult (failures/trustLoaded/scanId/completedAt), SweepResult,
   sweepVerifications (E3), buildFriends + hydrateFriendsStreaming (E15), runScan/runDeepScan
   new params, runRetry, applyRetryOutcome. Stub runRetry to a trivial resolved outcome if
   needed to unblock, but PREFER full impl (it is spine-critical).
5. `lib/api.ts` — fetchVerifications {rows,failedFids}, signals, fetchConnections uncheckedFids.
6. Routes (`connections`, `verifications`, `users`, `user`) — contract changes + maxDuration;
   use getProvider() keyless path; verifications failedFids; connections uncheckedFids.

Spine output: compiling contracts + real (not fake) return values so downstream streams
compile and run against truth.

### PHASE B — PARALLEL STREAMS (each owns a DISJOINT file set)

- **Stream B1 — Provider adapter (E9/E13).** Owns: `lib/providers/neynar.ts` (NEW),
  and the Neynar branch + `rateLimitByIp` body inside `lib/farcaster-server.ts`, plus the
  `rateLimitByIp` call lines in the 3 data routes.
  SHARED-FILE FLAG: `farcaster-server.ts` and the routes are spine files. Serialize: B1 edits
  them ONLY after Phase A merges; B1 touches the Neynar impl + bucket body, NOT the interface
  or keyless impl (frozen by spine). Routes: B1 adds only the 3-line bucket guard at the top of
  each GET — no overlap with B-UI.

- **Stream B2 — UI (D1-D12) + cache wiring.** Owns: `components/App.tsx`, `components/Results.tsx`,
  `components/ScanProgress.tsx`, `components/FriendRow.tsx`, `components/Hero.tsx`,
  `components/TrustGlyph.tsx`, and `README.md` (D8). Consumes `lib/cache.ts` (B3) + spine types.

- **Stream B3 — Cache (E7).** Owns: `lib/cache.ts` (NEW) only. No other file. B2 imports it.

- **Stream B4 — Tests + vitest setup.** Owns: `package.json` (scripts + devDeps),
  `vitest.config.ts` (NEW), and all files under `test/` (NEW). See section 4.
  SHARED-FILE FLAG: `package.json` is also touched by nobody else in Phase B — B4 owns it
  exclusively. devDeps install (`pnpm add -D …`) is a human/executor action, not a code edit.

Disjoint-set proof: B1=neynar.ts + 2 frozen-region edits; B2=components/* + README;
B3=cache.ts; B4=package.json + vitest.config.ts + test/*. Only `farcaster-server.ts` and the
routes are touched post-spine by B1 — serialized by the "after Phase A merge, bucket/Neynar
regions only" rule above. No two B-streams write the same file region.

---

## 4. TEST PLAN (vitest)

devDeps to add (B4): `vitest`, `vite-tsconfig-paths`. Scripts in package.json:
`"typecheck": "tsc --noEmit"`, `"test": "vitest run"`, `"test:watch": "vitest"`.

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
export default defineConfig({
  plugins: [tsconfigPaths()],   // resolves "@/..." like Next
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

Test files + assertions:

1. `test/sweep.test.ts` — sweepVerifications partial failure (E3). Mock `fetchVerifications`
   and `findCirclesAvatars`. Assert: (a) a batch whose fetch rejects -> its fids in
   `failedFids`, loop continues; (b) addresses in `findCirclesAvatars.failedAddresses` are
   NOT added to `checkedAddresses` and ARE in `uncheckedAddresses`; (c) successfully-checked
   addresses ARE committed; (d) `checked` counts all attempted batch lengths; (e) NEVER throws.

2. `test/reducer.test.ts` — applyRetryOutcome (E5), the highest-value test. Assert: (a)
   scanId mismatch -> inputs returned unchanged (referential or deep-equal); (b) new entries
   appended, no existing row re-sorted (assert index stability of pre-existing addresses);
   (c) failure sets replaced by stillFailed; `unchecked` recomputed; (d) trustMap provided ->
   trust re-derived per friend, trustLoaded/trustUnavailable updated; (e) dedupe by address.

3. `test/cache.test.ts` — DTO round-trip (E7). Assert: serialize->deserialize preserves
   `checkedAddresses` Set, `relation` Map (numeric keys revived as numbers), `failures.addresses`
   Map; trustMap excluded (empty Map, trustLoaded=false after revive); readCache returns null on
   version bump and on TTL expiry; writeCache swallows a thrown setItem (quota).

4. `test/pacing.test.ts` — pacing queue + Retry-After (E6) with `vi.useFakeTimers()`. Assert:
   N concurrent pacePrimary acquisitions serialize within the window (no more than
   PRIMARY_MAX_IN_WINDOW resolve before time advances); UpstreamError with retryAfterMs causes
   getJsonRetry to wait that long (chaos/429-storm scenario).

5. `test/routes.test.ts` — verifications route failedFids + parseFids. Assert: per-fid throw ->
   fid in `failedFids`, others in `rows`; parseFids junk/dupes/cap (empty->null, dedupe,
   slice to cap, drop non-positive/non-int).

6. `test/provider.test.ts` — adapter parity (E9), snapshot. Assert keyless vs Neynar
   `getUsersByFids`/`getPrimaryAddresses`/`getVerificationsByFids` produce the same normalized
   shape for a fixed fixture; Neynar error body mapped to a fixed string (never echoed).

---

## 5. VERIFICATION GATES (exact commands + order)

package.json scripts to ADD (none exist today): `typecheck`, `test`, `test:watch` (above).

Order:
1. After PHASE A (spine): `npx tsc --noEmit` MUST pass before any Phase B work starts.
2. During Phase B: each stream runs `npx tsc --noEmit` on its own before integration.
3. After Phase B integration: `npx tsc --noEmit` -> `pnpm vitest run` (all 6 groups green)
   -> `pnpm build`.
4. Final gate: `npx tsc --noEmit && pnpm vitest run && pnpm build` all clean.

Devdep install (executor/human): `pnpm add -D vitest vite-tsconfig-paths`.

---

## 6. RISK / ORDERING NOTES

- **Largest item: streaming hydration (E15).** Restructures hydrateFriends into
  buildFriends (sync placeholders) + hydrateFriendsStreaming (onHydrated chunks) and rewires
  runScan/runDeepScan/runRetry signatures AND App.tsx friends-patching. It is the deepest
  cross-cut (spine + B2). Do it fully in the spine so B2 only consumes a stable callback.
- **Cache Set/Map trap (E7).** Naive `JSON.stringify(ScanResult)` silently drops every Set
  and Map -> cache returns lossy data with no error. The DTO serializer is non-optional;
  numeric Map keys must be revived with `Number()`. Covered by test/cache.test.ts.
- **Retry rides verifications sweep (E2), no new primary endpoint.** runRetry resolves failed
  primaryFids by fetching their FULL verifications (verified ⊇ primary) through the existing
  verifications route, plus re-checking `failures.addresses` directly via findCirclesAvatars,
  plus optional trust refetch. Do NOT add a primary-addresses-by-fid route.
- **scanId guard everywhere.** runRetry/runScan/runDeepScan capture scanId; applyRetryOutcome
  bails on mismatch; App.tsx ignores stale callbacks. Prevents a cancelled/superseded scan
  from corrupting current state.
- **Provider is a quota SWAP, not an escape hatch (E9).** Follow graph stays on Snapchain even
  with the key set. rateLimitByIp only active when key set (E13).
- **D8 truncation order unverified.** Ship neutral copy (C8/E17) unless empirically verified.

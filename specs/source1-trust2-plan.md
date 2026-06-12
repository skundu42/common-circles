> ## ⚠️ CORRECTED BASELINE (verified by orchestrator before execution) ⚠️
> Run `pnpm test` at HEAD (`234a938 "Default HyperSnap to the public node"`) **today**: **31 pass / 3 fail**.
> The 3 failures are ALL in `test/provider.test.ts` (`provider parity` describe block). They are **NOT a
> sandbox artifact** (the plan text below guesses that — it is wrong). Root cause, confirmed: commit `234a938`
> made `HYPERSNAP_NODE_URL` default to a non-empty public node. `provider.test.ts` stubs `NEYNAR_API_KEY=""`
> to exercise the keyless path but does NOT stub `HYPERSNAP_NODE_URL`, so `getProvider()` now selects HyperSnap
> (hitting `haatz.quilibrium.com` URLs the mock doesn't handle → empty results). It is pre-existing test/code
> drift, **orthogonal to trust2**, and OUT OF SCOPE for this work.
>
> **Rule for every implementation agent:** Do NOT touch `test/provider.test.ts` or `lib/providers/*`. Do NOT
> "fix" those 3 failures. Success = "the 31 deterministic tests stay green, your NEW tests pass, and you
> introduce ZERO new failures." The 3 provider failures must remain exactly 3 (unchanged) after your work.
> ---

This is the decisive constraint. `test/reducer.test.ts:42` constructs a `Friend` literal WITHOUT a `source` field. The spec's Type-changes block shows `source: SourceId` as **required**. If `source` is made required, this test (and `test/hydrate.test.ts`) fails typecheck — violating "all 34 tests stay green and unchanged."

Resolution: `source` must be **optional** in the `Friend` type (`source?: SourceId`), OR `buildFriends` must set it so Farcaster rows get `source:"farcaster"` and tests that build literals still typecheck. Since the test literal omits it, and we cannot edit tests, **`source` must be optional** (`source?: SourceId`). Consumers reading `friend.source` then branch on `friend.source === "farcaster"` falling through to Farcaster rendering when `undefined` (which is correct — existing Farcaster-built rows would have it set by `buildFriends`, but test literals default to undefined → treated as Farcaster). I'll specify `source?` optional with the FriendRow branch defaulting `undefined → farcaster`.

I now have everything needed. Let me write the plan.

---

# IMPLEMENTATION PLAN — Source 1 (`trust2`, "Friends of friends") + the `lib/sources/` seam

## 1. Scoping confirmation

This plan ships the spec's **MVP cut** (spec line ~129-131): the discovery seam plus **Source 1 (`trust2`) only**, behind a tab bar with exactly **2 working tabs** — `Friends of friends` (default, id `trust2`) and `Farcaster` (id `farcaster`). The full `lib/sources/` abstraction (`types.ts`, `match.ts`, `sort.ts`, `trust2.ts`, `registry.ts`, `farcasterRow.ts`) is built so `snapshot` and the `poap` enrichment slot in later with **zero rework**: `SourceId` already includes `"snapshot"`, the `Friend` type already carries `poapShared?`, and a documented insertion point is left in `SourceTabs`/`registry` for a 3rd "Shared DAOs" tab. The Farcaster scan path (`runScan`/`runDeepScan`/`runRetry`, the failure ledger, streaming hydration) and `lib/circles.ts` are **untouched** — Farcaster is adapted only at the row boundary (`farcasterRow.ts`).

**Deferred (NOT in this plan, no code):** `lib/sources/snapshot.ts`, `lib/sources/poap.ts`, `app/api/onchain/*` routes, POAP enrichment/badge/cache, `ALCHEMY_API_KEY`, `.env.example` changes, `test/sources/snapshot.test.ts`, `test/sources/poap.test.ts`. No dead/disabled Snapshot tab is added. The `Friend` shape *includes* the future `poapShared?: number[]` field so the type does not churn, but no POAP logic exists.

**Pre-existing test state (verified):** running `pnpm test` today yields **31 pass / 3 fail**; all 3 failures are in `test/provider.test.ts` (Neynar-key branch, a `vi.stubEnv`/`vi.resetModules` ordering artifact in this sandbox), totaling the spec's 34 tests. These 3 failures are **orthogonal** to this work — implementers must NOT "fix" them and must leave `provider.test.ts` unchanged. "Stay green" here means: introduce **no new failures**, and the deterministic 31 stay passing.

---

## 2. Exact type contracts (verbatim — implementers copy these)

### 2a. `lib/sources/types.ts` (NEW — pure types, zero runtime deps)

```ts
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
```

> Note: `Friend` is imported here only so `match.ts` and consumers share a single source of truth; `types.ts` re-uses it but does not redefine it.

### 2b. Generalized `Friend` in `lib/types.ts` (additive)

**CRITICAL CONSTRAINT (verified):** `test/reducer.test.ts:42-56` and `test/hydrate.test.ts` construct `Friend` **literals** that omit any `source` field, and those tests must stay unchanged. Therefore **`source` is OPTIONAL**, not required. All other Farcaster fields also become optional (additive). `displayName` stays **required** (sanity-check #1).

```ts
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
```

Add the import at the top of `lib/types.ts`:
```ts
import type { SourceId } from "@/lib/sources/types";
```
This creates a `types.ts → sources/types.ts → types.ts` cycle, but it is **type-only** (no runtime import), which TypeScript and the bundler resolve fine. (Verified: no runtime value flows across this edge.)

**Why making `fid`/`username`/`fcRelation`/`hydrated`/`viaDeepScan` optional is safe for the 34 tests:** every existing producer (`buildFriends`, `applyHydration`, the test `friend()` factory) sets all of them, and every existing consumer either reads them on rows it knows are Farcaster or accesses them in code paths the tests already cover. Making a required field optional is a **widening** — it never breaks an existing literal or assignment. The one place this could regress is `Results.tsx`/`FriendRow.tsx` reading `f.fcRelation`/`f.username` unconditionally; those reads stay valid for Farcaster rows and are guarded in the FriendRow changes (§6) and confined to the Farcaster wrapper for the dir filter.

### 2c. Sort util + matcher signatures

**Decision: extract `TRUST_ORDER` + the sort comparator to a new module `lib/sources/sort.ts`**, and have `lib/scan.ts` import them so Farcaster behavior is byte-for-byte identical. Rationale: the matcher must not import from `lib/scan.ts` (which pulls the whole Farcaster pipeline + `@/lib/api`); a tiny pure module is the clean shared dependency. `scan.ts` keeps its public `sortFriends` export (so `lib/scan.ts`'s own callers and tests are unaffected) but its body delegates to the shared comparator.

`lib/sources/sort.ts` (NEW):
```ts
import type { Friend, TrustState } from "@/lib/types";

/** Trust actionability order, lowest first (most actionable first).
 *  Moved verbatim from scan.ts:92 — DO NOT change the numbers (Farcaster
 *  ordering depends on them and reducer/sweep tests assert resulting order). */
export const TRUST_ORDER: Record<TrustState, number> = {
  trustedBy: 0, // they already trust you — most actionable
  none: 1,
  trusts: 2,
  mutuallyTrusts: 3,
};

/** Farcaster sort (UNCHANGED semantics): trust actionability → displayName.
 *  scan.ts's sortFriends delegates here so its behavior is identical. */
export function sortFriends(friends: Friend[]): Friend[] {
  return [...friends].sort(
    (a, b) =>
      TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] ||
      a.displayName.localeCompare(b.displayName),
  );
}

/** Generic source sort: trust actionability → weight DESC → displayName.
 *  Used by matchSource for trust2/snapshot. Distinct from sortFriends, which
 *  has no weight tier (Farcaster rows have no weight). */
export function sortMatches(friends: Friend[]): Friend[] {
  return [...friends].sort(
    (a, b) =>
      TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] ||
      (b.weight ?? 0) - (a.weight ?? 0) ||
      a.displayName.localeCompare(b.displayName),
  );
}
```

In `lib/scan.ts`: **delete** the local `TRUST_ORDER` const (lines 92-97) and the local `sortFriends` body (99-105); replace with a re-export so existing imports (`@/lib/scan` → `sortFriends`) keep working:
```ts
import { sortFriends } from "@/lib/sources/sort";
export { sortFriends };
```
(Internal `scan.ts` call sites at lines 381, 598 keep calling `sortFriends` unchanged.)

`lib/sources/match.ts` (NEW) — public signatures:
```ts
import type { Friend } from "@/lib/types";
import type { SourceResult } from "@/lib/sources/types";

/** Generic orchestrator: candidate addresses → Friend[] via the Circles spine.
 *  Cache-only robustness — no fid, no streaming hydration, no failure ledger. */
export async function matchSource(
  result: SourceResult,
  connectedAvatar: string | null, // for the trust map; usually == the seed (lowercased)
  signal?: AbortSignal,
): Promise<Friend[]>;
```
`sortMatches` is re-exported from `match.ts` for convenience (`export { sortMatches } from "@/lib/sources/sort";`) so consumers import sort + match from one place, but its definition lives in `sort.ts`.

`matchSource` body (spec lines 186-200, bound to real spine signatures):
1. Partition `result.candidates` into `preVerified` (skip registry) and `toCheck`.
2. `const { avatars } = await findCirclesAvatars(toCheck.map(c => c.address.toLowerCase()));` — note `findCirclesAvatars` returns `AvatarLookup` (`{ avatars, failedAddresses }`); the matcher uses only `avatars` and **ignores `failedAddresses`** (cache-only: no retry ledger).
3. Keep candidates whose address is `preVerified` OR present in `avatars`. Build `matched: Candidate[]`, deduped by lowercased address (first wins).
4. `const profiles = await getCirclesProfiles(matched.map(c => c.address));`
5. `const trustMap = connectedAvatar ? await getTrustMap(connectedAvatar) : new Map();` wrapped in try/catch → empty Map on failure (degrade, never throw).
6. Build `Friend` rows (mirroring `buildFriends` field derivation exactly):
   ```ts
   const info = avatars.get(c.address);       // undefined for preVerified-only rows
   const profile = profiles.get(c.address);
   const circlesName = profile?.name ?? info?.name ?? null;
   {
     address: c.address,
     displayName: circlesName ?? shortenAddress(c.address),
     source: result.sourceId,
     evidence: c.evidence,
     weight: c.weight,
     circlesName,
     circlesImageUrl: profile?.previewImageUrl ?? profile?.imageUrl ?? null,
     kind: info ? avatarKind(info) : "human",
     trust: trustMap.get(c.address) ?? "none",
   } satisfies Friend
   ```
   (No `fid`/`username`/`fcRelation`/`hydrated`/`viaDeepScan` — all optional now.)
7. `return sortMatches(rows);`

Imports for `match.ts`: `findCirclesAvatars, getCirclesProfiles, getTrustMap, avatarKind` from `@/lib/circles`; `shortenAddress` from `@/lib/util`; `sortMatches` from `@/lib/sources/sort`.

### 2d. Props interfaces

`components/MatchList.tsx` (NEW) — the shared chrome (headline, trust-state filter bar, FriendRow list, empty state). It is **source-agnostic** and Farcaster-feature-free:
```ts
export type MatchListProps = {
  friends: Friend[];
  /** True while the trust circle is still loading — disables trust filters, shows "?" counts. */
  trustLoaded: boolean;
  canAct: boolean;
  lockReason: string;
  busyAddress: string | null;
  onToggle: (friend: Friend, trusted: boolean) => void;
  /** Rendered when friends.length === 0 (source-specific copy from the wrapper). */
  emptyState: React.ReactNode;
};
```
Owns: the `FILTERS` const + `filter` state + `counts` memo + the trust-state filter bar (extracted from Results.tsx:519-541), the `<ol>` of `<FriendRow>` (Results.tsx:548-561), and the "Nobody in this slice" sub-empty (543-546). When `friends.length === 0`, render `emptyState`. It does **NOT** own: the headline, meta row, StatusBlock, deep-scan, followers-scan, direction filter, "scan details".

`components/SourceResults.tsx` (NEW) — generic wrapper for trust2 (and later snapshot):
```ts
export type SourceResultsProps = {
  source: DiscoverySource;        // for label / evidenceNoun in copy
  friends: Friend[];
  stats: Record<string, number>;  // SourceResult.stats — meta row counters
  truncated: boolean;
  loading: boolean;               // discover+match in flight
  error: string | null;          // source-fetch-failed copy
  trustLoaded: boolean;
  fromCache: boolean;
  completedAt: number | null;     // for "from your scan N min ago"
  canAct: boolean;
  lockReason: string;
  busyAddress: string | null;
  /** Degenerate-state discriminator for empty copy (see §4). */
  emptyKind: "not-connected" | "not-avatar" | "no-first-degree" | "no-matches" | null;
  onToggle: (friend: Friend, trusted: boolean) => void;
  onRescan: () => void;           // ↻ rescan affordance
};
```
Owns: stats meta row (`{contacts} contacts · {candidates} candidates`, plus the `fromCache` "from your scan N min ago · ↻ rescan" affordance — reuse the `minutesAgo` helper, extracted to a shared spot, see §6), the source-specific empty states, a loading skeleton, and renders `<MatchList … emptyState={…} />`.

`components/SourceTabs.tsx` (NEW):
```ts
export type SourceTabsProps = {
  active: SourceId;
  onSelect: (id: SourceId) => void;
  /** The tabs to render, in order. Default registry order; Farcaster always present. */
  tabs: { id: SourceId; label: string }[];
  /** trust2 disabled (greyed, not hidden) when not a Circles avatar — shows a tooltip. */
  disabled?: Partial<Record<SourceId, string>>; // id -> reason tooltip
};
```
Renders a horizontal pill/tab bar. **Insertion point for "Shared DAOs":** the `tabs` array is passed in from `App.tsx` (built from the registry, §6); to add Snapshot later you append `{ id: "snapshot", label: "Shared DAOs" }` — no change to `SourceTabs` itself. Document this with a code comment.

### 2e. `lib/sources/farcasterRow.ts` mapper

```ts
import type { ScanResult } from "@/lib/scan";
import type { Friend } from "@/lib/types";

/** Adapt a Farcaster ScanResult's friends to the shared Friend shape by
 *  stamping source:"farcaster" + evidence from fcRelation. Pure, no I/O.
 *  Farcaster fields (fid/username/pfpUrl/hydrated/viaDeepScan) pass through. */
export function farcasterRowsFromScan(result: ScanResult): Friend[];
```
Implementation: `return result.friends.map(f => ({ ...f, source: "farcaster", evidence: f.evidence ?? evidenceForRelation(f.fcRelation) }));` where `evidenceForRelation` maps `mutualFollow → "You follow each other on Farcaster"`, etc. **Note:** Because the Farcaster tab in this MVP renders through the existing `Results.tsx` (not `SourceResults`), `farcasterRow.ts` is used **only** where Farcaster rows would flow into a generic `MatchList` context — for MVP it is exercised by `match.test.ts`-adjacent unit coverage and is the documented seam for the future unified path. It does **not** alter the live Farcaster render (which keeps reading `friend.fcRelation` directly). Keeping it now satisfies the "no rework later" requirement and the spec's File Reference Table.

### 2f. Source cache in `lib/cache.ts`

Mirror the existing DTO/TTL/version pattern. `Friend[]` is already plain JSON (no Sets/Maps inside a Friend), so the DTO is trivial — but version + TTL + `(sourceId, seed)` keying are mandatory.

```ts
// --- Source cache (trust2/snapshot). Separate version line from the scan cache. ---
const SOURCE_CACHE_VERSION = 1;
const SOURCE_TTL_MS = 30 * 60 * 1000; // 30 min, mirrors the scan cache
const sourceKeyFor = (sourceId: SourceId, seed: string) =>
  `common-circles:source:v${SOURCE_CACHE_VERSION}:${sourceId}:${seed.toLowerCase()}`;

export type SourceCacheDTO = {
  version: number;
  completedAt: number;
  sourceId: SourceId;
  seed: string;          // lowercased
  friends: Friend[];     // plain objects; trust dropped-on-read like scan cache? NO — kept.
  stats: Record<string, number>;
  truncated: boolean;
};

export type SourceCacheEntry = {
  friends: Friend[];
  stats: Record<string, number>;
  truncated: boolean;
  completedAt: number;
};

/** Read a cached source result for (sourceId, seed). Null on miss/version/TTL/error. */
export function readSourceCache(sourceId: SourceId, seed: string): SourceCacheEntry | null;

/** Persist a source result. Swallows quota/private-mode failures. */
export function writeSourceCache(
  sourceId: SourceId,
  seed: string,
  friends: Friend[],
  stats: Record<string, number>,
  truncated: boolean,
): void;

/** Evict a cached source result for (sourceId, seed). */
export function clearSourceCache(sourceId: SourceId, seed: string): void;
```

**Trust-in-cache decision (important, deviates slightly from scan cache):** the scan cache *drops* trustMap and re-fetches because trust is a separate per-wallet RPC. For the source cache, `trust` lives **inside each Friend** and `matchSource` already fetched it via `getTrustMap`. The simplest correct behavior is to **persist `friend.trust` as-is** and let App.tsx's trust effect (§4) refresh it on adopt (same as the Farcaster path's E11 effect does). So the DTO keeps `friend.trust` verbatim; on read, App re-runs `getTrustMap(seed)` and patches rows — identical pattern to the existing E11 flow. This keeps the cache pure JSON with no Map surgery. Add a one-line comment explaining this divergence.

Add `import type { SourceId } from "@/lib/sources/types";` and `import type { Friend } from "@/lib/types";` to `cache.ts`. The existing scan-cache exports/keys are **untouched** (`CACHE_VERSION`, `keyFor`, `readCache`, etc. stay exactly as-is).

---

## 3. `trust2` algorithm — `lib/sources/trust2.ts` (NEW)

Constants live at the top of `trust2.ts`:
```ts
/** Cap first-degree contacts we fan out from, to bound RPC. Mutuals chosen first. */
export const TRUST2_CONTACT_CAP = 150;
/** Bounded concurrency for the per-contact getTrustMap fan-out. */
const TRUST2_FANOUT = 8;
```

Concrete pseudocode bound to the real `getTrustMap` return type `Map<string, "trusts"|"trustedBy"|"mutuallyTrusts">` (keys already lowercased by `getTrustMap`):

```ts
import { getTrustMap } from "@/lib/circles";
import { mapLimit } from "@/lib/util";
import type { DiscoverySource, SourceResult, Candidate } from "@/lib/sources/types";

export const trust2Source: DiscoverySource = {
  id: "trust2",
  label: "Friends of friends",
  evidenceNoun: "trusted contacts",
  needsHandle: false,
  async discover(seed, signal): Promise<SourceResult> {
    const self = seed.toLowerCase();

    // 1. first-degree circle (relation keyed by lowercase counterparty)
    const first = await getTrustMap(self);            // Map<addr, relation>

    // 2. contacts I trust OUTWARD (vouchers): relation ∈ {trusts, mutuallyTrusts}
    //    "trustedBy" = they trust me, not a voucher → excluded.
    //    Mutuals first (strongest), then plain "trusts", then cap.
    const mutuals = [...first].filter(([, r]) => r === "mutuallyTrusts").map(([a]) => a);
    const outward = [...first].filter(([, r]) => r === "trusts").map(([a]) => a);
    const contacts = [...mutuals, ...outward].slice(0, TRUST2_CONTACT_CAP);
    const truncated = mutuals.length + outward.length > TRUST2_CONTACT_CAP;

    // 3. fan out: each contact's outward trusts. Bounded concurrency 8.
    const firstDegree = new Set(first.keys());        // for step-4 exclusion
    const perContact = await mapLimit(contacts, TRUST2_FANOUT, async (contact) => {
      if (signal?.aborted) return [] as string[];
      try {
        const m = await getTrustMap(contact);
        return [...m]
          .filter(([, r]) => r === "trusts" || r === "mutuallyTrusts")
          .map(([a]) => a);                            // people my contact trusts outward
      } catch {
        return [] as string[];                         // degrade per contact, never throw
      }
    });

    // 4. tally per candidate, excluding seed + everyone already first-degree
    const tally = new Map<string, number>();
    for (const list of perContact) {
      for (const addr of list) {
        if (addr === self || firstDegree.has(addr)) continue;
        tally.set(addr, (tally.get(addr) ?? 0) + 1);
      }
    }

    // 5. candidates — NOT preVerified (edges can point to groups/orgs; the
    //    matcher's findCirclesAvatars filters to v2 humans).
    const candidates: Candidate[] = [...tally].map(([address, count]) => ({
      address,
      weight: count,
      evidence: `Trusted by ${count} of your contacts`,
      preVerified: false,
    }));

    // 6. stats
    return {
      sourceId: "trust2",
      candidates,
      stats: { contacts: contacts.length, candidates: tally.size },
      truncated,
    };
  },
};
```

Notes for implementers:
- The fan-out issues up to 150 `getTrustMap` calls. Each is one RPC (`getAggregatedTrustRelations`). `mapLimit(contacts, 8, …)` caps concurrency at 8 — matches the spec.
- Seed exclusion uses the **lowercased** `self` (the wallet address is NOT lowercased upstream — verified in `wallet.tsx`). `firstDegree` keys are already lowercase (from `getTrustMap`), and candidate addresses are already lowercase. So all comparisons are lowercase-consistent.
- Evidence string is the exact UI label ("Trusted by N of your contacts").
- `discover` never throws on per-contact failures; a total failure of the *first* `getTrustMap(self)` call propagates and is caught in App.tsx (→ source-fetch-failed empty state).

---

## 4. `App.tsx` load state machine

### Derived load states (computed, not all stored)

Inputs: `isConnected`, `identity` (`{ registered, name } | null` from `getMyCirclesIdentity`), and per-tab discovery state.

| State | Condition | Default tab | trust2 behavior |
|---|---|---|---|
| **not-connected** | `!isConnected` (no `address`) | `farcaster` | trust2 tab shows "Connect a Circles account…"; no auto-run |
| **connected-not-avatar** | `isConnected && identity?.registered === false` | `farcaster` | trust2 tab shows "Your connected wallet isn't a registered Circles avatar"; no auto-run |
| **connected-avatar-no-trust** | registered, trust2 discover ran, `stats.contacts === 0` | `trust2` | auto-ran; empty + "You don't trust anyone yet — scan Farcaster to find people to trust first" |
| **connected-avatar-with-trust** | registered, trust2 discover ran, candidates ≥ 0 | `trust2` | auto-ran; renders matches (or "no friends-of-friends found" if matches empty) |

Default-tab rule (spec UI changes): when `isConnected && identity?.registered`, default `activeSource = "trust2"` and auto-`discover`; otherwise default `activeSource = "farcaster"`.

### New state variables in `App.tsx`

```ts
const [activeSource, setActiveSource] = useState<SourceId>("farcaster"); // promoted to trust2 by effect
// trust2 (and future snapshot) discovery state, keyed by source:
const [sourceFriends, setSourceFriends] = useState<Friend[]>([]);
const [sourceStats, setSourceStats] = useState<Record<string, number>>({});
const [sourceTruncated, setSourceTruncated] = useState(false);
const [sourceLoading, setSourceLoading] = useState(false);
const [sourceError, setSourceError] = useState<string | null>(null);
const [sourceFromCache, setSourceFromCache] = useState(false);
const [sourceCompletedAt, setSourceCompletedAt] = useState<number | null>(null);
const sourceRunId = useRef(0);   // invalidate stale trust2 discover runs (mirrors scanId ref)
```
(Because MVP has a single non-Farcaster source, flat state is acceptable; a comment notes that adding Snapshot means keying these by `SourceId` — e.g. `Record<SourceId, SourceState>` — the documented follow-up.)

### Effects / handlers to add

1. **Default-tab promotion effect** (deps `[isConnected, identity?.registered]`): when connected + registered and `activeSource` is still the initial `"farcaster"` *and* the user has not manually selected a tab, set `activeSource = "trust2"`. Track a `userPickedTab` ref so we never override an explicit selection. If connection drops or identity becomes not-registered while on `trust2`, leave the tab but render the degenerate empty state.

2. **trust2 auto-run effect** (deps `[activeSource, address, identity?.registered]`): when `activeSource === "trust2" && address && identity?.registered`, run `runSource("trust2", address)` **cache-first**:
   ```ts
   const seed = address.toLowerCase();
   const cached = readSourceCache("trust2", seed);
   if (cached) { adopt cached → sourceFriends/stats/...; sourceFromCache = true; }
   else { setSourceLoading(true); const res = await getSource("trust2").discover(seed, signal);
          const friends = await matchSource(res, seed, signal);
          setSourceFriends(friends); setSourceStats(res.stats); setSourceTruncated(!!res.truncated);
          setSourceCompletedAt(Date.now()); setSourceFromCache(false);
          writeSourceCache("trust2", seed, friends, res.stats, !!res.truncated); }
   ```
   Guard every state set with `sourceRunId.current === id` (mirror the Farcaster `scanId.current === id` pattern). Catch → `setSourceError("Couldn't load friends of friends — try again.")`.

3. **Source trust-refresh** (cache-first parity with E11): after adopting a cached source result, re-run `getTrustMap(seed)` and patch `sourceFriends` trust (same shape as the existing E11 effect at App.tsx:139-180, but writing `sourceFriends` instead of `friends`). For a fresh run, `matchSource` already set trust, so no second fetch is needed — only the cached-adopt path needs the refresh. Keep it simple: a small effect keyed on `(activeSource, address, sourceCompletedAt)` that patches trust when `sourceFromCache`.

4. **`handleSourceRescan`**: `clearSourceCache("trust2", seed)` then re-run the discover (sets `sourceFromCache=false`). Wired to `SourceResults.onRescan`.

5. **trust toggle reuse**: `handleToggle` is **shared** — it already takes a `Friend` and calls `setTrust`. It must also patch `sourceFriends` (not just `friends`). Change `handleToggle` to patch **both** lists by address (the row exists in only one, so patching both is safe and idempotent). Also keep updating `trustMap.current`.

### Farcaster path that MUST stay verbatim

The entire existing scan flow — `handleScan`, `handleRescan` (rename collision: keep the existing `handleRescan` for Farcaster; name the new one `handleSourceRescan`), `runFreshScan`, `handleDeepScan`, `handleScanFollowers`, `handleRetry`, `handleRetryTrust`, `phase`/`scanUser`/`progress`/`result`/`friends`/`deep`/`followersScan`/`retry`/`fromCache`, the `scanId`/`controller`/`trustMap`/`trustWallet`/`friendsRef` refs, the E11 effect, `patchHydration`, `adoptResult` — **unchanged**. The Farcaster tab continues to render `Hero` (phase idle) / `ScanProgress` (scanning) / `Results` (results) exactly as today. The only structural change: these three render blocks are now gated behind `activeSource === "farcaster"`, and a `<SourceTabs>` bar plus a `trust2` render branch (`<SourceResults>`) are added above `<main>`'s content.

### Render structure (new)

```
<Header />
<SourceTabs active={activeSource} onSelect={…} tabs={tabsFromRegistry} disabled={trust2DisabledReason} />
<main>
  {activeSource === "farcaster" && (<>{phase idle→Hero / scanning→ScanProgress / results→Results}</>)}
  {activeSource === "trust2" && (
    <SourceResults source={getSource("trust2")} friends={sourceFriends} stats={sourceStats}
      truncated={sourceTruncated} loading={sourceLoading} error={sourceError}
      trustLoaded={…} fromCache={sourceFromCache} completedAt={sourceCompletedAt}
      canAct={canAct} lockReason={lockReason} busyAddress={busyAddress}
      emptyKind={deriveEmptyKind()} onToggle={handleToggle} onRescan={handleSourceRescan} />
  )}
</main>
```

`tabsFromRegistry` = `[{id:"trust2",label:"Friends of friends"},{id:"farcaster",label:"Farcaster"}]` (trust2 first = default position; Snapshot appended later). `disabled` carries `{ trust2: "Connect a Circles account" }` when not connected/registered (tab visible but greyed; clicking shows the degenerate empty state rather than auto-running).

---

## 5. File-ownership partition for parallel execution

Goal: zero same-file overlap **within a wave**. Three waves; Wave 2 has two fully-disjoint agents.

### Wave 1 — Contract (serial; everything downstream imports these)

**Agent W1** owns (creates/modifies):
- `lib/sources/types.ts` (NEW)
- `lib/sources/sort.ts` (NEW)
- `lib/types.ts` (MODIFY — generalize `Friend`, add `SourceId` import)
- `lib/scan.ts` (MODIFY — delete local `TRUST_ORDER`/`sortFriends`, import+re-export from `sort.ts`)

May READ but NOT edit: everything else.

Rationale for putting the `scan.ts` edit here (not Wave 3): the sort extraction is a *contract* change (it changes where `TRUST_ORDER`/`sortFriends` live) and `match.ts` (Wave 2) depends on `sort.ts` existing. The `scan.ts` edit is mechanical (3 lines) and must be done by exactly one agent. **Verification gate before Wave 2:** `pnpm typecheck && pnpm test` must be green (31 passing) — confirming the sort extraction didn't perturb Farcaster ordering (reducer/sweep/hydrate tests assert order).

### Wave 2 — Parallel (two disjoint agents)

**Agent W2a — sources logic + tests** owns:
- `lib/sources/match.ts` (NEW)
- `lib/sources/trust2.ts` (NEW)
- `lib/sources/registry.ts` (NEW)
- `lib/sources/farcasterRow.ts` (NEW)
- `lib/cache.ts` (MODIFY — add `read/write/clearSourceCache` + DTO; scan-cache section untouched)
- `test/sources/trust2.test.ts` (NEW)
- `test/sources/match.test.ts` (NEW)
- `test/cache.test.ts` (MODIFY — append source-cache describe blocks)

May READ but NOT edit: `lib/circles.ts`, `lib/util.ts`, `lib/types.ts`, `lib/sources/types.ts`, `lib/sources/sort.ts`, `lib/scan.ts` (for `ScanResult` type only).

**Agent W2b — UI shared components** owns:
- `components/MatchList.tsx` (NEW)
- `components/SourceResults.tsx` (NEW)
- `components/SourceTabs.tsx` (NEW)
- `components/Results.tsx` (MODIFY — extract shared chrome into `<MatchList>`, keep Farcaster wrapper)
- `components/FriendRow.tsx` (MODIFY — crash guards + source branching + (future-ready) POAP badge slot)
- `components/Hero.tsx` (MODIFY — scope headline/copy to the Farcaster tab)

May READ but NOT edit: `lib/types.ts`, `lib/sources/types.ts`, `lib/sources/sort.ts`, `components/TrustGlyph.tsx`, `components/ScanProgress.tsx`.

**Disjointness check between W2a and W2b:** no shared file. The only coupling is *type* imports (`Friend`, `SourceId`, `DiscoverySource`, `SourceResult`) — all owned by W1 and read-only for both. `MatchList`/`SourceResults`/`SourceTabs` do not import `match.ts`/`registry.ts` at the type level they need (they take `friends`/`stats`/`source` as props), so W2b can compile against W1's contracts without W2a's runtime. **`Hero.tsx` ownership flag:** only W2b touches it (App wiring is Wave 3) — no overlap.

### Wave 3 — Integration (serial)

**Agent W3 — App + wiring** owns:
- `components/App.tsx` (MODIFY — `activeSource` state machine, tab bar mount, trust2 auto-run + cache wiring, shared `handleToggle` patching both lists, render-branch gating, `handleSourceRescan`)

May READ but NOT edit: all Wave 1/2 outputs (`SourceTabs`, `SourceResults`, `MatchList`, `Results`, `registry`, `match`, `trust2`, `cache`, `sort`).

### Files two concerns might want — explicitly resolved

- **`lib/scan.ts`**: wanted by the sort-extraction (W1) and *not* by anyone else (matcher imports `sort.ts`, not `scan.ts`, for sorting; `farcasterRow.ts` imports only the `ScanResult` *type*). → **W1 owns**; W2a/W3 read the type only.
- **`lib/cache.ts`**: only W2a edits it (additive source-cache section). App (W3) only *calls* the new exports. → **W2a owns**.
- **`components/Results.tsx`**: only W2b edits it (extraction). App (W3) imports `Results`/`DeepState`/`RetryState` from it but does not edit it. → **W2b owns**. W2b must **keep the existing `Results` prop interface and `DeepState`/`RetryState` exports unchanged** so App's `<Results …/>` call site (App.tsx:594-629) needs zero changes — this is the contract between W2b and W3.
- **`components/FriendRow.tsx`**: only W2b edits it. `Results` and (future) `MatchList` both render it. → **W2b owns**.
- **`lib/types.ts`**: only W1 edits it. → **W1 owns**; everyone else reads.
- **Test files**: `test/cache.test.ts` → **W2a** (append-only, must not alter the existing 5 describe blocks). `test/sources/*.test.ts` → **W2a** (new). No UI tests are added (no component test harness exists). `test/provider.test.ts`, `reducer.test.ts`, `sweep.test.ts`, `hydrate.test.ts`, `pacing.test.ts`, `routes.test.ts` → **nobody edits** (frozen).

---

## 6. Per-file change list

**`lib/sources/types.ts`** (NEW) — §2a verbatim.

**`lib/sources/sort.ts`** (NEW) — §2c verbatim (`TRUST_ORDER`, `sortFriends`, `sortMatches`).

**`lib/types.ts`** (MODIFY) — replace the `Friend` type (current lines 56-77) with §2b. Add `import type { SourceId } from "@/lib/sources/types";` at top. Leave `FarcasterUser`, `FcRelation`, `TrustState`, `CirclesAvatarKind`, `ScanFailures`, `ConnectionsResponse`, etc. unchanged.

**`lib/scan.ts`** (MODIFY) — delete local `TRUST_ORDER` (lines 92-97) and the body of `sortFriends` (99-105); add `import { sortFriends } from "@/lib/sources/sort";` and `export { sortFriends };` near the other exports. Internal call sites (381, 598) unchanged. Nothing else in this file changes.

**`lib/sources/match.ts`** (NEW) — §2c: `matchSource` (steps 1-7 bound to `findCirclesAvatars`→`AvatarLookup`, `getCirclesProfiles`→`Map<string,Profile>`, `getTrustMap`→`Map<string,relation>`), `export { sortMatches } from "@/lib/sources/sort"`.

**`lib/sources/trust2.ts`** (NEW) — §3 verbatim (`TRUST2_CONTACT_CAP=150`, `TRUST2_FANOUT=8`, `trust2Source: DiscoverySource`).

**`lib/sources/registry.ts`** (NEW):
```ts
import type { DiscoverySource, SourceId } from "@/lib/sources/types";
import { trust2Source } from "@/lib/sources/trust2";
// Farcaster is NOT a DiscoverySource (adapted at the row boundary). It appears
// in the tab list (App) but not here.
// INSERTION POINT: when Snapshot lands, add `snapshot: snapshotSource`.
export const SOURCES: Partial<Record<SourceId, DiscoverySource>> = {
  trust2: trust2Source,
};
export function getSource(id: SourceId): DiscoverySource {
  const s = SOURCES[id];
  if (!s) throw new Error(`No DiscoverySource registered for "${id}"`);
  return s;
}
```
(`Partial<Record…>` because `farcaster` and `snapshot` are absent in MVP.)

**`lib/sources/farcasterRow.ts`** (NEW) — §2e: `farcasterRowsFromScan(result)` + `evidenceForRelation(rel)` helper.

**`lib/cache.ts`** (MODIFY) — append the source-cache block (§2f): `SOURCE_CACHE_VERSION`, `SOURCE_TTL_MS`, `sourceKeyFor`, `SourceCacheDTO`, `SourceCacheEntry`, `readSourceCache`, `writeSourceCache`, `clearSourceCache`, plus the two new type imports. Reuse the existing `hasSessionStorage()` guard. The scan-cache section (lines 1-141) is untouched.

**`components/MatchList.tsx`** (NEW) — §2d. Extract from `Results.tsx`: the `FILTERS` const (current Results.tsx:12-18), `filter` state, `counts` memo (334-344, but computed over **all** `friends` since MatchList has no direction filter), the trust-state filter bar JSX (519-541), the `<ol>` of `FriendRow` (548-561), and the "Nobody in this slice" sub-empty (543-546). Render `props.emptyState` when `friends.length === 0`. Keep the `trustLoaded`-gated "?" counts and disabled filters (527, 537). No StatusBlock/deep/followers/direction.

**`components/SourceResults.tsx`** (NEW) — §2d. Headline + stats meta row (`{contacts} contacts · {candidates} candidates`, with the `fromCache` "from your scan {minutesAgo} · ↻ rescan" affordance — extract `minutesAgo` from Results.tsx:53-58 into a shared `lib/util.ts`? **No** — to avoid W2a/W2b both editing `util.ts`, copy the 5-line `minutesAgo` helper locally into `SourceResults.tsx`; it's trivial and avoids a cross-agent file conflict). Source-specific empty states driven by `emptyKind`:
  - `not-connected` → "Connect a Circles account to see friends of friends."
  - `not-avatar` → "Your connected wallet isn't a registered Circles avatar yet."
  - `no-first-degree` → "You don't trust anyone yet — scan Farcaster to find people to trust first."
  - `no-matches` → "No friends-of-friends found among your contacts' circles."
  - loading → skeleton; error → the `error` string + a retry affordance (calls `onRescan`).
  Then `<MatchList friends={friends} trustLoaded={trustLoaded} canAct={canAct} lockReason={lockReason} busyAddress={busyAddress} onToggle={onToggle} emptyState={<the emptyKind copy/>} />`.

**`components/SourceTabs.tsx`** (NEW) — §2d. Pill/tab bar styled to match the existing filter pills (reuse the `border-ink bg-ink text-cream` / `border-line text-ink-faint` active/inactive pattern from Results.tsx:507-511). Disabled tabs render greyed with a `title` tooltip from `props.disabled[id]`. Comment marking the "Shared DAOs" insertion point (append to the `tabs` array in App).

**`components/Results.tsx`** (MODIFY) — becomes the **Farcaster wrapper**. Keep its full ~30-prop interface and `DeepState`/`RetryState` exports **unchanged** (App's call site must not change). Replace the inlined filter bar + `<ol>` (lines ~519-562) with `<MatchList friends={byDirection} trustLoaded={trustLoaded} canAct={canAct} lockReason={lockReason} busyAddress={busyAddress} onToggle={onToggle} emptyState={…the existing Farcaster empty copy…} />`. **Keep** in Results: headline (365-389), meta row (391-445), `StatusBlock` (449-458 + the component def 61-160), the direction filter bar (499-517) — direction filtering happens in Results, which passes the already-direction-filtered `byDirection` into MatchList — `FollowersCard` (both placements), deep-scan card (587-655), "scan details" (670-684), read-only notice (471-494). **Subtlety:** MatchList owns the trust-state filter, so Results must pass `byDirection` (post direction filter, pre trust filter) and let MatchList apply the trust filter. The `counts`/`dirCounts` split: `dirCounts` stays in Results (drives the direction bar); the trust `counts` move into MatchList. Net: Farcaster render is visually identical.

**`components/FriendRow.tsx`** (MODIFY) — branch on `friend.source` (treating `undefined` as `"farcaster"`):
  - `const isFarcaster = (friend.source ?? "farcaster") === "farcaster";`
  - **Avatar initial (line 71 crash):** replace `friend.username.slice(0,1)` with `(friend.circlesName ?? friend.displayName).slice(0,1).toUpperCase()` (already the value `initial` computed at line 34 — reuse it; never read `friend.username` for the initial).
  - **`AvatarPair` hydration gate (line 37):** non-Farcaster rows have no `hydrated` flag (undefined → falsy). Guard: treat `friend.hydrated ?? true` so onchain rows render the resolved (non-skeleton) avatar immediately. Use the Circles-image-or-initial branch for them (they have no `pfpUrl`).
  - **Secondary line / relation glyph (lines 158, 169-171 crash):** render the `@username` link + `RELATION_GLYPH[friend.fcRelation]` **only when `isFarcaster && friend.fcRelation` is defined**. For non-Farcaster rows, render `friend.evidence` as the secondary line instead (a muted text span). Guard `RELATION_GLYPH[friend.fcRelation]` with `friend.fcRelation ? RELATION_GLYPH[friend.fcRelation] : null`.
  - **Name line (line 145-174):** for non-Farcaster rows there is no hydration skeleton path — render `friend.displayName` directly + the evidence line. The `circlesName`/address/kind sub-line (175-201) is shared and unchanged (it already reads only universal fields).
  - **POAP badge slot (future-ready, no logic):** after the name line, add `{friend.poapShared?.length ? <PoapBadge shared={friend.poapShared} /> : null}` — but since POAP is out of scope, render nothing / a minimal placeholder span guarded by the (always-undefined in MVP) `poapShared`. Document that the badge content lands with the POAP follow-up. This is a 1-line guard that never fires in MVP, satisfying "no rework later."
  - Trust button + address link + `TrustBadge` (204-234) unchanged for all sources.

**`components/Hero.tsx`** (MODIFY) — minimal: the headline/copy ("Two networks, same people." / "Sweep everyone you follow on Farcaster…") is now the **Farcaster-tab** hero. Add a one-line note (when applicable, passed as a prop or rendered conditionally) that friends-of-friends lives on the other tab; or leave copy as-is and only adjust if W2b deems it misleading. Keep `onScan`/`error`/`suggestion` props and the form behavior unchanged. The smallest safe change: no functional change, optional copy tweak — flag this as low-risk and non-blocking.

**`components/App.tsx`** (MODIFY) — §4: add the new state vars + refs, the default-tab promotion effect, the trust2 auto-run/cache-first effect, the source trust-refresh effect, `handleSourceRescan`, extend `handleToggle` to patch `sourceFriends` too, mount `<SourceTabs>`, gate the existing render blocks behind `activeSource === "farcaster"`, add the `activeSource === "trust2"` → `<SourceResults>` branch. Import `getSource` from `@/lib/sources/registry`, `matchSource` from `@/lib/sources/match`, `readSourceCache`/`writeSourceCache`/`clearSourceCache` from `@/lib/cache`, `SourceId` from `@/lib/sources/types`. The existing Farcaster handlers/refs/effects stay verbatim.

---

## 7. Test plan

Mocking style (from `test/sweep.test.ts`): mock `@/lib/circles` via `vi.mock("@/lib/circles", async (importOriginal) => ({ ...actual, getTrustMap, findCirclesAvatars, getCirclesProfiles }))` with `vi.hoisted` mock fns; build minimal `AvatarInfo` with the `as unknown as AvatarInfo` cast helper (sweep.test.ts:51-59). No real SDK/`window`.

### `test/sources/trust2.test.ts` (NEW, ≥4 cases) — mock `getTrustMap` only

1. **Tally**: seed's first-degree `{A:"trusts", B:"mutuallyTrusts"}`; `getTrustMap(A)` → `{X:"trusts", Y:"trusts"}`, `getTrustMap(B)` → `{X:"mutuallyTrusts", Z:"trusts"}`. Assert candidates `X:2, Y:1, Z:1`; evidence string `"Trusted by 2 of your contacts"` for X; `stats.contacts===2`, `stats.candidates===3`.
2. **First-degree + seed exclusion**: a contact trusts the seed itself and an already-first-degree address; assert both excluded from candidates. (Also assert `"trustedBy"`-only first-degree relations are NOT treated as contacts in step 2.)
3. **Cap + mutuals-first**: build first-degree with 200 outward edges (e.g. 60 mutuals + 140 plain trusts); set `TRUST2_CONTACT_CAP` reached → assert exactly 150 contacts fanned out, all 60 mutuals included before any plain-trust contact, `truncated===true`. (Verify via counting `getTrustMap` mock calls and which addresses they were called with.)
4. **Ranking / weight**: assert returned candidates carry `weight===count`; (sort is applied by the matcher, not the source, so trust2 asserts weights, not order). Add a per-contact-failure case: one `getTrustMap` rejects → its contributions are absent but the others tally fine (degrade, no throw).

### `test/sources/match.test.ts` (NEW, ≥4 cases) — mock `findCirclesAvatars`, `getCirclesProfiles`, `getTrustMap`

1. **preVerified skip**: a candidate with `preVerified:true` is kept WITHOUT appearing in the `findCirclesAvatars` call args; a `preVerified:false` candidate is passed to `findCirclesAvatars`. (Note: trust2 never sets preVerified, but the matcher must support it for future sources — assert the partition.)
2. **Human filter via findCirclesAvatars**: two non-preVerified candidates; mock returns only one in `avatars`; assert the unmatched one is dropped (group/org filtered).
3. **Sort order (`sortMatches`)**: rows with mixed `trust` + `weight`; assert order = `TRUST_ORDER[trust]` asc → `weight` desc → `displayName`. Include a `trustedBy`-low-weight vs `none`-high-weight pair to prove trust tier beats weight.
4. **Dedupe by address**: two candidates with the same lowercased address (differing case) collapse to one Friend; assert single row. Also assert `failedAddresses` from `findCirclesAvatars` is ignored (no throw, no ledger).
5. (bonus) **Friend field derivation**: assert `displayName === circlesName ?? shortenAddress(address)`, `source === "trust2"`, `evidence` passed through, `kind` from `avatarKind`, `trust` from `getTrustMap`, and a `getTrustMap` rejection → all rows `trust:"none"` (degrade).

### `test/cache.test.ts` (MODIFY — append, don't alter existing) — reuse the `MemoryStorage` stub already in the file

1. **`(sourceId, seed)` round-trip**: `writeSourceCache("trust2","0xSEED",friends,stats,false)`; `readSourceCache("trust2","0xseed")` (different case) returns the entry (seed lowercased in key); assert `friends`/`stats`/`truncated`/`completedAt` survive, `friend.trust` preserved verbatim.
2. **Isolation + TTL + version**: `readSourceCache("trust2","0xother")` → null (key isolation); backdate `completedAt` past `SOURCE_TTL_MS` → null + evicted; craft a stored payload with `version: 999` → null. Also: `readSourceCache("snapshot", seed)` returns null when only a `trust2` entry exists (sourceId isolation). `clearSourceCache` evicts. Direct-storage assertions use a local `sourceKeyFor` mirror: `` `common-circles:source:v1:trust2:${seed.toLowerCase()}` ``.

All new tests live under `test/sources/` (matches `vitest.config.ts` include `test/**/*.test.ts`). Target: +4 (trust2) +5 (match) +3 (cache) ≈ +12 tests; the existing 31 deterministic tests stay green.

---

## 8. Risks & gotchas

1. **`source` cannot be required.** `test/reducer.test.ts:42` and `test/hydrate.test.ts` build `Friend` literals without `source`; making it required breaks typecheck on frozen tests. → **`source?: SourceId` optional**, consumers default `undefined → "farcaster"`. This is the single most important correctness constraint and is baked into §2b/§6.

2. **SDK dynamic-import / `window`.** Both `@aboutcircles/sdk` and `@aboutcircles/miniapp-sdk` touch `window` and must only be imported dynamically inside client code. `trust2.ts`/`match.ts` call `getTrustMap`/`findCirclesAvatars`/`getCirclesProfiles`, which already dynamic-import the SDK internally (`lib/circles.ts:25`). So `trust2.ts`/`match.ts` themselves may `import` from `@/lib/circles` at the top level (no direct SDK import) — **but** they must be reached only from client components (App is `"use client"`). Do NOT import `trust2`/`match`/`registry` from any server route or server component. Tests mock `@/lib/circles`, so they never load the real SDK.

3. **Seed == avatar (Open Question #3, verified).** `useWallet().address` is the host-pushed **Safe** address, and App.tsx already passes it straight to `getTrustMap(address)` (App.tsx:144) — confirming the connected wallet IS the Circles avatar. So `trust2`'s seed = that same `address`, **lowercased** (`address.toLowerCase()`), because `wallet.tsx` does NOT lowercase it and `getTrustMap`'s map keys are lowercase (`r.objectAvatar.toLowerCase()`). **Mismatch risk:** if you forget to lowercase the seed, step-4 seed exclusion (`addr === self`) and the cache key both silently break (the seed would never match its own lowercased first-degree keys). Always lowercase at the `discover` boundary and at every cache call. No EOA/Safe mismatch exists for trust2 (the address is the identity); the EOA/Safe leak is a Farcaster-only and future-POAP concern.

4. **MatchList extraction regressing Farcaster.** The highest-risk integration. Mitigations: (a) `Results.tsx` keeps its exact prop interface + `DeepState`/`RetryState` exports so App's call site is byte-identical; (b) direction filtering stays in `Results` (pass `byDirection` to MatchList) so the dir filter + counts are unaffected; (c) trust-state filter + its `trustLoaded`-gated "?" counts + disabled state move wholesale into MatchList with identical markup; (d) the `key={friend.address}` list and `FriendRow` props are preserved. Verify by eye that the Farcaster results screen renders identically and that `reducer/sweep/hydrate` tests (which assert friend ordering) stay green after the `sort.ts` extraction.

5. **`sort.ts` extraction must not change Farcaster order.** `reducer.test.ts`/`sweep.test.ts` assert resulting friend order from `sortFriends`. Keep `TRUST_ORDER` numbers and the `sortFriends` comparator **byte-identical**; only the module location changes. This is gated by the Wave-1 verification (`pnpm test` green before Wave 2).

6. **Pre-existing 3 `provider.test.ts` failures.** They are an env-stub/module-reset artifact in this sandbox, unrelated to the seam. Implementers must NOT touch `provider.test.ts` and must NOT count them as regressions. "Green" = no *new* failures beyond these 3; the 31 deterministic tests + the ~12 new tests pass.

7. **`Partial<Record<SourceId, …>>` in registry.** `farcaster` and `snapshot` are absent in MVP, so `SOURCES` is partial and `getSource` throws for unregistered ids. App must only call `getSource("trust2")` (never `getSource("farcaster")` — Farcaster uses `runScan`, not the seam). Guard the tab list so selecting Farcaster routes to the scan flow, not `getSource`.

8. **Type-only import cycle** `lib/types.ts ↔ lib/sources/types.ts`. It is `import type` only (no runtime value), which is safe. If an implementer accidentally makes it a value import, the bundler will warn — keep both edges `import type`.

9. **Verification command:** `pnpm typecheck && pnpm test && pnpm build` after each wave (Wave 1 gate especially). Expect: typecheck clean, tests = 31 prior-passing + new source/cache tests passing (3 provider.test failures persist, untouched), build succeeds.

---

### Critical Files for Implementation
- /Users/hellno/dev/misc/circles_garage/miniapps/common-circles/lib/types.ts
- /Users/hellno/dev/misc/circles_garage/miniapps/common-circles/lib/sources/trust2.ts
- /Users/hellno/dev/misc/circles_garage/miniapps/common-circles/lib/sources/match.ts
- /Users/hellno/dev/misc/circles_garage/miniapps/common-circles/components/Results.tsx
- /Users/hellno/dev/misc/circles_garage/miniapps/common-circles/components/App.tsx

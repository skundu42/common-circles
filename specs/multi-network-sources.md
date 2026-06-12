# Multi-Network Discovery Sources — Spec

> Status: FINAL (research + live Alchemy testing complete). Decisions locked:
> all three signals ship together · default tab = friends-of-friends · cache-only
> robustness · POAP ships as a **cross-source co-attendance badge** (Alchemy-only),
> not a discovery tab.

## Problem

**Who:** Circles members using the Common Circles miniapp (and the solo dev).

**Current behavior (verified in code):** the app has exactly one friend-discovery
source — the Farcaster follow graph. `lib/scan.ts:runScan` resolves a typed
handle/ENS/address → fid → follow graph (Snapchain) → verified ETH wallets →
`findCirclesAvatars` → trust UI. A freshly-built reliability layer (`ScanFailures`
ledger, `runRetry`, `lib/cache.ts`, streaming hydration; 34 passing tests) hardens
this one path.

**Why now:** Farcaster is the ceiling on who the app can surface — tens-of-thousands
of engaged DAU, plus a structural match leak (Circles avatars are usually **Safe**
addresses but Farcaster verifies the owner **EOA**, the reason `scan.ts` needs a
deep sweep). Users whose Farcaster circle yields few/zero Circles matches hit an empty
screen and churn. We want denser, **zero-friction** signals where the discovered
identity *is already* an ETH address on Gnosis, so the app is non-empty for embedded
users on day one.

**What it should be:** two new discovery **tabs** plus one cross-source **badge**, all
feeding the existing address-keyed Circles spine and trust flow:
1. **Second-degree Circles trust** (friends-of-friends) — default, auto-running tab.
   Zero key, zero new API.
2. **Snapshot shared voters** — tab. Free public GraphQL, no key.
3. **POAP co-attendance** — a "🎫 co-attended X" **badge + ranking boost** layered on
   rows from *any* source. Alchemy-only (`ALCHEMY_API_KEY`), no POAP key, no subgraph.

**How we'll know it's done:** see Success Criteria.

## Why the POAP design is a badge, not a tab (empirical)

Live tests against Gnosis with a real Alchemy key established:

| Alchemy primitive on Gnosis (chain 100) | Result |
|---|---|
| JSON-RPC (`eth_blockNumber`, `eth_call`) | ✅ works (`gnosis-mainnet.g.alchemy.com/v2/{key}`) |
| `getNFTsForOwner` (an address's NFTs + `raw.tokenUri`) | ✅ works |
| `getContractsForOwner` (an address's collections) | ✅ works, but **3,291 results for one wallet, all airdrop spam**; free tier has **no spam filter** (`isSpam` always false) |
| `getOwnersForNFT` (owners of one contract+tokenId) | ✅ works — but each POAP attendee holds a *different* tokenId, so it returns 1 person; useless for co-attendance |
| **`getOwnersForContract`** (all holders of a collection) | ❌ **errors on Gnosis** for ERC1155, ERC721, and the POAP contract |

Consequences that shaped the design:
- **Shared-NFT-collection co-holding is out** — `getOwnersForContract` is broken on
  Gnosis *and* Gnosis collections are spam-flooded with no free-tier filter. Doubly dead.
- **POAP eventId is cheaply readable without the gated POAP key:** POAP tokenURIs are
  literally `https://api.poap.tech/metadata/{eventId}/{tokenId}` — Alchemy returns the
  URI verbatim, so the eventId parses off the path (confirmed: a wallet's Gnosis POAPs
  returned events `6762`, `5517`, `7426`). No `api.poap.tech` auth, no subgraph.
- **But Alchemy cannot enumerate "other attendees of event X"** (no owners-by-eventId;
  `getOwnersForContract` broken). Finding *new strangers* via shared events would need
  the POAP subgraph (a separate self-serve key + an unconfirmed Gnosis deployment).
- So POAP ships as an **enrichment** over people the working sources already surface:
  read SELF's events + each candidate's events, intersect, badge the overlap. Highest
  signal ("you were at the same event"), zero friction, uses only `ALCHEMY_API_KEY`.
  The standalone subgraph-backed "discover via events" tab is a documented **phase-2**.

## Success Criteria

1. On load, with a connected wallet that is a registered Circles v2 human avatar, the
   **Friends-of-friends** tab auto-runs and renders Circles humans the user does **not**
   already trust at first degree, each labeled "Trusted by N of your contacts", sorted
   by N desc. Trusting a row submits the existing `hubV2.trust` tx via the host Safe.
2. A **source tab bar** shows exactly three tabs: `Friends of friends` (default) ·
   `Farcaster` · `Shared DAOs`. Selecting a tab runs that source (Farcaster keeps its
   handle input; the other two are seeded by the connected wallet) into the shared list.
3. **POAP badge:** after a tab's matches render, rows whose Circles avatar shares ≥1
   POAP eventId with the connected wallet show a "🎫 co-attended {event}" badge and sort
   above otherwise-equal rows. Absence of shared POAPs never blocks or delays the list
   (enrichment is async, best-effort, capped).
4. Every non-Farcaster row shows source-specific **evidence** text ("Trusted by 4 of
   your contacts", "Votes in GnosisDAO with you").
5. The **trust-state filter** (All / Not yet / Trusts you / You trust / Mutual) works on
   every tab; the Farcaster-only **direction filter** shows only on the Farcaster tab.
6. New-source + POAP results are **cached** in `sessionStorage` (per `(sourceId, seed)`
   and per address for POAP) via the `lib/cache.ts` pattern; re-selecting a tab within
   TTL is instant with a "from your scan N min ago · ↻ rescan" affordance.
7. The existing Farcaster scan + deep scan + retry + its 34 tests remain **unchanged and
   green**. New code adds tests; `pnpm typecheck && pnpm test && pnpm build` all pass.
8. Explicit empty/degenerate states (no blank screens): not-connected,
   connected-but-not-a-Circles-avatar, connected-but-no-first-degree-trust, no Snapshot
   votes, and source-fetch-failed each render a specific message + next action.
9. `ALCHEMY_API_KEY` is read **server-side only** (never `NEXT_PUBLIC_*`, never shipped
   to the iframe); absent key → the POAP badge silently no-ops (no errors, tabs still work).

## Quantified Impact

- Adds **2 discovery sources + 1 enrichment layer** behind **1 new abstraction**
  (`DiscoverySource`) + **1 generic matcher**, reusing the entire `lib/circles.ts`
  spine unchanged.
- Keys: second-degree **0**, Snapshot **0**, POAP **1** (`ALCHEMY_API_KEY`, free tier
  30M CU/mo — this app's per-scan cost ~4k–150k CU is effectively never billed).
- New routes: Snapshot proxy + POAP-events proxy (both server-side, rate-limited).
- New code is **cache-only** robustness — it does **not** replicate the
  `ScanFailures`/`runRetry`/streaming-hydration machinery (Farcaster-shaped; inapplicable
  to onchain sources where the address IS the identity).

## Scope

### In Scope
- A `DiscoverySource` interface + registry (`lib/sources/`).
- Two sources: `trust2`, `snapshot`. One enrichment: `poap` (cross-source badge).
- A generic `matchSource()` orchestrator: candidate addresses → `Friend[]` via the spine,
  with `sessionStorage` caching.
- Generalizing `Friend` + `Results`/`FriendRow` to render any source's rows (source tag +
  evidence + POAP badge), keeping Farcaster's richer fields.
- A 3-tab source bar in `App.tsx`; FoF as the default auto-running tab.
- Tests for each source's candidate-building, the matcher, the POAP intersection, and caches.

### Out of Scope
- Refactoring Farcaster `runScan`/`runDeepScan`/`runRetry` INTO `DiscoverySource` —
  Farcaster stays as-is and is **adapted at the row boundary** only (it's freshly built,
  tested, and far richer than the generic seam needs; forcing it in is high-risk).
- Failure-ledger / targeted-retry for new sources (cache-only decision).
- **Shared-NFT-collection co-holding** (dead: `getOwnersForContract` broken on Gnosis +
  spam flood).
- A **standalone "co-attended events" discovery tab** via the POAP subgraph — documented
  phase-2, not MVP.
- Bluesky / Twitter / Lichess (no wallet bridge — see
  `memory/multi-network-expansion-analysis.md`).
- A server-side identity index / DB. Bulk trust writes.

### MVP cut (if we must trim)
Ship **Friends-of-friends only** first (zero key, zero route, highest impact) behind the
tab bar with Farcaster as tab 2; Snapshot and the POAP badge slot into the same seam after.

## Landscape — the three signals + the existing source

| Signal | Surface | Seed | New key? | New route? | Needs `findCirclesAvatars`? | Tie strength | Label |
|---|---|---|---|---|---|---|---|
| Farcaster (existing) | tab | typed handle | no | (exists) | yes (+deep sweep) | strong | "you follow each other" |
| **Second-degree trust** | tab (default) | connected avatar | **no** | **no** (client SDK) | only to filter humans | strong (economic vouch) | "Trusted by N of your contacts" |
| **Snapshot voters** | tab | connected address | **no** | yes (proxy) | **yes** | weak–medium | "Votes in <space> with you" |
| **POAP co-attendance** | **badge on any tab** | connected address | **1 (Alchemy)** | yes (proxy) | no (enriches matched rows) | strong (same event) | "🎫 co-attended <event>" |

## Architecture — the `DiscoverySource` seam

The spine (`lib/circles.ts`) is already address-only and **stays untouched**. The new
seam sits *above* it: a source produces **candidate addresses + evidence**, a generic
matcher consults Circles once, the UI renders source-tagged rows, and a POAP enrichment
pass patches co-attendance badges onto the rendered rows.

```ts
// lib/sources/types.ts — new, pure types, zero deps
export type SourceId = "farcaster" | "trust2" | "snapshot";

/** A discovered person BEFORE the Circles registry is consulted. */
export type Candidate = {
  /** Lowercase ETH address — match key, dedupe key, and React list key. */
  address: string;
  /** Why this person surfaced — rendered verbatim as the row's secondary line. */
  evidence: string;
  /** Source-native ranking weight (e.g. # of contacts who trust them). Higher first. */
  weight?: number;
  /** True when the address is ALREADY known to be a Circles human (skip findCirclesAvatars). */
  preVerified?: boolean;
};

export type SourceResult = {
  sourceId: SourceId;
  candidates: Candidate[];
  /** Headline counters for the meta row, e.g. { contacts: 23, candidates: 140 }. */
  stats: Record<string, number>;
  /** Set when the source hit a cap / partial fetch (informational, like truncated). */
  truncated?: boolean;
};

export interface DiscoverySource {
  readonly id: SourceId;
  readonly label: string;        // tab label, e.g. "Friends of friends"
  readonly evidenceNoun: string; // for empty-state copy, e.g. "trusted contacts"
  /** false → seeded by the connected wallet, no text input (trust2 / snapshot). */
  readonly needsHandle: boolean;
  /** `seed` = connected Circles avatar address (lowercase) for wallet-seeded sources. */
  discover(seed: string, signal?: AbortSignal): Promise<SourceResult>;
}
```

```ts
// lib/sources/match.ts — generic orchestrator. Cache-only robustness.
export async function matchSource(
  result: SourceResult,
  connectedAvatar: string | null, // for the trust map; usually == the seed
  signal?: AbortSignal,
): Promise<Friend[]> {
  // 1. Partition candidates: preVerified (skip registry) vs toCheck.
  // 2. const { avatars } = await findCirclesAvatars(toCheck.map(c => c.address));
  //    Keep candidates whose address is preVerified OR present in `avatars`.
  // 3. const profiles = await getCirclesProfiles(matchedAddresses);
  // 4. const trustMap = connectedAvatar ? await getTrustMap(connectedAvatar) : new Map();
  // 5. Build generic Friend rows (see Type changes), sorted by sortMatches():
  //    trust actionability (reuse TRUST_ORDER) → weight desc → name.
  // No fid, no streaming hydration, no failure ledger.
}
```

**Why Farcaster stays out of the interface:** `runScan` returns a `ScanResult` with fid
relations, deep-scan candidates, a failure ledger, and streaming hydration. We adapt it
to the shared row type at the boundary (`lib/sources/farcasterRow.ts`: sets
`source:"farcaster"`, `evidence` from `fcRelation`), so the Farcaster tab keeps 100% of
its behavior while rendering in the shared list.

## Source 1 — Second-degree Circles trust (`trust2`)

**Seed:** connected Circles avatar address. `needsHandle = false`. Auto-runs as the
default tab when the connected wallet is a registered v2 human avatar.

**Algorithm (all client-side via `@aboutcircles/sdk`, no new route):**
1. `first = await getTrustMap(seed)` — first-degree circle
   (`Map<address, "trusts"|"trustedBy"|"mutuallyTrusts">`). Reuses `lib/circles.ts`.
2. `contacts =` addresses in `first` where relation ∈ {`trusts`,`mutuallyTrusts`} (people
   *I* trust outward — the vouchers). Cap to `TRUST2_CONTACT_CAP` (default **150**,
   mutuals first) to bound RPC fan-out.
3. For each contact, call the existing `getTrustMap(contact)` (no new helper — it already
   wraps `getAggregatedTrustRelations` and returns `Map<address, relation>`). Collect each
   address whose relation is `trusts`/`mutuallyTrusts` (people my contact trusts outward).
   `mapLimit(contacts, 8, …)`.
4. Tally counts per candidate address. Exclude `seed` and every address already in
   `first`. Result = `Map<address, count>`.
5. Build `candidates`: `{ address, weight: count, evidence: \`Trusted by ${count} of your
   contacts\`, preVerified: false }`. **Not** `preVerified` — trust edges can point to
   groups/orgs, so the matcher's `findCirclesAvatars` filters to v2 humans (cheap, reuses
   the spine).
6. `stats = { contacts: contacts.length, candidates: map.size }`.

**Ranking:** `weight` (contact count) desc, then trust actionability, then name. Show the
count prominently and honestly — Circles trust is *economic acceptance*, not personal
acquaintance, so a `1`-of-`1` edge must read as weak.

**Edge cases:** seed not a registered avatar → empty + "Connect a Circles account to see
friends of friends." Seed has zero first-degree trust → empty + "You don't trust anyone
yet — scan Farcaster to find people to trust first" (the newcomer cold-start).

## Source 2 — Snapshot shared voters (`snapshot`)

**Seed:** connected wallet address. `needsHandle = false`. Free public GraphQL at
`https://hub.snapshot.org/graphql`, no key (60 req/min unauth). Proxied through
`app/api/onchain/snapshot/route.ts` (CORS + `maxDuration`, the `app/api/farcaster/*`
pattern).

**Algorithm:**
1. Seed's recent votes → the **spaces** they vote in:
   `votes(first:200, where:{ voter:"<seed>" }){ proposal { space { id name } } }` →
   distinct `spaceIds` (cap top **K=10** by vote count).
2. Per space, recent voters: `votes(first:500, where:{ space:"<spaceId>" }){ voter }` →
   distinct `voter` addresses, tally shared-space count. Cap total to
   `SNAPSHOT_CANDIDATE_CAP` (default **500**).
3. `candidates`: `{ address: voter, weight: sharedSpaceCount, evidence: \`Votes in
   ${spaceName} with you\` (or "Votes in N DAOs with you"), preVerified: false }`. Matcher
   runs `findCirclesAvatars` (arbitrary addresses) → Circles humans → profiles + trust.
4. `stats = { spaces: spaceIds.length, voters: candidates.length }`; `truncated` on caps.

**Scoping note:** voter sets skew Ethereum mainnet; MVP scopes by **space** (not proposal)
and may bias toward Gnosis-native spaces (GnosisDAO) if yield is thin. `findCirclesAvatars`
is the natural funnel — most voters won't be on Circles.

**Edge cases:** no Snapshot votes → empty + "No DAO votes found for this wallet." GraphQL
error/timeout → toast + empty (cache-only).

## Enrichment — POAP co-attendance badge (`poap`)

Not a `DiscoverySource`; a post-match pass that decorates rows from **any** tab. Reads
SELF's POAP events once, then each rendered row's avatar's events, intersects, badges
overlaps. Alchemy-only (`ALCHEMY_API_KEY`), no POAP key, no subgraph.

**Constants:** POAP contract on Gnosis `0x22C1f6050E56d2876009903609a2cC3fEf83B415`.
eventId parse: first `\d+` after `/metadata/` in `raw.tokenUri`.

**Server route `app/api/onchain/poap/route.ts`** (server-only key, rate-limited via
`rateLimitByIp`): `GET ?addresses=0x..,0x..` → `{ events: { [address]: number[] } }`,
where each `number[]` is that address's POAP eventId set on Gnosis. Internally, per
address: `getNFTsForOwner({owner, contractAddresses:[POAP], withMetadata:true})`,
paginate, parse eventId from each `raw.tokenUri`. Batch the request's addresses with
`mapLimit(_, 4)`. Cap addresses per request to `POAP_REQUEST_CAP` (default **40**).

**Client `lib/sources/poap.ts`:**
1. `selfEvents = events[connectedAddress]` (fetch once, cache by address).
2. After a tab's `Friend[]` renders, take the top `POAP_ENRICH_CAP` (default **120**) rows
   by current sort, fetch their event sets (chunked to the route cap, async, non-blocking).
3. For each row, `shared = intersect(selfEvents, rowEvents)`; if non-empty set
   `friend.poapShared = shared` and re-sort (POAP-shared rows rank up). Patch rows
   progressively (like the Farcaster hydration patch, keyed by `address`).
4. Event **names:** fetch the public metadata URL
   `https://api.poap.tech/metadata/{eventId}/{tokenId}` (the tokenURI target — **verified
   key-free**, returns `{ name, image_url, year, … }`, e.g. event 6762 → "The One Millionth
   POAP") for the *matched* eventIds only; fall back to "event #{id}" on failure. Cache by
   eventId.

**Caching:** per-address event sets + self set in `sessionStorage` (cache-only). Event
names cached by eventId.

**Coverage caveats (be honest in UI):**
- **EOA-vs-Safe again:** SELF's and candidates' events are read from their **Circles
  avatar (Safe)** address; POAPs collected on a personal EOA won't show. So the badge
  fires only when *both* parties hold the shared POAP on their Circles address — narrow,
  but pure upside (a badge when it happens, never a blocker).
- Enrichment is capped (`POAP_ENRICH_CAP`) and async; rows beyond the cap simply don't get
  a badge. `log`/note the cap rather than implying full coverage.
- POAP can't *discover* new people here (no owners-by-eventId) — it only enriches matches.

## Sanity check — verified against current (uncommitted, post-reliability) code

Done before finalizing, against the live tree. Findings are folded into the spec above; the
load-bearing ones for the implementer:

1. **`Friend.displayName` is universal & required — keep it.** `FriendRow.tsx:147` renders it,
   `:34` uses `circlesName ?? displayName`, App.tsx trust toasts read it (×4). New sources MUST
   set `displayName = circlesName ?? shortenAddress(address)`. (Fixed in the Friend type below.)
2. **`FriendRow` crashes on non-Farcaster rows today** — `friend.username.slice(0,1)` (:71) and
   `RELATION_GLYPH[friend.fcRelation]` (:158/:171) are `undefined` for onchain sources. The
   `source` branch must guard both.
3. **`Results.tsx` is too Farcaster-coupled to reuse as-is** (~30 props incl. `user:
   FarcasterUser`, `failures`, `retry`, `deep`, `deepScanLimit`, `followersScan`,
   `followerOnlyCount`, `onScanFollowers` — the reliability work also added a "scan followers"
   feature). → extract `MatchList`; `Results` becomes the Farcaster wrapper, `SourceResults` the
   generic one. Largest integration task (see Effort + File table).
4. **`rateLimitByIp` only fires when `NEYNAR_API_KEY` is set** (`farcaster-server.ts:410`).
   Reusing it verbatim leaves the metered Alchemy/POAP route unprotected — generalize it (pass a
   should-limit predicate / gate on `ALCHEMY_API_KEY`) or give the onchain routes their own guard.
5. ✅ **`TRUST_ORDER` + `sortFriends` exist** (`scan.ts:92/99`) — "extract to shared util" holds;
   matcher sort = `TRUST_ORDER[trust]` → `weight desc` → `displayName`.
6. ✅ The spec's other references to current shapes are accurate: `AvatarLookup` return,
   6-arg `runScan`, `ScanResult.failures/scanId/completedAt`, `lib/cache.ts` DTO pattern,
   `getTrustMap` relation values. New code is additive and touches neither the Farcaster scan
   nor `lib/circles.ts`.

## Type changes

`Friend` (in `lib/types.ts`) generalizes minimally — **additive**, Farcaster fields become
optional so non-Farcaster rows don't fake them:

```ts
export type Friend = {
  /** Circles avatar address (lowercase). React/dedupe key. UNCHANGED, now universal. */
  address: string;
  /** Primary display name — UNIVERSAL & REQUIRED. FriendRow:147 renders it and App.tsx trust
   *  toasts read it (×4), so it must stay required. Farcaster: FC displayName. New sources:
   *  `circlesName ?? shortenAddress(address)`. */
  displayName: string;

  // --- NEW: provenance + cross-source enrichment ---
  source: SourceId;            // "farcaster" | "trust2" | "snapshot"
  evidence?: string;           // secondary line for non-Farcaster rows
  weight?: number;             // source-native ranking
  /** Shared POAP eventIds with the connected wallet (set by the poap enrichment). */
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

`FriendRow` display contract (branch on `source`). ⚠️ The current FriendRow **crashes on
non-Farcaster rows** — it calls `friend.username.slice(0,1)` (FriendRow.tsx:71) and
`RELATION_GLYPH[friend.fcRelation]` (:158/:171), both `undefined` for onchain sources. Guard:
- **name:** `friend.displayName` (universal — already what FriendRow:147 renders).
- **avatar initial:** `(friend.circlesName ?? friend.displayName).slice(0,1)` — do **not** read
  `friend.username` (may be undefined).
- **avatar img:** `pfpUrl` (Farcaster) else `circlesImageUrl` else the initial.
- **secondary line:** Farcaster → `@username` link + `RELATION_GLYPH[fcRelation]`; others →
  `evidence`. Render the relation glyph **only when `fcRelation` is defined**.
- **POAP badge:** when `poapShared?.length`, render "🎫 co-attended {name|#id}{ +N more}".
- **trust button + address link + trust glyph:** unchanged for all sources.

## UI changes

**Tab bar (new), in `App.tsx` / `components/SourceTabs.tsx`:** three tabs — `Friends of
friends` (default) · `Farcaster` · `Shared DAOs`. State: `activeSource: SourceId`,
default `"trust2"`. The POAP badge is orthogonal (appears within any tab).

**Load state machine:**
- Connected + registered Circles avatar → default tab `trust2`, auto-`discover(seed)`.
- Connected + NOT a registered avatar, or not connected → default tab `farcaster` (the
  existing Hero handle input), with a one-line note that friends-of-friends needs a
  Circles account / host wallet.
- Selecting `farcaster` reveals the existing Hero + `runScan` flow **verbatim** (handle
  input, deep scan, retry, StatusBlock — unchanged).
- Selecting `snapshot` runs `discover(connectedAddress)` (cache-first).
- After any tab's matches render, kick off the async POAP enrichment pass.

**Results rendering:** `Results.tsx` is too Farcaster-coupled to reuse directly (~30 props:
`user: FarcasterUser`, `failures`, `retry`, `deep`, `deepScanLimit`, `followersScan`,
`followerOnlyCount`, `onScanFollowers`, …). Extract the shared chrome — headline, trust-state
filter bar, `FriendRow` list, empty state, POAP badge — into a new `MatchList`. `Results.tsx`
becomes the **Farcaster wrapper** (`MatchList` + StatusBlock + deep-scan + followers-scan +
direction filter); a new `SourceResults` wraps `MatchList` for trust2/snapshot (stats meta row
+ source empty states). The direction filter stays in the Farcaster wrapper; the trust-state
filter + POAP badge live in the shared `MatchList`.

## File Reference Table

| File | Change |
|---|---|
| `lib/sources/types.ts` | NEW — `SourceId`, `Candidate`, `SourceResult`, `DiscoverySource`. |
| `lib/sources/match.ts` | NEW — generic `matchSource()` + `sortMatches()` (spine + sort, cache-only). |
| `lib/sources/trust2.ts` | NEW — second-degree trust source (client SDK). |
| `lib/sources/snapshot.ts` | NEW — Snapshot source (calls the proxy route). |
| `lib/sources/poap.ts` | NEW — POAP co-attendance enrichment (self set, intersect, name lookup). |
| `lib/sources/registry.ts` | NEW — `SOURCES: Record<SourceId, DiscoverySource>`, `getSource(id)`. |
| `lib/sources/farcasterRow.ts` | NEW — maps `ScanResult.friends` → generic `Friend` rows. |
| `app/api/onchain/snapshot/route.ts` | NEW — proxy Snapshot GraphQL; `maxDuration`; IP rate-limit (see ⚠️ below — current `rateLimitByIp` only fires when `NEYNAR_API_KEY` is set). |
| `app/api/onchain/poap/route.ts` | NEW — Alchemy getNFTsForOwner→eventIds per address; `ALCHEMY_API_KEY` server-side; IP rate-limit (generalize `rateLimitByIp` or add own guard). |
| `lib/types.ts` | Generalize `Friend` (additive; fields above). No breaking export changes. |
| `lib/cache.ts` | Add generic `read/writeSourceCache(sourceId, seed, friends)` + POAP-events cache keyed by address; reuse the DTO/TTL/version approach. Farcaster cache untouched. |
| `components/App.tsx` | Add `activeSource` state + tab bar + load state machine + `discover`/`matchSource` + async POAP enrichment wiring; Farcaster path unchanged. |
| `components/SourceTabs.tsx` | NEW — the 3-tab bar. |
| `components/MatchList.tsx` | NEW — shared chrome extracted from Results: headline, trust-state filter bar, `FriendRow` list, empty state, POAP badge. Used by both result wrappers. |
| `components/Results.tsx` | Becomes the **Farcaster wrapper**: keep its ~30 Farcaster props (user/failures/retry/deep/followersScan/…), render `<MatchList>` + StatusBlock + deep-scan + followers-scan + direction filter. Don't pass these props to the generic view. |
| `components/SourceResults.tsx` | NEW — generic view for trust2/snapshot: stats meta row + `<MatchList>` + source empty states. |
| `components/FriendRow.tsx` | Branch display on `friend.source`; **guard `username`/`fcRelation`** (crash today on undefined); render POAP badge from `poapShared`. |
| `components/Hero.tsx` | Scope to the Farcaster tab / generalize headline. |
| `.env.example` | Add `ALCHEMY_API_KEY=` (documented; real value lives in gitignored `.env.local`). |
| `test/sources/trust2.test.ts` | NEW — tally, first-degree exclusion, cap, ranking (mock SDK). |
| `test/sources/snapshot.test.ts` | NEW — space derivation + voter intersection + caps (mock GraphQL). |
| `test/sources/poap.test.ts` | NEW — tokenUri→eventId parse, self∩candidate intersection, cap, badge. |
| `test/sources/match.test.ts` | NEW — preVerified skip, human filter, sort order, dedupe by address. |
| `test/cache.test.ts` | Extend — `(sourceId, seed)` + POAP-address key round-trips + TTL. |

## Existing Code to Leverage
- `findCirclesAvatars` / `getCirclesProfiles` / `getTrustMap` / `setTrust` / `avatarKind`
  from `lib/circles.ts` — the entire spine, unchanged.
- `chunk`, `mapLimit` from `lib/util.ts` — batching/fan-out for RPC + route loops.
- `lib/cache.ts` serialize/deserialize/TTL/version pattern — extend for source/POAP caches.
- `sortFriends` / `TRUST_ORDER` in `lib/scan.ts` — extract to a shared util so the matcher
  reuses the same trust-actionability ordering.
- `rateLimitByIp`, `errorResponse`, `maxDuration`, the route shape in `app/api/farcaster/*`
  and `lib/farcaster-server.ts` — mirror for the two new `app/api/onchain/*` routes.
- The Farcaster `onHydrated` patch-by-key pattern in `App.tsx` — mirror for the async POAP
  badge patch (keyed by `address`).

## Edge Cases
- **No wallet / standalone preview:** wallet-seeded tabs show "needs the Circles host
  wallet"; Farcaster tab still works (read-only) as today; POAP no-ops.
- **Connected but not a Circles avatar / zero first-degree trust:** `trust2` empty-states
  point to Farcaster (newcomer cold-start).
- **Already trusted at first degree:** excluded from `trust2` (surface only *new* people);
  still shown in Snapshot/Farcaster with real `trust` state.
- **Group/org edges:** filtered by `findCirclesAvatars` (v2 human only).
- **Huge voter sets:** capped (`SNAPSHOT_CANDIDATE_CAP`); `truncated` surfaced.
- **POAP enrichment beyond cap / async still running:** rows render immediately without a
  badge; badges patch in as they resolve; rows past `POAP_ENRICH_CAP` get none.
- **`ALCHEMY_API_KEY` missing:** POAP route returns empty map; badge layer no-ops; tabs work.
- **Source/route fetch fails:** toast + empty list (cache-only; no retry ledger).
- **Same person across tabs:** each tab is its own list; dedupe by `address` within a tab.

## Testing Pyramid

| Layer | What | Count |
|---|---|---|
| Unit | `trust2` tally / first-degree exclusion / cap / ranking (mock SDK) | +4 |
| Unit | `snapshot` space-derivation + voter intersection + caps (mock GraphQL) | +3 |
| Unit | `poap` tokenUri→eventId parse + self∩candidate intersection + cap | +3 |
| Unit | `match` preVerified-skip / human-filter / sort / dedupe | +4 |
| Unit | `cache` `(sourceId, seed)` + POAP-address round-trip + TTL/version | +2 |
| Integration | snapshot + poap route proxies return shaped JSON / error mapping / key-absent | +3 |
| Regression | existing Farcaster scan + 34 tests stay green | 0 (unchanged) |

## Effort Breakdown
- `DiscoverySource` types + `match.ts` + registry + `farcasterRow` mapper: ~3h
- `trust2` source + tests: ~3h (pure SDK; highest-value, lowest-risk)
- `snapshot` source + route + tests: ~4h
- `poap` enrichment + route + name lookup + async patch + tests: ~5h
- `Friend` generalization + `MatchList` extraction from Results + `SourceResults` +
  `FriendRow`(+badge, +crash-guards)/`Hero`: ~7h (largest task — Results is ~30-prop coupled)
- Tab bar + `App.tsx` state machine + cache wiring + empty states: ~4h
- Total: **~3–3.5 days**, dominated by the Results→MatchList extraction + the POAP async patch,
  not the seam.

## Rollback Strategy
- The seam is additive: revert the PR to return to the (committed) Farcaster-only app.
- Per-source kill switch: remove a source from `registry.ts` (one line) to drop its tab.
- POAP kill switch: unset `ALCHEMY_API_KEY` → badge layer no-ops; or remove the enrichment
  call in `App.tsx`. No spine/tab impact.

## Constraints
### Must Follow
- Reuse `lib/circles.ts` verbatim; do **not** modify the spine.
- Name the new axis **Source / DiscoverySource** — never "provider" (taken by the Farcaster
  keyless↔Neynar quota swap in `farcaster-server.ts`).
- Dynamic-import the Circles SDK only inside client components/handlers (both SDKs touch
  `window`).
- `ALCHEMY_API_KEY` is **server-only** — read in the route via `process.env`, never
  `NEXT_PUBLIC_*`, never returned to the client. `.env.local` is already gitignored
  (`.env*` + `!.env.example`); add the key only to `.env.example` as documentation.
- Proxy external HTTP through Next route handlers (CORS + `maxDuration` + `rateLimitByIp`).
- Keep the client-orchestrated, key-light, no-DB posture.
### Must Avoid
- Do **not** fold Farcaster's `runScan` into `DiscoverySource` for MVP.
- Do **not** add `ScanFailures`/`runRetry`/streaming-hydration to new sources (cache-only).
- Do **not** use the approval-gated POAP REST/Compass API, SimpleHash (shutting down), or
  `getOwnersForContract` on Gnosis (broken).
- Do **not** ship shared-NFT-collection co-holding (broken + spam).
- Do **not** block the rendered list on the async POAP pass.
- Do **not** commit `ALCHEMY_API_KEY`.

## Open Questions / Phase-2
- **Standalone "co-attended" discovery tab** (find new people sharing an event): needs a
  POAP subgraph reverse index. The Graph decentralized network has a self-serve key (100k
  free q/mo, NOT the gated POAP form) but a queryable Gnosis-mainnet POAP subgraph isn't
  confirmed public — may require self-deploying `poap-xyz/poap-subgraph` to Goldsky/The
  Graph. Phase-2.
- Snapshot Gnosis-space biasing if global overlap is too thin (revisit with real data).
- Confirm the connected miniapp-host wallet == the Circles avatar address used as the
  `trust2`/POAP seed (today `App.tsx` passes `address` straight to `getTrustMap`).
- Optional: let users add a secondary (EOA) address to widen their POAP set past the Safe.

---
*Rebuildability: this spec + the listed files should let an unfamiliar implementer build
all three signals without rejoining this conversation. The Farcaster path and `lib/circles.ts`
are explicitly do-not-touch; the new code is additive behind `lib/sources/` and two
`app/api/onchain/*` routes.*

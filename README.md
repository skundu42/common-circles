# Common Circles

**Your Farcaster friends, found in the Circles trust graph.**

A [Circles](https://aboutcircles.com) embedded miniapp: enter a Farcaster handle, it
sweeps **the people that account follows** — the most relevant set — finds the ones
who are registered Circles **v2 human avatars** on Gnosis Chain (groups,
organizations and v1-only signups are excluded), shows where they stand in *your*
trust circle — and lets you trust / untrust them straight from your Safe, without
leaving the host. After results, an opt-in second pass can also check **people who
follow you** that you don't follow back.

> Coverage is bounded: the default scan checks up to 8,000 of the people you follow;
> the opt-in followers pass checks up to 4,000 followers. Anything beyond that, plus
> any lookups the upstream APIs rate-limit, is reported as "not checked" and can be
> retried — it is never silently dropped.

Built from scratch on the dependency set of
[`aboutcircles/embedded-miniapp-boilerplate`](https://github.com/aboutcircles/embedded-miniapp-boilerplate)
(Next.js 16 · Tailwind v4 · TypeScript · the two Circles SDKs), with a custom UI.

## How it works

```
input ────► handle / ENS / 0x address ─► fid, profile, verified wallets
fid ──────► snap.farcaster.xyz (hub) ──► following (mutuals first); followers fetched for labeling + opt-in pass
fids ─────► /fc/primary-addresses ─────► primary ETH wallet per person (bulk ×100)
wallets ──► circles_getAvatarInfoBatch ► who is a registered Circles avatar
matches ──► profiles + trust relations ► names, images, trusts/trustedBy/mutual
row ──────► hubV2.trust(addr, expiry) ─► encoded client-side, signed by the host Safe
```

- **Farcaster data** comes from the free public APIs (`api.farcaster.xyz` + a public
  Snapchain node) — no API key, no Farcaster login. Calls are proxied through Next.js
  route handlers (`app/api/farcaster/*`) so the browser never fights CORS.
- **Bulk provider (server-side).** Bulk profile / verification / primary-address lookups
  go through a bulk-capable provider, which lets the deep scan lift its per-fid cap and
  sweep every unmatched connection. The follow graph always stays on Snapchain.
  Selection order (first match wins):
  1. **`NEYNAR_API_KEY`** — routes through Neynar's bulk endpoints (a quota swap; the key
     is never shipped to the client). Per-IP rate limiting activates only when this is set.
  2. **`HYPERSNAP_NODE_URL`** — a key-free [HyperSnap](https://hypersnap.org) Farcaster
     node. **Defaults to the public node `https://haatz.quilibrium.com`** (same underlying
     Farcaster data; hundreds of fids per call, no API key, no per-IP limit), so bulk
     lookups work out of the box. Set this to point at a self-hosted node, or to `""` to
     disable HyperSnap and fall back to the keyless `api.farcaster.xyz` path.
- **The input accepts three shapes**: a Farcaster handle, an ENS name, or a raw
  `0x` address. Handles are tried as usernames first (Farcaster usernames can *be*
  ENS names, e.g. `hellno.eth`); otherwise resolution falls back to
  [ensdata.net](https://ensdata.net) (free, key-less): ENS/reverse-ENS → Farcaster
  fid → canonical profile from the official API. The connected Safe is also probed
  silently on arrival — if its primary ENS links to a Farcaster account, the hero
  offers a one-click "scan my friends" chip (rare in practice, since verifications
  are usually EOAs).
- **Circles data** is read client-side with `@aboutcircles/sdk` against
  `rpc.aboutcircles.com` (batch avatar lookup, batch profiles, aggregated trust
  relations in one call).
- **Writes** follow the boilerplate's two-SDK pattern: encode
  `hubV2.trust(trustee, expiry)` with the read-only SDK (max-uint96 = trust forever,
  `0` = untrust), submit via the miniapp SDK's `sendTransactions` — the host signs
  with the user's Safe.

### The two-pass match (why "deep scan" exists)

Most Circles v2 avatars are Safes, while Farcaster verifications are usually EOAs —
so a follow's *primary* wallet often isn't their Circles address. The scan therefore
runs two passes:

1. **Primary pass** — bulk primary-address lookup for every followed account (cheap).
2. **Verification sweep** — *all* verified addresses per account (1 upstream call
   per fid). For follow graphs ≤ 400 this runs automatically inside the main scan;
   for larger graphs it's offered as an explicit **deep scan** over the first 300
   unmatched follows, closest relationships (mutual follows) first.

The default scan covers up to 8,000 of the people you follow; a separate opt-in
pass after results sweeps up to 4,000 of the **people who follow you** that you
don't follow back. Anything past those caps is reported as "not checked" rather
than implied to be covered. Results carry a per-person follow direction (⇄ mutual ·
→ you follow · ← follows you) that can be filtered alongside trust state.

## Develop

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # production build
```

Standalone (a normal browser tab) everything works read-only — wallet features need
the Circles host. To test the full flow, deploy to any HTTPS host and open
`https://circles.gnosis.io/playground?url=<your-deploy-url>`; the host iframes the
app and pushes a Safe address (`next.config.ts` already ships the required
`frame-ancestors` CSP).

## Layout

```
app/
  page.tsx / layout.tsx       single route, fonts, WalletProvider
  api/farcaster/
    user/route.ts             handle/ENS/address → fid + profile + wallets
    connections/route.ts      fid → following (scanned) with primary addresses; followers fetched for labeling
    users/route.ts            fids → hydrated profiles (matched only)
    verifications/route.ts    fids → all verified ETH addresses (sweep)
components/
  App.tsx                     phase machine: idle → scanning → results
  Hero / ScanProgress / Results / FriendRow
  TrustGlyph.tsx              trust state as a miniature venn
  VennFigure.tsx              the motif: Farcaster ∩ Circles
  Toast.tsx · Header.tsx · wallet.tsx (host wallet context)
lib/
  scan.ts                     the two-pass match pipeline
  circles.ts                  SDK plumbing: batch reads + trust encoding
  farcaster-server.ts         upstream fetchers (server only)
  api.ts · types.ts · util.ts
```

## Trust semantics

| Glyph | State | Meaning |
| --- | --- | --- |
| ◌◌ | `none` | no trust either way |
| ●◌ | `trusts` | you trust them |
| ◌● | `trustedBy` | they trust you |
| ●● | `mutuallyTrusts` | mutual |

Rows are ordered by actionability: people who already trust you first, then
untrusted, then already-trusted. Untrusting asks for a second click.

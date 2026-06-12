# TODOS

## From /autoplan review 2026-06-12 (friend-scan reliability plan)

- [ ] **Persistent identity index (server-side)** — Why: both outside voices: the
  12-month shape is a precomputed FID↔wallets↔Circles map; the miniapp becomes a
  fast trust surface instead of a live scanner. Pros: kills rate-limit pressure,
  enables instant scans + invite loops. Cons: new infra (DB/cron), hosting cost.
  Context: today the scan is fully client-orchestrated (lib/scan.ts); R8 session
  cache is the first step. Depends on: deployment-model decision.
- [ ] **Server-side scan orchestration** — Why: centralizes rate limiting for
  real (per-instance limiter can't bound shared quota), enables caching/jobs.
  Cons: Vercel function lifetimes, complexity. Blocked by: same decision as above.
- [ ] **Raise/remove FOLLOW_CAP=4000 + ranked scan order** — Why: power users get
  systematic misses; ranked-by-mutuals beats arbitrary truncation. Context:
  collectLinkFids caps at 4000/direction; truncation order unverified (E17).
- [ ] **External analytics (PostHog) for scan funnel** — Why: R7 ships local
  diagnostics only; product needs aggregate failure-cause data. Needs provider
  decision + privacy stance.
- [ ] **Per-IP throttle on key-free deployments** — Why: open proxy burns shared
  free quota. E13 covers keyed deployments only.
- [ ] **README copy: stop promising whole-graph coverage** — partially covered by
  D8/U4; full README pass deferred.

## From codex review of friend-scan reliability implementation 2026-06-12 (low-priority, deferred)

- [ ] **runRetry re-burns verifications quota on walletless FIDs** — failed
  `primaryFids` (no primary address) are unioned into the retry verifications
  sweep; FIDs that genuinely have no verified ETH address get re-checked every
  retry and re-marked unchecked. Idempotent/correct, just wasteful. Consider
  caching "confirmed no-wallet" FIDs so retry skips them. (codex m4)
- [ ] **parseFids cap (100/150) vs client 100-chunking is a latent mismatch** —
  safe today (sweep + hydration both chunk at ≤100), but a future caller sending
  >cap fids in one request would silently drop the overflow. Add a guard/comment.
  (codex m5)
- [ ] **Trust effect missing `trustLoaded` dep (latent footgun)** — App.tsx
  wallet-keyed trust effect re-runs on scanId/trustNonce only; setting
  `trustLoaded` elsewhere without bumping those wouldn't re-trigger. No live bug.
  (codex m3)
- [ ] **Test gaps** — no direct test for `runRetry` orchestration (only the pure
  reducer + sweep-via-deepscan), no abort/cancel test asserting the chunk loop
  stops on `signal.aborted`, no integration test that deep-scan failures reach the
  ledger via `handleDeepScan`. (codex test-gap list)

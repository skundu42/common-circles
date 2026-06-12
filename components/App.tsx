"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Header, type CirclesIdentity } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Results, type DeepState, type RetryState } from "@/components/Results";
import { ScanProgress } from "@/components/ScanProgress";
import { SourceResults, type SourceEmptyKind } from "@/components/SourceResults";
import { SourceTabs } from "@/components/SourceTabs";
import { Toast, type ToastState } from "@/components/Toast";
import { VennMark } from "@/components/VennFigure";
import { useWallet } from "@/components/wallet";
import {
  clearCache,
  clearSourceCache,
  readCache,
  readSourceCache,
  writeCache,
  writeSourceCache,
} from "@/lib/cache";
import { fetchFarcasterUser } from "@/lib/api";
import { getMyCirclesIdentity, getTrustMap, setTrust } from "@/lib/circles";
import {
  applyRetryOutcome,
  DEEP_SCAN_CAP,
  FOLLOWERS_SCAN_CAP,
  runDeepScan,
  runRetry,
  runScan,
  type ScanProgress as Progress,
  type ScanResult,
  type TrustMap,
} from "@/lib/scan";
import { matchSource } from "@/lib/sources/match";
import { getSource } from "@/lib/sources/registry";
import type { SourceId } from "@/lib/sources/types";
import type { FarcasterUser, Friend, TrustState } from "@/lib/types";

type Phase = "idle" | "scanning" | "results";

/** The progress STAGES count in ScanProgress; used to clamp the failed-stage index. */
const STAGE_COUNT = 4;

function nextTrust(current: TrustState, trusted: boolean): TrustState {
  if (trusted) return current === "trustedBy" ? "mutuallyTrusts" : "trusts";
  return current === "mutuallyTrusts" ? "trustedBy" : "none";
}

/** Patch matching friends with hydrated FC profile fields (E15/onHydrated). */
function patchHydration(
  friends: Friend[],
  patches: Map<number, FarcasterUser>,
): Friend[] {
  if (patches.size === 0) return friends;
  let touched = false;
  const next = friends.map((f) => {
    // fid is optional on Friend now (onchain sources have none); patches only
    // ever target Farcaster rows, so a missing fid simply doesn't match.
    const u = f.fid === undefined ? undefined : patches.get(f.fid);
    if (!u) return f;
    touched = true;
    return {
      ...f,
      username: u.username,
      displayName: u.displayName,
      pfpUrl: u.pfpUrl,
      hydrated: true,
    };
  });
  return touched ? next : friends;
}

export function App() {
  const { address, isConnected, isMiniappHost } = useWallet();

  const [identity, setIdentity] = useState<CirclesIdentity | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [scanHandle, setScanHandle] = useState("");
  const [scanUser, setScanUser] = useState<FarcasterUser | null>(null);
  const [progress, setProgress] = useState<Progress>({ step: 0 });
  const [scanError, setScanError] = useState<string | null>(null);
  const [failedStep, setFailedStep] = useState<number | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [deep, setDeep] = useState<DeepState | null>(null);
  // The opt-in "check your followers" pass — same DeepState shape, mutually
  // exclusive with the deep scan + retry (all ride the verification sweep).
  const [followersScan, setFollowersScan] = useState<DeepState | null>(null);
  const [retry, setRetry] = useState<RetryState>({ phase: "idle" });
  const [fromCache, setFromCache] = useState(false);
  // Bumped to re-arm the E11 trust effect on demand (D6 "retry trust").
  const [trustNonce, setTrustNonce] = useState(0);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [suggestion, setSuggestion] = useState<FarcasterUser | null>(null);

  // --- Discovery source (tab) state. ---
  // `activeSource` starts on Farcaster and is promoted to trust2 once we know
  // the connected wallet is a registered Circles avatar (unless the user picks
  // a tab themselves). trust2 (and future snapshot) discovery state is flat
  // here because MVP has a single non-Farcaster source; adding Snapshot means
  // keying these by SourceId (e.g. Record<SourceId, SourceState>) — the
  // documented follow-up.
  const [activeSource, setActiveSource] = useState<SourceId>("farcaster");
  const [sourceFriends, setSourceFriends] = useState<Friend[]>([]);
  const [sourceStats, setSourceStats] = useState<Record<string, number>>({});
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceFromCache, setSourceFromCache] = useState(false);
  const [sourceCompletedAt, setSourceCompletedAt] = useState<number | null>(null);
  // Bumped to invalidate stale trust2 discover runs (mirrors scanId).
  const sourceRunId = useRef(0);
  // True once the user explicitly clicks a tab — suppresses the default-tab
  // promotion so we never override an intentional selection.
  const userPickedTab = useRef(false);

  // Bumped to invalidate in-flight scans (cancel / reset / new scan).
  const scanId = useRef(0);
  // Aborts the in-flight scan's upstream fetches (E10).
  const controller = useRef<AbortController | null>(null);
  // The connected avatar's trust circle; shared with deep-scan hydration.
  const trustMap = useRef<TrustMap>(new Map());
  // The wallet address the current trustMap was built for (E11 race guard).
  const trustWallet = useRef<string | null>(null);
  // Latest friends, so the retry reducer always folds into current state.
  const friendsRef = useRef(friends);
  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  // --- Circles identity for the header badge / action gating ---
  useEffect(() => {
    if (!address) {
      setIdentity(null);
      return;
    }
    let cancelled = false;
    getMyCirclesIdentity(address)
      .then((id) => !cancelled && setIdentity(id))
      // If the lookup itself fails, don't wrongly lock the UI — the
      // transaction will surface the truth.
      .catch(() => !cancelled && setIdentity({ registered: true, name: null }));
    return () => {
      cancelled = true;
    };
  }, [address]);

  // --- Best-effort: does the connected Safe resolve to a Farcaster account? ---
  // Usually it won't (verifications are EOAs, the Safe is a contract), but when
  // its primary ENS is linked we can offer a one-click scan.
  useEffect(() => {
    if (!address) {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    fetchFarcasterUser(address)
      .then((user) => !cancelled && setSuggestion(user))
      .catch(() => !cancelled && setSuggestion(null));
    return () => {
      cancelled = true;
    };
  }, [address]);

  // --- E11: weave the connected wallet's trust circle into the results. ---
  // Keyed on phase + scanId + wallet so it refetches only when the wallet the
  // map was built for no longer matches the connected one (no stale-race). This
  // same path is what the D6 "retry trust" link re-invokes (via trustWallet
  // reset in handleRetryTrust). On success it sets friends' trust AND marks the
  // result trustLoaded so the headline/filters/badges update.
  const scanIdResult = result?.scanId;
  useEffect(() => {
    if (!address || phase !== "results") return;
    if (trustWallet.current === address && (result?.trustLoaded ?? false)) return;

    let cancelled = false;
    getTrustMap(address)
      .then((map) => {
        if (cancelled) return;
        trustMap.current = map;
        trustWallet.current = address;
        setFriends((prev) =>
          prev.map((f) => ({ ...f, trust: map.get(f.address) ?? "none" })),
        );
        setResult((prev) =>
          prev
            ? {
                ...prev,
                trustMap: map,
                trustLoaded: true,
                failures: { ...prev.failures, trustUnavailable: false },
              }
            : prev,
        );
      })
      .catch(() => {
        if (cancelled) return;
        // leave trustUnavailable / trustLoaded as-is so D6 keeps offering retry
        setResult((prev) =>
          prev
            ? {
                ...prev,
                trustLoaded: false,
                failures: { ...prev.failures, trustUnavailable: true },
              }
            : prev,
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, phase, scanIdResult, trustNonce]);

  /** Show a cached or freshly-computed result, wiring shared refs. */
  const adoptResult = useCallback((res: ScanResult, cached: boolean) => {
    trustMap.current = res.trustMap;
    trustWallet.current = res.trustLoaded ? trustWallet.current : null;
    setResult(res);
    setFriends(res.friends);
    setDeep(null);
    setFollowersScan(null);
    setRetry({ phase: "idle" });
    setFromCache(cached);
    setPhase("results");
  }, []);

  // --- scan ---
  const runFreshScan = useCallback(
    async (username: string) => {
      const id = ++scanId.current;
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;

      setPhase("scanning");
      setScanHandle(username);
      setScanUser(null);
      setScanError(null);
      setFailedStep(null);
      setProgress({ step: 0 });
      setResult(null);
      setFriends([]);
      setDeep(null);
      setFollowersScan(null);
      setRetry({ phase: "idle" });
      setFromCache(false);

      let lastStep = 0;
      try {
        const res = await runScan(
          username,
          address,
          (user) => scanId.current === id && setScanUser(user),
          (p) => {
            if (scanId.current !== id) return;
            lastStep = p.step;
            setProgress(p);
          },
          (patches) =>
            scanId.current === id &&
            setFriends((prev) => patchHydration(prev, patches)),
          ctrl.signal,
        );
        if (scanId.current !== id) return;
        trustWallet.current = res.trustLoaded ? address : null;
        adoptResult(res, false);
        writeCache(res);
      } catch (err) {
        if (scanId.current !== id) return;
        // D4: stay on the scanning screen with the failed stage marked, rather
        // than bouncing to idle. The user retries in place.
        setFailedStep(Math.min(lastStep, STAGE_COUNT - 1));
        setScanError(
          err instanceof Error ? err.message : "The scan failed — try again.",
        );
      }
    },
    [address, adoptResult],
  );

  // Entry point: try the cache first (D7), else run a fresh scan.
  const handleScan = useCallback(
    async (username: string) => {
      const id = ++scanId.current;
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;

      setPhase("scanning");
      setScanHandle(username);
      setScanUser(null);
      setScanError(null);
      setFailedStep(null);
      setProgress({ step: 0 });
      setResult(null);
      setFriends([]);

      // Resolve the handle to a fid so we can probe the cache. If this fails the
      // fresh scan below will surface the same error in-place (D4).
      let user: FarcasterUser | null = null;
      try {
        user = await fetchFarcasterUser(username);
        if (scanId.current !== id) return;
        setScanUser(user);
        const cached = readCache(user.fid);
        if (cached) {
          adoptResult(cached, true);
          return;
        }
      } catch {
        // fall through to runFreshScan, which re-resolves and reports failure
      }
      if (scanId.current !== id) return;
      await runFreshScan(username);
    },
    [adoptResult, runFreshScan],
  );

  const handleRetryScan = useCallback(() => {
    void runFreshScan(scanHandle);
  }, [runFreshScan, scanHandle]);

  // D7 rescan: drop the cache and run a fresh scan for the same handle.
  const handleRescan = useCallback(() => {
    if (result) clearCache(result.user.fid);
    void runFreshScan(scanHandle);
  }, [result, scanHandle, runFreshScan]);

  const handleCancel = useCallback(() => {
    scanId.current++;
    controller.current?.abort();
    setScanError(null);
    setFailedStep(null);
    setPhase("idle");
  }, []);

  const handleReset = useCallback(() => {
    scanId.current++;
    controller.current?.abort();
    setPhase("idle");
    setScanError(null);
    setFailedStep(null);
    setResult(null);
    setFriends([]);
    setDeep(null);
    setFollowersScan(null);
    setRetry({ phase: "idle" });
    setFromCache(false);
  }, []);

  // --- deep scan (mutually exclusive with retry + followers scan) ---
  const handleDeepScan = useCallback(async () => {
    if (!result || deep || followersScan?.phase === "running" || retry.phase === "retrying")
      return;
    const id = scanId.current;
    const ctrl = controller.current ?? new AbortController();
    controller.current = ctrl;
    // Keyless lookups are one-call-per-fid, so cap the sweep; a bulk provider
    // (Neynar) does 100/call, so sweep the whole candidate list.
    const cap = result.bulkProvider ? result.deepScanCandidates.length : DEEP_SCAN_CAP;
    const fids = result.deepScanCandidates.slice(0, cap);
    setDeep({
      phase: "running",
      progress: { checked: 0, total: fids.length, found: 0 },
    });
    try {
      const { friends: extra, checked, failures: deepFailures } = await runDeepScan(
        fids,
        result.checkedAddresses,
        trustMap.current,
        result.relation,
        (p) => scanId.current === id && setDeep({ phase: "running", progress: p }),
        (patches) =>
          scanId.current === id && setFriends((prev) => patchHydration(prev, patches)),
        ctrl.signal,
      );
      if (scanId.current !== id) return;
      setFriends((prev) => {
        const seen = new Set(prev.map((f) => f.address));
        return [...prev, ...extra.filter((f) => !seen.has(f.address))];
      });
      setDeep({ phase: "done", checked, found: extra.length });
      // Persist the enriched result so the cache reflects the deep-scan finds,
      // and fold the deep sweep's OWN failures into the ledger (m2: otherwise
      // they're silently dropped and never surface in D2 / become retry-eligible).
      setResult((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.friends.map((f) => f.address));
        const verificationFids = [
          ...new Set([...prev.failures.verificationFids, ...deepFailures.verificationFids]),
        ];
        const addresses = new Map(prev.failures.addresses);
        for (const [addr, fid] of deepFailures.addresses) addresses.set(addr, fid);
        const failures = { ...prev.failures, verificationFids, addresses };
        const merged = {
          ...prev,
          friends: [...prev.friends, ...extra.filter((f) => !seen.has(f.address))],
          failures,
          // unchecked derives from primaryFids (untouched by the deep sweep).
          unchecked: failures.primaryFids.length,
          completedAt: Date.now(),
        };
        writeCache(merged);
        return merged;
      });
    } catch {
      if (scanId.current !== id) return;
      setDeep(null);
      setToast({ kind: "error", text: "Deep scan failed — try again in a moment." });
    }
  }, [result, deep, followersScan?.phase, retry.phase]);

  // --- check your followers (opt-in secondary pass, mirrors handleDeepScan) ---
  // Sweeps the follower-only set (people who follow you that you don't follow
  // back) via runDeepScan. Verified addresses ⊇ primary, so the sweep finds them
  // whether or not their Circles wallet is their primary — no extra primary pass.
  const handleScanFollowers = useCallback(async () => {
    if (!result || followersScan || deep?.phase === "running" || retry.phase === "retrying")
      return;
    const id = scanId.current;
    const ctrl = controller.current ?? new AbortController();
    controller.current = ctrl;
    // follower-only fids = relation entries labeled "follower" (mutuals are
    // already covered by the main scan). Keyless caps the sweep; a bulk provider
    // (Neynar/HyperSnap) does 100/call, so sweep the whole list.
    const followerOnly = [...result.relation.entries()]
      .filter(([, rel]) => rel === "follower")
      .map(([fid]) => fid);
    const cap = result.bulkProvider ? followerOnly.length : FOLLOWERS_SCAN_CAP;
    const fids = followerOnly.slice(0, cap);
    setFollowersScan({
      phase: "running",
      progress: { checked: 0, total: fids.length, found: 0 },
    });
    try {
      const { friends: extra, checked, failures: scanFailures } = await runDeepScan(
        fids,
        result.checkedAddresses,
        trustMap.current,
        result.relation,
        (p) => scanId.current === id && setFollowersScan({ phase: "running", progress: p }),
        (patches) =>
          scanId.current === id && setFriends((prev) => patchHydration(prev, patches)),
        ctrl.signal,
      );
      if (scanId.current !== id) return;
      // a follower found on Circles is just a follower match (← glyph via the
      // relation map) — not a "deep" find, so don't keep the deep badge (RD-2).
      const honest = extra.map((f) => ({ ...f, viaDeepScan: false }));
      setFriends((prev) => {
        const seen = new Set(prev.map((f) => f.address));
        return [...prev, ...honest.filter((f) => !seen.has(f.address))];
      });
      setFollowersScan({ phase: "done", checked, found: honest.length });
      setResult((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.friends.map((f) => f.address));
        const verificationFids = [
          ...new Set([...prev.failures.verificationFids, ...scanFailures.verificationFids]),
        ];
        const addresses = new Map(prev.failures.addresses);
        for (const [addr, fid] of scanFailures.addresses) addresses.set(addr, fid);
        const failures = { ...prev.failures, verificationFids, addresses };
        const merged = {
          ...prev,
          friends: [...prev.friends, ...honest.filter((f) => !seen.has(f.address))],
          failures,
          unchecked: failures.primaryFids.length,
          completedAt: Date.now(),
        };
        writeCache(merged);
        return merged;
      });
    } catch {
      if (scanId.current !== id) return;
      setFollowersScan(null);
      setToast({ kind: "error", text: "Followers scan failed — try again in a moment." });
    }
  }, [result, followersScan, deep?.phase, retry.phase]);

  // --- D3 retry: re-check the failed primary/verification/address sets. ---
  const handleRetry = useCallback(async () => {
    if (
      !result ||
      retry.phase === "retrying" ||
      deep?.phase === "running" ||
      followersScan?.phase === "running"
    )
      return;
    const id = scanId.current;
    const ctrl = controller.current ?? new AbortController();
    controller.current = ctrl;
    const launched = result;
    setRetry({ phase: "retrying", checked: 0, total: 0 });
    try {
      const outcome = await runRetry(
        launched,
        (checked, total) =>
          scanId.current === id && setRetry({ phase: "retrying", checked, total }),
        ctrl.signal,
      );
      if (scanId.current !== id) return;
      // applyRetryOutcome is pure and atomic over result + friends; it bails if
      // the scanId no longer matches (stale retry).
      let foundCount = 0;
      let stillFailed = false;
      setResult((prevResult) => {
        if (!prevResult) return prevResult;
        const { result: nextResult, friends: nextFriends } = applyRetryOutcome(
          prevResult,
          friendsRef.current,
          outcome,
        );
        foundCount = nextFriends.length - friendsRef.current.length;
        // D3: any non-empty failure class means residual failures remain — the
        // StatusBlock stays up (partial-success); only an all-clear collapses it.
        const f = nextResult.failures;
        stillFailed =
          f.primaryFids.length > 0 ||
          f.verificationFids.length > 0 ||
          f.addresses.size > 0;
        setFriends(nextFriends);
        writeCache(nextResult);
        return nextResult;
      });
      setRetry(
        stillFailed
          ? { phase: "partial-success", found: foundCount }
          : { phase: "resolved", found: foundCount },
      );
    } catch {
      if (scanId.current !== id) return;
      setRetry({ phase: "idle" });
      setToast({ kind: "error", text: "Retry failed — try again in a moment." });
    }
  }, [result, retry.phase, deep?.phase, followersScan?.phase]);

  // D6 "retry trust": re-arm the E11 effect by clearing the recorded wallet so
  // it refetches getTrustMap on the next render.
  const handleRetryTrust = useCallback(() => {
    trustWallet.current = null;
    setResult((prev) => (prev ? { ...prev, trustLoaded: false } : prev));
    setTrustNonce((n) => n + 1);
  }, []);

  // --- trust / untrust ---
  const handleToggle = useCallback(
    async (friend: Friend, trusted: boolean) => {
      if (busyAddress) return;
      setBusyAddress(friend.address);
      setToast({
        kind: "pending",
        text: trusted
          ? `Trusting ${friend.displayName} — confirm in your Safe…`
          : `Removing trust for ${friend.displayName} — confirm in your Safe…`,
      });
      try {
        const hash = await setTrust(friend.address, trusted);
        // Patch BOTH lists by address: the row lives in only one (Farcaster vs
        // source), so patching both is safe and idempotent.
        setFriends((prev) =>
          prev.map((f) =>
            f.address === friend.address ? { ...f, trust: nextTrust(f.trust, trusted) } : f,
          ),
        );
        setSourceFriends((prev) =>
          prev.map((f) =>
            f.address === friend.address ? { ...f, trust: nextTrust(f.trust, trusted) } : f,
          ),
        );
        const updated = nextTrust(friend.trust, trusted);
        if (updated === "none") trustMap.current.delete(friend.address);
        else trustMap.current.set(friend.address, updated);
        setToast({
          kind: "success",
          text: trusted
            ? `You now trust ${friend.displayName}.`
            : `Trust removed for ${friend.displayName}.`,
          hash,
        });
      } catch (err) {
        setToast({
          kind: "error",
          text:
            err instanceof Error && !/reject|denied|cancel/i.test(err.message)
              ? err.message
              : "Transaction declined.",
        });
      } finally {
        setBusyAddress(null);
      }
    },
    [busyAddress],
  );

  // --- trust2 discovery: cache-first discover + match (mirrors handleScan). ---
  // `bypassCache` skips the read (rescan path). Every state set is guarded by
  // sourceRunId so a stale run can't clobber a newer one (mirrors scanId).
  const runSource = useCallback(
    async (seed: string, bypassCache: boolean) => {
      const id = ++sourceRunId.current;
      setSourceError(null);

      if (!bypassCache) {
        const cached = readSourceCache("trust2", seed);
        if (cached) {
          if (sourceRunId.current !== id) return;
          setSourceFriends(cached.friends);
          setSourceStats(cached.stats);
          setSourceTruncated(cached.truncated);
          setSourceCompletedAt(cached.completedAt);
          setSourceFromCache(true);
          setSourceLoading(false);
          return;
        }
      }

      setSourceLoading(true);
      try {
        const controller = new AbortController();
        const res = await getSource("trust2").discover(seed, controller.signal);
        if (sourceRunId.current !== id) return;
        const friends = await matchSource(res, seed, controller.signal);
        if (sourceRunId.current !== id) return;
        const completedAt = Date.now();
        setSourceFriends(friends);
        setSourceStats(res.stats);
        setSourceTruncated(!!res.truncated);
        setSourceCompletedAt(completedAt);
        setSourceFromCache(false);
        setSourceLoading(false);
        writeSourceCache("trust2", seed, friends, res.stats, !!res.truncated);
      } catch {
        if (sourceRunId.current !== id) return;
        setSourceLoading(false);
        setSourceError("Couldn't load friends of friends — try again.");
      }
    },
    [],
  );

  // Default-tab promotion: once connected + registered, surface trust2 as the
  // landing tab — unless the user has already picked a tab themselves.
  useEffect(() => {
    if (userPickedTab.current) return;
    if (isConnected && identity?.registered) setActiveSource("trust2");
  }, [isConnected, identity?.registered]);

  // trust2 auto-run: cache-first discover + match whenever trust2 is the active
  // tab and the connected wallet is a registered Circles avatar.
  useEffect(() => {
    if (activeSource !== "trust2" || !address || !identity?.registered) return;
    void runSource(address.toLowerCase(), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource, address, identity?.registered]);

  // Source trust-refresh: only on the cached-adopt path, re-run getTrustMap and
  // patch sourceFriends.trust — mirrors the Farcaster E11 effect. A fresh run
  // already has current trust from matchSource, so it skips this.
  useEffect(() => {
    if (!sourceFromCache || activeSource !== "trust2" || !address) return;
    let cancelled = false;
    getTrustMap(address.toLowerCase())
      .then((map) => {
        if (cancelled) return;
        setSourceFriends((prev) =>
          prev.map((f) => ({ ...f, trust: map.get(f.address) ?? "none" })),
        );
      })
      .catch(() => {
        /* leave the cached trust as-is on failure (degrade) */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource, address, sourceCompletedAt, sourceFromCache]);

  // Rescan: drop the cache and re-run discover (fromCache → false).
  const handleSourceRescan = useCallback(() => {
    if (!address) return;
    const seed = address.toLowerCase();
    clearSourceCache("trust2", seed);
    void runSource(seed, true);
  }, [address, runSource]);

  // Tab selection: routes Farcaster to the EXISTING scan flow (never
  // getSource("farcaster") — it's unregistered and throws).
  const handleSelectSource = useCallback((id: SourceId) => {
    userPickedTab.current = true;
    setActiveSource(id);
  }, []);

  const canAct = isConnected && (identity?.registered ?? false);
  const lockReason = !isConnected ? "no wallet" : "not on Circles";

  // Empty-state discriminator for the trust2 tab (see §4's load-state table).
  const sourceEmptyKind: SourceEmptyKind = !isConnected
    ? "not-connected"
    : identity?.registered === false
      ? "not-avatar"
      : (sourceStats.contacts ?? 0) === 0 && !sourceLoading && sourceCompletedAt != null
        ? "no-first-degree"
        : "no-matches";

  // Tabs in registry order: trust2 first (default position), Farcaster always
  // present. INSERTION POINT — append { id: "snapshot", label: "Shared DAOs" }.
  const sourceTabs: { id: SourceId; label: string }[] = [
    { id: "trust2", label: "Friends of friends" },
    { id: "farcaster", label: "Farcaster" },
  ];
  // trust2 is greyed (not hidden) until the connected wallet is a registered
  // Circles avatar.
  const tabsDisabled = canAct
    ? undefined
    : { trust2: "Connect a Circles account" };

  // follower-only count (people who follow you that you don't follow back) —
  // drives the opt-in "check your followers" card. Derived from the relation map
  // to avoid a ScanResult schema/cache change (RD-3).
  const followerOnlyCount = result
    ? [...result.relation.values()].filter((rel) => rel === "follower").length
    : 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <Header identity={identity} />

      {!isMiniappHost && (
        <p className="border-b border-line bg-parch/50 px-5 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink-soft">
          standalone preview — wallet features need the Circles host
        </p>
      )}

      <SourceTabs
        active={activeSource}
        onSelect={handleSelectSource}
        tabs={sourceTabs}
        disabled={tabsDisabled}
      />

      <main className="flex-1">
        {activeSource === "farcaster" && (
          <>
            {phase === "idle" && (
              <Hero onScan={handleScan} error={scanError} suggestion={suggestion} />
            )}

            {phase === "scanning" && (
              <ScanProgress
                handle={scanHandle}
                user={scanUser}
                progress={progress}
                scanError={scanError}
                failedStep={failedStep}
                onCancel={handleCancel}
                onRetryScan={handleRetryScan}
              />
            )}

            {phase === "results" && result && (
              <Results
                user={result.user}
                followingTotal={result.followingTotal}
                followersTotal={result.followersTotal}
                withWallet={result.withWallet}
                truncated={result.truncated}
                unchecked={result.unchecked}
                autoSwept={result.autoSwept}
                friends={friends}
                failures={result.failures}
                trustLoaded={result.trustLoaded}
                retry={retry}
                fromCache={fromCache}
                completedAt={result.completedAt}
                canAct={canAct}
                lockReason={lockReason}
                busyAddress={busyAddress}
                deep={deep}
                deepCandidateCount={result.deepScanCandidates.length}
                deepScanLimit={
                  result.bulkProvider
                    ? result.deepScanCandidates.length
                    : Math.min(DEEP_SCAN_CAP, result.deepScanCandidates.length)
                }
                followersScan={followersScan}
                followerOnlyCount={followerOnlyCount}
                onToggle={handleToggle}
                onDeepScan={handleDeepScan}
                onScanFollowers={handleScanFollowers}
                onReset={handleReset}
                onRetry={handleRetry}
                onRetryTrust={handleRetryTrust}
                onRescan={handleRescan}
              />
            )}
          </>
        )}

        {activeSource === "trust2" && (
          <SourceResults
            source={getSource("trust2")}
            friends={sourceFriends}
            stats={sourceStats}
            truncated={sourceTruncated}
            loading={sourceLoading}
            error={sourceError}
            trustLoaded={sourceCompletedAt != null && !sourceLoading}
            fromCache={sourceFromCache}
            completedAt={sourceCompletedAt}
            canAct={canAct}
            lockReason={lockReason}
            busyAddress={busyAddress}
            emptyKind={sourceEmptyKind}
            onToggle={handleToggle}
            onRescan={handleSourceRescan}
          />
        )}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-center gap-1.5 px-5 py-3.5 font-mono text-[10px] uppercase tracking-[0.14em] whitespace-nowrap text-ink-faint">
          <VennMark size={16} />
          common circles
        </div>
      </footer>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

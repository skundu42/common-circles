"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Header, type CirclesIdentity } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Results, type DeepState } from "@/components/Results";
import { ScanProgress } from "@/components/ScanProgress";
import { Toast, type ToastState } from "@/components/Toast";
import { VennMark } from "@/components/VennFigure";
import { useWallet } from "@/components/wallet";
import { fetchFarcasterUser } from "@/lib/api";
import { getMyCirclesIdentity, getTrustMap, setTrust } from "@/lib/circles";
import {
  runDeepScan,
  runScan,
  type ScanProgress as Progress,
  type ScanResult,
  type TrustMap,
} from "@/lib/scan";
import type { FarcasterUser, Friend, TrustState } from "@/lib/types";

type Phase = "idle" | "scanning" | "results";

function nextTrust(current: TrustState, trusted: boolean): TrustState {
  if (trusted) return current === "trustedBy" ? "mutuallyTrusts" : "trusts";
  return current === "mutuallyTrusts" ? "trustedBy" : "none";
}

export function App() {
  const { address, isConnected, isMiniappHost } = useWallet();

  const [identity, setIdentity] = useState<CirclesIdentity | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [scanHandle, setScanHandle] = useState("");
  const [scanUser, setScanUser] = useState<FarcasterUser | null>(null);
  const [progress, setProgress] = useState<Progress>({ step: 0 });
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [deep, setDeep] = useState<DeepState | null>(null);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [suggestion, setSuggestion] = useState<FarcasterUser | null>(null);

  // Bumped to invalidate in-flight scans (cancel / reset / new scan).
  const scanId = useRef(0);
  // The connected avatar's trust circle; shared with deep-scan hydration.
  const trustMap = useRef<TrustMap>(new Map());

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

  // --- If the wallet arrives after a scan, weave its trust circle in ---
  useEffect(() => {
    if (!address || phase !== "results") return;
    let cancelled = false;
    getTrustMap(address)
      .then((map) => {
        if (cancelled) return;
        trustMap.current = map;
        setFriends((prev) =>
          prev.map((f) => ({ ...f, trust: map.get(f.address) ?? "none" })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // --- scan ---
  const handleScan = useCallback(
    async (username: string) => {
      const id = ++scanId.current;
      setPhase("scanning");
      setScanHandle(username);
      setScanUser(null);
      setScanError(null);
      setProgress({ step: 0 });
      setResult(null);
      setFriends([]);
      setDeep(null);
      try {
        const res = await runScan(
          username,
          address,
          (user) => scanId.current === id && setScanUser(user),
          (p) => scanId.current === id && setProgress(p),
        );
        if (scanId.current !== id) return;
        trustMap.current = res.trustMap;
        setResult(res);
        setFriends(res.friends);
        setPhase("results");
      } catch (err) {
        if (scanId.current !== id) return;
        setScanError(err instanceof Error ? err.message : "The scan failed — try again.");
        setPhase("idle");
      }
    },
    [address],
  );

  const handleCancel = useCallback(() => {
    scanId.current++;
    setPhase("idle");
  }, []);

  const handleReset = useCallback(() => {
    scanId.current++;
    setPhase("idle");
    setScanError(null);
    setResult(null);
    setFriends([]);
    setDeep(null);
  }, []);

  // --- deep scan ---
  const handleDeepScan = useCallback(async () => {
    if (!result || deep) return;
    const id = scanId.current;
    setDeep({
      phase: "running",
      progress: { checked: 0, total: Math.min(result.deepScanCandidates.length, 300), found: 0 },
    });
    try {
      const { friends: extra, checked } = await runDeepScan(
        result.deepScanCandidates,
        result.checkedAddresses,
        trustMap.current,
        result.relation,
        (p) => scanId.current === id && setDeep({ phase: "running", progress: p }),
      );
      if (scanId.current !== id) return;
      setFriends((prev) => {
        const seen = new Set(prev.map((f) => f.address));
        return [...prev, ...extra.filter((f) => !seen.has(f.address))];
      });
      setDeep({ phase: "done", checked, found: extra.length });
    } catch {
      if (scanId.current !== id) return;
      setDeep(null);
      setToast({ kind: "error", text: "Deep scan failed — try again in a moment." });
    }
  }, [result, deep]);

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
        setFriends((prev) =>
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

  const canAct = isConnected && (identity?.registered ?? false);
  const lockReason = !isConnected ? "no wallet" : "not on Circles";

  return (
    <div className="flex min-h-dvh flex-col">
      <Header identity={identity} />

      {!isMiniappHost && (
        <p className="border-b border-line bg-parch/50 px-5 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink-soft">
          standalone preview — wallet features need the Circles host
        </p>
      )}

      <main className="flex-1">
        {phase === "idle" && (
          <Hero onScan={handleScan} error={scanError} suggestion={suggestion} />
        )}

        {phase === "scanning" && (
          <ScanProgress
            handle={scanHandle}
            user={scanUser}
            progress={progress}
            onCancel={handleCancel}
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
            canAct={canAct}
            lockReason={lockReason}
            busyAddress={busyAddress}
            deep={deep}
            deepCandidateCount={result.deepScanCandidates.length}
            onToggle={handleToggle}
            onDeepScan={handleDeepScan}
            onReset={handleReset}
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

"use client";

import { useEffect, useState, type FormEvent } from "react";

import { VennFigure } from "@/components/VennFigure";
import type { FarcasterUser } from "@/lib/types";

const HANDLE_KEY = "common-circles:handle";

export function Hero({
  onScan,
  error,
  suggestion,
}: {
  onScan: (query: string) => void;
  error: string | null;
  /** Farcaster account auto-detected from the connected wallet, if any. */
  suggestion: FarcasterUser | null;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem(HANDLE_KEY);
    if (saved) setQuery(saved);
  }, []);

  const isAddressInput = query.trim().toLowerCase().startsWith("0x");

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = query.trim().replace(/^@/, "").toLowerCase();
    if (!value) return;
    window.localStorage.setItem(HANDLE_KEY, value);
    onScan(value);
  }

  return (
    <section className="mx-auto w-full max-w-xl px-5 pt-10 pb-16 sm:pt-14">
      <VennFigure className="rise mx-auto w-[230px] sm:w-[260px]" />

      <h1
        className="rise mt-8 text-center font-display text-[42px] leading-[1.02] font-medium tracking-tight sm:text-[54px]"
        style={{ animationDelay: "80ms" }}
      >
        Two networks,
        <br />
        <em className="font-light">same people.</em>
      </h1>

      <p
        className="rise mx-auto mt-5 max-w-md text-center text-[15px] leading-relaxed text-ink-soft"
        style={{ animationDelay: "160ms" }}
      >
        Sweep everyone you follow on{" "}
        <strong className="font-semibold text-violet-deep">Farcaster</strong>, find who
        already lives on{" "}
        <strong className="font-semibold text-leaf-deep">Circles</strong>, and trust
        them from your Circles account, right here.
      </p>

      <form
        onSubmit={submit}
        className="rise mx-auto mt-9 flex max-w-md flex-col gap-3 sm:flex-row"
        style={{ animationDelay: "240ms" }}
      >
        <label className="flex flex-1 items-baseline gap-1 border-b-2 border-ink/70 pb-2 transition-colors focus-within:border-violet-deep">
          {!isAddressInput && <span className="font-display text-xl text-ink-faint">@</span>}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="handle · ens · 0x address"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className={`w-full bg-transparent outline-none placeholder:text-ink-faint ${
              isAddressInput ? "font-mono text-sm" : "text-lg"
            }`}
            aria-label="Farcaster handle, ENS name, or wallet address"
          />
        </label>
        <button type="submit" className="btn-ink px-6 py-2.5 text-sm" disabled={!query.trim()}>
          Find the overlap
          <span aria-hidden="true">→</span>
        </button>
      </form>

      {suggestion && (
        <div className="rise mx-auto mt-5 flex max-w-md justify-center" style={{ animationDelay: "120ms" }}>
          <button
            onClick={() => onScan(suggestion.username)}
            className="group flex items-center gap-2.5 rounded-full border border-line bg-cream py-1.5 pr-4 pl-1.5 transition-colors hover:border-violet"
          >
            {suggestion.pfpUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={suggestion.pfpUrl}
                alt=""
                className="h-7 w-7 rounded-full bg-parch object-cover ring-1 ring-violet/40"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-wash font-display text-xs text-violet-deep">
                {suggestion.username.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="text-[13px] text-ink-soft">
              Your wallet looks like{" "}
              <strong className="font-semibold text-violet-deep">@{suggestion.username}</strong>
            </span>
            <span className="font-mono text-[11px] text-ink-faint transition-colors group-hover:text-violet-deep">
              scan →
            </span>
          </button>
        </div>
      )}

      {error && (
        <p className="mx-auto mt-4 max-w-md text-center text-sm text-rust" role="alert">
          {error}
        </p>
      )}

      <p
        className="rise mx-auto mt-6 max-w-md text-center font-mono text-[11px] leading-relaxed text-ink-faint"
        style={{ animationDelay: "320ms" }}
      >
        Read-only lookup — no Farcaster login, nothing signed.
        <br />
        Trusting happens through your Circles Safe.
        <br />
        Already on Circles? Try the <strong className="text-ink-soft">Friends of friends</strong> tab.
      </p>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { TrustBadge } from "@/components/TrustGlyph";
import type { FcRelation, Friend } from "@/lib/types";
import { shortenAddress } from "@/lib/util";

const RELATION_GLYPH: Record<FcRelation, { glyph: string; title: string }> = {
  mutualFollow: { glyph: "⇄", title: "You follow each other on Farcaster" },
  following: { glyph: "→", title: "You follow them on Farcaster" },
  follower: { glyph: "←", title: "They follow you on Farcaster" },
};

function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" className="spinner" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="26"
        strokeDashoffset="18"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AvatarPair({ friend }: { friend: Friend }) {
  const initial = (friend.circlesName ?? friend.displayName).slice(0, 1).toUpperCase();
  return (
    <div className="relative h-9 w-[52px] shrink-0">
      {friend.pfpUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={friend.pfpUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute left-0 top-0 h-9 w-9 rounded-full bg-parch object-cover ring-2 ring-violet/50"
        />
      ) : (
        <span className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-violet-wash font-display text-sm text-violet-deep ring-2 ring-violet/50">
          {friend.username.slice(0, 1).toUpperCase()}
        </span>
      )}
      {friend.circlesImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={friend.circlesImageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute left-4 top-0 h-9 w-9 rounded-full bg-parch object-cover ring-2 ring-leaf/60"
        />
      ) : (
        <span className="absolute left-4 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-leaf-wash font-display text-sm text-leaf-deep ring-2 ring-leaf/60">
          {initial}
        </span>
      )}
    </div>
  );
}

export function FriendRow({
  friend,
  index,
  canAct,
  lockReason,
  busy,
  onToggle,
}: {
  friend: Friend;
  index: number;
  canAct: boolean;
  lockReason: string;
  busy: boolean;
  onToggle: (friend: Friend, trusted: boolean) => void;
}) {
  const trusted = friend.trust === "trusts" || friend.trust === "mutuallyTrusts";
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  function handleClick() {
    if (!canAct || busy) return;
    if (!trusted) {
      onToggle(friend, true);
      return;
    }
    // untrust needs a second click within a few seconds
    if (!confirming) {
      setConfirming(true);
      confirmTimer.current = setTimeout(() => setConfirming(false), 3500);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(false);
    onToggle(friend, false);
  }

  return (
    <li
      className="rise flex flex-wrap items-center gap-x-3 gap-y-2 py-3.5 sm:flex-nowrap"
      style={{ animationDelay: `${Math.min(index, 14) * 45}ms` }}
    >
      <AvatarPair friend={friend} />

      <div className="min-w-0 flex-1 basis-40">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-semibold">{friend.displayName}</span>
          <a
            href={`https://farcaster.xyz/${friend.username}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 font-mono text-[11px] text-violet-deep hover:underline"
          >
            @{friend.username}
          </a>
          <span
            className="shrink-0 cursor-default font-mono text-[11px] text-ink-faint"
            title={RELATION_GLYPH[friend.fcRelation].title}
          >
            {RELATION_GLYPH[friend.fcRelation].glyph}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-soft">
          {friend.circlesName && (
            <span className="max-w-[10rem] truncate text-leaf-deep">{friend.circlesName}</span>
          )}
          <a
            href={`https://gnosisscan.io/address/${friend.address}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-ink-faint hover:text-ink-soft hover:underline"
            title={friend.address}
          >
            {shortenAddress(friend.address)}
          </a>
          {friend.kind !== "human" && (
            <span className="rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              {friend.kind === "organization" ? "org" : "group"}
            </span>
          )}
          {friend.viaDeepScan && (
            <span
              className="rounded-full border border-dashed border-ink-faint px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-ink-faint"
              title="Found via deep scan — Circles avatar on a non-primary verified wallet"
            >
              deep
            </span>
          )}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <TrustBadge state={friend.trust} />
        {canAct ? (
          <button
            onClick={handleClick}
            disabled={busy}
            className={`${trusted ? "btn-ghost" : "btn-ink"} w-[88px] px-3 py-1.5 text-xs ${
              confirming ? "!border-rust !text-rust" : ""
            }`}
          >
            {busy ? (
              <Spinner />
            ) : trusted ? (
              confirming ? (
                "Sure?"
              ) : (
                "Untrust"
              )
            ) : (
              "Trust"
            )}
          </button>
        ) : (
          <span
            className="w-[88px] text-center font-mono text-[10px] leading-tight text-ink-faint"
            title={lockReason}
          >
            ⌀ {lockReason}
          </span>
        )}
      </div>
    </li>
  );
}

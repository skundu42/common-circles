"use client";

import { VennFigure } from "@/components/VennFigure";
import type { ScanProgress as Progress } from "@/lib/scan";
import type { FarcasterUser } from "@/lib/types";
import { shortenAddress } from "@/lib/util";

const STAGES = [
  "Reading the follow graph",
  "Collecting verified wallets",
  "Sweeping the Circles registry",
  "Weaving in your trust circle",
] as const;

function detailFor(index: number, progress: Progress): string | null {
  if (index === 0 && progress.followingTotal !== undefined)
    return `${progress.followingTotal.toLocaleString()} out · ${(
      progress.followersTotal ?? 0
    ).toLocaleString()} in`;
  if (index === 1 && progress.withWallet !== undefined)
    return `${progress.withWallet.toLocaleString()} wallets`;
  if (index === 2 && progress.sweep)
    return `${progress.matches ?? 0} found · ${progress.sweep.checked}/${progress.sweep.total}`;
  if (index === 2 && progress.matches !== undefined)
    return `${progress.matches.toLocaleString()} found`;
  return null;
}

export function ScanProgress({
  handle,
  user,
  progress,
  onCancel,
}: {
  handle: string;
  user: FarcasterUser | null;
  progress: Progress;
  onCancel: () => void;
}) {
  return (
    <section className="mx-auto w-full max-w-sm px-5 pt-10 pb-16 text-center sm:pt-14">
      <VennFigure scanning className="mx-auto w-[210px]" />

      <p className="mt-8 font-display text-2xl tracking-tight">
        Sweeping{" "}
        <em>
          {user
            ? `@${user.username}`
            : handle.startsWith("0x")
              ? shortenAddress(handle)
              : `@${handle}`}
        </em>
        ’s graph…
      </p>
      {user && (
        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          fid {user.fid} · follows {user.followingCount.toLocaleString()}
        </p>
      )}

      <ol className="mx-auto mt-9 max-w-[300px] space-y-3.5 text-left">
        {STAGES.map((label, i) => {
          const done = progress.step > i;
          const active = progress.step === i;
          const detail = detailFor(i, progress);
          return (
            <li key={label} className="flex items-center gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                {done ? (
                  <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
                    <path
                      d="M2.5 8l3.2 3.2L12.5 4"
                      fill="none"
                      stroke="var(--color-leaf-deep)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : active ? (
                  <span className="soft-pulse h-2.5 w-2.5 rounded-full bg-violet" />
                ) : (
                  <span className="h-2 w-2 rounded-full border border-ink-faint" />
                )}
              </span>
              <span
                className={`flex-1 text-sm ${
                  done ? "text-ink" : active ? "font-medium text-ink" : "text-ink-faint"
                }`}
              >
                {label}
              </span>
              {detail && (
                <span className="font-mono text-[11px] tabular-nums text-ink-soft">
                  {detail}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-8 text-xs text-ink-faint">
        {progress.sweep
          ? "Checking every verified wallet — this is the thorough part."
          : "Large follow graphs can take a little while."}
      </p>
      <button
        onClick={onCancel}
        className="mt-2 font-mono text-[11px] text-ink-soft underline underline-offset-4 hover:text-rust"
      >
        cancel
      </button>
    </section>
  );
}

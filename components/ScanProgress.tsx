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
  scanError,
  failedStep,
  onCancel,
  onRetryScan,
}: {
  handle: string;
  user: FarcasterUser | null;
  progress: Progress;
  /** Set when the scan died hard (D4); keeps this screen mounted with the failure in place. */
  scanError: string | null;
  /** Which stage (STAGES index) was running when it died (D4). */
  failedStep: number | null;
  onCancel: () => void;
  /** Re-run the scan from the failed stage (D4). */
  onRetryScan: () => void;
}) {
  const errored = scanError !== null;
  return (
    <section className="mx-auto w-full max-w-sm px-5 pt-10 pb-16 text-center sm:pt-14">
      <VennFigure scanning className="mx-auto w-[210px]" />

      <p className="mt-8 font-display text-2xl tracking-tight">
        {errored ? "Scan hit a snag for " : "Sweeping "}
        <em>
          {user
            ? `@${user.username}`
            : handle.startsWith("0x")
              ? shortenAddress(handle)
              : `@${handle}`}
        </em>
        {errored ? "." : "’s graph…"}
      </p>
      {user && (
        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          fid {user.fid} · follows {user.followingCount.toLocaleString()}
        </p>
      )}

      <ol
        className="mx-auto mt-9 max-w-[300px] space-y-3.5 text-left"
        aria-live="polite"
      >
        {STAGES.map((label, i) => {
          const failed = errored && failedStep === i;
          const done = !errored && progress.step > i;
          const active = !errored && progress.step === i;
          const detail = detailFor(i, progress);
          return (
            <li key={label} className="flex items-center gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                {failed ? (
                  <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
                    <path
                      d="M3 3l9 9M12 3l-9 9"
                      fill="none"
                      stroke="var(--color-rust)"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : done ? (
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
                  failed
                    ? "font-medium text-rust"
                    : done
                      ? "text-ink"
                      : active
                        ? "font-medium text-ink"
                        : "text-ink-faint"
                }`}
              >
                {label}
              </span>
              {detail && !failed && (
                <span className="font-mono text-[11px] tabular-nums text-ink-soft">
                  {detail}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {errored ? (
        <div className="mt-8" role="alert">
          <p className="text-sm text-rust">{scanError}</p>
          <div className="mt-3 flex items-center justify-center gap-4">
            <button onClick={onRetryScan} className="btn-ink px-5 py-2 text-xs">
              Try again
            </button>
            <button
              onClick={onCancel}
              className="font-mono text-[11px] text-ink-soft underline underline-offset-4 hover:text-rust"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <>
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
        </>
      )}
    </section>
  );
}

"use client";

import { useEffect } from "react";

import { explorerTxUrl } from "@/lib/circles";

export type ToastState =
  | { kind: "pending"; text: string }
  | { kind: "success"; text: string; hash?: string }
  | { kind: "error"; text: string };

export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast || toast.kind === "pending") return;
    const timer = setTimeout(onDismiss, toast.kind === "success" ? 6000 : 8000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-5">
      <div
        role="status"
        className="rise pointer-events-auto flex max-w-md items-center gap-3 border border-ink bg-cream px-4 py-3 text-sm shadow-[4px_4px_0_0_var(--color-ink-faint)]"
      >
        {toast.kind === "pending" && (
          <svg width="14" height="14" viewBox="0 0 14 14" className="spinner shrink-0 text-violet-deep" aria-hidden="true">
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
        )}
        {toast.kind === "success" && (
          <svg width="15" height="15" viewBox="0 0 15 15" className="shrink-0" aria-hidden="true">
            <path
              d="M2.5 8l3.2 3.2L12.5 4"
              fill="none"
              stroke="var(--color-leaf-deep)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {toast.kind === "error" && (
          <span className="shrink-0 font-display text-base leading-none text-rust">×</span>
        )}

        <span className="min-w-0 flex-1">
          {toast.text}
          {toast.kind === "success" && toast.hash && (
            <>
              {" "}
              <a
                href={explorerTxUrl(toast.hash)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-violet-deep underline underline-offset-2"
              >
                view tx ↗
              </a>
            </>
          )}
        </span>

        {toast.kind !== "pending" && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 text-ink-faint hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

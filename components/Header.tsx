"use client";

import { VennMark } from "@/components/VennFigure";
import { useWallet } from "@/components/wallet";
import { shortenAddress } from "@/lib/util";

export type CirclesIdentity = { registered: boolean; name: string | null };

export function Header({ identity }: { identity: CirclesIdentity | null }) {
  const { address, isConnected } = useWallet();

  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-3.5">
        <span className="flex items-center gap-2">
          <VennMark size={26} />
          <span className="font-display text-[17px] font-semibold tracking-tight">
            Common Circles
          </span>
        </span>

        {isConnected && address ? (
          <span
            className="flex min-w-0 items-center gap-2 rounded-full border border-line bg-cream py-1.5 pr-3 pl-2.5"
            title={address}
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-leaf" />
            {identity?.name ? (
              <span className="truncate text-xs font-medium">{identity.name}</span>
            ) : (
              <span className="truncate font-mono text-[11px] text-ink-soft">
                {shortenAddress(address)}
              </span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-2 rounded-full border border-dashed border-ink-faint py-1.5 px-3">
            <span className="h-2 w-2 shrink-0 rounded-full border border-ink-faint" />
            <span className="font-mono text-[11px] text-ink-soft">no wallet</span>
          </span>
        )}
      </div>
    </header>
  );
}

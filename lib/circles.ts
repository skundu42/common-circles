// Client-side Circles plumbing, following the boilerplate's two-SDK pattern:
//
//   @aboutcircles/sdk         → reads (rpc.*) + calldata encoding (core.hubV2.*)
//   @aboutcircles/miniapp-sdk → submit through the host's Safe (sendTransactions)
//
// Both SDKs touch `window`, so they are ONLY imported dynamically from inside
// client components / event handlers — never at module top level (type-only
// imports are fine).

import type { Sdk } from "@aboutcircles/sdk";
import type { AvatarInfo, Profile } from "@aboutcircles/sdk-types";
import { chunk, mapLimit } from "@/lib/util";
import type { CirclesAvatarKind, TrustState } from "@/lib/types";

/** Indefinite trust = max uint96 (the SDK's own default). Expiry 0 untrusts. */
export const INDEFINITE_TRUST_EXPIRY = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFF");

type Address = `0x${string}`;

let sdkSingleton: Sdk | null = null;

/** Memoized read-only Sdk (no signer) on Gnosis Chain mainnet defaults. */
export async function getSdk(): Promise<Sdk> {
  if (sdkSingleton) return sdkSingleton;
  const { Sdk } = await import("@aboutcircles/sdk");
  sdkSingleton = new Sdk();
  return sdkSingleton;
}

/**
 * Result of an avatar lookup: matched avatars plus the addresses whose batch
 * failed the RPC (after one retry) so callers can surface / retry them (E4).
 */
export type AvatarLookup = {
  avatars: Map<string, AvatarInfo>;
  /** lowercase addresses whose batch failed after the retry. */
  failedAddresses: string[];
};

/**
 * Which of `addresses` are registered Circles v2 HUMAN avatars. Groups,
 * organizations and v1-only signups are excluded — they aren't people you'd
 * trust from this app. Returns matched avatars keyed by lowercase address;
 * a batch that throws is retried once, then its addresses are reported in
 * `failedAddresses` rather than silently dropped (E4).
 */
export async function findCirclesAvatars(
  addresses: string[],
): Promise<AvatarLookup> {
  const sdk = await getSdk();
  const avatars = new Map<string, AvatarInfo>();
  const failedAddresses: string[] = [];
  if (addresses.length === 0) return { avatars, failedAddresses };
  const batches = chunk(addresses, 100);
  await mapLimit(batches, 4, async (batch) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const infos = await sdk.rpc.avatar.getAvatarInfoBatch(batch as Address[]);
        for (const info of infos) {
          if (info.version === 2 && info.isHuman) avatars.set(info.avatar.toLowerCase(), info);
        }
        return;
      } catch {
        // first failure: retry once; second failure: report the whole batch
        if (attempt === 1) failedAddresses.push(...batch.map((a) => a.toLowerCase()));
      }
    }
  });
  return { avatars, failedAddresses };
}

/** Circles profiles (name/image) for avatars, keyed by lowercase address. */
export async function getCirclesProfiles(
  addresses: string[],
): Promise<Map<string, Profile>> {
  const sdk = await getSdk();
  const map = new Map<string, Profile>();
  if (addresses.length === 0) return map;
  const batches = chunk(addresses, 50);
  const results = await mapLimit(batches, 4, async (batch) => {
    try {
      const profiles = await sdk.rpc.profile.getProfileByAddressBatch(batch as Address[]);
      return batch.map((address, i) => [address, profiles[i]] as const);
    } catch {
      return []; // profiles are decorative — degrade to addresses
    }
  });
  for (const rows of results) {
    for (const [address, profile] of rows) {
      if (profile) map.set(address.toLowerCase(), profile);
    }
  }
  return map;
}

/**
 * The connected avatar's full trust circle in one RPC call, keyed by
 * lowercase counterparty address.
 */
export async function getTrustMap(
  avatar: string,
): Promise<Map<string, Exclude<TrustState, "none">>> {
  const sdk = await getSdk();
  const rows = await sdk.rpc.trust.getAggregatedTrustRelations(avatar as Address);
  return new Map(rows.map((r) => [r.objectAvatar.toLowerCase(), r.relation]));
}

/** Minimal identity for the header badge. */
export async function getMyCirclesIdentity(
  address: string,
): Promise<{ registered: boolean; name: string | null }> {
  const sdk = await getSdk();
  const view = await sdk.rpc.profile.getProfileView(address as Address);
  return {
    registered: !!view.avatarInfo,
    name: view.profile?.name ?? null,
  };
}

export function avatarKind(info: AvatarInfo): CirclesAvatarKind {
  if (info.isHuman) return "human";
  return info.type.toLowerCase().includes("organization") ? "organization" : "group";
}

/**
 * Encode hubV2.trust(trustee, expiry) and submit it through the host's Safe.
 * `trusted: true` → indefinite trust, `false` → expiry 0 (removes trust).
 * Resolves with the transaction hash; rejects if the user declines in the host.
 */
export async function setTrust(trustee: string, trusted: boolean): Promise<string> {
  const sdk = await getSdk();
  const tx = sdk.core.hubV2.trust(
    trustee as Address,
    trusted ? INDEFINITE_TRUST_EXPIRY : BigInt(0),
  );
  const { sendTransactions } = await import("@aboutcircles/miniapp-sdk");
  const [hash] = await sendTransactions([
    { to: tx.to, data: tx.data, value: tx.value === undefined ? "0" : tx.value.toString() },
  ]);
  return hash;
}

export function explorerTxUrl(hash: string): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

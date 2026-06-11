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
 * Which of `addresses` are registered Circles v2 HUMAN avatars. Groups,
 * organizations and v1-only signups are excluded — they aren't people you'd
 * trust from this app. Returns a map keyed by lowercase address;
 * non-matching addresses are absent.
 */
export async function findCirclesAvatars(
  addresses: string[],
): Promise<Map<string, AvatarInfo>> {
  const sdk = await getSdk();
  const map = new Map<string, AvatarInfo>();
  if (addresses.length === 0) return map;
  const batches = chunk(addresses, 100);
  const results = await mapLimit(batches, 4, (batch) =>
    sdk.rpc.avatar.getAvatarInfoBatch(batch as Address[]),
  );
  for (const infos of results) {
    for (const info of infos) {
      if (info.version === 2 && info.isHuman) map.set(info.avatar.toLowerCase(), info);
    }
  }
  return map;
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

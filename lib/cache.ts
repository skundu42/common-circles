// Session-storage cache for a completed scan (E7). A scan is expensive
// (hundreds of upstream calls), so we stash the result per-fid and rehydrate on
// re-open within the TTL.
//
// THE TRAP (§6): a ScanResult carries Sets and Maps — checkedAddresses (Set),
// relation / failures.addresses (Maps). JSON.stringify silently emits `{}` for
// every one of them, so naive caching loses that data with NO error. The DTO
// below is therefore mandatory: Sets -> arrays, Maps -> entry tuples. JSON.parse
// gives back STRING keys, so numeric Map keys (relation) are revived via
// Number(). trustMap is excluded entirely and always refetched (E7/D7), so on
// deserialize trustLoaded resets to false.

import type { ScanResult } from "@/lib/scan";
import type { FcRelation } from "@/lib/types";

// Bump whenever ScanResult's shape OR semantics change so stale entries are
// invalidated instead of silently deserializing to undefined / wrong meaning.
// v2: added bulkProvider. v3: default scan scoped to following-only (old caches
// mixed followers into entries/relation/deepScanCandidates).
const CACHE_VERSION = 3;
const TTL_MS = 30 * 60 * 1000; // 30 min
const keyFor = (fid: number) => `common-circles:scan:v${CACHE_VERSION}:${fid}`;

// Plain-JSON-safe shape: Sets -> arrays, Maps -> entries, trustMap dropped.
// friends serialize as-is (already plain objects).
export type ScanResultDTO = {
  version: number;
  completedAt: number;
  result: Omit<
    ScanResult,
    "checkedAddresses" | "trustMap" | "relation" | "failures" | "trustLoaded"
  > & {
    checkedAddresses: string[];
    relation: [number, FcRelation][];
    failures: {
      primaryFids: number[];
      verificationFids: number[];
      addresses: [string, number][];
      trustUnavailable: boolean;
    };
  };
};

const hasSessionStorage = (): boolean =>
  typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";

/** Pure: ScanResult -> JSON-safe DTO (no I/O, no mutation). */
export function serialize(result: ScanResult): ScanResultDTO {
  // trustMap / trustLoaded are intentionally dropped (always refetched).
  const {
    checkedAddresses,
    trustMap: _trustMap,
    relation,
    failures,
    trustLoaded: _trustLoaded,
    ...rest
  } = result;
  return {
    version: CACHE_VERSION,
    completedAt: result.completedAt,
    result: {
      ...rest,
      checkedAddresses: [...checkedAddresses],
      relation: [...relation.entries()],
      failures: {
        primaryFids: failures.primaryFids,
        verificationFids: failures.verificationFids,
        addresses: [...failures.addresses.entries()],
        trustUnavailable: failures.trustUnavailable,
      },
    },
  };
}

/**
 * Pure: DTO -> ScanResult. Revives Set/Map (relation keys via Number(), since
 * JSON.parse hands back string keys). trustMap starts empty and trustLoaded
 * false — trust is always refetched (E7/D7). `unchecked` is re-derived from the
 * stored primaryFids to stay consistent with the contract.
 */
export function deserialize(dto: ScanResultDTO): ScanResult {
  const { checkedAddresses, relation, failures, ...rest } = dto.result;
  return {
    ...rest,
    checkedAddresses: new Set(checkedAddresses),
    relation: new Map(relation.map(([k, v]) => [Number(k), v])),
    failures: {
      primaryFids: failures.primaryFids,
      verificationFids: failures.verificationFids,
      addresses: new Map(failures.addresses),
      trustUnavailable: failures.trustUnavailable,
    },
    unchecked: failures.primaryFids.length,
    trustMap: new Map(),
    trustLoaded: false,
  };
}

/**
 * Read a cached scan for `fid`. Returns null on miss, version mismatch, expired
 * TTL (also evicting the stale entry), or ANY error (corrupt JSON, no storage).
 */
export function readCache(fid: number): ScanResult | null {
  if (!hasSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(keyFor(fid));
    if (raw === null) return null;
    const dto = JSON.parse(raw) as ScanResultDTO;
    if (dto.version !== CACHE_VERSION) return null;
    if (Date.now() - dto.completedAt > TTL_MS) {
      window.sessionStorage.removeItem(keyFor(fid));
      return null;
    }
    return deserialize(dto);
  } catch {
    return null;
  }
}

/** Persist a completed scan. Swallows quota / private-mode write failures (E7). */
export function writeCache(result: ScanResult): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.setItem(
      keyFor(result.user.fid),
      JSON.stringify(serialize(result)),
    );
  } catch {
    /* quota exceeded / private mode: ignore */
  }
}

/** Evict the cached scan for `fid`. */
export function clearCache(fid: number): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.removeItem(keyFor(fid));
  } catch {
    /* ignore */
  }
}

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
import type { FcRelation, Friend } from "@/lib/types";
import type { SourceId } from "@/lib/sources/types";

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

// --- Source cache (trust2/snapshot). Separate version line from the scan cache. ---
//
// Unlike the scan cache, a source result needs NO Set/Map surgery: a Friend[] is
// already plain JSON. Divergence from the scan cache: `friend.trust` is persisted
// VERBATIM (it lives inside each Friend, fetched once by matchSource), not dropped
// and refetched — App re-runs getTrustMap on the cached-adopt path to refresh it,
// mirroring the Farcaster E11 flow.

const SOURCE_CACHE_VERSION = 1;
const SOURCE_TTL_MS = 30 * 60 * 1000; // 30 min, mirrors the scan cache
const sourceKeyFor = (sourceId: SourceId, seed: string) =>
  `common-circles:source:v${SOURCE_CACHE_VERSION}:${sourceId}:${seed.toLowerCase()}`;

export type SourceCacheDTO = {
  version: number;
  completedAt: number;
  sourceId: SourceId;
  seed: string; // lowercased
  friends: Friend[]; // plain objects; friend.trust kept verbatim (see note above).
  stats: Record<string, number>;
  truncated: boolean;
};

export type SourceCacheEntry = {
  friends: Friend[];
  stats: Record<string, number>;
  truncated: boolean;
  completedAt: number;
};

/**
 * Read a cached source result for `(sourceId, seed)`. Returns null on miss,
 * version mismatch, expired TTL (also evicting the stale entry), or ANY error.
 */
export function readSourceCache(
  sourceId: SourceId,
  seed: string,
): SourceCacheEntry | null {
  if (!hasSessionStorage()) return null;
  const key = sourceKeyFor(sourceId, seed);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return null;
    const dto = JSON.parse(raw) as SourceCacheDTO;
    if (dto.version !== SOURCE_CACHE_VERSION) return null;
    if (Date.now() - dto.completedAt > SOURCE_TTL_MS) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return {
      friends: dto.friends,
      stats: dto.stats,
      truncated: dto.truncated,
      completedAt: dto.completedAt,
    };
  } catch {
    return null;
  }
}

/** Persist a source result. Swallows quota / private-mode write failures. */
export function writeSourceCache(
  sourceId: SourceId,
  seed: string,
  friends: Friend[],
  stats: Record<string, number>,
  truncated: boolean,
): void {
  if (!hasSessionStorage()) return;
  const dto: SourceCacheDTO = {
    version: SOURCE_CACHE_VERSION,
    completedAt: Date.now(),
    sourceId,
    seed: seed.toLowerCase(),
    friends,
    stats,
    truncated,
  };
  try {
    window.sessionStorage.setItem(sourceKeyFor(sourceId, seed), JSON.stringify(dto));
  } catch {
    /* quota exceeded / private mode: ignore */
  }
}

/** Evict the cached source result for `(sourceId, seed)`. */
export function clearSourceCache(sourceId: SourceId, seed: string): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.removeItem(sourceKeyFor(sourceId, seed));
  } catch {
    /* ignore */
  }
}

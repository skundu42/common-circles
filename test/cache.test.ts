// E7 — sessionStorage cache DTO round-trip + read/write guards.
// The trap (§6): naive JSON.stringify silently drops Sets/Maps. The DTO
// serializer is mandatory; numeric Map keys must be revived as numbers.
//
// readCache/writeCache need a `window.sessionStorage`. Node has neither, so we
// install a minimal in-memory stub on globalThis before importing the module.

import { describe, it, expect, beforeEach, vi } from "vitest";

// --- in-memory sessionStorage stub (installed before the SUT touches window) ---
class MemoryStorage {
  store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
});

import { serialize, deserialize, readCache, writeCache, clearCache } from "@/lib/cache";
import {
  readSourceCache,
  writeSourceCache,
  clearSourceCache,
} from "@/lib/cache";
import type { ScanResult, TrustMap } from "@/lib/scan";
import type { FarcasterUser, FcRelation, Friend } from "@/lib/types";

const user: FarcasterUser = {
  fid: 42,
  username: "alice",
  displayName: "Alice",
  pfpUrl: null,
  bio: "",
  followingCount: 1,
  followerCount: 2,
  ethWallets: [],
};

function makeResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    user,
    followingTotal: 10,
    followersTotal: 5,
    withWallet: 8,
    truncated: false,
    unchecked: 1,
    autoSwept: true,
    friends: [],
    deepScanCandidates: [],
    bulkProvider: false,
    checkedAddresses: new Set<string>(["0xabc", "0xdef"]),
    trustMap: new Map([["0xabc", "trusts"]]) as TrustMap,
    trustLoaded: true,
    relation: new Map<number, FcRelation>([
      [10, "following"],
      [20, "follower"],
    ]),
    failures: {
      primaryFids: [10],
      verificationFids: [99],
      addresses: new Map([["0xfail", 30]]),
      trustUnavailable: false,
    },
    scanId: 7,
    completedAt: Date.now(),
    ...over,
  };
}

// Mirror cache.ts CACHE_VERSION so direct-storage assertions hit the real key.
const keyFor = (fid: number) => `common-circles:scan:v3:${fid}`;

describe("serialize / deserialize round-trip", () => {
  it("preserves checkedAddresses Set, relation Map (numeric keys), failures.addresses Map", () => {
    const result = makeResult();
    // round-trip through JSON exactly as writeCache/readCache do
    const dto = JSON.parse(JSON.stringify(serialize(result)));
    const revived = deserialize(dto);

    expect(revived.checkedAddresses).toBeInstanceOf(Set);
    expect([...revived.checkedAddresses].sort()).toEqual(["0xabc", "0xdef"]);

    expect(revived.relation).toBeInstanceOf(Map);
    // numeric keys must be revived as NUMBERS, not strings
    expect(revived.relation.get(10)).toBe("following");
    expect(revived.relation.get(20)).toBe("follower");
    for (const k of revived.relation.keys()) {
      expect(typeof k).toBe("number");
    }

    expect(revived.failures.addresses).toBeInstanceOf(Map);
    expect(revived.failures.addresses.get("0xfail")).toBe(30);
    expect(revived.failures.primaryFids).toEqual([10]);
    expect(revived.failures.verificationFids).toEqual([99]);
  });

  it("excludes trustMap: revives to an empty Map with trustLoaded=false", () => {
    const result = makeResult({
      trustMap: new Map([["0xabc", "mutuallyTrusts"]]) as TrustMap,
      trustLoaded: true,
    });
    const dto = JSON.parse(JSON.stringify(serialize(result)));
    const revived = deserialize(dto);

    expect(revived.trustMap).toBeInstanceOf(Map);
    expect(revived.trustMap.size).toBe(0);
    expect(revived.trustLoaded).toBe(false);
  });
});

describe("readCache", () => {
  it("returns the revived scan on a fresh hit", () => {
    const result = makeResult();
    writeCache(result);
    const got = readCache(user.fid);
    expect(got).not.toBeNull();
    expect(got!.user.fid).toBe(user.fid);
    expect(got!.checkedAddresses).toBeInstanceOf(Set);
  });

  it("returns null on version bump", () => {
    const dto = serialize(makeResult());
    // craft a payload with a stale version
    storage.setItem(keyFor(user.fid), JSON.stringify({ ...dto, version: 999 }));
    expect(readCache(user.fid)).toBeNull();
  });

  it("returns null on TTL expiry and evicts the stale entry", () => {
    const dto = serialize(makeResult({ completedAt: Date.now() }));
    // backdate completedAt past the 30-min TTL (both top-level + inner result)
    const stale = {
      ...dto,
      completedAt: Date.now() - 31 * 60 * 1000,
      result: { ...dto.result, completedAt: Date.now() - 31 * 60 * 1000 },
    };
    storage.setItem(keyFor(user.fid), JSON.stringify(stale));

    expect(readCache(user.fid)).toBeNull();
    // evicted
    expect(storage.getItem(keyFor(user.fid))).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    storage.setItem(keyFor(user.fid), "{not valid json");
    expect(readCache(user.fid)).toBeNull();
  });

  it("returns null on a miss", () => {
    expect(readCache(12345)).toBeNull();
  });
});

describe("writeCache", () => {
  it("swallows a thrown setItem (quota / private mode)", () => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => writeCache(makeResult())).not.toThrow();
  });
});

describe("clearCache", () => {
  it("evicts the cached entry", () => {
    writeCache(makeResult());
    expect(storage.getItem(keyFor(user.fid))).not.toBeNull();
    clearCache(user.fid);
    expect(storage.getItem(keyFor(user.fid))).toBeNull();
  });
});

// --- Source cache (trust2/snapshot): (sourceId, seed) keying, TTL/version,
// isolation, clear. Friend[] is plain JSON; friend.trust is kept verbatim. ---

// Mirror cache.ts's sourceKeyFor for direct-storage assertions (v1).
const sourceKeyFor = (sourceId: string, seed: string) =>
  `common-circles:source:v1:${sourceId}:${seed.toLowerCase()}`;

function sourceFriend(over: Partial<Friend> = {}): Friend {
  return {
    address: "0xabc",
    displayName: "0xab…cdef",
    source: "trust2",
    evidence: "Trusted by 3 of your contacts",
    weight: 3,
    circlesName: null,
    circlesImageUrl: null,
    kind: "human",
    trust: "trustedBy",
    ...over,
  };
}

describe("readSourceCache / writeSourceCache round-trip", () => {
  it("survives a (sourceId, seed) round-trip with a case-insensitive seed; preserves friend.trust", () => {
    const friends = [sourceFriend(), sourceFriend({ address: "0xdef", trust: "mutuallyTrusts" })];
    const stats = { contacts: 12, candidates: 40 };
    writeSourceCache("trust2", "0xSEED", friends, stats, false);

    // read with a different-cased seed → key is lowercased on both sides.
    const got = readSourceCache("trust2", "0xseed");
    expect(got).not.toBeNull();
    expect(got!.friends).toHaveLength(2);
    expect(got!.friends[0].trust).toBe("trustedBy"); // trust kept verbatim
    expect(got!.friends[1].trust).toBe("mutuallyTrusts");
    expect(got!.stats).toEqual(stats);
    expect(got!.truncated).toBe(false);
    expect(typeof got!.completedAt).toBe("number");
  });

  it("isolates by seed and by sourceId", () => {
    writeSourceCache("trust2", "0xseed", [sourceFriend()], {}, false);
    // different seed → miss
    expect(readSourceCache("trust2", "0xother")).toBeNull();
    // different sourceId, same seed → miss (no cross-source bleed)
    expect(readSourceCache("snapshot", "0xseed")).toBeNull();
  });
});

describe("readSourceCache eviction", () => {
  it("returns null on TTL expiry and evicts the stale entry", () => {
    writeSourceCache("trust2", "0xseed", [sourceFriend()], {}, false);
    const key = sourceKeyFor("trust2", "0xseed");
    const dto = JSON.parse(storage.getItem(key)!);
    // backdate completedAt past the 30-min TTL.
    storage.setItem(
      key,
      JSON.stringify({ ...dto, completedAt: Date.now() - 31 * 60 * 1000 }),
    );

    expect(readSourceCache("trust2", "0xseed")).toBeNull();
    expect(storage.getItem(key)).toBeNull(); // evicted
  });

  it("returns null on a version mismatch", () => {
    writeSourceCache("trust2", "0xseed", [sourceFriend()], {}, false);
    const key = sourceKeyFor("trust2", "0xseed");
    const dto = JSON.parse(storage.getItem(key)!);
    storage.setItem(key, JSON.stringify({ ...dto, version: 999 }));

    expect(readSourceCache("trust2", "0xseed")).toBeNull();
  });

  it("returns null on corrupt JSON and on a miss", () => {
    storage.setItem(sourceKeyFor("trust2", "0xseed"), "{not valid json");
    expect(readSourceCache("trust2", "0xseed")).toBeNull();
    expect(readSourceCache("trust2", "0xmissing")).toBeNull();
  });
});

describe("writeSourceCache / clearSourceCache", () => {
  it("swallows a thrown setItem (quota / private mode)", () => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() =>
      writeSourceCache("trust2", "0xseed", [sourceFriend()], {}, false),
    ).not.toThrow();
  });

  it("clearSourceCache evicts the (sourceId, seed) entry", () => {
    writeSourceCache("trust2", "0xseed", [sourceFriend()], {}, false);
    expect(storage.getItem(sourceKeyFor("trust2", "0xseed"))).not.toBeNull();
    clearSourceCache("trust2", "0xSEED"); // case-insensitive seed
    expect(storage.getItem(sourceKeyFor("trust2", "0xseed"))).toBeNull();
  });
});

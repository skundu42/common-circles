// E5 — applyRetryOutcome (the highest-value test: pure, no mocks).
// Folds a RetryOutcome back into scan state per the §1.3 contract:
//  (a) scanId mismatch -> inputs returned unchanged
//  (b) new entries appended, existing rows never re-sorted (index stability)
//  (c) failure sets replaced by stillFailed, unchecked recomputed
//  (d) outcome.trustMap provided -> trust re-derived + trustLoaded/Unavailable
//  (e) dedupe by address (a recovered address already present is not duplicated)

import { describe, it, expect } from "vitest";
import { applyRetryOutcome } from "@/lib/scan";
import type { ScanResult, RetryOutcome, TrustMap } from "@/lib/scan";
import type {
  Friend,
  FarcasterUser,
  ConnectionEntry,
  ScanFailures,
} from "@/lib/types";
import type { AvatarInfo, Profile } from "@aboutcircles/sdk-types";

const user: FarcasterUser = {
  fid: 1,
  username: "scanner",
  displayName: "Scanner",
  pfpUrl: null,
  bio: "",
  followingCount: 0,
  followerCount: 0,
  ethWallets: [],
};

/** Minimal human v2 AvatarInfo, only the fields buildFriends/avatarKind read. */
function avatar(address: string): AvatarInfo {
  return {
    version: 2,
    isHuman: true,
    type: "CrcV2_RegisterHuman",
    avatar: address,
    name: null,
  } as unknown as AvatarInfo;
}

function friend(partial: Partial<Friend> & Pick<Friend, "fid" | "address">): Friend {
  return {
    username: `!${partial.fid}`,
    displayName: `FID ${partial.fid}`,
    pfpUrl: null,
    fcRelation: "following",
    circlesName: null,
    circlesImageUrl: null,
    kind: "human",
    trust: "none",
    viaDeepScan: false,
    hydrated: true,
    ...partial,
  };
}

function emptyFailures(): ScanFailures {
  return {
    primaryFids: [],
    verificationFids: [],
    addresses: new Map(),
    trustUnavailable: false,
  };
}

function makeResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    user,
    followingTotal: 10,
    followersTotal: 5,
    withWallet: 8,
    truncated: false,
    unchecked: 2,
    autoSwept: true,
    friends: [],
    deepScanCandidates: [],
    bulkProvider: false,
    checkedAddresses: new Set<string>(),
    trustMap: new Map() as TrustMap,
    trustLoaded: true,
    relation: new Map<number, "following" | "follower" | "mutualFollow">([
      [10, "following"],
      [20, "follower"],
      [30, "following"],
    ]),
    failures: {
      primaryFids: [10, 20],
      verificationFids: [99],
      addresses: new Map([["0xfail", 30]]),
      trustUnavailable: false,
    },
    scanId: 7,
    completedAt: 1000,
    ...over,
  };
}

function makeOutcome(over: Partial<RetryOutcome> = {}): RetryOutcome {
  return {
    entries: [],
    avatars: new Map<string, AvatarInfo>(),
    profiles: new Map<string, Profile>(),
    stillFailed: emptyFailures(),
    trustMap: undefined,
    trustLoaded: undefined,
    scanId: 7,
    ...over,
  };
}

describe("applyRetryOutcome", () => {
  it("(a) scanId mismatch returns the same input references unchanged", () => {
    const result = makeResult({ scanId: 7 });
    const friends = [friend({ fid: 10, address: "0xa" })];
    const outcome = makeOutcome({ scanId: 999 });

    const next = applyRetryOutcome(result, friends, outcome);

    expect(next.result).toBe(result);
    expect(next.friends).toBe(friends);
  });

  it("(b) appends new entries WITHOUT re-sorting existing rows (index stability)", () => {
    // Existing rows in a deliberately NON-trust-sorted order; the reducer must
    // preserve their relative order and only append the new arrival.
    const friends = [
      friend({ fid: 10, address: "0xexisting1", trust: "none" }),
      friend({ fid: 20, address: "0xexisting2", trust: "trustedBy" }),
    ];
    const entries: ConnectionEntry[] = [{ fid: 30, address: "0xnew" }];
    const outcome = makeOutcome({
      entries,
      avatars: new Map([["0xnew", avatar("0xnew")]]),
    });

    const next = applyRetryOutcome(makeResult(), friends, outcome);

    // pre-existing addresses keep their original indices
    expect(next.friends[0].address).toBe("0xexisting1");
    expect(next.friends[1].address).toBe("0xexisting2");
    // the new row is appended at the end
    expect(next.friends[2].address).toBe("0xnew");
    expect(next.friends).toHaveLength(3);
  });

  it("(c) replaces failure sets with stillFailed and recomputes unchecked", () => {
    const stillFailed: ScanFailures = {
      primaryFids: [20],
      verificationFids: [],
      addresses: new Map([["0xstill", 30]]),
      trustUnavailable: false,
    };
    const outcome = makeOutcome({ stillFailed });

    const next = applyRetryOutcome(makeResult(), [], outcome);

    expect(next.result.failures.primaryFids).toEqual([20]);
    expect(next.result.failures.verificationFids).toEqual([]);
    expect([...next.result.failures.addresses.entries()]).toEqual([["0xstill", 30]]);
    // unchecked is the derived convenience = primaryFids.length (C2)
    expect(next.result.unchecked).toBe(1);
  });

  it("(d) re-derives trust per friend when outcome.trustMap is provided", () => {
    const friends = [
      friend({ fid: 10, address: "0xa", trust: "none" }),
      friend({ fid: 20, address: "0xb", trust: "none" }),
    ];
    const trustMap: TrustMap = new Map([["0xa", "mutuallyTrusts"]]);
    const outcome = makeOutcome({ trustMap, trustLoaded: true });

    const next = applyRetryOutcome(
      makeResult({ trustLoaded: false }),
      friends,
      outcome,
    );

    // 0xa is in the new trust map; 0xb falls back to "none"
    expect(next.friends.find((f) => f.address === "0xa")?.trust).toBe("mutuallyTrusts");
    expect(next.friends.find((f) => f.address === "0xb")?.trust).toBe("none");
    expect(next.result.trustMap).toBe(trustMap);
    expect(next.result.trustLoaded).toBe(true);
    expect(next.result.failures.trustUnavailable).toBe(false);
  });

  it("(d') leaves trust untouched when outcome.trustMap is undefined (not retried)", () => {
    const friends = [friend({ fid: 10, address: "0xa", trust: "trusts" })];
    const outcome = makeOutcome({ trustMap: undefined, trustLoaded: undefined });

    const next = applyRetryOutcome(
      makeResult({ trustLoaded: false }),
      friends,
      outcome,
    );

    expect(next.friends[0].trust).toBe("trusts");
    expect(next.result.trustLoaded).toBe(false);
  });

  it("(e) dedupes by address — a recovered address already present is not duplicated", () => {
    const friends = [friend({ fid: 10, address: "0xdup" })];
    const entries: ConnectionEntry[] = [{ fid: 10, address: "0xdup" }];
    const outcome = makeOutcome({
      entries,
      avatars: new Map([["0xdup", avatar("0xdup")]]),
    });

    const next = applyRetryOutcome(makeResult(), friends, outcome);

    expect(next.friends).toHaveLength(1);
    expect(next.friends[0].address).toBe("0xdup");
  });
});

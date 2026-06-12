// §2c — generic matcher. We mock the three spine reads matchSource calls
// (findCirclesAvatars, getCirclesProfiles, getTrustMap); avatarKind runs for
// real. No SDK / window. Mock style mirrors test/sweep.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AvatarInfo, Profile } from "@aboutcircles/sdk-types";
import type { TrustState } from "@/lib/types";
import type { SourceResult, Candidate } from "@/lib/sources/types";

type Relation = Exclude<TrustState, "none">;

const { findCirclesAvatars, getCirclesProfiles, getTrustMap } = vi.hoisted(() => ({
  findCirclesAvatars:
    vi.fn<
      (addresses: string[]) => Promise<{ avatars: Map<string, AvatarInfo>; failedAddresses: string[] }>
    >(),
  getCirclesProfiles: vi.fn<(addresses: string[]) => Promise<Map<string, Profile>>>(),
  getTrustMap: vi.fn<(avatar: string) => Promise<Map<string, Relation>>>(),
}));

vi.mock("@/lib/circles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/circles")>();
  return { ...actual, findCirclesAvatars, getCirclesProfiles, getTrustMap };
});

import { matchSource } from "@/lib/sources/match";
import { shortenAddress } from "@/lib/util";

function avatar(address: string, over: Partial<AvatarInfo> = {}): AvatarInfo {
  return {
    version: 2,
    isHuman: true,
    type: "CrcV2_RegisterHuman",
    avatar: address,
    name: null,
    ...over,
  } as unknown as AvatarInfo;
}

function profile(over: Partial<Profile> = {}): Profile {
  return { name: null, previewImageUrl: null, imageUrl: null, ...over } as unknown as Profile;
}

const candidate = (over: Partial<Candidate> & { address: string }): Candidate => ({
  evidence: "",
  preVerified: false,
  ...over,
});

const result = (candidates: Candidate[]): SourceResult => ({
  sourceId: "trust2",
  candidates,
  stats: {},
});

beforeEach(() => {
  findCirclesAvatars.mockReset();
  getCirclesProfiles.mockReset();
  getTrustMap.mockReset();
  getCirclesProfiles.mockResolvedValue(new Map());
  getTrustMap.mockResolvedValue(new Map());
});

describe("matchSource", () => {
  it("skips preVerified candidates from the findCirclesAvatars call, keeps them anyway", async () => {
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([["0xtocheck", avatar("0xtocheck")]]),
      failedAddresses: [],
    });

    const rows = await matchSource(
      result([
        candidate({ address: "0xpre", preVerified: true }),
        candidate({ address: "0xtocheck", preVerified: false }),
      ]),
      null,
    );

    // preVerified address is NOT passed to the registry; the not-verified one is.
    const checkedArgs = findCirclesAvatars.mock.calls[0][0];
    expect(checkedArgs).toEqual(["0xtocheck"]);
    expect(checkedArgs).not.toContain("0xpre");
    // both survive into the rows (pre via preVerified, the other via registry match).
    expect(rows.map((r) => r.address).sort()).toEqual(["0xpre", "0xtocheck"]);
  });

  it("drops non-preVerified candidates absent from the registry (human filter)", async () => {
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([["0xhuman", avatar("0xhuman")]]),
      failedAddresses: ["0xrpcfail"], // ignored — no throw, no ledger
    });

    const rows = await matchSource(
      result([
        candidate({ address: "0xhuman" }),
        candidate({ address: "0xgroup" }), // not in avatars → dropped
      ]),
      null,
    );

    expect(rows.map((r) => r.address)).toEqual(["0xhuman"]);
  });

  it("sorts by TRUST_ORDER then weight desc then displayName (trust tier beats weight)", async () => {
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([
        ["0xtrustsyou", avatar("0xtrustsyou")],
        ["0xstranger", avatar("0xstranger")],
        ["0xb", avatar("0xb")],
        ["0xa", avatar("0xa")],
      ]),
      failedAddresses: [],
    });
    getCirclesProfiles.mockResolvedValue(
      new Map<string, Profile>([
        ["0xa", profile({ name: "Aaa" })],
        ["0xb", profile({ name: "Bbb" })],
      ]),
    );
    getTrustMap.mockResolvedValue(new Map<string, Relation>([["0xtrustsyou", "trustedBy"]]));

    const rows = await matchSource(
      result([
        // high weight but no trust edge ("none")
        candidate({ address: "0xstranger", weight: 99 }),
        // low weight but trustedBy → most actionable, must sort first
        candidate({ address: "0xtrustsyou", weight: 1 }),
        // equal trust ("none") + equal weight → displayName tiebreak Aaa < Bbb
        candidate({ address: "0xb", weight: 5 }),
        candidate({ address: "0xa", weight: 5 }),
      ]),
      "0xself",
    );

    expect(rows.map((r) => r.address)).toEqual([
      "0xtrustsyou", // trustedBy beats every "none" regardless of weight
      "0xstranger", // none, weight 99 — highest weight in the none tier
      "0xa", // none, weight 5, name Aaa (displayName tiebreak)
      "0xb", // none, weight 5, name Bbb
    ]);
    // sanity: trust tier dominated weight (stranger w99 ranked below trustsyou w1).
    expect(rows[0].address).toBe("0xtrustsyou");
  });

  it("dedupes by lowercased address (case-insensitive), first wins", async () => {
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([["0xdup", avatar("0xdup")]]),
      failedAddresses: [],
    });

    const rows = await matchSource(
      result([
        candidate({ address: "0xDUP", evidence: "first" }),
        candidate({ address: "0xdup", evidence: "second" }),
      ]),
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("0xdup");
    expect(rows[0].evidence).toBe("first"); // first wins
  });

  it("derives Friend fields and degrades trust to 'none' when getTrustMap rejects", async () => {
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([
        ["0xnamed", avatar("0xnamed", { name: "AvatarName" })],
        ["0xbare", avatar("0xbare")],
      ]),
      failedAddresses: [],
    });
    getCirclesProfiles.mockResolvedValue(
      new Map<string, Profile>([
        ["0xnamed", profile({ name: "ProfileName", previewImageUrl: "img://preview" })],
      ]),
    );
    getTrustMap.mockRejectedValue(new Error("trust RPC down"));

    const rows = await matchSource(
      result([
        candidate({ address: "0xnamed", evidence: "Trusted by 3 of your contacts", weight: 3 }),
        candidate({ address: "0xbare", evidence: "Trusted by 1 of your contacts", weight: 1 }),
      ]),
      "0xself",
    );

    const named = rows.find((r) => r.address === "0xnamed")!;
    const bare = rows.find((r) => r.address === "0xbare")!;

    // profile name wins over avatar name; both feed circlesName.
    expect(named.displayName).toBe("ProfileName");
    expect(named.circlesName).toBe("ProfileName");
    expect(named.circlesImageUrl).toBe("img://preview");
    expect(named.source).toBe("trust2");
    expect(named.evidence).toBe("Trusted by 3 of your contacts");
    expect(named.weight).toBe(3);
    expect(named.kind).toBe("human");

    // no profile + no avatar name → displayName falls back to short address.
    expect(bare.circlesName).toBeNull();
    expect(bare.displayName).toBe(shortenAddress("0xbare"));

    // getTrustMap threw → every row degrades to "none".
    expect(named.trust).toBe("none");
    expect(bare.trust).toBe("none");
  });
});

// §3 — trust2 (friends-of-friends) candidate building. We mock ONLY
// getTrustMap from @/lib/circles (the source's single I/O dependency); the
// tally/cap/exclusion logic runs for real. No SDK / window.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrustState } from "@/lib/types";

type Relation = Exclude<TrustState, "none">;

const { getTrustMap } = vi.hoisted(() => ({
  getTrustMap: vi.fn<(avatar: string) => Promise<Map<string, Relation>>>(),
}));

vi.mock("@/lib/circles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/circles")>();
  return { ...actual, getTrustMap };
});

import { trust2Source, TRUST2_CONTACT_CAP, TRUST2_CANDIDATE_CAP } from "@/lib/sources/trust2";

const rel = (entries: [string, Relation][]) => new Map<string, Relation>(entries);

beforeEach(() => {
  getTrustMap.mockReset();
});

describe("trust2 discover", () => {
  it("tallies second-degree trusts and stamps weight + evidence", async () => {
    // seed's first-degree contacts: A (plain trust), B (mutual) — both are vouchers.
    getTrustMap.mockImplementation(async (addr: string) => {
      if (addr === "0xseed") return rel([["0xa", "trusts"], ["0xb", "mutuallyTrusts"]]);
      if (addr === "0xa") return rel([["0xx", "trusts"], ["0xy", "trusts"]]);
      if (addr === "0xb") return rel([["0xx", "mutuallyTrusts"], ["0xz", "trusts"]]);
      return rel([]);
    });

    const res = await trust2Source.discover("0xSEED");

    const byAddr = new Map(res.candidates.map((c) => [c.address, c]));
    expect(byAddr.get("0xx")!.weight).toBe(2); // trusted by both A and B
    expect(byAddr.get("0xy")!.weight).toBe(1);
    expect(byAddr.get("0xz")!.weight).toBe(1);
    expect(byAddr.get("0xx")!.evidence).toBe("Trusted by 2 of your contacts");
    expect(byAddr.get("0xx")!.preVerified).toBe(false);
    expect(res.stats.contacts).toBe(2);
    expect(res.stats.candidates).toBe(3);
    expect(res.truncated).toBe(false);
  });

  it("excludes the seed and any already-first-degree address; trustedBy-only is not a contact", async () => {
    // first-degree: A (trust → a contact/voucher), C (trustedBy only → NOT a contact).
    getTrustMap.mockImplementation(async (addr: string) => {
      if (addr === "0xseed") return rel([["0xa", "trusts"], ["0xc", "trustedBy"]]);
      if (addr === "0xa")
        return rel([
          ["0xseed", "trusts"], // points back at the seed → excluded
          ["0xc", "trusts"], // already first-degree → excluded
          ["0xnew", "trusts"], // genuine second-degree
        ]);
      return rel([]);
    });

    const res = await trust2Source.discover("0xseed");

    const addrs = res.candidates.map((c) => c.address);
    expect(addrs).toEqual(["0xnew"]);
    expect(addrs).not.toContain("0xseed");
    expect(addrs).not.toContain("0xc");
    // C was first-degree but trustedBy-only → never fanned out as a contact.
    expect(getTrustMap).not.toHaveBeenCalledWith("0xc");
    expect(res.stats.contacts).toBe(1); // only A
  });

  it("caps contacts at TRUST2_CONTACT_CAP with mutuals first, sets truncated", async () => {
    // 60 mutuals + 140 plain trusts = 200 outward edges; cap is 150.
    const mutuals = Array.from({ length: 60 }, (_, i) => `0xm${i}`);
    const plain = Array.from({ length: 140 }, (_, i) => `0xp${i}`);
    const firstDegree: [string, Relation][] = [
      ...mutuals.map((a) => [a, "mutuallyTrusts"] as [string, Relation]),
      ...plain.map((a) => [a, "trusts"] as [string, Relation]),
    ];

    getTrustMap.mockImplementation(async (addr: string) => {
      if (addr === "0xseed") return rel(firstDegree);
      return rel([]); // contacts have no onward trusts (we only count calls here)
    });

    const res = await trust2Source.discover("0xseed");

    expect(res.stats.contacts).toBe(TRUST2_CONTACT_CAP); // 150
    expect(res.truncated).toBe(true);

    // Which contacts were fanned out? (every getTrustMap call except the seed's.)
    const fannedOut = getTrustMap.mock.calls.map((c) => c[0]).filter((a) => a !== "0xseed");
    expect(fannedOut).toHaveLength(TRUST2_CONTACT_CAP);
    // All 60 mutuals come before any plain-trust contact.
    expect(fannedOut.filter((a) => a.startsWith("0xm"))).toHaveLength(60);
    expect(fannedOut.slice(0, 60).every((a) => a.startsWith("0xm"))).toBe(true);
    expect(fannedOut.slice(60).every((a) => a.startsWith("0xp"))).toBe(true);
  });

  it("degrades on a per-contact failure: others still tally, never throws", async () => {
    getTrustMap.mockImplementation(async (addr: string) => {
      if (addr === "0xseed") return rel([["0xa", "trusts"], ["0xb", "trusts"]]);
      if (addr === "0xa") throw new Error("RPC down for this contact");
      if (addr === "0xb") return rel([["0xgood", "trusts"]]);
      return rel([]);
    });

    const res = await trust2Source.discover("0xseed");

    const byAddr = new Map(res.candidates.map((c) => [c.address, c]));
    expect(byAddr.get("0xgood")!.weight).toBe(1); // B's contribution survives
    expect(res.candidates).toHaveLength(1); // A's failed fan-out contributes nothing
    expect(res.stats.contacts).toBe(2);
    expect(res.stats.contactsFailed).toBe(1); // the failed contact is surfaced
  });

  it("caps the candidate set at TRUST2_CANDIDATE_CAP, strongest vouches first, sets truncated", async () => {
    // A trusts CAP+50 distinct strangers (weight 1); B re-trusts the first 5
    // (weight 2). The 5 strongest must survive the cap; the total is reported.
    const many = Array.from({ length: TRUST2_CANDIDATE_CAP + 50 }, (_, i) => `0xs${i}`);
    getTrustMap.mockImplementation(async (addr: string) => {
      if (addr === "0xseed") return rel([["0xa", "trusts"], ["0xb", "trusts"]]);
      if (addr === "0xa") return rel(many.map((a) => [a, "trusts"] as [string, Relation]));
      if (addr === "0xb")
        return rel(many.slice(0, 5).map((a) => [a, "trusts"] as [string, Relation]));
      return rel([]);
    });

    const res = await trust2Source.discover("0xseed");

    expect(res.candidates).toHaveLength(TRUST2_CANDIDATE_CAP);
    expect(res.truncated).toBe(true);
    expect(res.stats.candidates).toBe(TRUST2_CANDIDATE_CAP + 50); // total discovered
    expect(res.candidates.slice(0, 5).every((c) => c.weight === 2)).toBe(true);
  });
});

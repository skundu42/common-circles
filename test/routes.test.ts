// parseFids (pure) + the verifications route's failedFids accounting (E3/R2).
//
// The route now goes through getProvider().getVerificationsByFids (E9/M2). We
// mock getProvider to return a fake provider whose getVerificationsByFids
// partitions fids into rows/failedFids (mirroring the keyless impl's per-fid
// success-vs-failure semantics), keep parseFids/rateLimitByIp/errorResponse real
// via importActual, then drive the real GET handler.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getVerificationsByFids } = vi.hoisted(() => ({
  getVerificationsByFids:
    vi.fn<
      (fids: number[]) => Promise<{
        rows: { fid: number; addresses: string[] }[];
        failedFids: number[];
      }>
    >(),
}));

vi.mock("@/lib/farcaster-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/farcaster-server")>();
  return {
    ...actual,
    getProvider: () => ({ ...actual.getProvider(), getVerificationsByFids }),
  };
});

import { parseFids } from "@/lib/farcaster-server";
import { GET } from "@/app/api/farcaster/verifications/route";

beforeEach(() => {
  getVerificationsByFids.mockReset();
  // ensure the keyless path (no rate limiting) for the route tests
  delete process.env.NEYNAR_API_KEY;
});

describe("parseFids", () => {
  it("returns null for empty / nullish input", () => {
    expect(parseFids(null, 100)).toBeNull();
    expect(parseFids("", 100)).toBeNull();
    expect(parseFids("  ", 100)).toBeNull();
  });

  it("dedupes while preserving first-seen order", () => {
    expect(parseFids("1,2,2,3,1", 100)).toEqual([1, 2, 3]);
  });

  it("drops non-positive and non-integer values", () => {
    expect(parseFids("0,-1,1.5,abc,5,foo", 100)).toEqual([5]);
  });

  it("caps the list to `cap` (after dedupe)", () => {
    expect(parseFids("1,2,3,4,5", 3)).toEqual([1, 2, 3]);
  });

  it("returns null when every token is junk", () => {
    expect(parseFids("0,-2,abc,1.1", 100)).toBeNull();
  });
});

describe("GET /api/farcaster/verifications", () => {
  it("surfaces the provider's rows (success) and failedFids (per-fid failure)", async () => {
    // Mirror the keyless impl: fid 2 failed → failedFids; 1 & 3 → rows.
    getVerificationsByFids.mockImplementation(async (fids: number[]) => {
      const rows = fids
        .filter((fid) => fid !== 2)
        .map((fid) => ({ fid, addresses: [`0xaddr${fid}`] }));
      const failedFids = fids.filter((fid) => fid === 2);
      return { rows, failedFids };
    });

    const res = await GET(new Request("https://x/api/farcaster/verifications?fids=1,2,3"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { fid: number; addresses: string[] }[];
      failedFids: number[];
    };

    expect(body.failedFids).toEqual([2]);
    const rowFids = body.rows.map((r) => r.fid).sort();
    expect(rowFids).toEqual([1, 3]);
    expect(body.rows.find((r) => r.fid === 1)?.addresses).toEqual(["0xaddr1"]);
    expect(getVerificationsByFids).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("400s when fids is missing", async () => {
    const res = await GET(new Request("https://x/api/farcaster/verifications"));
    expect(res.status).toBe(400);
    expect(getVerificationsByFids).not.toHaveBeenCalled();
  });
});

// E3 — sweepVerifications partial-failure semantics.
//
// sweepVerifications is NOT exported from lib/scan.ts. We exercise it through the
// smallest exported surface that calls it directly: runDeepScan, which forwards
// the sweep's failedFids -> failures.verificationFids and uncheckedAddresses ->
// failures.addresses, mutates the passed-in `checkedAddresses` Set, and returns
// `checked`. (See agent report note: indirect coverage via runDeepScan.)
//
// We mock the two I/O dependencies sweepVerifications touches — fetchVerifications
// (@/lib/api) and findCirclesAvatars (@/lib/circles) — plus the other I/O
// runDeepScan calls (getCirclesProfiles, fetchFarcasterUsers). buildFriends and
// sweepVerifications themselves run for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AvatarInfo } from "@aboutcircles/sdk-types";
import type { VerificationsRow } from "@/lib/types";

const { fetchVerifications, findCirclesAvatars } = vi.hoisted(() => ({
  fetchVerifications:
    vi.fn<
      (fids: number[]) => Promise<{ rows: VerificationsRow[]; failedFids: number[] }>
    >(),
  findCirclesAvatars:
    vi.fn<
      (
        addresses: string[],
      ) => Promise<{ avatars: Map<string, AvatarInfo>; failedAddresses: string[] }>
    >(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchVerifications,
    fetchFarcasterUsers: vi.fn(async () => []), // hydration no-op
  };
});

vi.mock("@/lib/circles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/circles")>();
  return {
    ...actual,
    findCirclesAvatars,
    getCirclesProfiles: vi.fn(async () => new Map()),
  };
});

import { runDeepScan } from "@/lib/scan";

function avatar(address: string): AvatarInfo {
  return {
    version: 2,
    isHuman: true,
    type: "CrcV2_RegisterHuman",
    avatar: address,
    name: null,
  } as unknown as AvatarInfo;
}

const noopProgress = () => {};
const noopHydrate = () => {};

beforeEach(() => {
  fetchVerifications.mockReset();
  findCirclesAvatars.mockReset();
});

describe("sweepVerifications (via runDeepScan) partial failure (E3)", () => {
  it("(a) a batch whose verification fetch rejects -> its fids in failedFids, loop continues", async () => {
    // 150 fids -> three batches of 50. First batch rejects, the rest succeed.
    const fids = Array.from({ length: 150 }, (_, i) => i + 1);
    const firstBatch = fids.slice(0, 50);

    fetchVerifications.mockImplementation(async (batch: number[]) => {
      if (batch[0] === firstBatch[0]) throw new Error("verifications upstream down");
      // second batch: fid 101 has a matchable address
      return { rows: [{ fid: 101, addresses: ["0xgood"] }], failedFids: [] };
    });
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([["0xgood", avatar("0xgood")]]),
      failedAddresses: [],
    });

    const checkedAddresses = new Set<string>();
    const out = await runDeepScan(
      fids,
      checkedAddresses,
      new Map(),
      new Map(),
      noopProgress,
      noopHydrate,
    );

    // every fid in the failed batch is recorded; the loop still processed batch 2
    expect(out.failures.verificationFids).toEqual(firstBatch);
    expect(out.friends.map((f) => f.fid)).toEqual([101]);
    // both batches counted toward `checked`
    expect(out.checked).toBe(150);
  });

  it("(b) failedAddresses are NOT committed to checkedAddresses and ARE in failures.addresses", async () => {
    fetchVerifications.mockResolvedValue({
      rows: [
        { fid: 10, addresses: ["0xfail"] },
        { fid: 20, addresses: ["0xok"] },
      ],
      failedFids: [],
    });
    findCirclesAvatars.mockResolvedValue({
      avatars: new Map([["0xok", avatar("0xok")]]),
      failedAddresses: ["0xfail"],
    });

    const checkedAddresses = new Set<string>();
    const out = await runDeepScan(
      [10, 20],
      checkedAddresses,
      new Map(),
      new Map(),
      noopProgress,
      noopHydrate,
    );

    // failed address stays eligible (not committed) and is surfaced for retry
    expect(checkedAddresses.has("0xfail")).toBe(false);
    expect(out.failures.addresses.get("0xfail")).toBe(10);
    // (c) the successfully-checked address IS committed
    expect(checkedAddresses.has("0xok")).toBe(true);
  });

  it("(d) `checked` counts all attempted batch lengths even when nothing matches", async () => {
    const fids = Array.from({ length: 250 }, (_, i) => i + 1); // 5 batches of 50
    fetchVerifications.mockResolvedValue({ rows: [], failedFids: [] });
    findCirclesAvatars.mockResolvedValue({ avatars: new Map(), failedAddresses: [] });

    const out = await runDeepScan(
      fids,
      new Set(),
      new Map(),
      new Map(),
      noopProgress,
      noopHydrate,
    );
    expect(out.checked).toBe(250);
  });

  it("(e) NEVER throws even when every dependency fails", async () => {
    fetchVerifications.mockRejectedValue(new Error("all verifications down"));
    findCirclesAvatars.mockRejectedValue(new Error("RPC down"));

    const checkedAddresses = new Set<string>();
    await expect(
      runDeepScan(
        [1, 2, 3],
        checkedAddresses,
        new Map(),
        new Map(),
        noopProgress,
        noopHydrate,
      ),
    ).resolves.toBeDefined();

    const out = await runDeepScan(
      [1, 2, 3],
      checkedAddresses,
      new Map(),
      new Map(),
      noopProgress,
      noopHydrate,
    );
    // whole batch recorded as failed; no rows; nothing committed
    expect(out.failures.verificationFids).toEqual([1, 2, 3]);
    expect(out.friends).toEqual([]);
  });
});

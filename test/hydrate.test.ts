// M1/E15 — hydrateFriendsStreaming must hydrate ALL matched fids in 100-chunks,
// with NO 300-row cap (the old HYDRATE_CAP silently truncated the name list).
//
// We mock fetchFarcasterUsers (@/lib/api) — the only I/O the function touches —
// and assert it is called for every fid across the chunk boundary, never capped.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FarcasterUser } from "@/lib/types";

const { fetchFarcasterUsers } = vi.hoisted(() => ({
  fetchFarcasterUsers:
    vi.fn<(fids: number[], signal?: AbortSignal) => Promise<FarcasterUser[]>>(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchFarcasterUsers };
});

import { hydrateFriendsStreaming } from "@/lib/scan";

function user(fid: number): FarcasterUser {
  return {
    fid,
    username: `u${fid}`,
    displayName: `User ${fid}`,
    pfpUrl: null,
    bio: "",
    followingCount: 0,
    followerCount: 0,
    ethWallets: [],
  };
}

beforeEach(() => {
  fetchFarcasterUsers.mockReset();
  fetchFarcasterUsers.mockImplementation(async (fids: number[]) => fids.map(user));
});

describe("hydrateFriendsStreaming (M1: no 300 cap)", () => {
  it("hydrates ALL fids in 100-chunks, even past 300", async () => {
    const fids = Array.from({ length: 350 }, (_, i) => i + 1);
    const patched: number[] = [];

    await hydrateFriendsStreaming(fids, (patches) => {
      for (const fid of patches.keys()) patched.push(fid);
    });

    // 350 fids -> chunks of 100,100,100,50 = 4 calls
    expect(fetchFarcasterUsers).toHaveBeenCalledTimes(4);
    const requested = fetchFarcasterUsers.mock.calls.flatMap(([batch]) => batch);
    expect(requested.length).toBe(350);
    expect(new Set(requested)).toEqual(new Set(fids));
    // every fid was patched through onHydrated — nothing truncated at 300
    expect(patched.length).toBe(350);
    expect(patched).toContain(350);
  });

  it("aborts cleanly on signal without further fetches", async () => {
    const fids = Array.from({ length: 250 }, (_, i) => i + 1);
    const ctrl = new AbortController();
    ctrl.abort();
    await hydrateFriendsStreaming(fids, () => {}, ctrl.signal);
    expect(fetchFarcasterUsers).not.toHaveBeenCalled();
  });
});

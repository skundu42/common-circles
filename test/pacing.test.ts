// E6 — the in-instance pacing queue + Retry-After honouring.
//
// pacePrimary / paceVerifications / getJsonRetry are NOT exported from
// farcaster-server.ts. We observe their behaviour through the exported callers
// that use them, with a stubbed global fetch and fake timers:
//
//   - getPrimaryEthAddresses  -> paced via pacePrimary (16 per ~10.5s window)
//   - getAllEthVerifications   -> getJsonRetry, which honours Retry-After on 429
//
// Limitation: the exact window constants (PRIMARY_MAX_IN_WINDOW=16,
// PRIMARY_WINDOW_MS=10_500) are internal; we assert the OBSERVABLE invariant
// (no burst past the window before time advances) rather than re-deriving them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.NEYNAR_API_KEY; // keyless path
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A primary-addresses JSON body for one batch (shape getPrimaryEthAddresses reads). */
function primaryBody() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ result: { addresses: [] } }),
  } as unknown as Response;
}

describe("pacePrimary window (via getPrimaryEthAddresses)", () => {
  it("does not let more than the window's worth of requests fire before time advances", async () => {
    const { getPrimaryEthAddresses } = await import("@/lib/farcaster-server");

    let inflight = 0;
    let maxConcurrent = 0;
    const fetchMock = vi.fn(async () => {
      inflight++;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      // never resolve "instantly" relative to the queue: resolve on a microtask
      await Promise.resolve();
      inflight--;
      return primaryBody();
    });
    vi.stubGlobal("fetch", fetchMock);

    // 25 batches (2500 fids) — comfortably more than one window's allowance.
    const fids = Array.from({ length: 2500 }, (_, i) => i + 1);
    const promise = getPrimaryEthAddresses(fids);

    // Let all immediately-eligible (windowed) calls flush WITHOUT advancing time.
    await vi.advanceTimersByTimeAsync(0);
    const firedBeforeAdvance = fetchMock.mock.calls.length;

    // The window must have throttled: not all 25 batches fired at t=0.
    expect(firedBeforeAdvance).toBeLessThan(25);
    expect(firedBeforeAdvance).toBeGreaterThan(0);

    // Advancing past several windows lets the rest drain.
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;
    expect(fetchMock.mock.calls.length).toBe(25);
  });
});

describe("Retry-After honouring (via getAllEthVerifications)", () => {
  it("waits the Retry-After duration before retrying a 429", async () => {
    const { getAllEthVerifications } = await import("@/lib/farcaster-server");

    const RETRY_AFTER_S = 7;
    const verBody = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ result: { verifications: [] } }),
    } as unknown as Response;
    const tooMany = {
      ok: false,
      status: 429,
      headers: {
        get: (h: string) => (h.toLowerCase() === "retry-after" ? String(RETRY_AFTER_S) : null),
      },
      json: async () => ({ errors: [{ message: "slow down" }] }),
    } as unknown as Response;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooMany) // first attempt -> 429 w/ Retry-After: 7s
      .mockResolvedValue(verBody); // subsequent attempts succeed
    vi.stubGlobal("fetch", fetchMock);

    const promise = getAllEthVerifications(123);

    // Flush the first attempt (the 429) without advancing time.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still waiting just before the Retry-After elapses.
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000 - 100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After the Retry-After window, the retry fires.
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

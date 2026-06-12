// Thin client fetchers for our own API routes.

import type {
  ConnectionsResponse,
  FarcasterUser,
  VerificationsRow,
} from "@/lib/types";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

/** Resolve @handle, ENS name, or 0x address to a Farcaster account. */
export function fetchFarcasterUser(query: string): Promise<FarcasterUser> {
  return getJson(`/api/farcaster/user?q=${encodeURIComponent(query)}`);
}

export function fetchConnections(
  fid: number,
  signal?: AbortSignal,
): Promise<ConnectionsResponse> {
  return getJson(`/api/farcaster/connections?fid=${fid}`, signal);
}

export async function fetchFarcasterUsers(
  fids: number[],
  signal?: AbortSignal,
): Promise<FarcasterUser[]> {
  if (fids.length === 0) return [];
  const { users } = await getJson<{ users: FarcasterUser[] }>(
    `/api/farcaster/users?fids=${fids.join(",")}`,
    signal,
  );
  return users;
}

export async function fetchVerifications(
  fids: number[],
  signal?: AbortSignal,
): Promise<{ rows: VerificationsRow[]; failedFids: number[] }> {
  if (fids.length === 0) return { rows: [], failedFids: [] };
  const { rows, failedFids } = await getJson<{
    rows: VerificationsRow[];
    failedFids: number[];
  }>(`/api/farcaster/verifications?fids=${fids.join(",")}`, signal);
  return { rows, failedFids };
}

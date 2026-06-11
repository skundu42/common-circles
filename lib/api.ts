// Thin client fetchers for our own API routes.

import type {
  ConnectionsResponse,
  FarcasterUser,
  VerificationsRow,
} from "@/lib/types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
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

export function fetchConnections(fid: number): Promise<ConnectionsResponse> {
  return getJson(`/api/farcaster/connections?fid=${fid}`);
}

export async function fetchFarcasterUsers(fids: number[]): Promise<FarcasterUser[]> {
  if (fids.length === 0) return [];
  const { users } = await getJson<{ users: FarcasterUser[] }>(
    `/api/farcaster/users?fids=${fids.join(",")}`,
  );
  return users;
}

export async function fetchVerifications(fids: number[]): Promise<VerificationsRow[]> {
  if (fids.length === 0) return [];
  const { rows } = await getJson<{ rows: VerificationsRow[] }>(
    `/api/farcaster/verifications?fids=${fids.join(",")}`,
  );
  return rows;
}

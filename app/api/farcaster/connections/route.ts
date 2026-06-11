import {
  errorResponse,
  getFollowerFids,
  getFollowingFids,
  getPrimaryEthAddresses,
} from "@/lib/farcaster-server";
import type { ConnectionsResponse } from "@/lib/types";

// GET /api/farcaster/connections?fid=3
// → everyone `fid` follows OR is followed by, with primary verified ethereum
// addresses for those who have one. The union is ordered mutual follows →
// following → followers, so downstream caps prefer the closest relationships.
export async function GET(request: Request) {
  const fid = Number(new URL(request.url).searchParams.get("fid"));
  if (!Number.isInteger(fid) || fid <= 0) {
    return Response.json({ error: "fid is required" }, { status: 400 });
  }
  try {
    const [following, followers] = await Promise.all([
      getFollowingFids(fid),
      getFollowerFids(fid),
    ]);
    const followingSet = new Set(following.fids);
    const followerSet = new Set(followers.fids);
    const union = [
      ...following.fids.filter((f) => followerSet.has(f)),
      ...following.fids.filter((f) => !followerSet.has(f)),
      ...followers.fids.filter((f) => !followingSet.has(f)),
    ];

    const { addresses, uncheckedFids } = await getPrimaryEthAddresses(union);
    const entries = union
      .filter((f) => addresses.has(f))
      .map((f) => ({ fid: f, address: addresses.get(f)! }));

    const body: ConnectionsResponse = {
      followingTotal: following.fids.length,
      followersTotal: followers.fids.length,
      withWallet: entries.length,
      truncated: following.truncated || followers.truncated,
      unchecked: uncheckedFids.length,
      entries,
      followingFids: following.fids,
      followerFids: followers.fids,
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}

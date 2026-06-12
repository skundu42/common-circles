import {
  errorResponse,
  FOLLOW_CAP,
  FOLLOWING_CAP,
  getFollowerFids,
  getFollowingFids,
  getProvider,
  hasBulkProvider,
  rateLimitByIp,
} from "@/lib/farcaster-server";
import type { ConnectionsResponse } from "@/lib/types";

export const maxDuration = 60;

// GET /api/farcaster/connections?fid=3
// → the people `fid` FOLLOWS (the default scan scope), with primary verified
// ethereum addresses for those who have one, ordered mutual follows → following.
// Followers are still fetched (for direction/mutual labeling + the opt-in
// "check your followers" secondary pass) but are NOT resolved or scanned here.
export async function GET(request: Request) {
  const limited = rateLimitByIp(request);
  if (limited) return limited;
  const fid = Number(new URL(request.url).searchParams.get("fid"));
  if (!Number.isInteger(fid) || fid <= 0) {
    return Response.json({ error: "fid is required" }, { status: 400 });
  }
  try {
    const [following, followers] = await Promise.all([
      getFollowingFids(fid, FOLLOWING_CAP),
      getFollowerFids(fid, FOLLOW_CAP),
    ]);
    const followerSet = new Set(followers.fids);
    // resolve + scan the FOLLOWING set only, mutuals first
    const followingScan = [
      ...following.fids.filter((f) => followerSet.has(f)),
      ...following.fids.filter((f) => !followerSet.has(f)),
    ];

    const { addresses, uncheckedFids } =
      await getProvider().getPrimaryAddresses(followingScan);
    const entries = followingScan
      .filter((f) => addresses.has(f))
      .map((f) => ({ fid: f, address: addresses.get(f)! }));

    const body: ConnectionsResponse = {
      followingTotal: following.fids.length,
      followersTotal: followers.fids.length,
      withWallet: entries.length,
      // only the following direction is in the default scan, so only its
      // truncation matters here (the followers pass reports its own).
      truncated: following.truncated,
      unchecked: uncheckedFids.length,
      uncheckedFids,
      bulkProvider: hasBulkProvider(),
      entries,
      followingFids: following.fids,
      followerFids: followers.fids,
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}

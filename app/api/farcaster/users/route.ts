import { errorResponse, getUserByFid, parseFids } from "@/lib/farcaster-server";
import { mapLimit } from "@/lib/util";

// GET /api/farcaster/users?fids=1,2,3 (max 150)
// → hydrated Farcaster profiles for the matched FIDs only.
export async function GET(request: Request) {
  const fids = parseFids(new URL(request.url).searchParams.get("fids"), 150);
  if (!fids) {
    return Response.json({ error: "fids is required (comma-separated)" }, { status: 400 });
  }
  try {
    const users = await mapLimit(fids, 8, async (fid) => {
      try {
        return await getUserByFid(fid);
      } catch {
        return null; // one failed profile shouldn't sink the page
      }
    });
    return Response.json({ users: users.filter(Boolean) });
  } catch (err) {
    return errorResponse(err);
  }
}

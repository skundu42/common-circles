import { errorResponse, getProvider, parseFids, rateLimitByIp } from "@/lib/farcaster-server";

export const maxDuration = 30;

// GET /api/farcaster/users?fids=1,2,3 (max 150)
// → hydrated Farcaster profiles for the matched FIDs only (bulk via provider).
export async function GET(request: Request) {
  const limited = rateLimitByIp(request);
  if (limited) return limited;
  const fids = parseFids(new URL(request.url).searchParams.get("fids"), 150);
  if (!fids) {
    return Response.json({ error: "fids is required (comma-separated)" }, { status: 400 });
  }
  try {
    const users = await getProvider().getUsersByFids(fids);
    return Response.json({ users });
  } catch (err) {
    return errorResponse(err);
  }
}

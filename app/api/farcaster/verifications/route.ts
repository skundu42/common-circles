import {
  errorResponse,
  getProvider,
  parseFids,
  rateLimitByIp,
} from "@/lib/farcaster-server";

export const maxDuration = 30;

// GET /api/farcaster/verifications?fids=1,2,3 (max 100)
// → ALL verified ethereum addresses per FID. Powers the deep scan: people
// whose Circles avatar lives on a non-primary verified wallet. A fid whose
// fetch fails is reported in `failedFids` (drives targeted retry) rather than
// silently returning an empty row.
export async function GET(request: Request) {
  const limited = rateLimitByIp(request);
  if (limited) return limited;
  const fids = parseFids(new URL(request.url).searchParams.get("fids"), 100);
  if (!fids) {
    return Response.json({ error: "fids is required (comma-separated)" }, { status: 400 });
  }
  try {
    const { rows, failedFids } = await getProvider().getVerificationsByFids(fids);
    return Response.json({ rows, failedFids });
  } catch (err) {
    return errorResponse(err);
  }
}

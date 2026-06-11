import { errorResponse, getAllEthVerifications, parseFids } from "@/lib/farcaster-server";
import { mapLimit } from "@/lib/util";
import type { VerificationsRow } from "@/lib/types";

// GET /api/farcaster/verifications?fids=1,2,3 (max 100)
// → ALL verified ethereum addresses per FID. Powers the deep scan: people
// whose Circles avatar lives on a non-primary verified wallet.
export async function GET(request: Request) {
  const fids = parseFids(new URL(request.url).searchParams.get("fids"), 100);
  if (!fids) {
    return Response.json({ error: "fids is required (comma-separated)" }, { status: 400 });
  }
  try {
    const rows = await mapLimit(fids, 8, async (fid): Promise<VerificationsRow> => {
      try {
        return { fid, addresses: await getAllEthVerifications(fid) };
      } catch {
        return { fid, addresses: [] };
      }
    });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}

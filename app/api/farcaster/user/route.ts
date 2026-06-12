import { errorResponse, resolveFarcasterUser, UpstreamError } from "@/lib/farcaster-server";

export const maxDuration = 30;

function notFoundMessage(input: string): string {
  if (/^0x[0-9a-f]{40}$/.test(input)) {
    return "No Farcaster account is linked to that address (resolution works via its primary ENS name).";
  }
  if (input.includes(".")) {
    return `Couldn't find a Farcaster account for “${input}” — tried it as a username and as an ENS name.`;
  }
  return `No Farcaster account named “${input}”.`;
}

// GET /api/farcaster/user?q=<handle | ens name | 0x address> → FarcasterUser
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = params.get("q") ?? params.get("username") ?? "";
  const query = raw.trim().replace(/^@/, "").toLowerCase();
  if (!query) {
    return Response.json({ error: "q is required" }, { status: 400 });
  }
  try {
    return Response.json(await resolveFarcasterUser(query));
  } catch (err) {
    if (err instanceof UpstreamError && (err.status === 400 || err.status === 404)) {
      return Response.json({ error: notFoundMessage(query) }, { status: 404 });
    }
    return errorResponse(err);
  }
}

import { requireAgentUserId } from "@/lib/api-tokens";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errorResponse, HttpError } from "@/lib/errors";
import { handleMcpMessage, RPC, SUPPORTED_PROTOCOL_VERSIONS } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 512 * 1024;

/**
 * Remote MCP endpoint (Streamable HTTP, stateless, JSON responses). Auth: `Authorization: Bearer myk_…`
 * (an API token from the app's Agents panel). Cookies are ignored, so no CSRF checks are needed; a present
 * Origin header must still be our own (the spec's DNS-rebinding guard).
 */
export async function POST(req: Request) {
  try {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(env.appUrl).origin) throw new HttpError(403, "Cross-origin request rejected");
    const version = req.headers.get("mcp-protocol-version");
    if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      throw new HttpError(400, `Unsupported MCP-Protocol-Version: ${version}`);
    }
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    const db = await getDb();
    const userId = await requireAgentUserId(db, req);

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: RPC.parse, message: "Parse error" } }, { status: 400 });
    }
    const out = await handleMcpMessage(db, userId, body);
    if (!out) return new Response(null, { status: 202 });
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const res = errorResponse(e);
    if (res.status === 401) {
      const headers = new Headers(res.headers);
      headers.set("WWW-Authenticate", 'Bearer realm="mykfully", error="invalid_token"');
      return new Response(res.body, { status: 401, headers });
    }
    return res;
  }
}

/** No server-initiated stream: GET/DELETE are not offered (stateless server). */
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
export const DELETE = GET;

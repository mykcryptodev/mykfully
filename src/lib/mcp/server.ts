import { z } from "zod";
import type { DB } from "../db";
import { toPublicError } from "../errors";
import { limitNamed } from "../ratelimit";
import { TOOLS, type ToolCtx, type ToolResult } from "./tools";

/**
 * A minimal, stateless MCP server (Streamable HTTP transport, JSON responses only, no SSE, no sessions).
 * Implements initialize, ping, tools/list and tools/call, which is all the tools need; it avoids pulling the
 * MCP SDK (and its express/hono dependency tree) into a money-handling app.
 * Spec: https://modelcontextprotocol.io/specification
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "mykfully", title: "mykfully", version: "1.0.0" };

const INSTRUCTIONS = [
  "mykfully drafts X (Twitter) threads for the signed-in user.",
  "Workflow: get_account (limits, credits) → create_draft or update_draft → preview_draft (mobile by default) → share the draft url so the user can schedule or publish it in the app.",
  "You cannot schedule, publish or delete; never claim a post went out.",
  "Keep every post within maxLength (fits=true). For a thread, split at natural sentence boundaries.",
  "buy_credits explains the x402 purchase; always confirm the price with the user before paying.",
].join(" ");

type JsonRpcId = string | number;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId | null; method: string; params?: unknown };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 };

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const toolList = TOOLS.map((t) => {
  const inputSchema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
  };
});

function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Tool failures are results with isError (so the model can read and fix them), not protocol errors. */
function toolError(e: unknown): ToolResult {
  if (e instanceof z.ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid arguments", code: "invalid_request", issues }) }], isError: true };
  }
  const pe = toPublicError(e);
  return { content: [{ type: "text", text: JSON.stringify({ error: pe.message, code: pe.code, ...(pe.extra ?? {}) }) }], isError: true };
}

async function callTool(ctx: ToolCtx, params: unknown, id: JsonRpcId | null): Promise<JsonRpcResponse> {
  const p = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
  if (!p.success) return rpcError(id, RPC.invalidParams, "Invalid tools/call params");
  const t = TOOLS.find((x) => x.name === p.data.name);
  if (!t) return rpcError(id, RPC.invalidParams, `Unknown tool: ${p.data.name}`);
  try {
    await limitNamed(ctx.db, "agent", ctx.userId);
    const args = t.input.parse(p.data.arguments ?? {});
    const run = t.run as (c: ToolCtx, a: unknown) => Promise<ToolResult>;
    return { jsonrpc: "2.0", id, result: await run(ctx, args) };
  } catch (e) {
    return { jsonrpc: "2.0", id, result: toolError(e) };
  }
}

async function dispatch(ctx: ToolCtx, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
      };
    }
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolList } };
    case "tools/call":
      return callTool(ctx, msg.params, id);
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
      return rpcError(id, RPC.methodNotFound, `Method not found: ${msg.method}`);
  }
}

/**
 * Handle one POSTed JSON-RPC message for an authenticated user. Returns the JSON body to send, or null for a
 * notification/response (→ 202 with no body). Batches are rejected (removed from the spec in 2025-06-18).
 */
export async function handleMcpMessage(db: DB, userId: string, body: unknown): Promise<JsonRpcResponse | null> {
  if (Array.isArray(body)) return rpcError(null, RPC.invalidRequest, "Batch requests are not supported");
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // A JSON-RPC response or anything else from the client: nothing to answer.
    if (body && typeof body === "object" && ("result" in body || "error" in body)) return null;
    return rpcError(null, RPC.invalidRequest, "Invalid JSON-RPC request");
  }
  return dispatch({ db, userId }, parsed.data as JsonRpcRequest);
}

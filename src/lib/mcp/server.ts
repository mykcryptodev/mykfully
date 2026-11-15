import { z } from "zod";
import type { DB } from "../db";
import type { TokenScopes } from "../api-tokens";
import { toPublicError } from "../errors";
import { limitNamed } from "../ratelimit";
import { TOOLS, type Scope, type ToolCtx, type ToolResult } from "./tools";

/**
 * A minimal, stateless MCP server (Streamable HTTP transport, JSON responses only, no SSE, no sessions).
 * Implements initialize, ping, tools/list and tools/call, which is all the tools need; it avoids pulling the
 * MCP SDK (and its express/hono dependency tree) into a money-handling app.
 * Spec: https://modelcontextprotocol.io/specification
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "mykfully", title: "mykfully", version: "1.0.0" };

const SCOPE_LABEL: Record<Scope, string> = { schedule: "schedule", publish: "publish", delete: "delete" };

/** Server instructions reflect what this token may do right now. */
export function instructionsFor(scopes: TokenScopes): string {
  const allowed = (Object.keys(SCOPE_LABEL) as Scope[]).filter((k) => scopes[k]);
  const denied = (Object.keys(SCOPE_LABEL) as Scope[]).filter((k) => !scopes[k]);
  return [
    "mykfully drafts X (Twitter) threads for the signed-in user.",
    "Workflow: get_account (limits, credits, permissions) → create_draft or update_draft → preview_draft (mobile by default) → share the draft url.",
    allowed.length ? `This token may also ${allowed.join(", ")}.` : "",
    scopes.publish ? "publish_draft posts publicly and spends credits: only when the user explicitly asks to post that thread now." : "",
    scopes.schedule ? "Confirm the time and timezone before schedule_draft." : "",
    denied.length ? `This token can't ${denied.join(" or ")}; the user does that in the app (or enables it for this token under Connect an agent, after which this client may need to reconnect to see the tools). Never claim a post went out unless publish_draft returned published: true.` : "",
    "Keep every post within maxLength (fits=true). For a thread, split at natural sentence boundaries.",
    "buy_credits explains the x402 purchase; always confirm the price with the user before paying.",
  ].filter(Boolean).join(" ");
}

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

const toolDefs = TOOLS.map((t) => {
  const inputSchema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    scope: t.scope,
    def: {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        destructiveHint: !!t.destructive,
        idempotentHint: t.readOnly,
        openWorldHint: !!t.openWorld,
      },
    },
  };
});

/** Only the tools this token may call (the authoritative check is in callTool, since clients cache the list). */
export function listTools(scopes: TokenScopes) {
  return toolDefs.filter((t) => !t.scope || scopes[t.scope]).map((t) => t.def);
}

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
  if (t.scope && !ctx.scopes[t.scope]) {
    // Checked per call against the token's current permissions, so turning one off applies immediately.
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `This token isn't allowed to ${SCOPE_LABEL[t.scope]}. The user can enable it in mykfully under Connect an agent, or do it in the app.`,
              code: "permission_denied",
              permission: t.scope,
            }),
          },
        ],
        isError: true,
      },
    };
  }
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
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instructionsFor(ctx.scopes) },
      };
    }
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listTools(ctx.scopes) } };
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
export async function handleMcpMessage(db: DB, auth: { userId: string; scopes: TokenScopes }, body: unknown): Promise<JsonRpcResponse | null> {
  if (Array.isArray(body)) return rpcError(null, RPC.invalidRequest, "Batch requests are not supported");
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // A JSON-RPC response or anything else from the client: nothing to answer.
    if (body && typeof body === "object" && ("result" in body || "error" in body)) return null;
    return rpcError(null, RPC.invalidRequest, "Invalid JSON-RPC request");
  }
  return dispatch({ db, userId: auth.userId, scopes: auth.scopes }, parsed.data as JsonRpcRequest);
}

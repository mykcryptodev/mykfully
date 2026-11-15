import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));

import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { createApiToken, hashToken, listApiTokens, requireAgentUserId, resolveApiToken, revokeApiToken, MAX_TOKENS_PER_USER } from "@/lib/api-tokens";
import { handleMcpMessage } from "@/lib/mcp/server";
import sharp from "sharp";
import { imageSize, renderThreadPreview, PREVIEW_MAX_BYTES } from "@/lib/preview";
import { appendMediaChunk, startMediaUpload } from "@/lib/media";
import { MEDIA_CHUNK_SIZE, type MediaAttachment, type MediaContentType } from "@/lib/media-types";
import { setFacilitatorClient } from "@/lib/payments/x402";
import { getBalance } from "@/lib/credits";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { POST as agentPurchaseRoute } from "@/app/api/agent/credits/purchase/route";
import { installTestDb, setAuthEnv } from "./auth-helpers";

const ORIGIN = "http://localhost:3000";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const SEPOLIA = "eip155:84532";

let db: DB;
beforeEach(async () => {
  setAuthEnv();
  delete process.env.APP_URL;
  db = await installTestDb();
  await db.insert(schema.users).values([
    { id: "u1", username: "alice", name: "Alice", credits: 100 },
    { id: "u2", username: "bob", name: "Bob", credits: 0 },
  ]);
});
afterEach(() => {
  for (const k of ["PAY_TO_ADDRESS", "X402_NETWORK"]) delete process.env[k];
  setFacilitatorClient(null);
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const req = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers });

type ToolOut = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
async function call(userId: string, name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  const res = await handleMcpMessage(db, userId, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(res && "result" in res).toBe(true);
  return (res as { result: ToolOut }).result;
}
const body = (r: ToolOut) => JSON.parse(r.content.find((c) => c.type === "text")!.text!);

describe("API tokens", () => {
  it("stores only a hash, resolves to the owner, and stops working when revoked", async () => {
    const { token, row } = await createApiToken(db, "u1", { name: "Claude" });
    expect(token).toMatch(/^myk_[A-Za-z0-9_-]{43}$/);
    const [stored] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, row.id));
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(await resolveApiToken(db, token)).toBe("u1");
    expect((await db.select().from(schema.apiTokens))[0].lastUsedAt).not.toBeNull();

    await expect(revokeApiToken(db, "u2", row.id)).rejects.toMatchObject({ status: 404 }); // not bob's
    await revokeApiToken(db, "u1", row.id);
    expect(await resolveApiToken(db, token)).toBeNull();
    expect(await listApiTokens(db, "u1")).toHaveLength(0);
  });

  it("rejects malformed and unknown tokens, and caps tokens per user", async () => {
    expect(await resolveApiToken(db, "myk_short")).toBeNull();
    expect(await resolveApiToken(db, `myk_${"a".repeat(43)}`)).toBeNull();
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) await createApiToken(db, "u2", { name: `t${i}` });
    await expect(createApiToken(db, "u2", { name: "one more" })).rejects.toMatchObject({ status: 403 });
  });

  it("requireAgentUserId takes a bearer token only and ignores cookies", async () => {
    const { token } = await createApiToken(db, "u1", { name: "a" });
    expect(await requireAgentUserId(db, req(bearer(token)))).toBe("u1");
    await expect(requireAgentUserId(db, req({ cookie: "myk_session=whatever" }))).rejects.toMatchObject({ name: "UnauthorizedError" });
    await expect(requireAgentUserId(db, req({ authorization: token }))).rejects.toMatchObject({ name: "UnauthorizedError" });
  });

  it("stops working when the user is deleted", async () => {
    const { token } = await createApiToken(db, "u2", { name: "a" });
    await db.delete(schema.users).where(eq(schema.users.id, "u2"));
    expect(await resolveApiToken(db, token)).toBeNull();
  });
});

describe("MCP protocol", () => {
  it("initializes, negotiates the protocol version and lists the draft-only tools", async () => {
    const init = await handleMcpMessage(db, "u1", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mykfully" } } });
    const fallback = await handleMcpMessage(db, "u1", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((fallback as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");

    const list = (await handleMcpMessage(db, "u1", { jsonrpc: "2.0", id: 3, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(["get_account", "list_drafts", "get_draft", "create_draft", "update_draft", "preview_draft", "get_credits", "buy_credits"]);
    expect(names.some((n) => /publish|schedule|delete/.test(n))).toBe(false);
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
  });

  it("ignores notifications and rejects unknown methods and batches", async () => {
    expect(await handleMcpMessage(db, "u1", { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleMcpMessage(db, "u1", { jsonrpc: "2.0", id: 9, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcpMessage(db, "u1", [{ jsonrpc: "2.0", id: 1, method: "ping" }])).toMatchObject({ error: { code: -32600 } });
    expect(await handleMcpMessage(db, "u1", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_now" } })).toMatchObject({ error: { code: -32602 } });
  });
});

describe("MCP tools", () => {
  it("creates, reads and updates drafts scoped to the token's user, with X-weighted lengths", async () => {
    const created = await call("u1", "create_draft", { posts: [{ text: "hello @bob https://example.com/a/very/long/path" }, { text: "x".repeat(281) }] });
    expect(created.isError).toBeFalsy();
    const draft = body(created).draft;
    expect(draft).toMatchObject({ status: "draft", url: `${ORIGIN}/drafts/${draft.id}` });
    expect(draft.posts[0]).toMatchObject({ length: 34, maxLength: 280, fits: true }); // URLs count as 23
    expect(draft.posts[1]).toMatchObject({ length: 281, fits: false });

    const updated = body(await call("u1", "update_draft", { draftId: draft.id, posts: [{ id: draft.posts[0].id, text: "edited" }, { text: "new post" }] })).draft;
    expect(updated.posts.map((p: { text: string }) => p.text)).toEqual(["edited", "new post"]);
    expect(updated.posts[0].id).toBe(draft.posts[0].id);

    // Bob can't see or edit Alice's draft.
    expect(body(await call("u2", "get_draft", { draftId: draft.id }))).toMatchObject({ code: "error", error: "Draft not found" });
    expect((await call("u2", "update_draft", { draftId: draft.id, posts: [{ text: "pwned" }] })).isError).toBe(true);
    expect(body(await call("u2", "list_drafts")).drafts).toHaveLength(0);
    expect(body(await call("u1", "list_drafts")).drafts).toHaveLength(1);
  });

  it("can't edit a scheduled thread", async () => {
    const draft = body(await call("u1", "create_draft", { posts: [{ text: "hi" }] })).draft;
    await db.update(schema.drafts).set({ status: "scheduled", scheduledAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.drafts.id, draft.id));
    const res = await call("u1", "update_draft", { draftId: draft.id, posts: [{ text: "changed" }] });
    expect(res.isError).toBe(true);
    expect(body(res).error).toMatch(/scheduled/);
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(row.posts[0].text).toBe("hi");
  });

  it("returns validation problems as tool errors the model can fix", async () => {
    const res = await call("u1", "create_draft", { posts: [] });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatchObject({ code: "invalid_request" });
    expect((await call("u1", "preview_draft", {})).isError).toBe(true); // needs draftId or posts
  });

  it("renders PNG previews, mobile by default and desktop on request", async () => {
    const mobile = await call("u1", "preview_draft", { posts: [{ text: "Hello #world" }, { text: "second post" }] });
    expect(mobile.isError).toBeFalsy();
    const img = mobile.content.find((c) => c.type === "image")!;
    expect(img.mimeType).toBe("image/png");
    const png = Buffer.from(img.data!, "base64");
    expect(imageSize(png)?.width).toBe(786); // 393px at 2x
    expect(mobile.structuredContent).toMatchObject({ device: "mobile", totalPosts: 2 });

    const draft = body(await call("u1", "create_draft", { posts: [{ text: "desktop" }] })).draft;
    const desktop = await call("u1", "preview_draft", { draftId: draft.id, device: "desktop", theme: "dark" });
    expect(imageSize(Buffer.from(desktop.content[0].data!, "base64"))?.width).toBe(1200);
    expect((await call("u2", "preview_draft", { draftId: draft.id })).isError).toBe(true);
  }, 30_000);

  it("pages long threads", async () => {
    const posts = Array.from({ length: 10 }, (_, i) => ({ text: `post ${i + 1}` }));
    const first = await call("u1", "preview_draft", { posts });
    expect(first.structuredContent).toMatchObject({ postsShown: { from: 0, to: 7 }, nextStart: 8 });
    const second = await call("u1", "preview_draft", { posts, start: 8 });
    expect(second.structuredContent).toMatchObject({ postsShown: { from: 8, to: 9 } });
    expect(second.structuredContent?.nextStart).toBeUndefined();
  }, 30_000);

  it("reports balance and explains how to buy credits over x402", async () => {
    expect(body(await call("u1", "get_credits"))).toMatchObject({ balance: 100, unlimited: false });
    const disabled = body(await call("u1", "buy_credits", { packId: "p1" }));
    expect(disabled).toMatchObject({ code: "purchases_disabled" });
    expect(disabled.error).toMatch(/not enabled/);

    process.env.PAY_TO_ADDRESS = PAY_TO;
    process.env.X402_NETWORK = "base-sepolia";
    const info = body(await call("u1", "buy_credits", { packId: "p5" }));
    expect(info).toMatchObject({
      pack: { id: "p5", usd: 5, credits: 5000 },
      priceUsdc: "5.00",
      network: "base-sepolia",
      payTo: PAY_TO,
      request: { method: "POST", url: `${ORIGIN}/api/agent/credits/purchase`, body: { packId: "p5" } },
    });
    expect(JSON.stringify(info)).not.toMatch(/myk_[A-Za-z0-9_-]{43}/); // never echoes a real token
    expect(body(await call("u1", "get_account")).purchase).toMatchObject({ enabled: true, purchaseUrl: `${ORIGIN}/api/agent/credits/purchase` });
    expect((await call("u1", "buy_credits", { packId: "p999" })).isError).toBe(true);
  });
});

/** Upload a photo-like (noisy, poorly compressible) image as the user's media. */
async function uploadNoise(userId: string, format: "jpeg" | "webp" | "gif", seed: number): Promise<MediaAttachment> {
  const w = 1600, h = 1200;
  const raw = Buffer.alloc(w * h * 3);
  let x = seed * 2654435761;
  for (let i = 0; i < raw.length; i++) raw[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  const bytes = await (format === "jpeg" ? img.jpeg({ quality: 80 }) : format === "webp" ? img.webp({ quality: 70 }) : img.resize(400).gif()).toBuffer();
  const contentType = `image/${format}` as MediaContentType;
  const a = await startMediaUpload(db, userId, { name: `p.${format}`, contentType, size: bytes.length });
  for (let off = 0; off < bytes.length; off += MEDIA_CHUNK_SIZE) {
    await appendMediaChunk(db, userId, a.id, { offset: off, data: bytes.subarray(off, off + MEDIA_CHUNK_SIZE).toString("base64") });
  }
  return { ...a, size: bytes.length };
}

describe("preview media", () => {
  it("renders WebP/JPEG/GIF attachments and keeps photo-heavy pages under the byte budget", async () => {
    const [jpg, webp, gif] = [await uploadNoise("u1", "jpeg", 1), await uploadNoise("u1", "webp", 2), await uploadNoise("u1", "gif", 3)];

    // A single WebP actually renders (resvg alone can't decode WebP): the media area isn't blank.
    const one = await renderThreadPreview(db, "u1", [{ text: "webp", media: [webp] }], { device: "mobile", theme: "light", numbered: false, start: 0 });
    const stats = await sharp(one.image).extract({ left: 150, top: 200, width: 400, height: 200 }).stats();
    expect(stats.channels[0].stdev).toBeGreaterThan(20);

    const posts = Array.from({ length: 8 }, (_, i) => ({ text: `post ${i}`, media: i % 2 ? [jpg, webp, jpg, webp] : [i === 2 ? gif : jpg] }));
    const heavy = await renderThreadPreview(db, "u1", posts, { device: "desktop", theme: "light", numbered: true, start: 0 });
    expect(heavy.image.length).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(heavy.shown[0]).toBe(0);
    expect(heavy.total).toBe(8);

    // Another user's media id isn't rendered (loadMedia is owner-scoped) and doesn't fail the render.
    const other = await renderThreadPreview(db, "u2", [{ text: "x", media: [jpg] }], { device: "mobile", theme: "light", numbered: false, start: 0 });
    expect(other.image.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("MCP route", () => {
  const post = (payload: unknown, headers: Record<string, string>) =>
    mcpRoute(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) }));

  it("needs a bearer token (401 + WWW-Authenticate)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("serves JSON-RPC for a valid token and rejects foreign origins", async () => {
    const { token } = await createApiToken(db, "u1", { name: "a" });
    const ok = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, bearer(token));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, bearer(token))).status).toBe(202);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { ...bearer(token), origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { ...bearer(token), "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
  });
});

/** Facilitator double (same shape as purchases.test.ts). */
class StubFacilitator implements FacilitatorClient {
  settleCalls = 0;
  async verify(): Promise<VerifyResponse> {
    return { isValid: true };
  }
  async settle(): Promise<SettleResponse> {
    this.settleCalls++;
    return { success: true, transaction: `0x${"ab".repeat(32)}`, network: SEPOLIA };
  }
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: SEPOLIA as `${string}:${string}` }], extensions: [], signers: {} };
  }
}

describe("agent x402 purchase route", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: SEPOLIA, client: new ExactEvmScheme(account) }] }));
  const buy = (headers: Record<string, string>) =>
    agentPurchaseRoute(
      new Request(`${ORIGIN}/api/agent/credits/purchase`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ packId: "p1" }) }),
    );

  it("challenges, settles and credits the token's user (no Origin header needed)", async () => {
    process.env.PAY_TO_ADDRESS = PAY_TO;
    process.env.X402_NETWORK = "base-sepolia";
    const fac = new StubFacilitator();
    setFacilitatorClient(fac);
    const { token } = await createApiToken(db, "u2", { name: "agent" });

    expect((await buy({})).status).toBe(401);
    const challengeRes = await buy(bearer(token));
    expect(challengeRes.status).toBe(402);
    const challenge = wallet.getPaymentRequiredResponse((n) => challengeRes.headers.get(n), await challengeRes.json());
    expect(challenge.resource?.url).toBe(`${ORIGIN}/api/agent/credits/purchase`);
    expect(challenge.accepts[0]).toMatchObject({ amount: "1000000", payTo: PAY_TO });

    const payment = await wallet.createPaymentPayload(challenge);
    const paid = await buy({ ...bearer(token), ...wallet.encodePaymentSignatureHeader(payment) });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ balance: 1000, credits: 1000 });
    expect(fac.settleCalls).toBe(1);
    expect(await getBalance(db, "u2")).toBe(1000);
    expect(await getBalance(db, "u1")).toBe(100);
  });
});

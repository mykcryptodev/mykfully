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
import {
  createApiToken, hashToken, listApiTokens, requireAgentUserId, resolveApiToken, revokeApiToken, updateApiTokenScopes,
  MAX_TOKENS_PER_USER, NO_SCOPES, type TokenScopes,
} from "@/lib/api-tokens";
import { handleMcpMessage } from "@/lib/mcp/server";
import sharp from "sharp";
import { imageSize, renderThreadPreview, PREVIEW_MAX_BYTES } from "@/lib/preview";
import { appendMediaChunk, startMediaUpload } from "@/lib/media";
import { MEDIA_CHUNK_SIZE, type MediaAttachment, type MediaContentType } from "@/lib/media-types";
import { setFacilitatorClient } from "@/lib/payments/x402";
import { getBalance } from "@/lib/credits";
import { resetMockCounters } from "@/lib/x/mock";
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
const ALL: TokenScopes = { schedule: true, publish: true, delete: true };
async function call(userId: string, name: string, args: Record<string, unknown> = {}, scopes: TokenScopes = NO_SCOPES): Promise<ToolOut> {
  const res = await handleMcpMessage(db, { userId, scopes }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
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
    expect(await resolveApiToken(db, token)).toMatchObject({ userId: "u1", scopes: NO_SCOPES });
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
    const init = await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mykfully" } } });
    const fallback = await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((fallback as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");

    const list = (await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, { jsonrpc: "2.0", id: 3, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(["get_account", "list_drafts", "get_draft", "create_draft", "update_draft", "preview_draft", "get_credits", "buy_credits"]);
    expect(names.some((n) => /publish|schedule|delete/.test(n))).toBe(false); // nothing beyond drafting by default
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
  });

  it("ignores notifications and rejects unknown methods and batches", async () => {
    expect(await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, { jsonrpc: "2.0", id: 9, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).toMatchObject({ error: { code: -32600 } });
    expect(await handleMcpMessage(db, { userId: "u1", scopes: NO_SCOPES }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_now" } })).toMatchObject({ error: { code: -32602 } });
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

describe("token permissions", () => {
  it("default to off, can be set at creation and changed later (partial updates, owner only)", async () => {
    const plain = await createApiToken(db, "u1", { name: "plain" });
    expect(await resolveApiToken(db, plain.token)).toMatchObject({ scopes: NO_SCOPES });
    const pub = await createApiToken(db, "u1", { name: "pub", scopes: { publish: true } });
    expect(await resolveApiToken(db, pub.token)).toMatchObject({ scopes: { schedule: false, publish: true, delete: false } });

    await updateApiTokenScopes(db, "u1", plain.row.id, { scopes: { schedule: true, delete: true } });
    expect(await resolveApiToken(db, plain.token)).toMatchObject({ scopes: { schedule: true, publish: false, delete: true } });
    await updateApiTokenScopes(db, "u1", plain.row.id, { scopes: { delete: false } });
    expect(await resolveApiToken(db, plain.token)).toMatchObject({ scopes: { schedule: true, publish: false, delete: false } });

    await expect(updateApiTokenScopes(db, "u2", plain.row.id, { scopes: { publish: true } })).rejects.toMatchObject({ status: 404 });
    await expect(updateApiTokenScopes(db, "u1", plain.row.id, { scopes: { admin: true } })).rejects.toBeTruthy(); // unknown keys rejected
    await revokeApiToken(db, "u1", plain.row.id);
    await expect(updateApiTokenScopes(db, "u1", plain.row.id, { scopes: { publish: true } })).rejects.toMatchObject({ status: 404 });
  });

  it("lists only permitted tools and refuses the rest at call time", async () => {
    const list = (s: TokenScopes) =>
      handleMcpMessage(db, { userId: "u1", scopes: s }, { jsonrpc: "2.0", id: 1, method: "tools/list" }).then(
        (r) => (r as { result: { tools: { name: string; annotations: { destructiveHint: boolean; openWorldHint: boolean } }[] } }).result.tools,
      );
    const all = await list(ALL);
    expect(all.map((t) => t.name)).toEqual(expect.arrayContaining(["schedule_draft", "unschedule_draft", "publish_draft", "delete_draft"]));
    expect(all.find((t) => t.name === "publish_draft")?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect((await list({ ...NO_SCOPES, delete: true })).map((t) => t.name)).toContain("delete_draft");
    expect((await list({ ...NO_SCOPES, delete: true })).map((t) => t.name)).not.toContain("publish_draft");

    const draft = body(await call("u1", "create_draft", { posts: [{ text: "hi" }] })).draft;
    for (const [name, args] of [["publish_draft", {}], ["schedule_draft", { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }], ["delete_draft", {}]] as const) {
      const res = await call("u1", name, { draftId: draft.id, ...args });
      expect(res.isError).toBe(true);
      expect(body(res)).toMatchObject({ code: "permission_denied" });
    }
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(row.status).toBe("draft");
  });

  it("schedule: schedules with the app's checks, edits scheduled threads, unschedules", async () => {
    const s = { ...NO_SCOPES, schedule: true };
    const draft = body(await call("u1", "create_draft", { posts: [{ text: "x".repeat(281) }] })).draft;
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const tooLong = await call("u1", "schedule_draft", { draftId: draft.id, scheduledAt: at }, s);
    expect(body(tooLong)).toMatchObject({ code: "post_too_long" });

    await call("u1", "update_draft", { draftId: draft.id, posts: [{ id: draft.posts[0].id, text: "ok now" }] }, s);
    const scheduled = body(await call("u1", "schedule_draft", { draftId: draft.id, scheduledAt: at }, s)).draft;
    expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: at });
    expect(body(await call("u1", "schedule_draft", { draftId: draft.id, scheduledAt: new Date(Date.now() - 3_600_000).toISOString() }, s)).error).toMatch(/future/);

    // With the schedule permission a scheduled thread can be edited (and stays scheduled); without it, it can't.
    expect((await call("u1", "update_draft", { draftId: draft.id, posts: [{ text: "edited" }] })).isError).toBe(true);
    expect(body(await call("u1", "update_draft", { draftId: draft.id, posts: [{ text: "edited" }] }, s)).draft).toMatchObject({ status: "scheduled" });

    expect(body(await call("u1", "unschedule_draft", { draftId: draft.id }, s)).draft).toMatchObject({ status: "draft", scheduledAt: null });
    expect((await call("u1", "unschedule_draft", { draftId: draft.id }, s)).isError).toBe(true); // already a draft

    // Credits are checked when scheduling, as in the app.
    const poor = body(await call("u2", "create_draft", { posts: [{ text: "no credits" }] })).draft;
    expect(body(await call("u2", "schedule_draft", { draftId: poor.id, scheduledAt: at }, s))).toMatchObject({ code: "insufficient_credits" });
  });

  it("never re-runs a thread whose last publish was uncertain (it may be partly on X)", async () => {
    process.env.MOCK_X = "1";
    try {
      const draft = body(await call("u1", "create_draft", { posts: [{ text: "maybe posted" }] })).draft;
      await db.update(schema.drafts).set({ status: "failed", lastError: "[publish_uncertain] X may have posted" }).where(eq(schema.drafts.id, draft.id));
      const at = new Date(Date.now() + 3_600_000).toISOString();
      expect(body(await call("u1", "publish_draft", { draftId: draft.id }, ALL))).toMatchObject({ code: "publish_uncertain_review" });
      expect(body(await call("u1", "schedule_draft", { draftId: draft.id, scheduledAt: at }, ALL))).toMatchObject({ code: "publish_uncertain_review" });
      // Unscheduling moves it to "draft" but keeps last_error, so it still can't be published or scheduled.
      expect(body(await call("u1", "unschedule_draft", { draftId: draft.id }, ALL)).draft.status).toBe("draft");
      expect(body(await call("u1", "publish_draft", { draftId: draft.id }, ALL))).toMatchObject({ code: "publish_uncertain_review" });
      expect(body(await call("u1", "schedule_draft", { draftId: draft.id, scheduledAt: at }, ALL))).toMatchObject({ code: "publish_uncertain_review" });
      const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
      expect(row.posts[0].tweetId).toBeUndefined();
      expect(await getBalance(db, "u1")).toBe(100); // nothing posted, nothing charged
    } finally {
      delete process.env.MOCK_X;
    }
  });

  it("publish failures come back as errors carrying the failed draft", async () => {
    process.env.MOCK_X = "1";
    process.env.MOCK_X_FAIL_AFTER = "2";
    resetMockCounters(); // the mock's post counter is process-wide
    try {
      const draft = body(await call("u1", "create_draft", { posts: [{ text: "one" }, { text: "two" }] })).draft;
      const res = await call("u1", "publish_draft", { draftId: draft.id }, { ...NO_SCOPES, publish: true });
      expect(res.isError).toBe(true);
      const out = body(res);
      expect(out.code).toBeTruthy();
      expect(out.draft).toMatchObject({ id: draft.id, status: "failed" });
      expect(out.draft.posts[0].tweetId).toBeTruthy(); // the first post went out and is recorded (resume-safe)
      expect(out.draft.posts[1].tweetId).toBeUndefined();
    } finally {
      delete process.env.MOCK_X;
      delete process.env.MOCK_X_FAIL_AFTER;
    }
  });

  it("delete: removes only the user's own thread", async () => {
    const d = { ...NO_SCOPES, delete: true };
    const draft = body(await call("u1", "create_draft", { posts: [{ text: "bye" }] })).draft;
    expect((await call("u2", "delete_draft", { draftId: draft.id }, d)).isError).toBe(true);
    expect(body(await call("u1", "delete_draft", { draftId: draft.id }, d))).toEqual({ deleted: true, draftId: draft.id });
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))).toHaveLength(0);
  });

  it("publish: posts through the metered client (mock X) and charges credits", async () => {
    process.env.MOCK_X = "1";
    try {
      const p = { ...NO_SCOPES, publish: true };
      const draft = body(await call("u1", "create_draft", { posts: [{ text: "first" }, { text: "second" }] })).draft;
      const res = await call("u1", "publish_draft", { draftId: draft.id }, p);
      expect(res.isError).toBeFalsy();
      const out = body(res);
      expect(out.published).toBe(true);
      expect(out.draft.status).toBe("published");
      expect(out.draft.posts.every((x: { tweetUrl?: string }) => x.tweetUrl?.startsWith("https://x.com/i/status/"))).toBe(true);
      expect(await getBalance(db, "u1")).toBe(100 - draft.estimatedCredits);
      expect((await call("u1", "publish_draft", { draftId: draft.id }, p)).isError).toBe(true); // already published

      // Validation failures (no credits) throw before the claim and leave the draft untouched.
      const poor = body(await call("u2", "create_draft", { posts: [{ text: "x" }] })).draft;
      expect(body(await call("u2", "publish_draft", { draftId: poor.id }, p))).toMatchObject({ code: "insufficient_credits" });
      const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, poor.id));
      expect(row.status).toBe("draft");
    } finally {
      delete process.env.MOCK_X;
    }
  });
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

  it("applies permission changes from the app on the very next request", async () => {
    const { token, row } = await createApiToken(db, "u1", { name: "a", scopes: { delete: true } });
    const draft = body(await call("u1", "create_draft", { posts: [{ text: "keep me" }] })).draft;
    const del = () => post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_draft", arguments: { draftId: draft.id } } }, bearer(token));
    const listed = async () => ((await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(token))).json()).result.tools as { name: string }[]).map((t) => t.name);

    expect(await listed()).toContain("delete_draft");
    await updateApiTokenScopes(db, "u1", row.id, { scopes: { delete: false } }); // the user unticks "Delete"
    expect(await listed()).not.toContain("delete_draft");
    const denied = await (await del()).json();
    expect(JSON.parse(denied.result.content[0].text)).toMatchObject({ code: "permission_denied", permission: "delete" });
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))).toHaveLength(1);

    await updateApiTokenScopes(db, "u1", row.id, { scopes: { delete: true } }); // and ticks it again
    expect((await (await del()).json()).result.isError).toBeFalsy();
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

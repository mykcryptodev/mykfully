import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db";
import { users, type ThreadPost } from "../db/schema";
import { CREDIT_COSTS, estimateThreadCost, getBalance, isAdmin, listLedger } from "../credits";
import { MAX_DRAFT_POST_CODE_UNITS, MAX_DRAFT_POSTS } from "../draft-limits";
import { createDraft, getDraft, listDrafts, statusSchema, updateDraft, type DraftRow } from "../drafts";
import { env } from "../env";
import { HttpError } from "../errors";
import { publicPurchaseInfo } from "../payments/config";
import { renderThreadPreview } from "../preview";
import { limitNamed } from "../ratelimit";
import { countPost, maxLengthFor } from "../text";

/**
 * MCP tools for agents. Deliberately draft-only: agents can create, read, edit (status "draft" only) and
 * preview threads, and check or buy credits. Scheduling, publishing and deleting stay in the web app, so a
 * human always decides what goes out on X. None of these tools call the X API (no credits are spent).
 */

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };
export type ToolCtx = { db: DB; userId: string };

type Tool<S extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  run: (ctx: ToolCtx, args: z.output<S>) => Promise<ToolResult>;
};

function tool<S extends z.ZodType>(t: Tool<S>): Tool<S> {
  return t;
}

const json = (data: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

async function author(db: DB, userId: string) {
  const [u] = await db
    .select({ username: users.username, name: users.name, verifiedType: users.verifiedType })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new HttpError(404, "User not found");
  return u;
}

function draftUrl(id: string): string {
  return `${env.appUrl}/drafts/${id}`;
}

/** What agents see for a draft: per-post weighted counts (the real twitter-text rules) and a cost estimate. */
function agentDraft(row: DraftRow, verifiedType: string | null) {
  return {
    id: row.id,
    status: row.status,
    url: draftUrl(row.id),
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    lastError: row.lastError,
    estimatedCredits: estimateThreadCost(row.posts),
    posts: row.posts.map((p) => postView(p, verifiedType)),
  };
}

function postView(p: Pick<ThreadPost, "id" | "text" | "media" | "tweetId">, verifiedType: string | null) {
  const c = countPost(p.text.trim(), { verifiedType });
  return {
    id: p.id,
    text: p.text,
    length: c.weighted,
    maxLength: c.max,
    fits: c.valid,
    ...(p.media?.length ? { media: p.media.map((m) => ({ type: m.contentType, altText: m.altText ?? null })) } : {}),
    ...(p.tweetId ? { tweetId: p.tweetId } : {}),
  };
}

const postText = z.string().max(MAX_DRAFT_POST_CODE_UNITS).describe("Post text. Mentions, hashtags and URLs are counted the way X counts them.");
const deviceSchema = z.enum(["mobile", "desktop"]).default("mobile").describe("Mobile (393px wide, the default) or desktop (600px).");
const themeSchema = z.enum(["light", "dark"]).default("light");

const purchaseInfo = () => {
  const info = publicPurchaseInfo();
  return {
    ...info,
    purchaseUrl: info.enabled ? `${env.appUrl}/api/agent/credits/purchase` : null,
  };
};

export const TOOLS = [
  tool({
    name: "get_account",
    title: "Get account",
    description:
      "The connected X account (name, @username, max post length), credit balance, what X actions cost, and whether credits can be bought with USDC over x402.",
    input: z.object({}),
    readOnly: true,
    async run({ db, userId }) {
      const [u, balance] = await Promise.all([author(db, userId), getBalance(db, userId)]);
      return json({
        account: { name: u.name, username: u.username, verifiedType: u.verifiedType, maxPostLength: maxLengthFor(u.verifiedType) },
        credits: { balance, unlimited: isAdmin(userId), costs: { post: CREDIT_COSTS.post, postWithUrl: CREDIT_COSTS.postWithUrl } },
        purchase: purchaseInfo(),
        appUrl: env.appUrl,
      });
    },
  }),

  tool({
    name: "list_drafts",
    title: "List drafts",
    description: "List the user's threads, newest first. Filter by status (draft, scheduled, publishing, published, failed).",
    input: z.object({
      status: statusSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    readOnly: true,
    async run({ db, userId }, { status, limit }) {
      const [u, rows] = await Promise.all([author(db, userId), listDrafts(db, userId, status)]);
      return json({
        drafts: rows.slice(0, limit).map((r) => {
          const d = agentDraft(r, u.verifiedType);
          return { id: d.id, status: d.status, url: d.url, updatedAt: d.updatedAt, scheduledAt: d.scheduledAt, posts: d.posts.length, firstPost: r.posts[0]?.text.slice(0, 140) ?? "" };
        }),
      });
    },
  }),

  tool({
    name: "get_draft",
    title: "Get draft",
    description: "Full contents of one thread: every post's text, X-weighted length vs. the limit, attached media and estimated credits to publish.",
    input: z.object({ draftId: z.string().max(100) }),
    readOnly: true,
    async run({ db, userId }, { draftId }) {
      const [u, row] = await Promise.all([author(db, userId), getDraft(db, userId, draftId)]);
      if (!row) throw new HttpError(404, "Draft not found");
      return json({ draft: agentDraft(row, u.verifiedType) });
    },
  }),

  tool({
    name: "create_draft",
    title: "Create draft",
    description:
      "Save a new thread as a draft (not scheduled, not posted). Pass one post for a single tweet or several for a thread. Returns the draft with per-post lengths; posts over the limit are saved but flagged with fits=false. The user reviews, schedules and publishes it in the app (draft url).",
    input: z.object({ posts: z.array(z.object({ text: postText })).min(1).max(MAX_DRAFT_POSTS) }),
    readOnly: false,
    async run({ db, userId }, { posts }) {
      await limitNamed(db, "draftCreate", userId);
      const row = await createDraft(db, userId, { posts: posts.map((p) => ({ id: randomUUID(), text: p.text })) });
      const u = await author(db, userId);
      return json({ draft: agentDraft(row, u.verifiedType) });
    },
  }),

  tool({
    name: "update_draft",
    title: "Update draft",
    description:
      "Replace the posts of a draft (status \"draft\" only; scheduled or failed threads must be changed in the app). Send the full list in order. Include a post's existing id to keep its attached media; posts without an id are new.",
    input: z.object({
      draftId: z.string().max(100),
      posts: z.array(z.object({ id: z.string().min(1).max(100).optional(), text: postText })).min(1).max(MAX_DRAFT_POSTS),
    }),
    readOnly: false,
    async run({ db, userId }, { draftId, posts }) {
      const row = await updateDraft(
        db,
        userId,
        draftId,
        { posts: posts.map((p) => ({ id: p.id ?? randomUUID(), text: p.text })) },
        ["draft"],
      );
      const u = await author(db, userId);
      return json({ draft: agentDraft(row, u.verifiedType) });
    },
  }),

  tool({
    name: "preview_draft",
    title: "Preview on X",
    description:
      "Render an image (PNG, or JPEG for photo-heavy threads) of how the thread will look on X, using the user's real name, handle and avatar. Pass draftId for a saved draft (includes its media) or posts for unsaved text. Mobile by default; device=desktop for the wider layout. Up to 8 posts per image: use start to page through longer threads.",
    input: z
      .object({
        draftId: z.string().max(100).optional(),
        posts: z.array(z.object({ text: postText })).min(1).max(MAX_DRAFT_POSTS).optional(),
        device: deviceSchema,
        theme: themeSchema,
        numbered: z.boolean().default(false).describe("Show 1/N, 2/N… on each post."),
        start: z.number().int().min(0).default(0).describe("Index of the first post to render."),
      })
      .refine((v) => !!v.draftId !== !!v.posts, { message: "Pass exactly one of draftId or posts" }),
    readOnly: true,
    async run({ db, userId }, { draftId, posts, device, theme, numbered, start }) {
      await limitNamed(db, "preview", userId);
      let thread: Pick<ThreadPost, "text" | "media">[];
      if (draftId) {
        const row = await getDraft(db, userId, draftId);
        if (!row) throw new HttpError(404, "Draft not found");
        thread = row.posts;
      } else {
        thread = posts!.map((p) => ({ text: p.text }));
      }
      const out = await renderThreadPreview(db, userId, thread, { device, theme, numbered, start });
      const summary = {
        device,
        theme,
        mimeType: out.mimeType,
        width: out.width,
        height: out.height,
        postsShown: { from: out.shown[0], to: out.shown[1] },
        totalPosts: out.total,
        ...(out.shown[1] < out.total - 1 ? { nextStart: out.shown[1] + 1 } : {}),
      };
      return {
        content: [
          { type: "image", data: out.image.toString("base64"), mimeType: out.mimeType },
          { type: "text", text: JSON.stringify(summary) },
        ],
        structuredContent: summary,
      };
    },
  }),

  tool({
    name: "get_credits",
    title: "Get credits",
    description: "Credit balance and recent ledger entries (charges, refunds, grants, purchases). 1 credit ≈ $0.001 of X API spend.",
    input: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    readOnly: true,
    async run({ db, userId }, { limit }) {
      const [balance, ledger] = await Promise.all([getBalance(db, userId), listLedger(db, userId, limit)]);
      return json({
        balance,
        unlimited: isAdmin(userId),
        ledger: ledger.map((r) => ({
          kind: r.kind,
          delta: r.delta,
          balanceAfter: r.balanceAfter,
          reason: r.reason,
          ref: r.ref,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },
  }),

  tool({
    name: "buy_credits",
    title: "Buy credits (x402)",
    description:
      "How to buy a credit pack with USDC on Base over x402. This tool does not pay: it returns the price and the exact HTTP request to make with an x402-capable wallet (for example the Base MCP initiate_x402_request tool). Always confirm the amount with the user before paying.",
    input: z.object({ packId: z.string().max(16).describe("Pack id from get_account purchase.packs, e.g. p1, p5, p20.") }),
    readOnly: true,
    async run(_ctx, { packId }) {
      const info = purchaseInfo();
      if (!info.enabled || !info.purchaseUrl) throw new HttpError(404, "Credit purchases are not enabled on this instance", { code: "purchases_disabled" });
      const pack = info.packs.find((p) => p.id === packId);
      if (!pack) throw new HttpError(400, `Unknown pack. Choose one of: ${info.packs.map((p) => p.id).join(", ")}`, { code: "unknown_pack" });
      return json({
        pack,
        priceUsdc: pack.usd.toFixed(2),
        network: info.network,
        chainId: info.chainId,
        payTo: info.payTo,
        asset: info.asset,
        request: {
          method: "POST",
          url: info.purchaseUrl,
          headers: { Authorization: "Bearer <the same mykfully API token this MCP server uses>", "Content-Type": "application/json" },
          body: { packId: pack.id },
        },
        steps: [
          `Confirm with the user: pay ${pack.usd.toFixed(2)} USDC on ${info.network} for ${pack.credits} credits.`,
          `Send the request with an x402 client and maxPayment ${pack.usd.toFixed(2)}. The server answers 402 with the challenge; the client signs and retries.`,
          "200 → { balance, credits, txHash }: done. 202 → { pending: true }: the payment was submitted but not confirmed; do NOT pay again, check get_credits later.",
          "Verify the challenge pays exactly the payTo and asset above before signing.",
        ],
      });
    },
  }),
];

export type AnyTool = (typeof TOOLS)[number];

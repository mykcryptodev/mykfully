import { pgTable, text, timestamp, integer, jsonb, uniqueIndex, index, boolean, primaryKey, bigserial, customType } from "drizzle-orm/pg-core";
import type { MediaAttachment, MediaContentType } from "../media-types";

export const users = pgTable("users", {
  id: text("id").primaryKey(), // X user id
  username: text("username").notNull(),
  name: text("name").notNull(),
  profileImageUrl: text("profile_image_url"),
  verifiedType: text("verified_type"), // "blue" | "business" | "government" | "none" | null
  timezone: text("timezone").default("UTC").notNull(),
  credits: integer("credits").default(0).notNull(), // 1 credit = $0.001 of X API spend
  sessionVersion: integer("session_version").default(1).notNull(), // bump to revoke all sessions
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// OAuth tokens, AES-GCM encrypted at rest (see src/lib/crypto.ts)
export const xTokens = pgTable("x_tokens", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope"),
  refreshingUntil: timestamp("refreshing_until", { withTimezone: true }), // refresh claim (cross-instance lock)
  needsReconnect: boolean("needs_reconnect").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DraftStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";

/** One post inside a thread. `tweetId` is filled in as each post is published (resume-safe). */
export type ThreadPost = {
  id: string; // client-generated uuid
  text: string;
  media?: MediaAttachment[];
  tweetId?: string | null;
};

export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(), // uuid
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    posts: jsonb("posts").$type<ThreadPost[]>().notNull(),
    status: text("status").$type<DraftStatus>().default("draft").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }), // UTC
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("drafts_user_idx").on(t.userId), index("drafts_due_idx").on(t.status, t.scheduledAt)],
);

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").$type<MediaContentType>().notNull(),
    size: integer("size").notNull(),
    uploadedSize: integer("uploaded_size").default(0).notNull(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("media_assets_user_touched_idx").on(t.userId, t.touchedAt)],
);

export const mediaChunks = pgTable(
  "media_chunks",
  {
    mediaId: text("media_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    byteOffset: integer("byte_offset").notNull(),
    bytes: bytea("bytes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.byteOffset] })],
);

export const mediaUsage = pgTable("media_usage", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  totalBytes: integer("total_bytes").notNull(),
  assetCount: integer("asset_count").notNull(),
});

// Cache of X users seen via lookup/search, for @mention autocomplete fallback
export const mentionCache = pgTable(
  "mention_cache",
  {
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    xUserId: text("x_user_id").notNull(),
    username: text("username").notNull(),
    name: text("name").notNull(),
    profileImageUrl: text("profile_image_url"),
    verifiedType: text("verified_type"),
    useCount: integer("use_count").default(0).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("mention_cache_owner_user").on(t.ownerId, t.xUserId)],
);

export type CreditKind = "signup" | "grant" | "revoke" | "spend" | "refund" | "purchase";

/** Append-only credit history. `balance_after` is the user's balance after this row was applied. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(), // uuid
    seq: bigserial("seq", { mode: "number" }).notNull(), // insertion order (timestamps can tie)
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    kind: text("kind").$type<CreditKind>().notNull(),
    reason: text("reason"),
    actorId: text("actor_id"), // admin who granted/revoked
    ref: text("ref"), // draft id / endpoint / purchase tx hash
    unmetered: boolean("unmetered").default(false).notNull(), // admin spend (logged, not charged)
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("credit_ledger_user_idx").on(t.userId, t.createdAt), index("credit_ledger_kind_idx").on(t.kind, t.createdAt)],
);

/** Fixed-window rate limiter state. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export type PurchaseStatus = "pending" | "settled" | "failed";

/**
 * Credits bought with USDC via x402 (optional feature, see src/lib/payments). One row per signed payment
 * authorization. `payer`, `nonce`, `asset`, `pay_to` and `tx_hash` are stored lowercase.
 * UNIQUE(network, payer, nonce) blocks replays of an authorization; UNIQUE(tx_hash) blocks double credit.
 */
export const creditPurchases = pgTable(
  "credit_purchases",
  {
    id: text("id").primaryKey(), // uuid
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    packId: text("pack_id").notNull(),
    credits: integer("credits").notNull(),
    amountAtomic: text("amount_atomic").notNull(), // USDC atomic units (6 decimals)
    network: text("network").notNull(), // CAIP-2, e.g. "eip155:8453"
    asset: text("asset").notNull(), // USDC contract
    payTo: text("pay_to").notNull(), // recipient at the time of purchase
    payer: text("payer").notNull(),
    nonce: text("nonce").notNull(), // EIP-3009 authorization nonce (bytes32)
    status: text("status").$type<PurchaseStatus>().default("pending").notNull(),
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("credit_purchases_tx_hash_uq").on(t.txHash),
    uniqueIndex("credit_purchases_auth_uq").on(t.network, t.payer, t.nonce),
    index("credit_purchases_status_idx").on(t.status, t.createdAt),
    index("credit_purchases_user_idx").on(t.userId, t.createdAt),
  ],
);

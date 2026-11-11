import { pgTable, text, timestamp, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(), // X user id
  username: text("username").notNull(),
  name: text("name").notNull(),
  profileImageUrl: text("profile_image_url"),
  verifiedType: text("verified_type"), // "blue" | "business" | "government" | "none" | null
  timezone: text("timezone").default("UTC").notNull(),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DraftStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";

/** One post inside a thread. `tweetId` is filled in as each post is published (resume-safe). */
export type ThreadPost = {
  id: string; // client-generated uuid
  text: string;
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

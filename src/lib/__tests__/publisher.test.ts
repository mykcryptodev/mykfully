import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import type { ThreadPost } from "@/lib/db/schema";
import type { XClient } from "@/lib/x/types";
import { claimDueDrafts, MAX_ATTEMPTS, publishDraft, runDuePublishing } from "@/lib/publisher";

const { drafts, users, mentionCache } = schema;

class FakeX implements XClient {
  calls: { text: string; replyToId: string | null }[] = [];
  private n = 0;
  failOnCall: number | null = null; // 1-based index of the postTweet call that throws (once)
  alwaysFail = false;

  async me() {
    return { id: "u1", username: "me", name: "Me" };
  }
  async postTweet(text: string, replyToId?: string | null) {
    const call = this.calls.length + 1;
    if (this.alwaysFail) throw new Error("X is down");
    if (this.failOnCall === call) {
      this.failOnCall = null;
      this.calls.push({ text: "<failed>", replyToId: replyToId ?? null });
      throw new Error("boom");
    }
    this.calls.push({ text, replyToId: replyToId ?? null });
    return { id: `t${++this.n}` };
  }
  async lookupUsernames() {
    return [];
  }
  async searchUsers() {
    return [];
  }
  get posted() {
    return this.calls.filter((c) => c.text !== "<failed>");
  }
}

let db: DB;

async function insertDraft(opts: {
  id: string;
  posts?: ThreadPost[];
  status?: schema.DraftStatus;
  scheduledAt?: Date | null;
  lockedAt?: Date | null;
  userId?: string;
}) {
  const [row] = await db
    .insert(drafts)
    .values({
      id: opts.id,
      userId: opts.userId ?? "u1",
      posts: opts.posts ?? [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
        { id: "c", text: "three" },
      ],
      status: opts.status ?? "scheduled",
      scheduledAt: opts.scheduledAt === undefined ? new Date(Date.now() - 1000) : opts.scheduledAt,
      lockedAt: opts.lockedAt ?? null,
    })
    .returning();
  return row;
}

async function load(id: string) {
  const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
  return row;
}

beforeEach(async () => {
  const client = new PGlite();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  db = d as unknown as DB;
  await db.insert(users).values([
    { id: "u1", username: "me", name: "Me" },
    { id: "u2", username: "other", name: "Other" },
  ]);
});

describe("publishDraft", () => {
  it("chains replies to the previous tweet id and persists tweetIds", async () => {
    const draft = await insertDraft({ id: "d1", status: "publishing" });
    const x = new FakeX();
    await publishDraft(db, draft, x);
    expect(x.calls).toEqual([
      { text: "one", replyToId: null },
      { text: "two", replyToId: "t1" },
      { text: "three", replyToId: "t2" },
    ]);
    const row = await load("d1");
    expect(row.posts.map((p) => p.tweetId)).toEqual(["t1", "t2", "t3"]);
    expect(row.posts.map((p) => p.text)).toEqual(["one", "two", "three"]);
  });

  it("skips empty posts and keeps the chain intact", async () => {
    const draft = await insertDraft({
      id: "d1",
      status: "publishing",
      posts: [
        { id: "a", text: "one" },
        { id: "b", text: "   " },
        { id: "c", text: "three" },
      ],
    });
    const x = new FakeX();
    await publishDraft(db, draft, x);
    expect(x.calls).toEqual([
      { text: "one", replyToId: null },
      { text: "three", replyToId: "t1" },
    ]);
  });

  it("mid-thread failure persists earlier tweetIds; retry resumes without reposting", async () => {
    await insertDraft({ id: "d1" });
    const x = new FakeX();
    x.failOnCall = 2;

    const r1 = await runDuePublishing(db, async () => x);
    expect(r1).toEqual([{ id: "d1", status: "scheduled", error: "boom" }]);
    let row = await load("d1");
    expect(row.status).toBe("scheduled");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("boom");
    expect(row.lockedAt).toBeNull();
    expect(row.posts.map((p) => p.tweetId ?? null)).toEqual(["t1", null, null]);

    const r2 = await runDuePublishing(db, async () => x);
    expect(r2).toEqual([{ id: "d1", status: "published" }]);
    row = await load("d1");
    expect(row.status).toBe("published");
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.posts.map((p) => p.tweetId)).toEqual(["t1", "t2", "t3"]);
    // "one" posted exactly once; the retry replied to the persisted t1
    expect(x.posted).toEqual([
      { text: "one", replyToId: null },
      { text: "two", replyToId: "t1" },
      { text: "three", replyToId: "t2" },
    ]);
  });
});

describe("claimDueDrafts", () => {
  it("does not claim drafts that are not yet due or not scheduled", async () => {
    await insertDraft({ id: "future", scheduledAt: new Date(Date.now() + 60_000) });
    await insertDraft({ id: "plain", status: "draft", scheduledAt: null });
    await insertDraft({ id: "freshlock", status: "publishing", lockedAt: new Date() });
    await insertDraft({ id: "due" });
    const claimed = await claimDueDrafts(db);
    expect(claimed.map((d) => d.id)).toEqual(["due"]);
    expect(claimed[0].status).toBe("publishing");
    expect(claimed[0].lockedAt).toBeInstanceOf(Date);
    expect((await load("future")).status).toBe("scheduled");
  });

  it("reclaims stale publishing rows", async () => {
    await insertDraft({ id: "stale", status: "publishing", lockedAt: new Date(Date.now() - 11 * 60_000) });
    const claimed = await claimDueDrafts(db);
    expect(claimed.map((d) => d.id)).toEqual(["stale"]);
  });

  it("concurrent claims never double-claim", async () => {
    for (let i = 0; i < 25; i++) await insertDraft({ id: `d${String(i).padStart(2, "0")}` });
    const batches = await Promise.all([claimDueDrafts(db, 10), claimDueDrafts(db, 10), claimDueDrafts(db, 10), claimDueDrafts(db, 10)]);
    const ids = batches.flat().map((d) => d.id);
    expect(ids.length).toBe(25);
    expect(new Set(ids).size).toBe(25);
    expect(await claimDueDrafts(db, 10)).toEqual([]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) await insertDraft({ id: `d${i}` });
    expect((await claimDueDrafts(db, 2)).length).toBe(2);
  });
});

describe("runDuePublishing", () => {
  it(`marks failed after ${MAX_ATTEMPTS} attempts`, async () => {
    await insertDraft({ id: "d1" });
    const x = new FakeX();
    x.alwaysFail = true;
    const statuses: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      const r = await runDuePublishing(db, async () => x);
      statuses.push(r[0]?.status ?? "none");
    }
    expect(statuses).toEqual(["scheduled", "scheduled", "failed", "none"]);
    const row = await load("d1");
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toBe("X is down");
  });

  it("isolates errors per draft and uses each draft owner's client", async () => {
    await insertDraft({ id: "ok", userId: "u1" });
    await insertDraft({ id: "bad", userId: "u2" });
    const good = new FakeX();
    const broken = new FakeX();
    broken.alwaysFail = true;
    const results = await runDuePublishing(db, async (uid) => (uid === "u1" ? good : broken));
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(byId).toEqual({ ok: "published", bad: "scheduled" });
    expect(good.posted.length).toBe(3);
  });

  it("bumps mention_cache for existing rows only, case-insensitively, scoped to owner", async () => {
    await db.insert(mentionCache).values([
      { ownerId: "u1", xUserId: "x1", username: "Alice", name: "Alice", useCount: 2, lastUsedAt: new Date(0) },
      { ownerId: "u1", xUserId: "x2", username: "bob", name: "Bob", useCount: 0, lastUsedAt: new Date(0) },
      { ownerId: "u2", xUserId: "x1", username: "alice", name: "Alice", useCount: 0, lastUsedAt: new Date(0) },
    ]);
    await insertDraft({
      id: "d1",
      posts: [
        { id: "a", text: "hi @alice and @ALICE" },
        { id: "b", text: "cc @nobody" },
      ],
    });
    await runDuePublishing(db, async () => new FakeX());
    const rows = await db.select().from(mentionCache).orderBy(mentionCache.ownerId, mentionCache.xUserId);
    expect(rows.map((r) => [r.ownerId, r.username, r.useCount])).toEqual([
      ["u1", "Alice", 3],
      ["u1", "bob", 0],
      ["u2", "alice", 0],
    ]);
    expect(rows[0].lastUsedAt.getTime()).toBeGreaterThan(0);
    const [{ count }] = await db.execute<{ count: number }>(sql`select count(*)::int as count from mention_cache`).then(
      (r) => (r as unknown as { rows: { count: number }[] }).rows,
    );
    expect(count).toBe(3);
  });
});

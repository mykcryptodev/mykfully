import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import type { ThreadPost } from "@/lib/db/schema";
import { getBalance, grant, listLedger } from "@/lib/credits";
import { AmbiguousPublishError, InsufficientCreditsError, ReconnectRequiredError } from "@/lib/errors";
import { XApiError, type XClient, type XMediaRequest, type XMediaResponse, type XUser } from "@/lib/x/types";
import { meter } from "@/lib/x/metered";
import { runDuePublishing } from "@/lib/publisher";
import { updateDraft } from "@/lib/drafts";

const fakeUsers = (n: number): XUser[] => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, username: `u${i}`, name: `U${i}` }));

class FakeX implements XClient {
  posted: { text: string; replyToId: string | null }[] = [];
  searchMax: number | undefined;
  postError: Error | null = null;
  searchResult: XUser[] | Error = fakeUsers(3);
  private n = 0;
  async me() {
    return { id: "u1", username: "me", name: "Me" };
  }
  async postTweet(text: string, replyToId?: string | null) {
    if (this.postError) throw this.postError;
    this.posted.push({ text, replyToId: replyToId ?? null });
    return { id: `t${++this.n}` };
  }
  mediaError: Error | null = null;
  mediaCalls = 0;
  async requestMedia(request: XMediaRequest): Promise<XMediaResponse> {
    this.mediaCalls++;
    if (this.mediaError) throw this.mediaError;
    return request.type === "image" ? { id: "123" } : {};
  }
  async lookupUsernames(names: string[]) {
    return fakeUsers(names.length).slice(0, 1);
  }
  async searchUsers(_q: string, max?: number) {
    this.searchMax = max;
    if (this.searchResult instanceof Error) throw this.searchResult;
    return this.searchResult;
  }
}

// Ledger rows written in the same millisecond can tie on created_at, so compare as a sorted set.
const kinds = (rows: { kind: string; delta: number }[]) => rows.map((l) => `${l.kind}:${l.delta}`).sort();

let db: DB;
beforeEach(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as DB;
  await db.insert(schema.users).values([
    { id: "u1", username: "me", name: "Me" },
    { id: "admin", username: "boss", name: "Boss" },
  ]);
  process.env.ADMIN_X_USER_IDS = "admin";
});
afterEach(() => {
  delete process.env.ADMIN_X_USER_IDS;
  vi.restoreAllMocks();
});

async function loadDraft(id: string) {
  const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  return row;
}

async function insertScheduled(id: string, posts: ThreadPost[]) {
  await db.insert(schema.drafts).values({ id, userId: "u1", posts, status: "scheduled", scheduledAt: new Date(Date.now() - 1000) });
}

describe("meter: postTweet", () => {
  it("debits before posting (URL posts cost more) and records the ref", async () => {
    await grant(db, "admin", "u1", 300, null);
    const x = new FakeX();
    const m = meter(db, x, "u1", "draft-1");
    await m.postTweet("hello");
    expect(await getBalance(db, "u1")).toBe(285);
    await m.postTweet("see https://example.com");
    expect(await getBalance(db, "u1")).toBe(85);
    const spends = (await listLedger(db, "u1")).filter((l) => l.kind === "spend");
    expect(spends.map((l) => `${l.delta}:${l.ref}`).sort()).toEqual(["-15:draft-1", "-200:draft-1"]);
  });

  it.each([400, 403, 422, 429])("refunds on a definite X rejection (%i) and rethrows the original error", async (status) => {
    await grant(db, "admin", "u1", 100, null);
    const x = new FakeX();
    x.postError = new XApiError(status, "{}");
    await expect(meter(db, x, "u1").postTweet("hi")).rejects.toBeInstanceOf(XApiError);
    expect(await getBalance(db, "u1")).toBe(100);
    expect(kinds(await listLedger(db, "u1"))).toEqual(["grant:100", "refund:15", "spend:-15"]);
  });

  it.each([
    ["5xx", new XApiError(503, "{}")],
    ["408", new XApiError(408, "{}")],
    ["network error", new TypeError("fetch failed")],
    ["timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["bad 2xx body", new SyntaxError("Unexpected end of JSON input")],
  ])("does not refund an ambiguous failure (%s) and throws AmbiguousPublishError", async (_label, err) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await grant(db, "admin", "u1", 100, null);
    const x = new FakeX();
    x.postError = err;
    await expect(meter(db, x, "u1").postTweet("hi")).rejects.toBeInstanceOf(AmbiguousPublishError);
    expect(await getBalance(db, "u1")).toBe(85);
    expect(kinds(await listLedger(db, "u1"))).toEqual(["grant:100", "spend:-15"]);
  });

  it("does not call X without credits", async () => {
    const x = new FakeX();
    await expect(meter(db, x, "u1").postTweet("hi")).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(x.posted).toEqual([]);
  });

  it("admins are not charged but spend is logged as unmetered", async () => {
    await meter(db, new FakeX(), "admin").postTweet("hi");
    expect(await getBalance(db, "admin")).toBe(0);
    const [row] = await listLedger(db, "admin", 1);
    expect([row.delta, row.unmetered]).toEqual([-15, true]);
  });
});

describe("meter: requestMedia", () => {
  afterEach(() => {
    delete process.env.CREDIT_COST_MEDIA_UPLOAD;
  });

  it("charges alt text metadata and refunds a definite rejection", async () => {
    await grant(db, "admin", "u1", 100, null);
    const x = new FakeX();
    const m = meter(db, x, "u1");
    await m.requestMedia({ type: "altText", id: "1", text: "hi" });
    expect(await getBalance(db, "u1")).toBe(95);
    x.mediaError = new XApiError(400, "{}");
    await expect(m.requestMedia({ type: "altText", id: "1", text: "hi" })).rejects.toBeInstanceOf(XApiError);
    expect(await getBalance(db, "u1")).toBe(95);
  });

  it("uploads are free by default; a configured cost is charged and kept on ambiguous failure", async () => {
    await grant(db, "admin", "u1", 100, null);
    const x = new FakeX();
    await meter(db, x, "u1").requestMedia({ type: "image", media: new Blob(["x"]) });
    expect(await getBalance(db, "u1")).toBe(100);

    process.env.CREDIT_COST_MEDIA_UPLOAD = "3";
    x.mediaError = new XApiError(503, "{}");
    await expect(meter(db, x, "u1").requestMedia({ type: "image", media: new Blob(["x"]) })).rejects.toBeInstanceOf(XApiError);
    expect(await getBalance(db, "u1")).toBe(97);
  });

  it("refuses media requests without credits before calling X", async () => {
    const x = new FakeX();
    await expect(meter(db, x, "u1").requestMedia({ type: "altText", id: "1", text: "hi" })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(x.mediaCalls).toBe(0);
  });
});

describe("meter: user reads", () => {
  it("search reserves max (clamped to 8) × userRead and refunds unreturned users", async () => {
    await grant(db, "admin", "u1", 100, null);
    const x = new FakeX();
    const users = await meter(db, x, "u1").searchUsers("al", 50);
    expect(users.length).toBe(3);
    expect(x.searchMax).toBe(8);
    expect(await getBalance(db, "u1")).toBe(70);
    expect(kinds(await listLedger(db, "u1"))).toEqual(["grant:100", "refund:50", "spend:-80"]);
  });

  it("search refunds the full reservation on error", async () => {
    await grant(db, "admin", "u1", 100, null);
    const x = new FakeX();
    x.searchResult = new XApiError(500, "{}");
    await expect(meter(db, x, "u1").searchUsers("al", 8)).rejects.toBeInstanceOf(XApiError);
    expect(await getBalance(db, "u1")).toBe(100);
  });

  it("search needs the full reservation up front", async () => {
    await grant(db, "admin", "u1", 70, null);
    await expect(meter(db, new FakeX(), "u1").searchUsers("al", 8)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("lookup reserves per name and refunds the missing ones", async () => {
    await grant(db, "admin", "u1", 100, null);
    const users = await meter(db, new FakeX(), "u1").lookupUsernames(["a", "b", "c"]);
    expect(users.length).toBe(1);
    expect(await getBalance(db, "u1")).toBe(90);
  });

  it("me() is free", async () => {
    await meter(db, new FakeX(), "u1").me();
    expect(await listLedger(db, "u1")).toEqual([]);
  });
});

describe("metered publishing", () => {
  const posts: ThreadPost[] = [
    { id: "a", text: "one" },
    { id: "b", text: "two" },
    { id: "c", text: "three" },
  ];

  it("insufficient credits mid-thread → failed (no retry), earlier tweetIds kept; resumes after a grant", async () => {
    await grant(db, "admin", "u1", 20, null); // enough for one post only
    await insertScheduled("d1", posts);
    const x = new FakeX();
    const getClient = async (uid: string, ref?: string) => meter(db, x, uid, ref);

    const [r1] = await runDuePublishing(db, getClient);
    expect(r1.status).toBe("failed");
    expect(r1.error).toMatch(/^\[insufficient_credits\] /);
    let row = await loadDraft("d1");
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("[insufficient_credits] Not enough credits (need 15, have 5)");
    expect(row.posts.map((p) => p.tweetId ?? null)).toEqual(["t1", null, null]);
    expect(await getBalance(db, "u1")).toBe(5);
    expect(await runDuePublishing(db, getClient)).toEqual([]); // not retried

    // Re-scheduling is gated on the remaining cost (2 posts = 30)
    await expect(updateDraft(db, "u1", "d1", { scheduledAt: new Date().toISOString() })).rejects.toMatchObject({ status: 402 });
    await grant(db, "admin", "u1", 100, "top-up");
    await updateDraft(db, "u1", "d1", { scheduledAt: new Date(Date.now() - 1000).toISOString() });

    const [r2] = await runDuePublishing(db, getClient);
    expect(r2.status).toBe("published");
    row = await loadDraft("d1");
    expect(row.posts.map((p) => p.tweetId)).toEqual(["t1", "t2", "t3"]);
    expect(x.posted).toEqual([
      { text: "one", replyToId: null },
      { text: "two", replyToId: "t1" },
      { text: "three", replyToId: "t2" },
    ]);
    expect(await getBalance(db, "u1")).toBe(75);
  });

  it("fatal errors (X 401/403, reconnect required) are not retried", async () => {
    await grant(db, "admin", "u1", 1000, null);
    await insertScheduled("auth", posts);
    const x = new FakeX();
    x.postError = new XApiError(403, JSON.stringify({ title: "Forbidden" }));
    const [r] = await runDuePublishing(db, async (uid, ref) => meter(db, x, uid, ref));
    expect(r.status).toBe("failed");
    const row = await loadDraft("auth");
    expect([row.status, row.attempts, row.lastError]).toEqual(["failed", 1, "[x_api_error] X API error 403: Forbidden"]);
    expect(await getBalance(db, "u1")).toBe(1000); // refunded

    await insertScheduled("recon", posts);
    const [r2] = await runDuePublishing(db, async () => {
      throw new ReconnectRequiredError();
    });
    expect(r2.status).toBe("failed");
    expect((await loadDraft("recon")).lastError).toMatch(/^\[reconnect_required\] /);
  });

  it("X 429 is refunded and retried", async () => {
    await grant(db, "admin", "u1", 1000, null);
    await insertScheduled("d1", posts);
    const x = new FakeX();
    x.postError = new XApiError(429, "{}");
    const [r] = await runDuePublishing(db, async (uid, ref) => meter(db, x, uid, ref));
    expect(r.status).toBe("scheduled");
    expect(await getBalance(db, "u1")).toBe(1000);
  });

  it.each([
    ["5xx", new XApiError(503, "{}")],
    ["network error", new TypeError("fetch failed")],
  ])("ambiguous post failure (%s) → failed, not refunded, not retried; earlier tweetIds kept", async (_label, err) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await grant(db, "admin", "u1", 1000, null);
    await insertScheduled("d1", posts);
    const x = new FakeX();
    const real = x.postTweet.bind(x);
    let calls = 0;
    x.postTweet = async (text, replyToId) => {
      if (++calls === 2) throw err;
      return real(text, replyToId);
    };
    const getClient = async (uid: string, ref?: string) => meter(db, x, uid, ref);

    const [r] = await runDuePublishing(db, getClient);
    expect(r.status).toBe("failed");
    const row = await loadDraft("d1");
    expect([row.status, row.attempts, row.lastError]).toEqual([
      "failed",
      1,
      "[publish_uncertain] X may or may not have published this post. Check your X profile before retrying.",
    ]);
    expect(row.posts.map((p) => p.tweetId ?? null)).toEqual(["t1", null, null]);
    expect(await getBalance(db, "u1")).toBe(970); // two posts charged, none refunded
    expect(await runDuePublishing(db, getClient)).toEqual([]); // not retried
    expect(x.posted).toEqual([{ text: "one", replyToId: null }]);
  });
});

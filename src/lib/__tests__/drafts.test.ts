import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));

import { createDraft, deleteDraft, getDraft, HttpError, listDrafts, updateDraft } from "@/lib/drafts";

let db: DB;

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  db = d as unknown as DB;
  await db.insert(schema.users).values([
    { id: "u1", username: "me", name: "Me" },
    { id: "u2", username: "other", name: "Other" },
  ]);
});

async function expectStatus(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toSatisfy((e) => e instanceof HttpError && e.status === status);
}

describe("drafts data access", () => {
  it("strips client-sent tweetId on create and update; preserves server tweetIds", async () => {
    const d = await createDraft(db, "u1", { posts: [{ id: "a", text: "x", tweetId: "evil" }] });
    expect(d.posts).toEqual([{ id: "a", text: "x" }]);

    await db
      .update(schema.drafts)
      .set({ posts: [{ id: "a", text: "x", tweetId: "real" }], status: "failed" })
      .where(eq(schema.drafts.id, d.id));
    const u = await updateDraft(db, "u1", d.id, {
      posts: [
        { id: "a", text: "edited", tweetId: "evil" },
        { id: "b", text: "new", tweetId: "evil2" },
      ],
    });
    expect(u.posts).toEqual([
      { id: "a", text: "edited", tweetId: "real" },
      { id: "b", text: "new" },
    ]);
  });

  it("returns 409 when editing published/publishing drafts", async () => {
    const d = await createDraft(db, "u1", { posts: [{ id: "a", text: "x" }] });
    for (const status of ["published", "publishing"] as const) {
      await db.update(schema.drafts).set({ status }).where(eq(schema.drafts.id, d.id));
      await expectStatus(updateDraft(db, "u1", d.id, { posts: [{ id: "a", text: "y" }] }), 409);
    }
    await expectStatus(deleteDraft(db, "u1", d.id), 409);
  });

  it("validates scheduledAt with 30s skew and rejects empty posts when scheduling", async () => {
    const d = await createDraft(db, "u1", { posts: [{ id: "a", text: "x" }] });
    await expectStatus(updateDraft(db, "u1", d.id, { scheduledAt: new Date(Date.now() - 5 * 60_000).toISOString() }), 400);
    const ok = await updateDraft(db, "u1", d.id, { scheduledAt: new Date(Date.now() - 10_000).toISOString() });
    expect(ok.status).toBe("scheduled");
    const back = await updateDraft(db, "u1", d.id, { scheduledAt: null });
    expect(back.status).toBe("draft");
    expect(back.scheduledAt).toBeNull();
    await expectStatus(
      updateDraft(db, "u1", d.id, {
        posts: [{ id: "a", text: "  " }],
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      400,
    );
  });

  it("rejects invalid input via zod", async () => {
    await expect(createDraft(db, "u1", { posts: [] })).rejects.toThrow();
    await expect(createDraft(db, "u1", { posts: [{ id: "a", text: "x".repeat(25001) }] })).rejects.toThrow();
    await expect(
      createDraft(db, "u1", { posts: Array.from({ length: 51 }, (_, i) => ({ id: String(i), text: "x" })) }),
    ).rejects.toThrow();
  });

  it("scopes all access to the owner", async () => {
    const d = await createDraft(db, "u1", { posts: [{ id: "a", text: "x" }] });
    expect(await getDraft(db, "u2", d.id)).toBeNull();
    expect(await listDrafts(db, "u2")).toEqual([]);
    await expectStatus(updateDraft(db, "u2", d.id, { posts: [{ id: "a", text: "y" }] }), 404);
    await expectStatus(deleteDraft(db, "u2", d.id), 404);
    expect((await listDrafts(db, "u1", "draft")).length).toBe(1);
    await deleteDraft(db, "u1", d.id);
    expect(await getDraft(db, "u1", d.id)).toBeNull();
  });
});

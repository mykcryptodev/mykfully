import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import type { MediaAttachment } from "@/lib/media-types";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));

import { createDraft, deleteDraft, getDraft, HttpError, listDrafts, MAX_DRAFTS_PER_USER, updateDraft } from "@/lib/drafts";

let db: DB;

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  db = d as unknown as DB;
  await db.insert(schema.users).values([
    { id: "u1", username: "me", name: "Me", credits: 1000 },
    { id: "u2", username: "other", name: "Other" },
  ]);
});
afterEach(() => {
  delete process.env.ADMIN_X_USER_IDS;
});

async function expectStatus(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toSatisfy((e) => e instanceof HttpError && e.status === status);
}

async function seedMedia(
  userId: string,
  contentType: MediaAttachment["contentType"] = "image/png",
  complete = true,
): Promise<MediaAttachment> {
  const attachment = { id: randomUUID(), name: "file", size: 32, contentType };
  await db.insert(schema.mediaAssets).values({
    ...attachment,
    userId,
    uploadedSize: complete ? attachment.size : 0,
  });
  return attachment;
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

  const future = () => new Date(Date.now() + 60_000).toISOString();

  it("saves and schedules media-only posts with server-owned metadata", async () => {
    const image = await seedMedia("u1");
    const d = await createDraft(db, "u1", {
      posts: [{ id: "a", text: "", media: [{ id: image.id, name: "forged", size: 1, altText: "  An image  " }] }],
    });
    expect(d.posts).toEqual([{ id: "a", text: "", media: [{ ...image, altText: "An image" }] }]);

    const scheduled = await updateDraft(db, "u1", d.id, { scheduledAt: future(), posts: [{ id: "a", text: "" }] });
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.posts).toEqual(d.posts);
    await expectStatus(updateDraft(db, "u1", d.id, { posts: [{ id: "a", text: "", media: [] }] }), 400);

    const edited = await updateDraft(db, "u1", d.id, { posts: [{ id: "a", text: "Text only", media: [] }] });
    expect(edited.posts).toEqual([{ id: "a", text: "Text only" }]);
  });

  it("rejects unavailable media, duplicate files, and unsupported combinations", async () => {
    const image = await seedMedia("u1");
    const gif = await seedMedia("u1", "image/gif");
    const incomplete = await seedMedia("u1", "image/png", false);
    const otherUsersImage = await seedMedia("u2");
    for (const media of [[otherUsersImage], [incomplete], [image, image], [image, gif]]) {
      await expectStatus(createDraft(db, "u1", { posts: [{ id: "a", text: "Post", media }] }), 400);
    }
    const d = await createDraft(db, "u1", { posts: [{ id: "a", text: "Post", media: [gif] }] });
    await expectStatus(
      updateDraft(db, "u1", d.id, { posts: [{ id: "a", text: "Post", media: [otherUsersImage] }] }),
      400,
    );
    expect((await getDraft(db, "u1", d.id))?.posts).toEqual(d.posts);
  });

  it("keeps the original attachments for posts already published during a failed attempt", async () => {
    const image = await seedMedia("u1");
    const original = { id: "a", text: "", media: [{ ...image, altText: "Original caption" }] };
    const d = await createDraft(db, "u1", { posts: [original, { id: "b", text: "Reply" }] });
    await db.update(schema.drafts)
      .set({ posts: [{ ...original, tweetId: "published" }, d.posts[1]], status: "failed" })
      .where(eq(schema.drafts.id, d.id));
    const updated = await updateDraft(db, "u1", d.id, {
      posts: [{ id: "a", text: "", media: [] }, { id: "b", text: "New reply", media: [image] }],
      scheduledAt: future(),
    });
    expect(updated.posts).toEqual([
      { ...original, tweetId: "published" },
      { id: "b", text: "New reply", media: [image] },
    ]);
  });

  it("scheduling requires enough credits for non-admins (402 with needed/balance)", async () => {
    const d = await createDraft(db, "u2", { posts: [{ id: "a", text: "x" }, { id: "b", text: "see https://example.com" }] });
    await expect(updateDraft(db, "u2", d.id, { scheduledAt: future() })).rejects.toSatisfy(
      (e) =>
        e instanceof HttpError &&
        e.status === 402 &&
        e.extra?.code === "insufficient_credits" &&
        e.extra?.needed === 215 &&
        e.extra?.balance === 0,
    );
    expect((await getDraft(db, "u2", d.id))?.status).toBe("draft");
    // admins bypass the check
    process.env.ADMIN_X_USER_IDS = "u2";
    expect((await updateDraft(db, "u2", d.id, { scheduledAt: future() })).status).toBe("scheduled");
  });

  it("enforces the weighted per-post length server-side using the user's verified type", async () => {
    const long = "a".repeat(281);
    const d = await createDraft(db, "u1", { posts: [{ id: "a", text: long }] });
    await expect(updateDraft(db, "u1", d.id, { scheduledAt: future() })).rejects.toSatisfy(
      (e) => e instanceof HttpError && e.status === 400 && e.extra?.code === "post_too_long",
    );
    await db.update(schema.users).set({ verifiedType: "blue" }).where(eq(schema.users.id, "u1"));
    expect((await updateDraft(db, "u1", d.id, { scheduledAt: future() })).status).toBe("scheduled");
  });

  it("caps drafts per user and lists at most 200, newest first", async () => {
    const base = Date.now();
    await db.insert(schema.drafts).values(
      Array.from({ length: MAX_DRAFTS_PER_USER }, (_, i) => ({
        id: `bulk-${i}`,
        userId: "u1",
        posts: [{ id: "a", text: "x" }],
        updatedAt: new Date(base - i * 1000),
      })),
    );
    await expectStatus(createDraft(db, "u1", { posts: [{ id: "a", text: "x" }] }), 403);
    const list = await listDrafts(db, "u1");
    expect(list.length).toBe(200);
    expect(list[0].id).toBe("bulk-0");
    expect(list[1].id).toBe("bulk-1");
  });
});

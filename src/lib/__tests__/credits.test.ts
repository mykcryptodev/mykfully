import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { debit, estimateThreadCost, getBalance, grant, grantSignup, listLedger, refund } from "@/lib/credits";
import { CreditCapReachedError, InsufficientCreditsError, RateLimitedError } from "@/lib/errors";
import { limit } from "@/lib/ratelimit";

let db: DB;
beforeEach(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as DB;
  await db.insert(schema.users).values([
    { id: "u1", username: "alice", name: "Alice" },
    { id: "admin", username: "boss", name: "Boss" },
  ]);
  process.env.ADMIN_X_USER_IDS = "admin";
});
afterEach(() => {
  delete process.env.ADMIN_X_USER_IDS;
  delete process.env.GLOBAL_DAILY_CREDIT_CAP;
  delete process.env.SIGNUP_CREDITS;
});

describe("credits", () => {
  it("signup grant + debit + ledger balance_after", async () => {
    process.env.SIGNUP_CREDITS = "100";
    await grantSignup(db, "u1");
    expect(await getBalance(db, "u1")).toBe(100);
    const r = await debit(db, "u1", 15, { ref: "d1" });
    expect(r.balance).toBe(85);
    const ledger = await listLedger(db, "u1");
    expect(ledger.map((l) => [l.kind, l.delta, l.balanceAfter])).toEqual([
      ["spend", -15, 85],
      ["signup", 100, 100],
    ]);
  });

  it("rejects overspend and never goes negative, even concurrently", async () => {
    await grant(db, "admin", "u1", 50, "test");
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => debit(db, "u1", 15)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.every((r) => r.reason instanceof InsufficientCreditsError)).toBe(true);
    expect(await getBalance(db, "u1")).toBe(5);
  });

  it("refund restores balance", async () => {
    await grant(db, "admin", "u1", 30, null);
    await debit(db, "u1", 20);
    await refund(db, "u1", 20);
    expect(await getBalance(db, "u1")).toBe(30);
  });

  it("revoke clamps at zero and records actual delta", async () => {
    await grant(db, "admin", "u1", 30, null);
    expect(await grant(db, "admin", "u1", -100, "abuse")).toBe(0);
    const [last] = await listLedger(db, "u1", 1);
    expect([last.kind, last.delta, last.actorId]).toEqual(["revoke", -30, "admin"]);
    expect(await grant(db, "admin", "nobody", 10, null)).toBeNull();
  });

  it("admins are unmetered but logged", async () => {
    const r = await debit(db, "admin", 200, { ref: "x" });
    expect(r.unmetered).toBe(true);
    expect(await getBalance(db, "admin")).toBe(0);
    const [row] = await listLedger(db, "admin");
    expect([row.delta, row.unmetered]).toEqual([-200, true]);
  });

  it("global daily cap excludes admin spend", async () => {
    process.env.GLOBAL_DAILY_CREDIT_CAP = "40";
    await grant(db, "admin", "u1", 1000, null);
    await debit(db, "admin", 500);
    await debit(db, "u1", 30);
    await expect(debit(db, "u1", 15)).rejects.toBeInstanceOf(CreditCapReachedError);
  });

  it("estimates thread cost skipping posted/empty posts", () => {
    expect(
      estimateThreadCost([
        { text: "hi" },
        { text: "see https://example.com" },
        { text: "  " },
        { text: "done", tweetId: "1" },
      ]),
    ).toBe(15 + 200);
  });

  it("rate limiter blocks after max in window", async () => {
    for (let i = 0; i < 3; i++) await limit(db, "k", 3, 60);
    await expect(limit(db, "k", 3, 60)).rejects.toBeInstanceOf(RateLimitedError);
    await limit(db, "other", 3, 60);
  });

  it("user row unchanged by failed debit", async () => {
    await expect(debit(db, "u1", 1)).rejects.toBeInstanceOf(InsufficientCreditsError);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, "u1"));
    expect(u.credits).toBe(0);
  });
});

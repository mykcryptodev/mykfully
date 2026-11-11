import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";

const state = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

vi.mock("@/lib/db", () => ({ getDb: async () => state.db, schema: {} }));
vi.mock("@/lib/session", () => ({
  requireUserId: async () => {
    if (!state.userId) throw Object.assign(new Error("Unauthorized"), { name: "UnauthorizedError" });
    return state.userId;
  },
}));

import { POST as grantRoute } from "@/app/api/admin/credits/route";
import { GET as usersRoute } from "@/app/api/admin/users/route";
import { GET as ledgerRoute } from "@/app/api/admin/users/[id]/ledger/route";
import { debit, getBalance, refund } from "@/lib/credits";

const ORIGIN = "http://localhost:3000";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/admin/credits`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

let db: DB;
beforeEach(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as DB;
  state.db = db;
  state.userId = "admin";
  await db.insert(schema.users).values([
    { id: "u1", username: "alice", name: "Alice" },
    { id: "admin", username: "boss", name: "Boss" },
  ]);
  process.env.ADMIN_X_USER_IDS = "admin";
  delete process.env.APP_URL;
});
afterEach(() => {
  delete process.env.ADMIN_X_USER_IDS;
});

describe("admin APIs", () => {
  it("admin can grant and revoke; ledger records the actor", async () => {
    let res = await grantRoute(post({ userId: "u1", delta: 500, reason: "beta tester" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 500 });
    res = await grantRoute(post({ userId: "u1", delta: -800, reason: "abuse" }));
    expect(await res.json()).toEqual({ balance: 0 });

    const lres = await ledgerRoute(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: "u1" }) });
    const { ledger } = await lres.json();
    expect(ledger.map((l: { kind: string; delta: number; actorId: string }) => `${l.kind}:${l.delta}:${l.actorId}`).sort()).toEqual([
      "grant:500:admin",
      "revoke:-500:admin",
    ]);
    expect(typeof ledger[0].createdAt).toBe("string");
  });

  it("validates the body and 404s unknown users", async () => {
    expect((await grantRoute(post({ userId: "nobody", delta: 5, reason: "x" }))).status).toBe(404);
    expect((await grantRoute(post({ userId: "u1", delta: 0, reason: "x" }))).status).toBe(400);
    expect((await grantRoute(post({ userId: "u1", delta: 1.5, reason: "x" }))).status).toBe(400);
    expect((await grantRoute(post({ userId: "u1", delta: 10_000_001, reason: "x" }))).status).toBe(400);
    expect((await grantRoute(post({ userId: "u1", delta: 5, reason: "" }))).status).toBe(400);
    expect((await grantRoute(post({ userId: "u1", delta: 5, reason: "r".repeat(201) }))).status).toBe(400);
  });

  it("rejects cross-origin and non-JSON requests", async () => {
    expect((await grantRoute(post({ userId: "u1", delta: 5, reason: "x" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await grantRoute(post({ userId: "u1", delta: 5, reason: "x" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect(await getBalance(db, "u1")).toBe(0);
  });

  it("non-admins get 404 everywhere and cannot grant", async () => {
    state.userId = "u1";
    const res = await grantRoute(post({ userId: "u1", delta: 1000, reason: "free money" }));
    expect(res.status).toBe(404);
    expect((await usersRoute()).status).toBe(404);
    expect((await ledgerRoute(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: "u1" }) })).status).toBe(404);
    expect(await getBalance(db, "u1")).toBe(0);
    state.userId = null;
    expect((await usersRoute()).status).toBe(401);
  });

  it("lists users with net 7d/30d spend", async () => {
    await grantRoute(post({ userId: "u1", delta: 1000, reason: "x" }));
    await debit(db, "u1", 80);
    await refund(db, "u1", 50);
    await debit(db, "u1", 15);
    const res = await usersRoute();
    const { users } = await res.json();
    const alice = users.find((u: { id: string }) => u.id === "u1");
    expect(alice).toMatchObject({ username: "alice", credits: 955, isAdmin: false, spent7d: 45, spent30d: 45 });
    expect(users.find((u: { id: string }) => u.id === "admin")).toMatchObject({ isAdmin: true, spent7d: 0 });
    expect(typeof alice.lastSeen).toBe("string");
  });
});

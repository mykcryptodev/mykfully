import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { ReconnectRequiredError } from "@/lib/errors";
import { getBalance, listLedger } from "@/lib/credits";
import { getRawXClientForUser, refreshWithDbClaim, saveTokens, upsertUser } from "@/lib/x";
import { installTestDb, setAuthEnv } from "./auth-helpers";

let db: DB;

async function seedTokens(opts: { expired?: boolean; refreshEnc?: string } = {}) {
  await db.insert(schema.users).values({ id: "u1", username: "me", name: "Me" }).onConflictDoNothing();
  await db.insert(schema.xTokens).values({
    userId: "u1",
    accessTokenEnc: encrypt("old-access", "u1"),
    refreshTokenEnc: opts.refreshEnc ?? encrypt("old-refresh", "u1"),
    expiresAt: new Date(Date.now() + (opts.expired === false ? 3600_000 : -60_000)),
    updatedAt: new Date(Date.now() - 60_000),
  });
}

const tokenRow = async () => (await db.select().from(schema.xTokens).where(eq(schema.xTokens.userId, "u1")))[0];

function stubTokenEndpoint(respond: () => Response, delayMs = 100) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    expect(String(url)).toBe("https://api.x.com/2/oauth2/token");
    await new Promise((r) => setTimeout(r, delayMs));
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  setAuthEnv();
  db = await installTestDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SIGNUP_CREDITS;
});

describe("token refresh claim", () => {
  it("lets exactly one concurrent refresher hit the token endpoint", async () => {
    await seedTokens();
    let n = 0;
    const fetchMock = stubTokenEndpoint(() =>
      Response.json({ token_type: "bearer", access_token: `new-access-${++n}`, refresh_token: `new-refresh-${n}`, expires_in: 7200 }),
    );

    // Bypass the in-process promise map so the DB claim is what serializes these.
    const results = await Promise.all(Array.from({ length: 6 }, () => refreshWithDbClaim("u1")));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.accessToken))).toEqual(new Set(["new-access-1"]));
    const row = await tokenRow();
    expect(row.refreshingUntil).toBeNull();
    expect(row.accessTokenEnc.startsWith("v2:")).toBe(true);
    expect(decrypt(row.refreshTokenEnc!, "u1")).toBe("new-refresh-1");
  });

  it("does not refresh fresh tokens", async () => {
    await seedTokens({ expired: false });
    const fetchMock = stubTokenEndpoint(() => Response.json({}));
    expect((await refreshWithDbClaim("u1")).accessToken).toBe("old-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rewrites a legacy v1 refresh token as v2 on refresh", async () => {
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, "base64"), iv);
    const ct = Buffer.concat([c.update("old-refresh", "utf8"), c.final()]);
    const v1 = ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
    await seedTokens({ refreshEnc: v1 });
    const fetchMock = stubTokenEndpoint(() => Response.json({ token_type: "bearer", access_token: "a2", refresh_token: "r2" }), 0);
    await refreshWithDbClaim("u1");
    expect(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain("refresh_token=old-refresh");
    expect((await tokenRow()).refreshTokenEnc!.startsWith("v2:")).toBe(true);
  });

  it("invalid_grant sets needs_reconnect and throws ReconnectRequiredError (then fails fast)", async () => {
    await seedTokens();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = stubTokenEndpoint(
      () => Response.json({ error: "invalid_grant", error_description: "Value passed for the token was invalid." }, { status: 400 }),
      0,
    );
    await expect(refreshWithDbClaim("u1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    const row = await tokenRow();
    expect(row.needsReconnect).toBe(true);
    expect(row.refreshingUntil).toBeNull();
    // logs carry status + code only
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain("old-refresh");

    await expect(getRawXClientForUser("u1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Logging in again (saveTokens) clears the flag.
    await saveTokens("u1", { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000) });
    expect((await tokenRow()).needsReconnect).toBe(false);
    await expect(getRawXClientForUser("u1")).resolves.toBeDefined();
  });

  it("a transient token-endpoint failure releases the claim without needs_reconnect", async () => {
    await seedTokens();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubTokenEndpoint(() => new Response("oops", { status: 503 }), 0);
    await expect(refreshWithDbClaim("u1")).rejects.toThrow(/503/);
    const row = await tokenRow();
    expect(row.needsReconnect).toBe(false);
    expect(row.refreshingUntil).toBeNull();
  });
});

describe("signup grant", () => {
  it("grants only on the first upsertUser and still updates the profile", async () => {
    process.env.SIGNUP_CREDITS = "250";
    expect(await upsertUser({ id: "n1", username: "new", name: "New" })).toEqual({ created: true });
    expect(await upsertUser({ id: "n1", username: "renamed", name: "Renamed" })).toEqual({ created: false });
    expect(await getBalance(db, "n1")).toBe(250);
    const ledger = await listLedger(db, "n1");
    expect(ledger.filter((l) => l.kind === "signup")).toHaveLength(1);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, "n1"));
    expect(u.username).toBe("renamed");
  });
});

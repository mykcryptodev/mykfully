import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { installTestDb, setAuthEnv } from "./auth-helpers";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (!value || opts?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

import {
  clearSession,
  getSession,
  revokeSessions,
  sessionCookieName,
  setSession,
  signSessionToken,
} from "@/lib/session";

beforeEach(async () => {
  setAuthEnv();
  jar.clear();
  const db = await installTestDb();
  await db.insert(schema.users).values({ id: "u1", username: "me", name: "Me" });
});

describe("session revocation", () => {
  it("uses the dev cookie name outside production", () => {
    expect(sessionCookieName()).toBe("myk_session");
  });

  it("setSession -> getSession works; revokeSessions invalidates the old cookie", async () => {
    await setSession("u1");
    const stolen = jar.get(sessionCookieName())!;
    expect(await getSession()).toEqual({ userId: "u1" });

    await revokeSessions("u1");
    expect(await getSession()).toBeNull();

    // A fresh login gets the new version; the old token stays dead.
    await setSession("u1");
    expect(await getSession()).toEqual({ userId: "u1" });
    jar.set(sessionCookieName(), stolen);
    expect(await getSession()).toBeNull();
  });

  it("rejects tokens without ver, for unknown users, and after clearSession", async () => {
    const { SignJWT } = await import("jose");
    const noVer = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    jar.set(sessionCookieName(), noVer);
    expect(await getSession()).toBeNull();

    jar.set(sessionCookieName(), await signSessionToken("ghost", 1));
    expect(await getSession()).toBeNull();

    await setSession("u1");
    await clearSession();
    expect(await getSession()).toBeNull();
  });
});

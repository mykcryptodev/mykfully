import { afterEach, describe, expect, it } from "vitest";
import { env } from "@/lib/env";

const KEYS = ["APP_URL", "VERCEL_ENV", "VERCEL_BRANCH_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("env.appUrl", () => {
  it("uses APP_URL when set, without a trailing slash", () => {
    process.env.APP_URL = "https://mykfully.com/";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "mykfully-git-x-team.vercel.app";
    expect(env.appUrl).toBe("https://mykfully.com");
  });

  it("falls back to the branch URL on Vercel previews", () => {
    delete process.env.APP_URL;
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "mykfully-git-x-team.vercel.app";
    expect(env.appUrl).toBe("https://mykfully-git-x-team.vercel.app");
  });

  it("never uses the branch URL outside previews", () => {
    delete process.env.APP_URL;
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_BRANCH_URL = "mykfully-git-main-team.vercel.app";
    expect(env.appUrl).toBe("http://localhost:3000");
  });
});

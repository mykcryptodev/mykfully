import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { config, middleware } from "@/middleware";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { publicPageMetadata, siteUrl } from "@/lib/seo";

const secret = "seo-test-secret-at-least-32-bytes-long";
afterEach(() => vi.unstubAllEnvs());

describe("public discovery and auth boundaries", () => {
  it("serves crawler files and social images without auth middleware", () => {
    for (const url of ["/robots.txt", "/sitemap.xml", "/og-mykfully.jpg", "/login", "/privacy"]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    }
    for (const url of ["/", "/drafts/private-id", "/admin", "/sitemap.xml/private"]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });

  it("keeps the public root rewrite and private draft redirect", async () => {
    vi.stubEnv("SESSION_SECRET", secret);
    const root = await middleware(new NextRequest("https://example.com/"));
    expect(root.headers.get("x-middleware-rewrite")).toBe("https://example.com/login");
    const draft = await middleware(new NextRequest("https://example.com/drafts/private-id"));
    expect(draft.status).toBe(307);
    expect(draft.headers.get("location")).toBe("https://example.com/login?next=%2Fdrafts%2Fprivate-id");
  });

  it("still allows authenticated users into the workspace", async () => {
    vi.stubEnv("SESSION_SECRET", secret);
    const token = await new SignJWT({ sub: "test-user" }).setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h").sign(new TextEncoder().encode(secret));
    const response = await middleware(new NextRequest("https://example.com/", {
      headers: { cookie: `myk_session=${token}` },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("publishes only public canonical pages and a discoverable sitemap", () => {
    expect(sitemap().map(entry => entry.url)).toEqual([siteUrl, `${siteUrl}/privacy`]);
    expect(robots().sitemap).toBe(`${siteUrl}/sitemap.xml`);
    expect(publicPageMetadata("Title", "Description", "/").alternates).toEqual({ canonical: "/" });
    expect(publicPageMetadata("Privacy", "Description", "/privacy").alternates).toEqual({ canonical: "/privacy" });
  });
});

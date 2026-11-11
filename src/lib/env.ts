/** Centralized env access. */
export const env = {
  /**
   * MOCK_X=1 swaps the real X API for an in-memory fake (local dev/tests).
   * Hard-disabled on Vercel production deployments so it can never become an auth bypass.
   */
  get mockX() {
    if (process.env.MOCK_X !== "1") return false;
    if (process.env.VERCEL_ENV === "production") {
      console.error("[mykfully] MOCK_X=1 is set on a production deployment — ignoring it.");
      return false;
    }
    return true;
  },
  /** Mock login under NODE_ENV=production (local `pnpm start` smoke tests only — never set on a deploy). */
  get allowMockLogin() {
    return process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK_LOGIN === "1";
  },
  get isProd() {
    return process.env.NODE_ENV === "production";
  },
  get appUrl() {
    return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  },
  get xClientId() {
    return must("X_CLIENT_ID");
  },
  get xClientSecret() {
    return process.env.X_CLIENT_SECRET ?? null; // confidential client if set
  },
  get sessionSecret() {
    const s = must("SESSION_SECRET");
    if (new TextEncoder().encode(s).length < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
    return s;
  },
  get tokenEncKey() {
    return must("TOKEN_ENCRYPTION_KEY"); // 32 bytes, base64
  },
  get cronSecret() {
    return must("CRON_SECRET");
  },
  get databaseUrl() {
    return process.env.DATABASE_URL ?? null; // unset => local PGlite in ./.data
  },
  /** X user ids (numeric strings) with admin rights: unlimited credits + /admin. */
  get adminIds(): Set<string> {
    return new Set(
      (process.env.ADMIN_X_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  },
  /** Credits granted once when a new X account first signs in. */
  get signupCredits() {
    return intEnv("SIGNUP_CREDITS", 1000);
  },
  /** Cap on total non-admin spend per rolling 24h. Default 20000 (≈$20/day); 0 disables it. */
  get globalDailyCreditCap() {
    return intEnv("GLOBAL_DAILY_CREDIT_CAP", 20000);
  },
  /**
   * Optional sign-in allowlist of X user ids (comma-separated). Empty/unset = anyone may sign in.
   * Admins (ADMIN_X_USER_IDS) are always allowed.
   */
  get allowedXUserIds(): Set<string> | null {
    const ids = (process.env.ALLOWED_X_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return ids.length ? new Set(ids) : null;
  },
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

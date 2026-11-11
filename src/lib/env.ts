/** Centralized env access. MOCK_X=1 swaps the real X API for an in-memory fake (local dev/tests). */
export const env = {
  get mockX() {
    return process.env.MOCK_X === "1";
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
    return must("SESSION_SECRET"); // >= 32 chars
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
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

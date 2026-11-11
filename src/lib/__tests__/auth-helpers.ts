import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";

export const TEST_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

export function setAuthEnv() {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENC_KEY;
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.X_CLIENT_ID = "test-client";
  delete process.env.X_CLIENT_SECRET;
  delete process.env.MOCK_X;
}

/** Fresh in-memory DB installed as the getDb() singleton (never touches ./.data). */
export async function installTestDb(): Promise<DB> {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  const db = d as unknown as DB;
  const g = globalThis as unknown as { __mykDb?: Promise<DB>; __mykRefresh?: Map<string, unknown> };
  g.__mykDb = Promise.resolve(db);
  g.__mykRefresh?.clear();
  return db;
}

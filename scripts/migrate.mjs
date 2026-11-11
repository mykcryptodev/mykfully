// Applies Drizzle migrations to DATABASE_URL (Neon). Runs before `next build` on Vercel.
// No-op when DATABASE_URL is unset (local dev uses embedded PGlite, migrated on startup).
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("[migrate] DATABASE_URL not set — skipping");
} else {
  await migrate(drizzle(neon(url)), { migrationsFolder: "./drizzle" });
  console.log("[migrate] done");
}

// Run `next dev` against a chosen database:
//   pnpm dev:local     embedded PGlite (./.data/pglite), ignores DATABASE_URL in .env.local
//   pnpm dev:preview   the shared Preview database (migrated first, like a preview build)
//   pnpm dev:prod      the PRODUCTION database (never migrated; mock mode forced off)
// Add --refresh to re-pull the cached URL from Vercel. Extra args go to `next dev`.
//
// The URL is pulled with `vercel env pull` (needs `vercel login` + a linked project)
// and cached in .env.db.<target>, which holds only DATABASE_URL and is gitignored (.env*).
// Variables set here override .env.local, because Next never overwrites existing env vars.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGETS = { local: null, preview: "preview", prod: "production" };
const [target, ...rest] = process.argv.slice(2);
if (!(target in TARGETS)) {
  console.error(`usage: node scripts/dev-db.mjs <${Object.keys(TARGETS).join("|")}> [--refresh] [next dev args]`);
  process.exit(1);
}
const refresh = rest.includes("--refresh");
const nextArgs = rest.filter((a) => a !== "--refresh");

function readUrl(file) {
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  return line ? line.slice("DATABASE_URL=".length).trim().replace(/^"(.*)"$/, "$1") : "";
}

function pullUrl(environment) {
  const dir = mkdtempSync(join(tmpdir(), "myk-env-"));
  try {
    const file = join(dir, "pulled.env");
    const r = spawnSync("vercel", ["env", "pull", file, `--environment=${environment}`, "--yes"], { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`vercel env pull --environment=${environment} failed`);
    return readUrl(file);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // drop the other pulled secrets
  }
}

const env = { ...process.env };
if (target === "local") {
  env.DATABASE_URL = ""; // empty => PGlite (see src/lib/db/index.ts)
} else {
  const cache = `.env.db.${target}`;
  let url = !refresh && existsSync(cache) ? readUrl(cache) : "";
  if (!url) {
    url = pullUrl(TARGETS[target]);
    if (!url) throw new Error(`No DATABASE_URL on the Vercel ${TARGETS[target]} environment`);
    writeFileSync(cache, `# Cached by scripts/dev-db.mjs. Delete or use --refresh to re-pull.\nDATABASE_URL=${url}\n`, { mode: 0o600 });
  }
  env.DATABASE_URL = url;
  const dbName = new URL(url).pathname.slice(1);

  if (target === "prod") {
    // Mock login on the prod DB would create a fake user in real data.
    env.MOCK_X = "0";
    env.ALLOW_MOCK_LOGIN = "0";
    console.warn(`\n⚠️  PRODUCTION database (${dbName}). Real users, real credits. No migrations run.\n`);
  } else {
    console.log(`[dev-db] preview database (${dbName}): applying migrations`);
    const m = spawnSync(process.execPath, ["scripts/migrate.mjs"], { env, stdio: "inherit" });
    if (m.status !== 0) process.exit(m.status ?? 1);
  }
}

const child = spawn("pnpm", ["exec", "next", "dev", ...nextArgs], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

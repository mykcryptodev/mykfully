import type { XClient, XUser } from "./types";

export const MOCK_ME: XUser = {
  id: "mock-1",
  username: "mykdemo",
  name: "Myk Demo",
  profileImageUrl: "https://unavatar.io/x/mykdemo",
  verifiedType: null,
  description: "Demo account for mykfully mock mode",
  followersCount: 42,
};

type Seed = [username: string, name: string, verifiedType: string | null, followers: number, description: string];

const SEEDS: Seed[] = [
  ["jack", "jack", "none", 6_500_000, "no state is the best state"],
  ["elonmusk", "Elon Musk", "blue", 200_000_000, ""],
  ["vercel", "Vercel", "business", 500_000, "Develop. Preview. Ship."],
  ["rauchg", "Guillermo Rauch", "blue", 300_000, "@vercel CEO"],
  ["nextjs", "Next.js", "business", 400_000, "The React Framework"],
  ["typefully", "Typefully", "business", 60_000, "Write, schedule, and grow on X"],
  ["paulg", "Paul Graham", "blue", 2_000_000, ""],
  ["naval", "Naval", "blue", 2_500_000, ""],
  ["sama", "Sam Altman", "blue", 3_500_000, ""],
  ["levelsio", "@levelsio", "blue", 600_000, "Indie maker"],
  ["dhh", "DHH", "blue", 500_000, "Ruby on Rails, Basecamp, HEY"],
  ["swyx", "swyx", "blue", 120_000, "AI Engineer"],
  ["shadcn", "shadcn", "blue", 200_000, "Building ui.shadcn.com"],
  ["leerob", "Lee Robinson", "blue", 250_000, "Teaching developers"],
  ["OpenAI", "OpenAI", "business", 4_000_000, ""],
  ["AnthropicAI", "Anthropic", "business", 800_000, "AI safety and research company"],
  ["github", "GitHub", "business", 2_500_000, "The AI-powered developer platform"],
  ["figma", "Figma", "business", 900_000, "Where teams design together"],
  ["stripe", "Stripe", "business", 600_000, "Financial infrastructure for the internet"],
  ["patrickc", "Patrick Collison", "blue", 500_000, "Stripe CEO"],
  ["balajis", "Balaji", "blue", 1_000_000, "The Network State"],
  ["VitalikButerin", "vitalik.eth", "blue", 5_500_000, "Ethereum"],
  ["coinbase", "Coinbase", "business", 6_000_000, ""],
  ["base", "Base", "business", 700_000, "Base is for everyone"],
  ["jessepollak", "Jesse Pollak", "blue", 250_000, "Building @base"],
  ["rauchg_bot", "Rauch Bot", null, 120, "Not Guillermo"],
  ["raycastapp", "Raycast", "business", 150_000, "Supercharged productivity"],
  ["tailwindcss", "Tailwind CSS", "business", 400_000, "A utility-first CSS framework"],
  ["reactjs", "React", "business", 700_000, "The library for web and native user interfaces"],
  ["supabase", "Supabase", "business", 200_000, "The Postgres development platform"],
  ["neondatabase", "Neon", "business", 60_000, "Serverless Postgres"],
  ["alexalbert__", "Alex Albert", "blue", 100_000, ""],
];

export const MOCK_USERS: XUser[] = SEEDS.map(([username, name, verifiedType, followersCount, description], i) => ({
  id: `mock-u-${1000 + i}`,
  username,
  name,
  profileImageUrl: `https://unavatar.io/x/${username}`,
  verifiedType,
  followersCount,
  description: description || null,
}));

// Process-wide counters survive HMR so ids stay unique within a dev session.
const g = globalThis as unknown as { __mykMockX?: { nextId: bigint; postCalls: number } };
const state = (g.__mykMockX ??= { nextId: BigInt(Date.now()) * BigInt(1000), postCalls: 0 });

/** Test helper: reset the postTweet call counter (used with MOCK_X_FAIL_AFTER). */
export function resetMockCounters() {
  state.postCalls = 0;
}

export function createMockXClient(): XClient {
  return {
    async me() {
      return { ...MOCK_ME };
    },

    async postTweet(text, replyToId) {
      state.postCalls += 1;
      const failAt = Number(process.env.MOCK_X_FAIL_AFTER ?? "");
      if (Number.isFinite(failAt) && failAt > 0 && state.postCalls === failAt) {
        throw new Error(`Mock X: simulated failure on postTweet call #${state.postCalls} (MOCK_X_FAIL_AFTER=${failAt})`);
      }
      state.nextId += BigInt(1);
      const id = state.nextId.toString();
      console.log(`[mock-x] postTweet id=${id}${replyToId ? ` reply_to=${replyToId}` : ""}: ${JSON.stringify(text)}`);
      return { id };
    },

    async lookupUsernames(usernames) {
      const wanted = new Set(usernames.map((u) => u.replace(/^@/, "").toLowerCase()));
      return MOCK_USERS.filter((u) => wanted.has(u.username.toLowerCase()));
    },

    async searchUsers(query, max = 8) {
      const q = query.replace(/^@/, "").trim().toLowerCase();
      if (!q) return [];
      const scored = MOCK_USERS.map((u) => {
        const un = u.username.toLowerCase();
        const nm = u.name.toLowerCase();
        const score = un === q ? 0 : un.startsWith(q) ? 1 : nm.startsWith(q) ? 2 : un.includes(q) || nm.includes(q) ? 3 : -1;
        return { u, score };
      }).filter((x) => x.score >= 0);
      scored.sort((a, b) => a.score - b.score || (b.u.followersCount ?? 0) - (a.u.followersCount ?? 0));
      return scored.slice(0, max).map((x) => x.u);
    },
  };
}

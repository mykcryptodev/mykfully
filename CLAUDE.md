# CLAUDE.md

The canonical guidance for this repo lives in [AGENTS.md](AGENTS.md). Read it before making changes.

@AGENTS.md

## Claude-specific reminders

- **Gate:** run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` before you report work as done. Unset `DATABASE_URL` locally so `pnpm build` doesn't migrate a real database.
- **Git:** commit only when asked. This is a public repo, so check `git diff --cached` for secrets, `.env*` and local paths, and end commits with the attribution trailer your harness provides.
- **Package installs:** never bypass pnpm's `minimumReleaseAge: 1440`, and never use npm or yarn.

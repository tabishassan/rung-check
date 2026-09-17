# Rung Check

The Honest Read / Ladder Profile Audit — a LinkedIn profile scoring tool.

- **`api/`** — Cloudflare Worker backend (`rung-check-api`). Proxies the scoring model, sends the report email, and logs leads to D1.
- **`site/`** — Static site served via Cloudflare Workers Assets, live at `rungcheck.tabishhassan.com`.

## Deploying

Pushing to `main` automatically deploys via GitHub Actions:

- Changes under `api/` deploy the Worker backend.
- Changes under `site/` deploy the static site.

Both use a Cloudflare API token stored as the `CLOUDFLARE_API_TOKEN` repo secret. Runtime secrets (`GROQ_API_KEY`, `BREVO_API_KEY`, `PROXY_SECRET`) live in Cloudflare's own Worker secret store and are never part of this repo or CI.

You can also deploy manually from either folder with `npx wrangler deploy`.

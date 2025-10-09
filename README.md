# UAE Labour Laws Sync (GitHub Pages + Actions)

This repo generates static JSON endpoints that list **in‑force** UAE labour laws, daily snapshots, and diffs showing added/removed/changed items.

## Quick start
1. Enable GitHub Pages (Settings → Pages → Branch: `main`).
2. Run the workflow once (Actions → `Sync UAE Labour Laws` → Run).
3. JSON endpoints will appear under `/api/*` on your Pages domain.
4. Use `openapi.json` to wire a GPT Action to these endpoints.

## Commands
```bash
npm run sync
```

## Files
- `scripts/sources.mjs` — source registry (MOHRE indexes + specific instruments).
- `scripts/sync-laws.mjs` — scraper/normaliser/diff writer.
- `.github/workflows/law-sync.yml` — daily scheduled run.
- `api/` — generated outputs (`laws.json`, `snapshots/*.json`, `diff/*.json`).

> Note: This is a lightweight parser; always validate against official sources.

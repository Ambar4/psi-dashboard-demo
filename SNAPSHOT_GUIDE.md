# PSI Dashboard - operations guide

A self-hosted Lighthouse / PageSpeed Insights tracker. Supports **multiple clients** (sites) and **weekly snapshots per client** so you can compare scores week over week.

Snapshots run automatically every Wednesday at 7am Central via GitHub Actions. The local scripts are still here as a fallback for ad-hoc runs or debugging.

## Folder layout

```
psi-dashboard/
  .github/workflows/
    weekly-snapshot.yml       ← runs every configured client in parallel each Wed
  scripts/
    fetch-changes.sh          ← step 0: pull merged PRs from client's GitHub repo (optional)
    run-psi.sh                ← step 1: hit Google PSI API for one client
    build-snapshot.js         ← called by run-psi.sh; raw → snapshot
    run-rrweb.sh              ← step 2: capture replays
    record-rrweb.js           ← called by run-rrweb.sh
    publish.sh                ← step 3: copy template + client data → dist/<client>/
  template/                   ← shared across all clients
    index.html
    rrweb-player.js
    rrweb-player.css
  package.json                ← shared deps
  node_modules/               ← gitignored
  dist/                       ← gitignored, built by publish.sh
    <client>/                 ← deployed to Cloudflare Pages: <project-name>
  clients/
    <client>/
      config.json             ← URL list + display name + base host
      psi-raw/2026-04-21/     ← gitignored (regenerable)
      snapshots/2026-04-21.json, index.json
      rrweb-recordings/2026-04-21/
```

## Adding a new client

1. Create `clients/<id>/config.json`:

   ```json
   {
     "id": "<id>",
     "displayName": "Client name shown in dashboard",
     "baseUrl": "https://example.com",
     "repo": "owner/<repo-name>",
     "urls": [
       "https://example.com/",
       "https://example.com/page-2/"
     ]
   }
   ```

   The `repo` field is optional. If set, the dashboard shows a "Changes since last snapshot" section listing merged PRs (or commits as fallback) from that repo for the snapshot window. If omitted, that section shows the empty-state message. Requires the `SOURCE_REPO_TOKEN` secret to have read access to the repo.

2. Create a new Cloudflare Pages project for the client (direct upload, no git integration). Note the project name.

3. Add the client to the matrix in `.github/workflows/weekly-snapshot.yml`:

   ```yaml
   matrix:
     include:
       - client: <id-1>
         cf_project: <cloudflare-project-name-1>
       - client: <id-2>
         cf_project: <cloudflare-project-name-2>
   ```

4. If using the `repo` field on a new client, update the `SOURCE_REPO_TOKEN` fine-grained PAT in GitHub settings to grant it read access to the new repo.

5. Commit + push. Trigger a manual run from the Actions tab to verify.

## Weekly workflow

GitHub Actions runs every Wednesday at 13:00 UTC (8am CST / 7am CDT). It does the full pipeline for every configured client in parallel:

1. Fetch repo changes (PRs / commits) — optional, skipped if no `repo` field
2. Fetch PSI scores → build snapshot JSON
3. Capture rrweb replays
4. Build the deploy folder (`dist/<client>/`)
5. Deploy to Cloudflare Pages via wrangler
6. Commit the new snapshot back to the repo

Manual trigger: Actions tab → Weekly PSI snapshot → Run workflow.

### Manual fallback (local laptop)

If you need to run a snapshot outside the schedule, three commands per client:

```bash
cd /path/to/psi-dashboard
export PSI_API_KEY=<key>             # see GitHub repo secrets
export SOURCE_REPO_TOKEN=<token>     # only if the client config has a `repo` field

./scripts/fetch-changes.sh <client>  # optional, skipped if no `repo`
./scripts/run-psi.sh <client>
./scripts/run-rrweb.sh <client> $(date +%Y-%m-%d)
./scripts/publish.sh <client>
```

Then either drag `dist/<client>/` into Cloudflare Pages manually, or push the new snapshot files and let the next scheduled run pick them up.

## What each step does

**`fetch-changes.sh <client> [date]`**
- Reads `repo` from `clients/<client>/config.json`. Skips silently if missing.
- Computes the time window: from the previous snapshot date in `index.json` to the current snapshot date. First snapshot falls back to the last 7 days.
- Calls the GitHub PRs API for merged PRs targeting `main` in the window. Filters out dependabot, renovate, and github-actions bots.
- If no PRs in the window, falls back to the commits API for the same window.
- Writes `clients/<client>/psi-raw/<date>/changes.json` so `build-snapshot.js` can fold the items into the snapshot output.
- Reads the GitHub token from the `SOURCE_REPO_TOKEN` env var.

**`run-psi.sh <client> [date]`**
- Reads URLs from `clients/<client>/config.json`.
- Calls Google PSI for all URLs × 2 strategies in parallel (~30-45s).
- Saves raw API responses to `clients/<client>/psi-raw/<date>/url-{N}-{strategy}.json`.
- Calls `build-snapshot.js <client> <date>` to produce `clients/<client>/snapshots/<date>.json`.
- Updates `clients/<client>/snapshots/index.json` automatically.
- Reads the API key from the `PSI_API_KEY` env var.

**`run-rrweb.sh <client> [date]`**
- Reads URLs from `clients/<client>/config.json`.
- Records mobile (throttled, matching PSI conditions) and desktop (unthrottled) page loads.
- Saves to `clients/<client>/rrweb-recordings/<date>/url-{N}-{strategy}-rrweb.json`.
- Takes ~6-8 minutes for 10 URLs × 2 strategies.

**`publish.sh <client>`**
- Copies the shared template (`index.html`, `rrweb-player.js/.css`) to `dist/<client>/`.
- Copies that client's `config.json`, `snapshots/`, and `rrweb-recordings/`.
- Writes `_redirects` for Cloudflare Pages.
- Reports file count + total size so you catch any Cloudflare Pages limit issues early.
- Idempotent: safe to run after every weekly update.

## Sanity check after deploy

Open the Cloudflare URL and verify:
1. The h1 reads "PageSpeed Insights — <client display name>".
2. The Snapshot dropdown shows the new date and is selected by default.
3. The Compare-to dropdown shows the previous snapshot.
4. Score deltas appear under each ring (green = improved, red = regressed).
5. The perf trend sparkline at the bottom of each card shows two dots connected.
6. Click "Replay load" on any card — the replay opens with the snapshot date in the modal title.

## Notes

- **Adding or removing a URL** for a client = edit `clients/<client>/config.json`. That's it. The scripts and dashboard pick it up automatically.
- **Snapshots without rrweb recordings still work** — the Replay button just shows an error if you click it for that snapshot.
- **The compare picker auto-defaults** to the previous snapshot. Set it to "Off" to hide deltas.
- **The sparkline needs 2+ snapshots** to draw a line.
- **Cloudflare Pages 1,000-file limit:** `publish.sh` prints a warning if your deploy folder gets close. If you hit it, archive older `rrweb-recordings/<date>/` folders out of `clients/<client>/` (they'll stop showing up in the deploy and Replay will gracefully fail for those snapshots).
- **API key** for Google PSI lives in the `PSI_API_KEY` GitHub repo secret (Settings → Secrets and variables → Actions). The local scripts read from the env var of the same name. To rotate: update the GitHub secret, and update your local shell export if you run scripts manually.
- **Cloudflare credentials** also live as GitHub secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs Pages: Edit permission.
- **GitHub repo token** for the "Changes since last snapshot" feature lives as the `SOURCE_REPO_TOKEN` GitHub secret. It's a fine-grained PAT with read-only access to Contents and Pull requests on the client repos. To rotate or grant access to a new client repo: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → edit the token to add the new repo, then update the secret value if the token string changed.

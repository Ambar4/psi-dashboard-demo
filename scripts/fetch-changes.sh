#!/bin/bash
# fetch-changes.sh
# Pulls merged PRs (or commits as a fallback) from a client's GitHub repo for the
# window between the previous snapshot date and the snapshot date being built.
# Writes results to clients/<client>/psi-raw/<snapshot-id>/changes.json so
# build-snapshot.js can fold them into the snapshot output.
#
# Usage:
#   ./scripts/fetch-changes.sh <client> [snapshot-id]
#
# Env: requires SOURCE_REPO_TOKEN (fine-grained PAT with read access to the
# client repos). Skips silently if the client config has no `repo` field, or
# if SOURCE_REPO_TOKEN is unset (so local runs without auth still work).

set -u

if [ $# -lt 1 ]; then
  echo "Usage: $0 <client> [snapshot-id]"
  exit 2
fi

CLIENT="$1"
SNAPSHOT_ID="${2:-$(date +%Y-%m-%d)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/clients/$CLIENT"
CONFIG="$CLIENT_DIR/config.json"
INDEX="$CLIENT_DIR/snapshots/index.json"
RAW_DIR="$CLIENT_DIR/psi-raw/$SNAPSHOT_ID"
OUT_FILE="$RAW_DIR/changes.json"

if [ ! -f "$CONFIG" ]; then
  echo "Config not found: $CONFIG"
  exit 1
fi

REPO=$(python3 -c "
import json, sys
cfg = json.load(open(sys.argv[1]))
print(cfg.get('repo', ''))
" "$CONFIG")

if [ -z "$REPO" ]; then
  echo "No 'repo' field in $CONFIG. Skipping change fetch."
  exit 0
fi

if [ -z "${SOURCE_REPO_TOKEN:-}" ]; then
  echo "SOURCE_REPO_TOKEN not set. Skipping change fetch."
  exit 0
fi

# Compute time window: (prevSnapshotDate, snapshotDate].
# If there's no previous snapshot in the index, fall back to 7 days before.
PREV_DATE=$(python3 -c "
import json, sys, os
path, target = sys.argv[1], sys.argv[2]
if not os.path.exists(path):
    print('')
    sys.exit(0)
idx = json.load(open(path))
for s in sorted(idx, key=lambda x: x['id'], reverse=True):
    if s['id'] < target:
        print(s['id'])
        sys.exit(0)
print('')
" "$INDEX" "$SNAPSHOT_ID")

if [ -z "$PREV_DATE" ]; then
  PREV_DATE=$(python3 -c "
from datetime import date, timedelta
y, m, d = map(int, '$SNAPSHOT_ID'.split('-'))
print((date(y, m, d) - timedelta(days=7)).isoformat())
")
fi

mkdir -p "$RAW_DIR"

# ISO bounds: window is (PREV 23:59:59, SNAPSHOT 23:59:59].
SINCE_ISO="${PREV_DATE}T23:59:59Z"
UNTIL_ISO="${SNAPSHOT_ID}T23:59:59Z"

echo "Client:    $CLIENT"
echo "Repo:      $REPO"
echo "Window:    $SINCE_ISO  →  $UNTIL_ISO"

# --- Step 1: list closed PRs targeting main, sorted by updated desc.
PR_RESP=$(curl -sS \
  -H "Authorization: Bearer $SOURCE_REPO_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100")

PR_FILTERED=$(echo "$PR_RESP" | python3 -c "
import json, sys, re
data = json.load(sys.stdin)
if isinstance(data, dict):
    print(json.dumps({'error': data.get('message', 'unknown'), 'items': []}))
    sys.exit(0)
since = '$SINCE_ISO'
until = '$UNTIL_ISO'
out = []
for p in data:
    m = p.get('merged_at')
    if not m: continue
    if m <= since or m > until: continue
    user = p.get('user') or {}
    login = (user.get('login') or '').lower()
    if user.get('type') == 'Bot': continue
    if re.search(r'(dependabot|renovate|github-actions)', login): continue
    out.append({
        'type': 'pr',
        'title': p.get('title'),
        'date': m,
        'author': user.get('login'),
        'url': p.get('html_url'),
        'number': p.get('number'),
    })
out.sort(key=lambda x: x['date'], reverse=True)
print(json.dumps({'items': out}))
")

PR_COUNT=$(echo "$PR_FILTERED" | python3 -c "import json, sys; print(len(json.load(sys.stdin).get('items', [])))")

# --- Step 2: if no PRs in window after bot filter, fall back to commits.
if [ "$PR_COUNT" = "0" ]; then
  echo "No merged PRs in window after bot filter. Falling back to commits."
  COMMITS_RESP=$(curl -sS \
    -H "Authorization: Bearer $SOURCE_REPO_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$REPO/commits?sha=main&since=$SINCE_ISO&until=$UNTIL_ISO&per_page=100")

  FILTERED=$(echo "$COMMITS_RESP" | python3 -c "
import json, sys, re
data = json.load(sys.stdin)
if isinstance(data, dict):
    print(json.dumps({'error': data.get('message', 'unknown'), 'items': []}))
    sys.exit(0)
out = []
for c in data:
    msg = (c.get('commit') or {}).get('message') or ''
    title = msg.splitlines()[0] if msg else '(no message)'
    author_obj = c.get('author') or {}
    login = (author_obj.get('login') or '').lower()
    if author_obj.get('type') == 'Bot': continue
    if re.search(r'(dependabot|renovate|github-actions)', login): continue
    commit_meta = (c.get('commit') or {}).get('author') or {}
    out.append({
        'type': 'commit',
        'title': title,
        'date': commit_meta.get('date'),
        'author': author_obj.get('login') or commit_meta.get('name'),
        'url': c.get('html_url'),
        'sha': (c.get('sha') or '')[:7],
    })
print(json.dumps({'items': out}))
")
  echo "$FILTERED" > "$OUT_FILE"
else
  echo "$PR_FILTERED" > "$OUT_FILE"
fi

ITEM_COUNT=$(python3 -c "import json; print(len(json.load(open('$OUT_FILE')).get('items', [])))")
ERR=$(python3 -c "import json; print(json.load(open('$OUT_FILE')).get('error', ''))")
if [ -n "$ERR" ]; then
  echo "WARN: API returned error: $ERR"
fi
echo "Wrote $ITEM_COUNT change item(s) to $OUT_FILE"

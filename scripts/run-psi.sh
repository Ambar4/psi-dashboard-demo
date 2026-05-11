#!/bin/bash
# run-psi.sh
# Fetch Google PageSpeed Insights scores for one client's URL list.
#
# Usage:
#   ./scripts/run-psi.sh <client> [snapshot-id]
#
# Examples:
#   ./scripts/run-psi.sh topps                  # snapshot-id = today's date
#   ./scripts/run-psi.sh topps 2026-05-05
#   ./scripts/run-psi.sh bayalarm
#
# Reads URLs from clients/<client>/config.json.
# Saves raw PSI JSON to clients/<client>/psi-raw/<snapshot-id>/.
# Then runs build-snapshot.js to produce clients/<client>/snapshots/<snapshot-id>.json.
# Total run time: ~30-45s for the 20 parallel API calls.

set -u

if [ $# -lt 1 ]; then
  echo "Usage: $0 <client> [snapshot-id]"
  exit 2
fi

API_KEY="${PSI_API_KEY:?PSI_API_KEY not set}"
CLIENT="$1"
SNAPSHOT_ID="${2:-$(date +%Y-%m-%d)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/clients/$CLIENT"
CONFIG="$CLIENT_DIR/config.json"
RESULTS_DIR="$CLIENT_DIR/psi-raw/$SNAPSHOT_ID"

if [ ! -f "$CONFIG" ]; then
  echo "Config not found: $CONFIG"
  echo "Create it with at minimum { id, displayName, baseUrl, urls[] }."
  exit 1
fi
mkdir -p "$RESULTS_DIR"

# Read URLs from config.json into a bash array. Python is on every Mac.
# NOTE: macOS ships bash 3.2 which lacks `mapfile`/`readarray`. Use a portable
# while-read loop instead so this works on both macOS system bash and Linux.
URLS=()
while IFS= read -r u; do
  [ -n "$u" ] && URLS+=("$u")
done < <(python3 -c "
import json, sys
cfg = json.load(open(sys.argv[1]))
for u in cfg['urls']:
    print(u)
" "$CONFIG")

if [ "${#URLS[@]}" -eq 0 ]; then
  echo "No URLs in $CONFIG (or python3 failed to parse it)."
  echo "Try running this manually to see the error:"
  echo "  python3 -c 'import json; print(json.load(open(\"$CONFIG\"))[\"urls\"])'"
  exit 1
fi

echo "Client:      $CLIENT"
echo "Snapshot:    $SNAPSHOT_ID"
echo "URLs:        ${#URLS[@]}"
echo "Raw dir:     $RESULTS_DIR"
echo "Starting $((${#URLS[@]} * 2)) PSI calls (mobile + desktop) in parallel..."
echo "Each call takes ~15-30s. Total should be ~30-45s. Cached results are skipped."
echo ""

fetch_one() {
  local idx=$1
  local url=$2
  local strategy=$3
  local outfile="$RESULTS_DIR/url-${idx}-${strategy}.json"
  if [ -s "$outfile" ] && grep -q '"lighthouseResult"' "$outfile" 2>/dev/null; then
    echo "[$((idx+1))/${#URLS[@]}] SKIP (cached) - $url"
    return
  fi
  local encoded
  encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$url")
  local psi_url="https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encoded}&strategy=${strategy}&category=PERFORMANCE&category=ACCESSIBILITY&category=BEST_PRACTICES&category=SEO&key=${API_KEY}"
  local start=$(date +%s)
  for attempt in 1 2; do
    curl -sS --max-time 90 "$psi_url" > "$outfile"
    if [ -s "$outfile" ] && grep -q '"lighthouseResult"' "$outfile" 2>/dev/null; then
      break
    fi
    [ "$attempt" = "1" ] && sleep 2
  done
  local end=$(date +%s)
  local elapsed=$((end - start))
  if grep -q '"lighthouseResult"' "$outfile" 2>/dev/null; then
    echo "[$((idx+1))/${#URLS[@]}] OK   (${elapsed}s) - $url"
  else
    echo "[$((idx+1))/${#URLS[@]}] FAIL (${elapsed}s) - $url"
    head -c 200 "$outfile"
    echo ""
  fi
}

for strategy in mobile desktop; do
  echo "--- Batch: $strategy ---"
  for i in "${!URLS[@]}"; do
    fetch_one "$i" "${URLS[$i]}" "$strategy" &
  done
  wait
  echo ""
done

echo ""
echo "=== Building snapshot $SNAPSHOT_ID for $CLIENT ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Skipping snapshot build."
  echo "Install Node, then run: node scripts/build-snapshot.js $CLIENT $SNAPSHOT_ID"
  exit 0
fi
node "$SCRIPT_DIR/build-snapshot.js" "$CLIENT" "$SNAPSHOT_ID"

echo ""
echo "Next steps:"
echo "  1. Record replays:   ./scripts/run-rrweb.sh $CLIENT $SNAPSHOT_ID"
echo "  2. Publish to deploy: ./scripts/publish.sh $CLIENT"
echo "  3. Drag deploy-${CLIENT}-dashboard/ into Cloudflare Pages."

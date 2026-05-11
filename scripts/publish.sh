#!/bin/bash
# publish.sh
# Copy template + one client's config/snapshots/recordings into the per-client
# deploy folder so it's ready to drag into Cloudflare Pages.
#
# Usage:
#   ./scripts/publish.sh <client>
#
# Output: <repo-root>/deploy-<client>-dashboard/

set -eu

if [ $# -lt 1 ]; then
  echo "Usage: $0 <client>"
  exit 2
fi

CLIENT="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CLIENT_DIR="$ROOT_DIR/clients/$CLIENT"
TEMPLATE_DIR="$ROOT_DIR/template"
DEPLOY_DIR="$ROOT_DIR/dist/$CLIENT"

if [ ! -d "$CLIENT_DIR" ]; then
  echo "Client folder not found: $CLIENT_DIR"
  exit 1
fi
if [ ! -f "$CLIENT_DIR/config.json" ]; then
  echo "Missing $CLIENT_DIR/config.json"
  exit 1
fi
if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "Template folder not found: $TEMPLATE_DIR"
  exit 1
fi

echo "Publishing $CLIENT → $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# Template files (dashboard HTML + rrweb-player assets)
cp "$TEMPLATE_DIR/index.html"        "$DEPLOY_DIR/"
cp "$TEMPLATE_DIR/rrweb-player.js"   "$DEPLOY_DIR/"
cp "$TEMPLATE_DIR/rrweb-player.css"  "$DEPLOY_DIR/"

# Per-client config
cp "$CLIENT_DIR/config.json" "$DEPLOY_DIR/"

# Optional logo file. config.json may declare logoFile (e.g. "logo.png" or
# "logo.svg"); if that file exists in the client folder, copy it to the deploy
# folder so the dashboard can fetch it next to index.html.
LOGO_FILE=$(python3 -c "
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    print(cfg.get('logoFile', ''))
except Exception:
    pass
" "$CLIENT_DIR/config.json")
if [ -n "$LOGO_FILE" ] && [ -f "$CLIENT_DIR/$LOGO_FILE" ]; then
  cp "$CLIENT_DIR/$LOGO_FILE" "$DEPLOY_DIR/"
  echo "Copied logo: $LOGO_FILE"
elif [ -n "$LOGO_FILE" ]; then
  echo "WARNING: config.json references logoFile=$LOGO_FILE but $CLIENT_DIR/$LOGO_FILE is missing."
fi

# Snapshots (sync the whole folder; tiny JSON files)
mkdir -p "$DEPLOY_DIR/snapshots"
if [ -d "$CLIENT_DIR/snapshots" ]; then
  cp -R "$CLIENT_DIR/snapshots/." "$DEPLOY_DIR/snapshots/"
fi

# rrweb recordings (can be tens of MB; rsync if available, else cp)
mkdir -p "$DEPLOY_DIR/rrweb-recordings"
if [ -d "$CLIENT_DIR/rrweb-recordings" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$CLIENT_DIR/rrweb-recordings/" "$DEPLOY_DIR/rrweb-recordings/"
  else
    rm -rf "$DEPLOY_DIR/rrweb-recordings"
    mkdir -p "$DEPLOY_DIR/rrweb-recordings"
    cp -R "$CLIENT_DIR/rrweb-recordings/." "$DEPLOY_DIR/rrweb-recordings/"
  fi
fi

# _redirects: keep stable Cloudflare redirects across clients
cat > "$DEPLOY_DIR/_redirects" <<'EOF'
/topps-psi-dashboard      /  301
/topps-psi-dashboard/     /  301
/topps-psi-dashboard.html /  301
EOF

# Sanity check: file count + total size
FILE_COUNT=$(find "$DEPLOY_DIR" -type f | wc -l | tr -d ' ')
TOTAL_KB=$(du -sk "$DEPLOY_DIR" | awk '{print $1}')

echo ""
echo "Done."
echo "  Files: $FILE_COUNT  (Cloudflare Pages limit: 1000)"
echo "  Size:  ${TOTAL_KB} KB"
echo ""
if [ "$FILE_COUNT" -gt 1000 ]; then
  echo "WARNING: file count exceeds Cloudflare's 1000 limit. Consider archiving older snapshots."
fi
echo "Next: drag $DEPLOY_DIR into Cloudflare Pages."

#!/bin/bash
# run-rrweb.sh
# Records rrweb sessions for one client's URL list using headless Chrome.
# Saves JSON files to clients/<client>/rrweb-recordings/<snapshot-id>/.
# Takes ~6-8 minutes total (serial, both strategies).
#
# Usage:
#   ./scripts/run-rrweb.sh <client> [snapshot-id]
#
# First run installs puppeteer, which pulls ~170MB of Chromium. Subsequent
# runs reuse it and take just recording time.

set -e

if [ $# -lt 1 ]; then
  echo "Usage: $0 <client> [snapshot-id]"
  exit 2
fi

CLIENT="$1"
SNAPSHOT_ID="${2:-$(date +%Y-%m-%d)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Install it first: brew install node"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not available. Reinstall node: brew install node"
  exit 1
fi

if [ ! -f package.json ]; then
  echo "Initializing package.json..."
  npm init -y >/dev/null
fi
if [ ! -d node_modules/puppeteer ]; then
  echo "Installing puppeteer (first run only; downloads ~170MB Chromium)..."
  npm install puppeteer --silent
  echo ""
fi

node "$SCRIPT_DIR/record-rrweb.js" "$CLIENT" "$SNAPSHOT_ID"

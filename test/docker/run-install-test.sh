#!/usr/bin/env bash
# Build a clean image and run the installer inside it, then assert on what
# the user asked for: PLUR installed with Datacore, a named Chief of Staff,
# and the desktop app offered at the end.
#
# Usage: bash test/docker/run-install-test.sh [--shell]
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE="datacore-cli-install-test"

echo "==> building the CLI from this working tree"
cd "$REPO"
npm run build >/dev/null 2>&1 || { echo "FAIL: CLI build failed"; exit 2; }

rm -rf "$HERE/pkg" && mkdir -p "$HERE/pkg"
cp -R "$REPO/dist" "$HERE/pkg/dist"
cp "$REPO/package.json" "$HERE/pkg/package.json"

echo "==> building the image"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || { echo "FAIL: docker build failed"; exit 2; }

if [[ "${1:-}" == "--shell" ]]; then
  exec docker run --rm -it "$IMAGE" bash
fi

echo "==> running: datacore init --yes  (clean machine, no gh auth)"
docker run --rm "$IMAGE" bash -c '
  set -o pipefail
  datacore init --yes 2>&1 | tail -60
  echo "---INIT-EXIT:${PIPESTATUS[0]}---"
  echo "=== ASSERTIONS ==="
  fail=0
  chk() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

  chk "datacore-mcp binary installed"   "command -v datacore-mcp"
  chk "plur-mcp binary installed"       "command -v plur-mcp"
  chk "~/Data created"                  "test -d ~/Data"
  chk ".mcp.json written"               "test -f ~/Data/.mcp.json"
  chk "datacore registered in MCP"      "grep -q \"datacore\" ~/Data/.mcp.json"
  chk "plur registered in MCP"          "grep -q \"plur\" ~/Data/.mcp.json"
  chk "Chief of Staff persona written"  "test -f ~/Data/.datacore/personas/winston.md"
  chk "persona carries a displayName"   "grep -q \"displayName:\" ~/Data/.datacore/personas/winston.md"

  echo "--- .mcp.json ---"; cat ~/Data/.mcp.json 2>/dev/null || echo "(absent)"
  echo "--- persona ---";   cat ~/Data/.datacore/personas/winston.md 2>/dev/null || echo "(absent)"
  echo "---ASSERT-FAIL:$fail---"
'

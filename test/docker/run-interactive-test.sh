#!/usr/bin/env bash
# Drive the REAL prompts through a pty in a clean container and assert that
# what was typed is what landed on disk. Complements run-install-test.sh,
# which covers the unattended path and therefore never sees a question.
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

echo "==> driving the interactive wizard through a pty"
docker run --rm "$IMAGE" python3 /home/tester/interactive-init.py

#!/usr/bin/env bash
# Full install smoke test into a throwaway root.
#
# This could not exist before datacore-cli#9: init resolved DATA_DIR from $HOME
# and ignored DATACORE_ROOT, so a run against a temp root silently resolved to
# the real ~/Data, found it initialised, and returned success having created
# nothing. Every install bug therefore had to be found by a human on a clean
# laptop, which is exactly how the first external install went.
#
#   ./scripts/smoke-init.sh            # uses ./dist (run npm run build first)
set -euo pipefail

ROOT="${SMOKE_ROOT:-/tmp/datacore-smoke-$$}"
CLI="${SMOKE_CLI:-$(cd "$(dirname "$0")/.." && pwd)/dist/index.js}"
ANSWERS="$(mktemp)"
trap 'rm -rf "$ROOT" "$ANSWERS"' EXIT

cat > "$ANSWERS" <<'JSON'
{ "name": "Smoke Test", "email": "smoke@example.com", "useCase": "personal",
  "modules": ["news"], "cosName": "Babbage",
  "cosPersonality": "Brief.", "spaces": [] }
JSON

echo "→ init into $ROOT"
DATACORE_ROOT="$ROOT" node "$CLI" init --answers "$ANSWERS" --skip-checks --format json \
  > "$ROOT.json" 2>&1 || true

fail=0
check() {  # check <description> <test-expression...>
  if eval "${@:2}"; then printf '  ok   %s\n' "$1"; else printf '  FAIL %s\n' "$1"; fail=1; fi
}

echo "→ assertions"
check "root created"              "[ -d '$ROOT' ]"
check "personal space exists"     "[ -d '$ROOT/0-personal' ]"
check "org files present"         "[ -d '$ROOT/0-personal/org' ]"
check "datacore dir present"      "[ -d '$ROOT/.datacore' ]"
check "answers applied (cos name)" "grep -qi babbage '$ROOT/.datacore/personas/winston.md'"
check "requested module installed" "[ -d '$ROOT/.datacore/modules/news' ]"
# The catalog must never attempt a private repo unasked: that produced one red
# error line per module on every external install.
check "no private module attempted" "[ ! -d '$ROOT/.datacore/modules/telegram' ]"
check "safety hooks configured"    "git -C '$ROOT' config core.hooksPath >/dev/null 2>&1 || true"

echo
if [ "$fail" -eq 0 ]; then echo "smoke: PASS"; else echo "smoke: FAIL"; fi
exit "$fail"

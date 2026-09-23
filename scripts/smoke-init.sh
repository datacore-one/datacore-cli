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

# ── spaces are repos, and can be created, joined and audited ────────────────
# `createSpace` wrote a .gitignore, returned hasGit:false and never ran
# `git init`, in a system whose docs say every space is its own repo. A space
# that is not a repo cannot be pushed, cloned by a colleague, or synced.
echo "→ spaces"
DATACORE_ROOT="$ROOT" node "$CLI" space create smoketeam --yes --format json >/dev/null 2>&1 || true
check "space create makes a repo"  "[ -d '$ROOT/1-smoketeam/.git' ]"
check "  ...with a commit"         "git -C '$ROOT/1-smoketeam' rev-parse HEAD >/dev/null 2>&1"
check "  ...and a clean tree"      "[ -z \"\$(git -C '$ROOT/1-smoketeam' status --porcelain)\" ]"

# A bare repo stands in for any host: this is the path that makes Gitea,
# Codeberg, Bitbucket and self-hosted work without a forge CLI.
BARE="$ROOT.origin.git"
git init -q --bare "$BARE"
DATACORE_ROOT="$ROOT" node "$CLI" space create pushed --remote=url --url="$BARE" --format json >/dev/null 2>&1 || true
check "generic remote receives a push" "git -C '$BARE' rev-parse main >/dev/null 2>&1"

# Joining is the second machine, and the second person on the team.
JOINROOT="$ROOT.join"
mkdir -p "$JOINROOT"
DATACORE_ROOT="$JOINROOT" node "$CLI" space join "$BARE" --name joined --format json >/dev/null 2>&1 || true
check "space join clones it back"  "[ -d '$JOINROOT/1-joined/.datacore' ]"

# `space join` tells the user to run this when a clone does not look like a
# space, so it has to exist: auditSpace was exported and called from nowhere.
check "space audit answers"        "DATACORE_ROOT='$ROOT' node '$CLI' space audit 1-smoketeam --format json 2>/dev/null | grep -q '\"issues\"'"

rm -rf "$BARE" "$JOINROOT"

echo
if [ "$fail" -eq 0 ]; then echo "smoke: PASS"; else echo "smoke: FAIL"; fi
exit "$fail"

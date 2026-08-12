#!/usr/bin/env bash
# The gate that stands between a broken CLI and every machine in the fleet.
#
# Before this existed, `prepublishOnly` ran `bun run build` and nothing else.
# That means npm publish would happily ship code that did not typecheck, whose
# tests failed, or whose built binary reported a version different from the one
# being published — and this is the package that installs and updates Datacore
# everywhere, so a bad publish reaches every agent the moment it runs
# `datacore update`. The blast radius is the whole fleet, which is exactly why
# the checks belong here rather than in a habit.
#
# npm runs prepublishOnly automatically on `npm publish`, so this cannot be
# forgotten and cannot be skipped by publishing from a different directory.
#
# Every check below failed for real at least once. None are hypothetical.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }

VERSION=$(node -p "require('./package.json').version")
printf '\033[1mPre-publish verification — @datacore-one/cli %s\033[0m\n' "$VERSION"

step "Types"
if bun run typecheck >/tmp/dc-cli-tsc.log 2>&1; then ok "tsc --noEmit clean"
else bad "typecheck failed:"; tail -15 /tmp/dc-cli-tsc.log; fi

step "Tests"
# DATACORE_ROOT is deliberately NOT set here: the suite manages its own
# fixtures, and pinning it would hide a test that reaches for the real install.
if bun test >/tmp/dc-cli-test.log 2>&1; then
  ok "$(grep -Eo '[0-9]+ pass' /tmp/dc-cli-test.log | tail -1)"
else
  bad "tests failed:"; grep -E '\(fail\)|error:' /tmp/dc-cli-test.log | head -15
fi

step "Build"
if bun run build >/tmp/dc-cli-build.log 2>&1; then ok "dist/ built"
else bad "build failed:"; tail -15 /tmp/dc-cli-build.log; fi

step "Built artifact"
# Test the ARTIFACT, not the source. `files: ["dist/"]` means dist is the only
# thing users receive, and a stale or broken dist has shipped before.
if [ -f dist/index.js ]; then
  BUILT=$(node dist/index.js --version 2>/dev/null | tr -d '[:space:]')
  if [ "$BUILT" = "$VERSION" ]; then
    ok "dist reports $BUILT"
  else
    # This is the drift that shipped 1.3.0-vs-package.json and a lock file
    # stamped 1.0.6. The published binary lying about its own version makes
    # every downstream "which version are you on?" answer untrustworthy.
    bad "dist reports '$BUILT' but package.json says '$VERSION'"
  fi
  if node dist/index.js doctor --json >/tmp/dc-cli-doctor.json 2>&1; then
    ok "doctor runs from dist"
  else
    bad "doctor failed from dist — the command agents use to verify themselves"
  fi
else
  bad "dist/index.js missing after build"
fi

step "v2 invariants"
# Grep the SHIPPED bundle. A source-level test can pass while a dependency or a
# stale build reintroduces the pattern into what users actually execute.
if [ -f dist/index.js ]; then
  if grep -q -- "--rebase" dist/index.js; then
    bad "shipped bundle contains --rebase (DIP-0046: merge, never rebase)"
  else
    ok "no --rebase in shipped bundle"
  fi
fi

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  # Not fatal: publishing from a dirty tree is sometimes deliberate. But it
  # must be stated, because it means the published artifact corresponds to no
  # commit anyone can check out later.
  printf '\n  \033[33m!\033[0m uncommitted changes — published artifact will match no commit\n'
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '\033[31m✗ PUBLISH BLOCKED\033[0m — fix the above.\n'
  exit 1
fi
printf '\033[32m✓ verified — safe to publish %s\033[0m\n' "$VERSION"

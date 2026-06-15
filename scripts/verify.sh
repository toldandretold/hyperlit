#!/usr/bin/env bash
#
# Local verification pass for front-end (JS/TS) changes.
# Run this yourself — no assistant / API required:
#
#     npm run verify
#
# What it checks (and what each proves):
#   1. viz:idb   — regenerate the data-flow viz AND run the no-cycle gate (un-scoped):
#                  asserts ZERO static-import cycles. Writes visualisation/generated/* —
#                  commit those if they change. FAILS (and names the ring) if a cycle exists.
#   2. tsc       — full TypeScript type-check (strict).
#   3. vitest    — the whole JS unit suite (incl. the byte-check that the viz artifacts are fresh).
#   4. test:tdz  — production rollup build + load every entry chunk under a DOM shim, failing on
#                  any module-init "Cannot access X before initialization" (the prod-TDZ guard;
#                  the only check that sees a circular-import TDZ in the actual bundle).
#
# Exits non-zero if ANY step fails, and prints a summary. Note: step 4 (build) is the slow one.
#
# Still NOT covered by this script (needs eyeballs): a quick browser smoke of the reader page
# (open a highlight + a hypercite container) — the render hot-path has no headless coverage.

set -uo pipefail
cd "$(dirname "$0")/.."

declare -a NAMES=() RESULTS=()
overall=0

run() {
  local name="$1"; shift
  printf '\n\033[1;36m━━━ %s ━━━\033[0m\n' "$name"
  if "$@"; then
    NAMES+=("$name"); RESULTS+=("ok")
  else
    NAMES+=("$name"); RESULTS+=("FAIL")
    overall=1
  fi
}

run "1. viz + no-cycle gate (npm run viz:idb)" npm run viz:idb
run "2. typecheck (tsc --noEmit)"              npx tsc --noEmit
run "3. unit tests (vitest run)"               npx vitest run
run "4. bundle TDZ probe (npm run test:tdz)"   npm run test:tdz

printf '\n\033[1m══════════ verify summary ══════════\033[0m\n'
for i in "${!NAMES[@]}"; do
  if [ "${RESULTS[$i]}" = "ok" ]; then
    printf '  \033[32m✓\033[0m %s\n' "${NAMES[$i]}"
  else
    printf '  \033[31m✗ %s\033[0m\n' "${NAMES[$i]}"
  fi
done

if [ "$overall" -eq 0 ]; then
  printf '\n\033[1;32mALL CHECKS PASSED.\033[0m (Remember the manual browser smoke before deploy.)\n'
else
  printf '\n\033[1;31mVERIFICATION FAILED — see the failing section(s) above.\033[0m\n'
fi
exit "$overall"

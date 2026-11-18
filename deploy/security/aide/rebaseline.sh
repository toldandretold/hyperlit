#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rebaseline.sh — accept the CURRENT state of the disk as AIDE's new baseline.
#
#   sudo ./deploy/security/aide/rebaseline.sh            # after a deploy / apt upgrade
#   sudo ./deploy/security/aide/rebaseline.sh --report   # show what changed, THEN accept
#
# deploy.sh calls this as its final step (via sudo -n, so give marx a NOPASSWD
# line for exactly this script — see deploy/security/README.md). A deploy
# rewrites vendor/, public/build, config caches… all legitimately; without a
# re-baseline the next daily check is a wall of noise and the one real change
# hides inside it.
#
# `--report` is the honest mode: it prints AIDE's diff against the OLD baseline
# before accepting, so you SEE what the deploy changed. Use it when you want
# the check, skip it when you just deployed and know what moved.
#
# Debian/Ubuntu layout: config /etc/aide/aide.conf (+ aide.conf.d/*), database
# /var/lib/aide/aide.db, candidate /var/lib/aide/aide.db.new. `aide.wrapper`
# assembles the conf.d fragments; call it, not /usr/bin/aide, or the fragments
# are ignored and the app rules do nothing.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v aide.wrapper >/dev/null 2>&1 || { echo "aide not installed: apt install aide aide-common" >&2; exit 1; }

DB=/var/lib/aide/aide.db
NEW=/var/lib/aide/aide.db.new
REPORT=0
[ "${1:-}" = "--report" ] && REPORT=1

# Keep the daily check from fighting us for the database.
if pgrep -x aide >/dev/null 2>&1; then
    echo "an aide run is already in progress — try again in a few minutes" >&2; exit 2
fi

# Lower our own footprint: the hash walk is IO-bound and the box has workers.
renice -n 10 $$ >/dev/null 2>&1 || true
ionice -c 2 -n 7 -p $$ >/dev/null 2>&1 || true

if [ "${REPORT}" = 1 ] && [ -f "${DB}" ]; then
    echo "── changes since the last baseline ──────────────────────────────────"
    # --update checks AND writes the candidate db in one walk. Exit codes 1–7 are
    # "differences found" (bitmask: 1 added, 2 removed, 4 changed), not failure.
    aide.wrapper --update || rc=$?
    rc="${rc:-0}"
    if [ "${rc}" -gt 7 ]; then echo "aide --update failed (exit ${rc})" >&2; exit "${rc}"; fi
else
    aide.wrapper --init >/dev/null || rc=$?
    rc="${rc:-0}"
    if [ "${rc}" -gt 7 ]; then echo "aide --init failed (exit ${rc})" >&2; exit "${rc}"; fi
fi

[ -f "${NEW}" ] || { echo "no candidate database at ${NEW} — nothing accepted" >&2; exit 3; }
[ -f "${DB}" ] && cp -p "${DB}" "${DB}.prev"
mv -f "${NEW}" "${DB}"
chmod 0600 "${DB}"
echo "aide baseline accepted → ${DB} ($(stat -c %y "${DB}" | cut -d. -f1)); previous kept at ${DB}.prev"

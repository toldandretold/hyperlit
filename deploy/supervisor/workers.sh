#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# workers.sh — one memorable command for the Hyperlit prod queue workers.
#
# There are FIVE Supervisor programs, one per queue, and remembering their names
# + the right supervisorctl/artisan incantations is the chore this wraps:
#
#   hyperlit-worker      → queue `default`           (imports/reconverts + light jobs)
#   hyperlit-citation    → queue `citation-pipeline` (CitationPipelineJob etc, up to 2 h)
#   hyperlit-vibe        → queue `vibe`              (VibeConversionJob, up to ~30 min)
#   hyperlit-embeddings  → queue `embeddings`        (GenerateNodeEmbedding, high volume)
#   hyperlit-search      → queue `search-supplement` (citation-modal external ingest, seconds)
#
# Run it ON the droplet after `cd /var/www/hyperlit`, or from your laptop via the
# `hw` alias (see deploy/supervisor/README.md → "Daily ops").
#
# Usage:
#   ./deploy/supervisor/workers.sh status              # are all 5 RUNNING?
#   ./deploy/supervisor/workers.sh restart             # graceful: finish job, reload code
#   ./deploy/supervisor/workers.sh restart citation    # one program only
#   ./deploy/supervisor/workers.sh force-restart       # hard SIGTERM (can WAIT on in-flight)
#   ./deploy/supervisor/workers.sh logs citation -f    # tail a worker's log (-f to follow)
#   ./deploy/supervisor/workers.sh health              # queue:probe + citation:doctor --fast
#   ./deploy/supervisor/workers.sh backlog             # what's queued / reserved / failed
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve repo root from this script's location (deploy/supervisor/workers.sh → ../../).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
cd "${REPO_ROOT}"

# Short name → Supervisor program / log file. One place to add a worker.
SHORT_NAMES="worker citation vibe embeddings search"
program_for() {
    case "$1" in
        worker|default|import|imports) echo "hyperlit-worker" ;;
        citation|citations|cite)       echo "hyperlit-citation" ;;
        vibe)                          echo "hyperlit-vibe" ;;
        embeddings|embed|embeds)       echo "hyperlit-embeddings" ;;
        search|supplement)             echo "hyperlit-search" ;;
        *) return 1 ;;
    esac
}
logfile_for() {
    case "$(program_for "$1")" in
        hyperlit-worker)     echo "storage/logs/worker.log" ;;
        hyperlit-citation)   echo "storage/logs/citation-worker.log" ;;
        hyperlit-vibe)       echo "storage/logs/vibe-worker.log" ;;
        hyperlit-embeddings) echo "storage/logs/embeddings-worker.log" ;;
        hyperlit-search)     echo "storage/logs/search-worker.log" ;;
    esac
}

need_supervisorctl() {
    if ! command -v supervisorctl >/dev/null 2>&1; then
        cat >&2 <<'EOF'
✗ supervisorctl not found.

This command manages the PRODUCTION queue workers and must run on the droplet.
  • On the droplet:   ssh marx@170.64.145.89 → cd /var/www/hyperlit → ./deploy/supervisor/workers.sh ...
  • From your laptop: use the `hw` alias (see deploy/supervisor/README.md → "Daily ops").
EOF
        exit 1
    fi
}

# Supervisor's control socket is root-owned on the droplet, so status/restart
# fail with "Permission denied" as the `marx` user — that's why the install
# steps use `sudo supervisorctl`. Auto-detect: try plain, fall back to sudo.
# Result is cached in $SUPERVISORCTL (used UNQUOTED so it word-splits into
# `sudo supervisorctl`).
SUPERVISORCTL=""
resolve_supervisorctl() {
    need_supervisorctl
    if supervisorctl pid >/dev/null 2>&1; then
        SUPERVISORCTL="supervisorctl"
    else
        SUPERVISORCTL="sudo supervisorctl"
    fi
}

usage() {
    cat <<EOF
workers.sh — manage the Hyperlit prod queue workers (run on the droplet, or via the 'hw' alias)

  status              are all 5 workers RUNNING?
  restart             graceful reload (finish current job, pick up new code) — safe after deploy
  restart <name>      hard-restart ONE program (e.g. restart citation)
  force-restart       hard SIGTERM all (can wait on an in-flight job — prefer 'restart')
  logs <name> [-f]    tail a worker's log (-f to follow)
  health              queue:probe + citation:doctor --fast
  backlog             queued/reserved jobs per queue + failed count

  Worker short-names: ${SHORT_NAMES}
EOF
}

cmd="${1:-}"
[ $# -gt 0 ] && shift || true

case "${cmd}" in
    status|st)
        resolve_supervisorctl
        # supervisorctl groups appear as `hyperlit-worker:hyperlit-worker_00` etc.
        ${SUPERVISORCTL} status 'hyperlit-worker:*' 'hyperlit-citation:*' \
                                'hyperlit-vibe:*' 'hyperlit-embeddings:*' 'hyperlit-search:*'
        ;;

    restart)
        if [ $# -gt 0 ]; then
            resolve_supervisorctl
            prog="$(program_for "$1")" || { echo "✗ unknown worker '$1' (try: ${SHORT_NAMES})" >&2; exit 1; }
            echo "→ ${SUPERVISORCTL} restart ${prog}:* (hard restart of one program)"
            ${SUPERVISORCTL} restart "${prog}:*"
        else
            # Graceful, all workers: they finish the current job, exit, supervisor
            # autorestarts them on fresh code. The safe post-deploy default.
            echo "→ php artisan queue:restart (graceful — workers reload code after current job)"
            php artisan queue:restart
            echo "✓ signalled. 'workers.sh status' to confirm they came back up."
        fi
        ;;

    force-restart)
        resolve_supervisorctl
        echo "⚠ Hard restart (SIGTERM). If a citation/vibe job is mid-run, Supervisor WAITS"
        echo "  up to stopwaitsecs (≈2 h for citation) before the process actually cycles."
        echo "  Prefer 'restart' (graceful) on deploys. Continue? [y/N]"
        read -r ans
        case "${ans}" in
            y|Y|yes) ${SUPERVISORCTL} restart 'hyperlit-worker:*' 'hyperlit-citation:*' \
                                              'hyperlit-vibe:*' 'hyperlit-embeddings:*' 'hyperlit-search:*' ;;
            *) echo "aborted." ;;
        esac
        ;;

    logs|log)
        [ $# -gt 0 ] || { echo "✗ which worker? e.g. 'logs citation [-f]' (${SHORT_NAMES})" >&2; exit 1; }
        lf="$(logfile_for "$1")" || true
        [ -n "${lf:-}" ] || { echo "✗ unknown worker '$1' (try: ${SHORT_NAMES})" >&2; exit 1; }
        shift
        [ -f "${lf}" ] || { echo "✗ no log yet at ${lf}" >&2; exit 1; }
        if [ "${1:-}" = "-f" ]; then exec tail -f "${lf}"; else exec tail -n 100 "${lf}"; fi
        ;;

    health|doctor|check)
        echo "=== queue:probe (topology — nothing blocks anything else) ==="
        php artisan queue:probe --use-running || echo "(probe reported issues — see above)"
        echo
        echo "=== citation:doctor --fast (external deps for citation review) ==="
        php artisan citation:doctor --fast || echo "(doctor reported issues — see above)"
        ;;

    backlog|jobs)
        # What's queued/reserved per queue + how many have died. Read-only.
        php artisan tinker --execute='
            $rows = DB::table("jobs")->selectRaw("queue, count(*) as n, min(reserved_at) as oldest_reserved")
                      ->groupBy("queue")->get();
            echo "QUEUED/RESERVED jobs by queue:\n";
            if ($rows->isEmpty()) { echo "  (none — all queues idle)\n"; }
            foreach ($rows as $r) {
                $res = $r->oldest_reserved ? date("H:i:s", (int) $r->oldest_reserved) : "—";
                echo sprintf("  %-18s %4d   oldest reserved: %s\n", $r->queue, $r->n, $res);
            }
            echo "FAILED jobs: " . DB::table("failed_jobs")->count() . "  (php artisan queue:failed to list)\n";
        '
        ;;

    ""|help|-h|--help)
        usage
        ;;

    *)
        echo "✗ unknown command: ${cmd}" >&2
        echo
        usage
        exit 1
        ;;
esac

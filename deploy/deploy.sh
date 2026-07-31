#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — THE deploy command. Run this on the droplet, that's the whole job.
#
#   ssh marx@170.64.145.89
#   cd /var/www/hyperlit && ./deploy/deploy.sh
#
# …or from your laptop in one shot:  hd     (alias — see deploy/README.md)
#
# It pulls, works out what actually changed, and only does the steps that
# change requires: composer, npm build, migrations, framework caches, worker
# restart. Then it checks everything came back up and tells you what to look at.
#
#   ./deploy/deploy.sh                 # normal deploy
#   ./deploy/deploy.sh --yes           # no prompts (migrations run unattended)
#   ./deploy/deploy.sh --dry-run       # print the plan, touch nothing
#   ./deploy/deploy.sh --maintenance   # artisan down/up around it (breaking migrations)
#   ./deploy/deploy.sh --all           # force every step even if nothing changed
#   ./deploy/deploy.sh --skip-build    # don't rebuild front-end assets
#   ./deploy/deploy.sh --skip-migrate  # don't run migrations
# ─────────────────────────────────────────────────────────────────────────────
# -E so the ERR trap fires from inside run()/artisan() too, not just top level.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${REPO_ROOT}"

ASSUME_YES=0 DRY_RUN=0 MAINTENANCE=0 FORCE_ALL=0 SKIP_BUILD=0 SKIP_MIGRATE=0
for arg in "$@"; do
    case "${arg}" in
        -y|--yes)        ASSUME_YES=1 ;;
        -n|--dry-run)    DRY_RUN=1 ;;
        --maintenance)   MAINTENANCE=1 ;;
        --all|--force)   FORCE_ALL=1 ;;
        --skip-build)    SKIP_BUILD=1 ;;
        --skip-migrate)  SKIP_MIGRATE=1 ;;
        -h|--help)       sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "✗ unknown flag: ${arg} (try --help)" >&2; exit 1 ;;
    esac
done

# ── output helpers ───────────────────────────────────────────────────────────
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; OFF=""; }
STEP_N=0
CURRENT_STEP="startup"
step()  { STEP_N=$((STEP_N + 1)); CURRENT_STEP="$*"; echo; echo "${BOLD}[${STEP_N}] $*${OFF}"; }
ok()    { echo "  ${GRN}✓${OFF} $*"; }
skip()  { echo "  ${DIM}· skipped — $*${OFF}"; }
warn()  { echo "  ${YEL}⚠ $*${OFF}"; WARNINGS+=("$*"); }
die()   { echo "  ${RED}✗ $*${OFF}" >&2; exit 1; }
run()   { if [ "${DRY_RUN}" = 1 ]; then echo "  ${DIM}would run: $*${OFF}"; else echo "  ${DIM}\$ $*${OFF}"; "$@"; fi; }
# Same as run(), but a non-zero exit is a warning, not the end of the deploy.
run_soft() { if [ "${DRY_RUN}" = 1 ]; then echo "  ${DIM}would run: $*${OFF}"; return 0; fi
             echo "  ${DIM}\$ $*${OFF}"; "$@" || { warn "'$*' failed — continuing"; return 0; }; }
WARNINGS=()

# What got as far as happening, so a mid-deploy failure can tell you the truth
# about prod instead of leaving you to guess.
DID_COMPOSER=no DID_BUILD=no DID_MIGRATE=no DID_CACHES=no DID_WORKERS=no

on_err() {
    local code=$?
    echo
    echo "${RED}${BOLD}✗ DEPLOY FAILED${OFF} during: ${BOLD}${CURRENT_STEP}${OFF} (exit ${code})"
    echo
    echo "  Prod state right now:"
    echo "    code pulled ......... $([ "${BEFORE:-}" = "${AFTER:-}" ] && echo 'no new commits' || echo "${BEFORE:0:8} → ${AFTER:0:8}")"
    echo "    composer ............ ${DID_COMPOSER}"
    echo "    assets built ........ ${DID_BUILD}"
    echo "    migrations run ...... ${DID_MIGRATE}"
    echo "    caches rebuilt ...... ${DID_CACHES}"
    echo "    workers restarted ... ${DID_WORKERS}"
    echo
    if [ "${DID_WORKERS}" = "no" ]; then
        echo "  ${YEL}Workers are still running PRE-DEPLOY code.${OFF} Once you've fixed the above:"
        echo "    ./deploy/supervisor/workers.sh restart"
    fi
    echo "  Then re-run: ./deploy/deploy.sh --all"
    exit "${code}"
}
trap on_err ERR

confirm() { # confirm "question" → 0 = yes
    [ "${ASSUME_YES}" = 1 ] && return 0
    [ "${DRY_RUN}" = 1 ] && return 0
    printf "  %s [y/N] " "$1"
    read -r reply
    case "${reply}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Artisan must write bootstrap/cache + storage as the web user, or php-fpm ends
# up with cache files it can't rewrite. Pick the runner ONCE, up front.
WEB_USER="${HYPERLIT_WEB_USER:-www-data}"
ARTISAN=(php artisan)
resolve_artisan() {
    local owner me
    me="$(id -un)"
    owner="$(stat -c '%U' bootstrap/cache 2>/dev/null || stat -f '%Su' bootstrap/cache 2>/dev/null || echo "${me}")"
    [ -n "${owner}" ] && WEB_USER="${owner}"
    if [ "${owner}" = "${me}" ]; then
        ARTISAN=(php artisan)
    elif command -v sudo >/dev/null 2>&1; then
        ARTISAN=(sudo -u "${owner}" php artisan)
    else
        ARTISAN=(php artisan)
        warn "bootstrap/cache is owned by '${owner}' but running artisan as '${me}' (no sudo) — cache files may end up unwritable by php-fpm"
    fi
}
artisan() { run "${ARTISAN[@]}" "$@"; }

START_TS=$(date +%s)
echo "${BOLD}Hyperlit deploy${OFF} — $(pwd) @ $(hostname)"
[ "${DRY_RUN}" = 1 ] && echo "${YEL}DRY RUN — nothing will be changed${OFF}"

# ── 1. preflight ─────────────────────────────────────────────────────────────
step "Preflight"
command -v git   >/dev/null 2>&1 || die "git not found"
command -v php   >/dev/null 2>&1 || die "php not found"
[ -f artisan ] || die "no artisan here — are you in /var/www/hyperlit?"
resolve_artisan
ok "artisan runs as ${WEB_USER}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "  ${DIM}$(git status --short --untracked-files=no | head -10)${OFF}"
    warn "working tree has local modifications — 'git pull --ff-only' will refuse if they conflict"
fi

BEFORE="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ok "on ${BRANCH} at ${BEFORE:0:8}"

# ── 2. pull ──────────────────────────────────────────────────────────────────
step "Pull"
run git fetch --quiet origin "${BRANCH}"
INCOMING="$(git log --oneline "HEAD..origin/${BRANCH}" 2>/dev/null || true)"
if [ -z "${INCOMING}" ]; then
    skip "already at origin/${BRANCH}"
else
    echo "  ${DIM}incoming:${OFF}"
    echo "${INCOMING}" | sed 's/^/    /'
fi
run git pull --ff-only origin "${BRANCH}"
AFTER="$(git rev-parse HEAD)"

# ── 3. work out what changed ─────────────────────────────────────────────────
step "What changed"
if [ "${BEFORE}" = "${AFTER}" ] && [ "${FORCE_ALL}" != 1 ]; then
    CHANGED=""
    echo "  ${DIM}no new commits — only caches + workers will be cycled (--all to force every step)${OFF}"
else
    CHANGED="$(git diff --name-only "${BEFORE}" "${AFTER}" 2>/dev/null || true)"
fi
changed_any() { [ "${FORCE_ALL}" = 1 ] && return 0; echo "${CHANGED}" | grep -qE "$1"; }

DO_COMPOSER=0; DO_BUILD=0; DO_MIGRATE=0; DO_SUPERVISOR=0
changed_any '^composer\.(json|lock)$'                                   && DO_COMPOSER=1
changed_any '^(resources/|public/sw\.js|vite\.config\.js|package(-lock)?\.json|scripts/)' && DO_BUILD=1
changed_any '^database/migrations/'                                     && DO_MIGRATE=1
changed_any '^deploy/supervisor/.*\.conf$'                              && DO_SUPERVISOR=1

# A front-end change without a service-worker version bump = browsers keep the
# old cached HTML/chunks (docs/deploy.md). Cheap to check, expensive to miss.
if [ "${DO_BUILD}" = 1 ] && [ "${BEFORE}" != "${AFTER}" ]; then
    if ! echo "${CHANGED}" | grep -q '^public/sw\.js$'; then
        warn "front-end changed but public/sw.js CACHE_VERSION was not bumped this deploy (stale-cache risk — docs/deploy.md)"
    fi
fi

[ "${SKIP_BUILD}"   = 1 ] && DO_BUILD=0
[ "${SKIP_MIGRATE}" = 1 ] && DO_MIGRATE=0

# Migrations may also be pending from an earlier half-finished deploy.
PENDING=""
if [ "${SKIP_MIGRATE}" != 1 ]; then
    PENDING="$("${ARTISAN[@]}" migrate:status 2>/dev/null | grep -i 'pending' || true)"
    [ -n "${PENDING}" ] && DO_MIGRATE=1
fi

echo "  composer install ....... $([ "${DO_COMPOSER}"   = 1 ] && echo yes || echo no)"
echo "  npm build .............. $([ "${DO_BUILD}"      = 1 ] && echo yes || echo no)"
echo "  migrations ............. $([ "${DO_MIGRATE}"    = 1 ] && echo yes || echo no)"
echo "  supervisor confs ....... $([ "${DO_SUPERVISOR}" = 1 ] && echo 'CHANGED — see step 8' || echo no)"

# ── 4. maintenance mode (opt-in) ─────────────────────────────────────────────
LOWERED=0
if [ "${MAINTENANCE}" = 1 ]; then
    step "Maintenance mode ON"
    artisan down --render=errors::503
    LOWERED=1
    # shellcheck disable=SC2317
    trap 'if [ "${LOWERED}" = 1 ]; then echo; echo "${YEL}bringing site back up…${OFF}"; "${ARTISAN[@]}" up || true; fi' EXIT
fi

# ── 5. PHP deps ──────────────────────────────────────────────────────────────
step "PHP dependencies"
if [ "${DO_COMPOSER}" = 1 ]; then
    command -v composer >/dev/null 2>&1 || die "composer not found but composer.lock changed"
    run composer install --no-dev --optimize-autoloader --no-interaction
    DID_COMPOSER=yes
    ok "composer up to date"
else
    skip "composer.lock unchanged"
fi

# ── 6. front-end assets ──────────────────────────────────────────────────────
step "Front-end assets"
if [ "${DO_BUILD}" = 1 ]; then
    command -v npm >/dev/null 2>&1 || die "npm not found but front-end changed"
    if echo "${CHANGED}" | grep -q '^package-lock\.json$' || [ "${FORCE_ALL}" = 1 ]; then
        run npm ci
    fi
    # NEVER rm -rf public/build first: old hashed chunks are retained on purpose
    # so tabs open across the deploy keep resolving (docs/deploy.md). The build
    # script prunes anything untouched for 7 days by itself.
    run npm run build
    DID_BUILD=yes
    ok "assets built (old chunks retained for live tabs)"
else
    skip "no front-end changes"
fi

# ── 7. migrations + caches ───────────────────────────────────────────────────
step "Database migrations"
if [ "${DO_MIGRATE}" = 1 ]; then
    echo "  ${DIM}pending:${OFF}"
    "${ARTISAN[@]}" migrate:status 2>/dev/null | grep -i 'pending' | sed 's/^/    /' || echo "    (migrate:status unavailable)"
    if confirm "Run these migrations against PRODUCTION?"; then
        artisan migrate --force
        DID_MIGRATE=yes
        ok "migrated"
    else
        warn "migrations SKIPPED by you — the new code is live against the old schema"
    fi
else
    skip "no pending migrations"
fi

step "Framework caches"
# config + route caches are correctness-critical: without them prod runs on the
# pre-deploy config, so a failure here really should stop the deploy.
artisan config:cache
artisan route:cache
# view:cache is a perf optimisation — Laravel compiles blades on demand without
# it. It also compiles EVERY blade file, reachable or not, so one broken/dead
# template must not be allowed to abort a deploy before the worker restart.
run_soft "${ARTISAN[@]}" view:cache
DID_CACHES=yes
ok "config + route caches rebuilt"

# ── 8. supervisor confs (only when they changed) ─────────────────────────────
if [ "${DO_SUPERVISOR}" = 1 ]; then
    step "Supervisor confs changed"
    echo "  ${DIM}$(echo "${CHANGED}" | grep '^deploy/supervisor/.*\.conf$' | sed 's/^/    /')${OFF}"
    echo "  A new or renamed worker program needs its conf installed, or its queue"
    echo "  has NOBODY listening and those jobs silently never run."
    if confirm "Install confs + supervisorctl reread/update now (needs sudo)?"; then
        run sudo cp deploy/supervisor/hyperlit-*.conf /etc/supervisor/conf.d/
        run sudo supervisorctl reread
        run sudo supervisorctl update
        ok "confs installed"
    else
        warn "supervisor confs NOT installed — see deploy/supervisor/README.md"
    fi
fi

# ── 9. workers ───────────────────────────────────────────────────────────────
step "Queue workers"
# Graceful: each worker finishes its current job, exits, supervisor relaunches
# it on the new code. A worker that isn't cycled keeps running PRE-DEPLOY code.
# Same thing as `workers.sh restart`, but through the resolved artisan user so
# the restart cache file stays writable by php-fpm.
artisan queue:restart
DID_WORKERS=yes
ok "queue:restart signalled (workers reload after their current job)"

# ── 10. maintenance off ──────────────────────────────────────────────────────
if [ "${MAINTENANCE}" = 1 ]; then
    step "Maintenance mode OFF"
    artisan up
    LOWERED=0
    trap - EXIT
fi

# ── 11. verify ───────────────────────────────────────────────────────────────
step "Verify"
if [ "${DRY_RUN}" = 1 ]; then
    echo "  ${DIM}would run: workers.sh status / backlog + HTTP check${OFF}"
else
    # A worker that was just cycled sits in STARTING for a second or two — that's
    # health, not a fault. Poll until everything settles, and only judge the
    # states that actually mean something is wrong.
    WORKER_STATUS=""
    for attempt in 1 2 3 4 5 6; do
        WORKER_STATUS="$(./deploy/supervisor/workers.sh status 2>&1 || true)"
        SETTLING="$(echo "${WORKER_STATUS}" | grep -c 'STARTING' || true)"
        [ "${SETTLING}" -eq 0 ] && break
        sleep 3
    done
    echo "${WORKER_STATUS}" | sed 's/^/    /'

    if echo "${WORKER_STATUS}" | grep -qE 'RUNNING|STARTING'; then
        BROKEN="$(echo "${WORKER_STATUS}" | grep -E 'FATAL|BACKOFF|EXITED|STOPPED|UNKNOWN' || true)"
        RUNNING_N="$(echo "${WORKER_STATUS}" | grep -c 'RUNNING' || true)"
        if [ -n "${BROKEN}" ]; then
            warn "worker(s) not healthy: $(echo "${BROKEN}" | awk '{print $1}' | tr '\n' ' ')— ./deploy/supervisor/workers.sh logs <name>"
        elif [ "${RUNNING_N}" -lt 6 ]; then
            warn "only ${RUNNING_N}/6 workers RUNNING (rest still settling?) — re-check: ./deploy/supervisor/workers.sh status"
        else
            ok "all 6 workers RUNNING on the new code"
        fi
    else
        warn "could not read worker status (supervisorctl?) — check manually"
    fi

    echo "  ${DIM}backlog:${OFF}"
    ./deploy/supervisor/workers.sh backlog 2>&1 | sed 's/^/    /' || warn "backlog check failed"

    URL="${HYPERLIT_URL:-https://hyperlit.io}"
    if command -v curl >/dev/null 2>&1; then
        CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${URL}" || echo 000)"
        if [ "${CODE}" = "200" ]; then ok "${URL} → 200"; else warn "${URL} → HTTP ${CODE}"; fi
    fi
fi

# ── done ─────────────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
echo
if [ "${#WARNINGS[@]}" -eq 0 ]; then
    echo "${GRN}${BOLD}✓ Deployed${OFF}  ${BEFORE:0:8} → ${AFTER:0:8}  (${ELAPSED}s)"
else
    echo "${YEL}${BOLD}✓ Deployed with ${#WARNINGS[@]} warning(s)${OFF}  ${BEFORE:0:8} → ${AFTER:0:8}  (${ELAPSED}s)"
    for w in "${WARNINGS[@]}"; do echo "  ${YEL}⚠${OFF} ${w}"; done
fi
echo "${DIM}If anything looks off:  ./deploy/supervisor/workers.sh health  |  ... logs <worker> -f${OFF}"

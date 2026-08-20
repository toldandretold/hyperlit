#!/usr/bin/env bash
# pull_journal.sh — pull a whole journal's imported articles from prod to dev,
# so the citation-graph analysis (/maintainer/hypercites) can run locally.
#
#   tests/conversion/pull_journal.sh <journal-slug> [--limit N] [--skip-existing]
#
# Per promoted article (canonical_source.auto_version_book, the lane readers
# get): `book:export` ON PROD → scp the tarball → `book:import --force`
# locally. Each bundle carries the DB rows the analysis needs — nodes,
# bibliography, footnotes, the work's canonical_source row, and the
# journal_sources row (insert-if-absent) — so after a full pull the journal
# exists locally end-to-end: /j/{slug}, /maintainer/journal-import/{slug},
# and /maintainer/hypercites/{slug} all see it.
#
# The book list comes from prod via `artisan tinker --execute`, so NOTHING new
# has to be deployed for this script to work.
#
# NOTE: bundles travel with bibliographies AS THEY ARE on prod. If they were
# never matched to external databases (journal:harvest doesn't run
# citation:scan-bibliography), the hypercites detect run does it locally on
# first press — that step uses the LLM + OpenAlex etc., so local API keys
# apply. No fixture capture here: these are corpus pulls, not conversion cases.
#
# Config via env (or the .env.pull file shared with pull_case.sh):
#   HYPERLIT_PROD_SSH   e.g. deploy@hyperlit.io
#   HYPERLIT_PROD_APP   e.g. /var/www/hyperlit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$SCRIPT_DIR/.env.pull" ] && source "$SCRIPT_DIR/.env.pull"

SLUG="${1:?usage: pull_journal.sh <journal-slug> [--limit N] [--skip-existing]}"
shift

LIMIT=0
SKIP_EXISTING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --limit)         LIMIT="$2"; shift 2 ;;
    --skip-existing) SKIP_EXISTING=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

: "${HYPERLIT_PROD_SSH:?set HYPERLIT_PROD_SSH (e.g. deploy@hyperlit.io) in env or tests/conversion/.env.pull}"
: "${HYPERLIT_PROD_APP:?set HYPERLIT_PROD_APP (path to the app on prod) in env or tests/conversion/.env.pull}"

echo "── listing ${SLUG}'s promoted articles on prod…"
# One line per book id; blank output = journal unknown or nothing imported yet.
LIST_PHP="echo App\\Models\\CanonicalSource::where('journal_source_id', App\\Models\\JournalSource::where('slug', '$SLUG')->value('id'))->whereNotNull('auto_version_book')->orderByRaw('cited_by_count DESC NULLS LAST')->pluck('auto_version_book')->implode(PHP_EOL);"
BOOKS="$(ssh "$HYPERLIT_PROD_SSH" "cd '$HYPERLIT_PROD_APP' && php artisan tinker --execute=\"$LIST_PHP\"" | grep -E '^[A-Za-z0-9_-]+$' || true)"

if [ -z "$BOOKS" ]; then
  echo "no promoted articles found for '$SLUG' on prod (check the slug, or import some first)" >&2
  exit 1
fi

TOTAL=$(echo "$BOOKS" | wc -l | tr -d ' ')
[ "$LIMIT" -gt 0 ] && BOOKS="$(echo "$BOOKS" | head -n "$LIMIT")"
COUNT=$(echo "$BOOKS" | wc -l | tr -d ' ')
echo "── $TOTAL promoted articles; pulling $COUNT"

mkdir -p "$APP_ROOT/storage/app/book-exports"
OK=0; SKIPPED=0; FAILED=0; FAILED_BOOKS=""

i=0
for BOOK in $BOOKS; do
  i=$((i + 1))
  if [ "$SKIP_EXISTING" -eq 1 ] && (cd "$APP_ROOT" && php artisan tinker --execute="echo App\\Models\\PgLibrary::on('pgsql_admin')->where('book','$BOOK')->where('has_nodes',true)->exists() ? 'yes' : 'no';" | grep -q '^yes$'); then
    echo "── [$i/$COUNT] $BOOK already has content locally — skipped"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "── [$i/$COUNT] $BOOK: exporting on prod…"
  if ! ssh "$HYPERLIT_PROD_SSH" "cd '$HYPERLIT_PROD_APP' && php artisan book:export '$BOOK' --origin=pull-journal"; then
    echo "   export FAILED — continuing"; FAILED=$((FAILED + 1)); FAILED_BOOKS="$FAILED_BOOKS $BOOK"; continue
  fi
  TARBALL="storage/app/book-exports/$BOOK.tar.gz"
  if ! scp -q "$HYPERLIT_PROD_SSH:$HYPERLIT_PROD_APP/$TARBALL" "$APP_ROOT/$TARBALL"; then
    echo "   scp FAILED — continuing"; FAILED=$((FAILED + 1)); FAILED_BOOKS="$FAILED_BOOKS $BOOK"; continue
  fi
  if (cd "$APP_ROOT" && php artisan book:import "$TARBALL" --force); then
    OK=$((OK + 1))
  else
    echo "   import FAILED — continuing"; FAILED=$((FAILED + 1)); FAILED_BOOKS="$FAILED_BOOKS $BOOK"
  fi
done

echo
echo "── done: $OK imported, $SKIPPED skipped, $FAILED failed of $COUNT"
[ -n "$FAILED_BOOKS" ] && echo "   failed:$FAILED_BOOKS"
echo "── next: open /maintainer/hypercites/$SLUG and press ⌕ detect candidates"
echo "   (needs a worker: npm run queue:citation — first detect also resolves"
echo "    unmatched bibliographies via LLM + external lookups)"

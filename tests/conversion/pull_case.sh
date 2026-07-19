#!/usr/bin/env bash
# pull_case.sh — one-command prod→dev case pull for the bad-conversion loop.
#
#   tests/conversion/pull_case.sh <book> [--case-name X] [--corpus] [--with-logs]
#
# Does, in order:
#   1. `php artisan book:export <book>` ON PROD (over ssh) → scp the tarball down
#   2. `php artisan book:import <tar> --force` locally (DB rows + artifacts land;
#      the book opens in the local reader, cached OCR replays for free)
#   3. capture a conversion-regression fixture via add_fixture.py
#      (goldens are frozen with --update-golden only AFTER the conversion fix)
#   4. with --corpus: seed a vibe-eval corpus case with note.txt written from
#      the bundled conversion_flags (the user's complaint = the assessment brief)
#
# Config via env (or a .env.pull file next to this script):
#   HYPERLIT_PROD_SSH   e.g. deploy@hyperlit.io
#   HYPERLIT_PROD_APP   e.g. /var/www/hyperlit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$SCRIPT_DIR/.env.pull" ] && source "$SCRIPT_DIR/.env.pull"

BOOK="${1:?usage: pull_case.sh <book> [--case-name X] [--corpus] [--with-logs]}"
shift

CASE_NAME="$BOOK"
CORPUS=0
WITH_LOGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --case-name) CASE_NAME="$2"; shift 2 ;;
    --corpus)    CORPUS=1; shift ;;
    --with-logs) WITH_LOGS="--with-logs"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

: "${HYPERLIT_PROD_SSH:?set HYPERLIT_PROD_SSH (e.g. deploy@hyperlit.io) in env or tests/conversion/.env.pull}"
: "${HYPERLIT_PROD_APP:?set HYPERLIT_PROD_APP (path to the app on prod) in env or tests/conversion/.env.pull}"

TARBALL_REMOTE="$HYPERLIT_PROD_APP/storage/app/book-exports/$BOOK.tar.gz"
TARBALL_LOCAL="$APP_ROOT/storage/app/book-exports/$BOOK.tar.gz"

echo "── 1/4 exporting on prod…"
ssh "$HYPERLIT_PROD_SSH" "cd '$HYPERLIT_PROD_APP' && php artisan book:export '$BOOK' $WITH_LOGS"
mkdir -p "$APP_ROOT/storage/app/book-exports"
scp "$HYPERLIT_PROD_SSH:$TARBALL_REMOTE" "$TARBALL_LOCAL"

echo "── 2/4 importing locally…"
(cd "$APP_ROOT" && php artisan book:import "$TARBALL_LOCAL" --force)

ARTIFACTS="$APP_ROOT/resources/markdown/$BOOK"

echo "── 3/4 capturing regression fixture '$CASE_NAME'…"
if [ -e "$ARTIFACTS/ocr_response.json" ] || [ -e "$ARTIFACTS/debug_converted.html" ]; then
  python3 "$SCRIPT_DIR/add_fixture.py" \
    --name "$CASE_NAME" \
    --source "$ARTIFACTS" \
    --description "pulled prod case: $BOOK (see conversion_flags in bundle)" \
    --book-id "$BOOK" || echo "  (add_fixture failed — capture manually; artifacts are at $ARTIFACTS)"
else
  echo "  (no ocr_response.json/debug_converted.html in artifacts — for EPUB/MD cases"
  echo "   copy the input into a fixture manually, or use harvest_auto_versions.py --books $BOOK)"
fi

if [ "$CORPUS" -eq 1 ]; then
  echo "── 4/4 seeding vibe-eval corpus case…"
  CASE_DIR="$SCRIPT_DIR/corpus/$CASE_NAME"
  mkdir -p "$CASE_DIR"
  # Conversion input, in the shape the corpus expects.
  for f in original.pdf original.epub original.md original.html ocr_response.json; do
    [ -e "$ARTIFACTS/$f" ] && cp "$ARTIFACTS/$f" "$CASE_DIR/"
  done
  # The user complaint (from the bundled flags) becomes the assessment brief.
  (cd "$APP_ROOT" && php artisan tinker --execute='
    $flags = App\Models\ConversionFlag::where("book", "'"$BOOK"'")->get();
    $lines = ["Case pulled from prod: '"$BOOK"'", ""];
    foreach ($flags as $f) {
        $lines[] = "[{$f->source}] " . ($f->reason ?? "");
        foreach (($f->details["issueTypes"] ?? []) as $t) { $lines[] = "  - {$t}"; }
        foreach (($f->details["signals"] ?? []) as $s) { $lines[] = "  - signal: {$s}"; }
    }
    file_put_contents("'"$CASE_DIR"'/note.txt", implode("\n", $lines) . "\n");
    echo "note.txt written (" . count($flags) . " flag(s))\n";
  ')
else
  echo "── 4/4 (skipped — no --corpus)"
fi

cat <<EOF

Done. The case is local:
  reader:      open the book at /$BOOK in your dev reader
  regression:  python3 tests/conversion/run_regression.py --fixture $CASE_NAME   (expect RED)
  fix, then:   python3 tests/conversion/run_regression.py --update-golden --fixture $CASE_NAME
  reconvert:   php artisan library:reconvert-system-version $BOOK   (locally, to eyeball)
  resolve:     php artisan library:reconvert-queue --resolve=$BOOK --resolution=reconverted   (on prod)
EOF

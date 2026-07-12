#!/usr/bin/env python3
"""
Harvest the auto-versioned canonical PDF corpus into fixtures-local/.

The source harvester (see app/Services/SourceHarvest) mints new library *versions*
for open-access canonicals it finds by scanning a book's bibliography. Those rows are
stamped `canonical_match_method = 'auto_version_creation'`. The ones that came in as a
real PDF conversion (`conversion_method` starts `pdf_ocr`, and their
`resources/markdown/<book>/` still holds the cached `ocr_response.json`) are exactly
the "raw data from PDF conversion" we want as a growing regression corpus for improving
the PDF pipeline.

This tool:
  1. Queries the `library` table (via psql, creds from .env) for every
     `canonical_match_method = 'auto_version_creation'` row.
  2. Keeps the ones with real PDF raw on disk (`ocr_response.json`); REPORTS the rest
     (html-scrape / failed-fetch / missing) so nothing is silently dropped.
  3. For each, classifies it through the CURRENT pipeline (no network — replays the
     cached OCR), then captures a verified fixture into
     `fixtures-local/pdf/<pathway>/<book>/` (git-ignored: these are proprietary works).
     Golden outputs are frozen and the fixture is re-run to prove it passes; a fixture
     that can't pass is rolled back.

  python3 tests/conversion/harvest_auto_versions.py
  python3 tests/conversion/harvest_auto_versions.py --dry-run   # classify + report, write nothing
  python3 tests/conversion/harvest_auto_versions.py --books UUID1,UUID2   # explicit subset
  python3 tests/conversion/harvest_auto_versions.py --refresh   # re-capture even if present

fixtures-local is discovered automatically by run_regression.py, so captured fixtures
join the suite immediately (`python3 tests/conversion/run_regression.py`).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify_book as cb      # noqa: E402
import harvest as hv           # noqa: E402  (reuse slug_for / _build_manifest / _case_name)
import harvest_dedup as hd      # noqa: E402  (MARKDOWN_DIR)
import run_regression as rr     # noqa: E402

MARKDOWN_DIR = hd.MARKDOWN_DIR
LOCAL_DIR = rr.FIXTURES_LOCAL_DIR
PROJECT_ROOT = rr.PROJECT_ROOT

MATCH_METHOD = 'auto_version_creation'


# ---------------------------------------------------------------------------
# DB access — shell out to psql with creds from .env (matches repo convention;
# no psycopg2 dependency).
# ---------------------------------------------------------------------------
def _env(key, default=''):
    path = os.path.join(PROJECT_ROOT, '.env')
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + '='):
                    return line.split('=', 1)[1].strip()
    except OSError:
        pass
    return default


def query_auto_version_books():
    """Return [{book, conversion_method, title, foundation_source}] for every
    auto_version_creation library row, newest first."""
    sql = (
        "SELECT book, COALESCE(conversion_method,''), COALESCE(title,''), "
        "COALESCE(foundation_source,'') FROM library "
        f"WHERE canonical_match_method = '{MATCH_METHOD}' ORDER BY timestamp DESC NULLS LAST, book;"
    )
    env = dict(os.environ, PGPASSWORD=_env('DB_PASSWORD'))
    cmd = [
        'psql', '-h', _env('DB_HOST', '127.0.0.1'), '-p', _env('DB_PORT', '5432'),
        '-U', _env('DB_USERNAME', 'hyperlit_app'), '-d', _env('DB_DATABASE', 'my_laravel_db'),
        '-tAF', '\t', '-c', sql,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        print(f'psql query failed:\n{res.stderr}', file=sys.stderr)
        sys.exit(1)
    rows = []
    for line in res.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split('\t')
        parts += [''] * (4 - len(parts))
        rows.append({'book': parts[0], 'conversion_method': parts[1],
                     'title': parts[2], 'foundation_source': parts[3]})
    return rows


def has_pdf_raw(book):
    """True iff the book still has replayable PDF raw on disk."""
    return os.path.isfile(os.path.join(MARKDOWN_DIR, book, 'ocr_response.json'))


# ---------------------------------------------------------------------------
# Capture — like harvest.capture(), but targets fixtures-local, copies the
# source PDF for provenance, and stamps the manifest with canonical origin.
# ---------------------------------------------------------------------------
def capture(row, refresh=False):
    book = row['book']
    book_dir = os.path.join(MARKDOWN_DIR, book)
    c = cb.classify(book_dir)
    if not c.get('ok'):
        return 'error', f'{book}: classify failed ({c.get("error", "unknown")})'

    slug = hv.slug_for(c)
    if not slug:
        return 'error', f'{book}: no pathway slug (pipeline={c.get("pipeline")})'

    case_name = hv._case_name(book)
    fixture_dir = os.path.join(LOCAL_DIR, *slug.split('/'), case_name)
    if os.path.isdir(fixture_dir):
        if not refresh:
            return 'exists', f'{slug}/{case_name} already present'
        shutil.rmtree(fixture_dir)
    os.makedirs(fixture_dir, exist_ok=True)

    try:
        # Raw the replay pipeline consumes.
        shutil.copy2(os.path.join(book_dir, 'ocr_response.json'),
                     os.path.join(fixture_dir, 'ocr_response.json'))
        # Original PDF for provenance / future re-OCR (git-ignored tree, size is fine).
        src_pdf = os.path.join(book_dir, 'original.pdf')
        if os.path.isfile(src_pdf):
            shutil.copy2(src_pdf, os.path.join(fixture_dir, 'source.pdf'))

        manifest = hv._build_manifest(c, case_name, slug)
        manifest['source'] = {
            'origin': 'auto_version_creation',
            'canonical_match_method': MATCH_METHOD,
            'library_book': book,
            'conversion_method': row['conversion_method'],
            'foundation_source': row['foundation_source'],
            'title': row['title'],
        }
        manifest['description'] = (
            f"Auto-versioned canonical PDF ({row['title'][:80] or book}). "
            f"pipeline={c['pipeline']}, strategy={c.get('footnote_strategy')}, "
            f"style={c.get('citation_style')}."
        )
        with open(os.path.join(fixture_dir, 'manifest.json'), 'w') as f:
            json.dump(manifest, f, indent=4, ensure_ascii=False)

        _run_reg(['--fixture', case_name, '--update-golden'])
        verify = _run_reg(['--fixture', case_name])
        if verify.returncode == 0 and 'ALL PASS' in verify.stdout:
            return 'pass', f'{slug}/{case_name}  (fn={c.get("footnotes_count")} ref={c.get("references_count")})'
        shutil.rmtree(fixture_dir)
        tail = verify.stdout.strip().splitlines()[-8:]
        return 'fail', f'{slug}/{case_name} did not pass; rolled back: ' + ' | '.join(tail)
    except Exception as e:
        if os.path.isdir(fixture_dir):
            shutil.rmtree(fixture_dir)
        return 'error', f'{slug}/{case_name}: {e}'


def _run_reg(args):
    return subprocess.run(
        [sys.executable, os.path.join(rr.SCRIPT_DIR, 'run_regression.py'), *args],
        capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser(description='Harvest auto_version_creation PDF corpus into fixtures-local')
    ap.add_argument('--dry-run', action='store_true', help='classify + report, write nothing')
    ap.add_argument('--refresh', action='store_true', help='re-capture even if the fixture already exists')
    ap.add_argument('--books', help='comma-separated subset of book ids to consider')
    args = ap.parse_args()

    rows = query_auto_version_books()
    if args.books:
        wanted = {b.strip() for b in args.books.split(',') if b.strip()}
        rows = [r for r in rows if r['book'] in wanted]

    pdf_rows = [r for r in rows if has_pdf_raw(r['book'])]
    skipped = [r for r in rows if not has_pdf_raw(r['book'])]

    print(f'== {len(rows)} auto_version_creation library rows; '
          f'{len(pdf_rows)} with replayable PDF raw, {len(skipped)} without ==\n')

    print('== PDF corpus (has ocr_response.json) ==')
    for r in pdf_rows:
        print(f'   {r["book"]}  {r["conversion_method"]:<18} {r["title"][:60]}')

    if skipped:
        print('\n== skipped (no PDF raw on disk — html-scrape / failed fetch / missing) ==')
        for r in skipped:
            reason = 'missing dir' if not os.path.isdir(os.path.join(MARKDOWN_DIR, r['book'])) \
                else f'no ocr_response.json ({r["conversion_method"] or "?"})'
            print(f'   {r["book"]}  {reason}: {r["title"][:50]}')

    if args.dry_run:
        print('\n== dry run: nothing written ==')
        return

    print('\n== capturing into fixtures-local ==')
    captured = []
    for r in pdf_rows:
        status, msg = capture(r, refresh=args.refresh)
        print(f'   [{status}] {msg}')
        if status == 'pass':
            captured.append(msg)

    print(f'\n== DONE: {len(captured)} fixtures captured/verified in fixtures-local/pdf ==')
    print('   run: python3 tests/conversion/run_regression.py')


if __name__ == '__main__':
    main()

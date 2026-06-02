#!/usr/bin/env python3
"""
Deterministically harvest conversion-test fixtures from the LOCAL corpus.

Dedups resources/markdown/ by source content (the dir names are meaningless — many
are the same book re-converted), classifies every distinct source through the CURRENT
pipeline, auto-captures a fixture for each UNCOVERED pathway, and FLAGS faulty
conversions as candidate new pathways / bugs.

  python3 tests/conversion/harvest.py
  python3 tests/conversion/harvest.py --dry-run        # classify + report, write nothing
  python3 tests/conversion/harvest.py --capture-faulty # also capture faulty (locks current output)

No LLM, no network (PDF replays cached ocr_response.json). Captured fixtures are
verified by re-running the suite on them; a fixture that can't pass is rolled back.

(There is no single-file mode: converting one dropped file IS the normal import
pipeline, which already writes conversion_stats.json + audit.json — its pathway and
faultiness are readable straight from those. This tool is only for sweeping the
sources we already have locally.)
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify_book as cb      # noqa: E402
import harvest_dedup as hd      # noqa: E402
import run_regression as rr     # noqa: E402

FIXTURES_DIR = rr.FIXTURES_DIR
MARKDOWN_DIR = hd.MARKDOWN_DIR

DET_SLUG = {
    'AnchorHeadingFootnoteDetector': 'anchor_heading', 'EnoteFootnoteDetector': 'enote',
    'Epub3SemanticFootnoteDetector': 'epub3_semantic', 'AriaRoleFootnoteDetector': 'aria_role',
    'ClassPatternFootnoteDetector': 'class_pattern', 'NotesClassFootnoteDetector': 'notes_class',
    'TableFootnoteDetector': 'table', 'PandocFootnoteDetector': 'pandoc',
    'EndnoteCharactersFootnoteDetector': 'endnote_characters', 'HeuristicFootnoteDetector': 'heuristic',
}


def slug_for(c):
    """Map a classification to its pathway slug <filetype>/<pathway>."""
    if not c.get('ok'):
        return None
    if c['pipeline'] == 'epub':
        for d in c.get('detectors_fired', []):
            if d in DET_SLUG:
                return 'epub/' + DET_SLUG[d]
        return 'epub/' + ('pre_processed' if (c.get('footnotes_count') or 0) > 0 else 'no_footnotes')
    if (c.get('footnotes_count') or 0) == 0 and (c.get('references_count') or 0) > 0:
        style = c.get('citation_style')
        tail = style.replace('-', '_') if style and style != 'none' else 'bibliography'
        return f"{c['pipeline']}/{tail}"
    return f"{c['pipeline']}/{c.get('footnote_strategy') or 'no_footnotes'}"


def is_faulty(c):
    """A conversion worth human attention: errored, or has unmatched refs / numbering gaps."""
    if not c.get('ok'):
        return True
    return (c.get('audit_gaps') or 0) > 0 or (c.get('unmatched_refs') or 0) > 0


def covered_slugs():
    return hd.covered_slugs()


def _case_name(book):
    return re.sub(r'[^A-Za-z0-9_-]', '_', book)[:40]


def _copy_source(pipeline, book_dir, fixture_dir):
    if pipeline == 'pdf':
        shutil.copy2(os.path.join(book_dir, 'ocr_response.json'), os.path.join(fixture_dir, 'ocr_response.json'))
    elif pipeline == 'epub':
        shutil.copytree(os.path.join(book_dir, 'epub_original'), os.path.join(fixture_dir, 'epub_original'))
    elif pipeline == 'docx':
        src = os.path.join(book_dir, 'original.docx')
        if not os.path.isfile(src):
            src = os.path.join(book_dir, 'original.doc')
        shutil.copy2(src, os.path.join(fixture_dir, 'input.docx'))
    elif pipeline == 'html':
        shutil.copy2(os.path.join(book_dir, 'original.html'), os.path.join(fixture_dir, 'input.html'))
    elif pipeline == 'md':
        shutil.copy2(os.path.join(book_dir, 'original.md'), os.path.join(fixture_dir, 'input.md'))


def _build_manifest(c, case_name, slug):
    expected = {
        'references_count': c.get('references_count') or 0,
        'footnotes_count': c.get('footnotes_count') or 0,
        'audit_gaps': c.get('audit_gaps') or 0,
    }
    if c.get('footnote_strategy'):
        expected['footnote_strategy'] = c['footnote_strategy']
    if c.get('citation_style'):
        expected['citation_style'] = c['citation_style']
    if c.get('sample_links'):
        expected['footnote_links'] = c['sample_links'][:3]
    if c['pipeline'] == 'epub' and c.get('detectors_fired'):
        expected['detectors_fired'] = c['detectors_fired']
    dets = '+'.join(c.get('detectors_fired') or []) or 'none'
    return {
        'name': case_name,
        'description': f"Harvested from local corpus ({c['book']}). pipeline={c['pipeline']}, "
                       f"strategy={c.get('footnote_strategy')}, detectors={dets}.",
        'book_id': case_name,
        'citation_style': c.get('citation_style') or 'none',
        'footnote_strategy': c.get('footnote_strategy') or 'no_footnotes',
        'pipeline': c['pipeline'],
        'expected': expected,
    }


def _run_reg(args):
    return subprocess.run([sys.executable, os.path.join(rr.SCRIPT_DIR, 'run_regression.py'), *args],
                          capture_output=True, text=True)


def capture(c, book_dir, slug):
    """Create + verify a fixture for classification c. Returns (status, message)."""
    case_name = _case_name(c['book'])
    fixture_dir = os.path.join(FIXTURES_DIR, *slug.split('/'), case_name)
    if os.path.isdir(fixture_dir):
        return 'exists', f'{slug}/{case_name} already present'
    os.makedirs(fixture_dir, exist_ok=True)
    try:
        _copy_source(c['pipeline'], book_dir, fixture_dir)
        with open(os.path.join(fixture_dir, 'manifest.json'), 'w') as f:
            json.dump(_build_manifest(c, case_name, slug), f, indent=4, ensure_ascii=False)
        _run_reg(['--fixture', case_name, '--update-golden'])
        verify = _run_reg(['--fixture', case_name])
        if verify.returncode == 0 and 'ALL PASS' in verify.stdout:
            return 'pass', f'{slug}/{case_name}'
        shutil.rmtree(fixture_dir)  # roll back a fixture that won't pass
        tail = verify.stdout.strip().splitlines()[-8:]
        return 'fail', f'{slug}/{case_name} did not pass; rolled back: ' + ' | '.join(tail)
    except Exception as e:
        if os.path.isdir(fixture_dir):
            shutil.rmtree(fixture_dir)
        return 'error', f'{slug}/{case_name}: {e}'


def harvest_corpus(dry_run=False, capture_faulty=False):
    payload = json.loads(subprocess.run([sys.executable, os.path.join(rr.SCRIPT_DIR, 'harvest_dedup.py')],
                                         capture_output=True, text=True).stdout)
    books = payload['books']
    covered = set(payload['covered'])
    print(f'== {len(books)} distinct sources; {len(covered)} pathways already covered ==\n')

    best = {}      # slug -> classification (highest footnote+ref score)
    faulty = []
    for i, b in enumerate(books, 1):
        book_dir = os.path.join(MARKDOWN_DIR, b['book'])
        c = cb.classify(book_dir)
        slug = slug_for(c)
        flag = 'FAULTY' if is_faulty(c) else (slug or '-')
        print(f'  [{i:>3}/{len(books)}] {b["pipeline"]:<5} {b["book"][:34]:<34} -> {flag}'
              + (f'  fn={c.get("footnotes_count")} ref={c.get("references_count")}' if c.get('ok') else f'  ({c.get("error","")[:40]})'))
        if is_faulty(c):
            faulty.append(c)
            if not capture_faulty:
                continue
        if not slug:
            continue
        score = (c.get('footnotes_count') or 0) + (c.get('references_count') or 0)
        if slug not in best or score > best[slug]['_score']:
            c['_score'] = score
            best[slug] = c

    uncovered = sorted(s for s in best if s not in covered)
    print(f'\n== pathways seen: {len(set(list(best)+list(covered)))} | uncovered to capture: {len(uncovered)} ==')
    for s in uncovered:
        print(f'   + {s}  (from {best[s]["book"]})')

    captured = []
    if not dry_run:
        print('\n== capturing ==')
        for slug in uncovered:
            c = best[slug]
            status, msg = capture(c, os.path.join(MARKDOWN_DIR, c['book']), slug)
            print(f'   [{status}] {msg}')
            if status == 'pass':
                captured.append(slug)

    print(f'\n== FAULTY conversions ({len(faulty)}) — candidate new pathways / bugs ==')
    for c in faulty[:40]:
        reason = c.get('error') or f"gaps={c.get('audit_gaps')} unmatched_refs={c.get('unmatched_refs')}"
        print(f'   ! {c["pipeline"]:<5} {c["book"][:34]:<34} {reason[:60]}')
    if len(faulty) > 40:
        print(f'   ... and {len(faulty) - 40} more')

    print(f'\n== DONE: captured {len(captured)} new fixtures; {len(faulty)} faulty flagged ==')
    return captured, faulty


def main():
    ap = argparse.ArgumentParser(description='Harvest conversion fixtures from the local corpus')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--capture-faulty', action='store_true')
    args = ap.parse_args()
    harvest_corpus(dry_run=args.dry_run, capture_faulty=args.capture_faulty)


if __name__ == '__main__':
    main()

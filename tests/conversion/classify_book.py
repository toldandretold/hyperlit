#!/usr/bin/env python3
"""
Classify a single converted book from resources/markdown/<bookId>/ by running its
REAL source through the CURRENT conversion pipeline and reporting which pathway it
lands in, whether it succeeded, and a few marker->note link samples.

Used by the fixture-harvest workflow: run every distinct local source, see which
pathway it produces, and capture the ones whose pathway has no test fixture yet.

Usage:
    python3 tests/conversion/classify_book.py <path-to-book-dir> [--json]

Outputs JSON: {book, pipeline, ok, error, footnote_strategy, citation_style,
footnotes_count, references_count, detectors_fired, sample_links:[{marker,content_contains}]}
"""

import json
import os
import re
import shutil
import sys
import tempfile

# Reuse the harness's subprocess helper, script paths and id-normalization.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_regression as rr  # noqa: E402


def detect_pipeline(book_dir):
    if os.path.isfile(os.path.join(book_dir, 'ocr_response.json')):
        return 'pdf'
    if os.path.isdir(os.path.join(book_dir, 'epub_original')):
        return 'epub'
    if os.path.isfile(os.path.join(book_dir, 'original.docx')) or os.path.isfile(os.path.join(book_dir, 'original.doc')):
        return 'docx'
    if os.path.isfile(os.path.join(book_dir, 'original.html')):
        return 'html'
    if os.path.isfile(os.path.join(book_dir, 'original.md')):
        return 'md'
    return None


def _run_chain(pipeline, book_dir, tmp_dir, book_id):
    """Run the current pipeline; return None on success or an error string."""
    if pipeline == 'pdf':
        shutil.copy2(os.path.join(book_dir, 'ocr_response.json'), os.path.join(tmp_dir, 'ocr_response.json'))
        r = rr._run([sys.executable, rr.MISTRAL_OCR_SCRIPT, '/dev/null', tmp_dir])
        if r.returncode != 0:
            return f'mistral_ocr: {r.stderr[-200:]}'
        md = os.path.join(tmp_dir, 'main-text.md')
        html = os.path.join(tmp_dir, 'intermediate.html')
        if not os.path.isfile(md):
            return 'mistral_ocr: no main-text.md'
        r = rr._run([sys.executable, rr.MD_TO_HTML_SCRIPT, md, html])
        if r.returncode != 0:
            return f'md_to_html: {r.stderr[-200:]}'
        r = rr._run([sys.executable, rr.PROCESS_SCRIPT, html, tmp_dir, book_id])
        return None if r.returncode == 0 else f'process_document: {r.stderr[-200:]}'

    if pipeline == 'epub':
        r = rr._run([sys.executable, rr.EPUB_NORMALIZER_SCRIPT, os.path.join(book_dir, 'epub_original'), tmp_dir, book_id])
        if r.returncode != 0:
            return f'epub_normalizer: {r.stderr[-200:]}'
        main_html = os.path.join(tmp_dir, 'main-text.html')
        if not os.path.isfile(main_html):
            return 'epub_normalizer: no main-text.html'
        r = rr._run([sys.executable, rr.PROCESS_SCRIPT, main_html, tmp_dir, book_id])
        return None if r.returncode == 0 else f'process_document: {r.stderr[-200:]}'

    if pipeline == 'docx':
        if not shutil.which('pandoc'):
            return 'skipped: pandoc unavailable'
        src = os.path.join(book_dir, 'original.docx')
        if not os.path.isfile(src):
            src = os.path.join(book_dir, 'original.doc')
        work = os.path.join(tmp_dir, 'input.docx')
        shutil.copy2(src, work)
        rr._run([sys.executable, rr.STRIP_DOCX_SCRIPT, work], timeout=60)
        html = os.path.join(tmp_dir, 'intermediate.html')
        r = rr._run(['pandoc', work, '-o', html, *rr.PANDOC_BASE_FLAGS, f'--extract-media={os.path.join(tmp_dir, "media")}'])
        if r.returncode != 0:
            return f'pandoc: {r.stderr[-200:]}'
        r = rr._run([sys.executable, rr.PROCESS_SCRIPT, html, tmp_dir, book_id])
        return None if r.returncode == 0 else f'process_document: {r.stderr[-200:]}'

    if pipeline == 'html':
        src = os.path.join(book_dir, 'original.html')
        html_txt = open(src, encoding='utf-8', errors='replace').read(200000)
        use = src
        if 'ltx_bibitem' in html_txt or 'ltx_bibliography' in html_txt:  # ar5iv
            use = os.path.join(tmp_dir, 'input.html')
            shutil.copy2(src, use)
            rr._run([sys.executable, rr.AR5IV_SCRIPT, use, tmp_dir])
        r = rr._run([sys.executable, rr.PROCESS_SCRIPT, use, tmp_dir, book_id])
        return None if r.returncode == 0 else f'process_document: {r.stderr[-200:]}'

    if pipeline == 'md':
        html = os.path.join(tmp_dir, 'intermediate.html')
        r = rr._run([sys.executable, rr.MD_TO_HTML_SCRIPT, os.path.join(book_dir, 'original.md'), html])
        if r.returncode != 0:
            return f'md_to_html: {r.stderr[-200:]}'
        r = rr._run([sys.executable, rr.PROCESS_SCRIPT, html, tmp_dir, book_id])
        return None if r.returncode == 0 else f'process_document: {r.stderr[-200:]}'

    return f'unknown pipeline {pipeline}'


def _distinctive(text, n=24):
    """Pick a stable, distinctive substring from a note's plain text for an assertion."""
    plain = re.sub(r'<[^>]+>', ' ', text)
    plain = re.sub(r'\s+', ' ', plain).strip()
    # Prefer a run starting at the first long word, to avoid leading punctuation/markers.
    m = re.search(r'[A-Za-z][A-Za-z0-9 ,.\-]{%d,}' % (n - 1), plain)
    return (m.group(0)[:n].strip() if m else plain[:n].strip())


def classify(book_dir):
    book = os.path.basename(os.path.normpath(book_dir))
    pipeline = detect_pipeline(book_dir)
    out = {'book': book, 'pipeline': pipeline, 'ok': False, 'error': None,
           'footnote_strategy': None, 'citation_style': None,
           'footnotes_count': 0, 'references_count': 0,
           'audit_gaps': 0, 'unmatched_refs': 0, 'unmatched_defs': 0,
           'detectors_fired': [], 'sample_links': []}
    if not pipeline:
        out['error'] = 'no recognised source input'
        return out

    with tempfile.TemporaryDirectory(prefix=f'classify_{book}_') as tmp:
        err = _run_chain(pipeline, book_dir, tmp, book)
        if err:
            out['error'] = err
            return out

        stats_path = os.path.join(tmp, 'conversion_stats.json')
        if os.path.isfile(stats_path):
            s = json.load(open(stats_path))
            out['footnote_strategy'] = s.get('footnote_strategy')
            out['citation_style'] = s.get('citation_style')
            out['footnotes_count'] = s.get('footnotes_matched', 0)
            out['references_count'] = s.get('references_found', 0)

        audit_path = os.path.join(tmp, 'audit.json')
        if os.path.isfile(audit_path):
            a = json.load(open(audit_path))
            out['audit_gaps'] = len(a.get('gaps', []))
            out['unmatched_refs'] = len(a.get('unmatched_refs', []))
            out['unmatched_defs'] = len(a.get('unmatched_defs', []))

        dbg = os.path.join(tmp, 'epub_normalizer_debug.txt')
        if os.path.isfile(dbg):
            out['detectors_fired'] = rr.detectors_that_fired(open(dbg, encoding='utf-8', errors='replace').read())

        rr.normalize_outputs(tmp)
        summary = json.load(open(os.path.join(tmp, 'nodes.summary.json')))
        content = {fn['footnoteId']: fn['content']
                   for fn in rr._read_jsonl(os.path.join(tmp, 'footnotes.normalized.jsonl'))}
        seen = set()
        for node in summary.get('linked_nodes', []):
            for fn in node.get('footnotes', []):
                marker = str(fn.get('marker'))
                if marker in seen:
                    continue
                sub = _distinctive(content.get(fn['id'], ''))
                if sub and len(sub) >= 8:
                    out['sample_links'].append({'marker': marker, 'content_contains': sub})
                    seen.add(marker)
                if len(out['sample_links']) >= 3:
                    break
            if len(out['sample_links']) >= 3:
                break

        out['ok'] = (out['footnotes_count'] or 0) > 0 or (out['references_count'] or 0) > 0 \
            or summary.get('node_count', 0) > 0
    return out


def main():
    args = [a for a in sys.argv[1:] if a != '--json']
    if not args:
        print('usage: classify_book.py <book-dir>', file=sys.stderr)
        sys.exit(2)
    print(json.dumps(classify(args[0])))


if __name__ == '__main__':
    main()

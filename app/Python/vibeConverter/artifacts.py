"""vibeConverter.artifacts — read a failing conversion's artifacts + summarise its stats."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.gate import (_count_headings, _ref_key_stats)




# ---------------------------------------------------------------------------
# 1. Read the failing conversion's artifacts
# ---------------------------------------------------------------------------
def load_artifacts(book_dir):
    def _read_json(name):
        p = os.path.join(book_dir, name)
        return json.load(open(p, encoding='utf-8')) if os.path.isfile(p) else None

    assessment = _read_json('assessment.json')
    source = None
    for cand in ('main-text.html', 'intermediate.html', 'input.html'):
        p = os.path.join(book_dir, cand)
        if os.path.isfile(p):
            source = open(p, encoding='utf-8').read()
            break
    _stats = _read_json('conversion_stats.json') or {}
    _headings = _count_headings(os.path.join(book_dir, 'nodes.jsonl'))
    _stats['headings_total'] = _headings['total']   # so _stat_summary can SHOW headings in every beat
    return {
        'book_dir': book_dir,
        'assessment': (assessment or {}).get('records', []) if assessment else [],
        'audit': _read_json('audit.json') or {},
        'stats': _stats,
        'headings': _headings,
        'refs': _ref_key_stats(os.path.join(book_dir, 'references.json')),
        'source': source,
        'is_pdf': os.path.isfile(os.path.join(book_dir, 'ocr_response.json')),
        # Detect EPUB from the source OR from epub_normalizer's footprint — the latter matters when
        # book_dir is a freshly-CONVERTED dir (the eval harness) that doesn't carry the .epub source,
        # else is_epub=False mis-routes the footnote fork away from epub_normalizer.py.
        'is_epub': (os.path.isfile(os.path.join(book_dir, 'original.epub'))
                    or os.path.isdir(os.path.join(book_dir, 'epub_original'))
                    or os.path.isfile(os.path.join(book_dir, 'epub_normalizer_debug.txt'))),
        'markdown': (open(os.path.join(book_dir, 'main-text.md'), encoding='utf-8').read()
                     if os.path.isfile(os.path.join(book_dir, 'main-text.md')) else None),
    }




def _stat_summary(stats):
    # headings included so a heading fix (or its absence) is VISIBLE in the beat — the gate measures
    # h1–h6 nodes, but if the line only shows refs/citations/footnotes it LOOKS like headings are ignored.
    h = stats.get('headings_total')
    return (f"refs {stats.get('references_found', 0)}, "
            f"citations {stats.get('citations_linked', 0)}/{stats.get('citations_total', 0)}, "
            f"footnotes {stats.get('footnotes_matched', 0)}"
            + (f", headings {h}" if h is not None else ""))

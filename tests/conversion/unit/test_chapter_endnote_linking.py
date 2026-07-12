"""Regression test for the DOCUMENT-ENDNOTE mislinking bug (book 9045b32e, 'Towards global
political parties').

The book keeps its footnote DEFINITIONS in a single back-of-book "NOTES" section, numbered
1…N with no restarts, while the in-text markers live in the body. The chunk-footnote
renumber (`renumber_chunk_footnotes`) is meant to offset a NEW-PAPER boundary in a >50MB
anthology split — detected by the in-text REFS restarting at 1. It wrongly fired on the
NOTES section (whose DEFINITIONS restart at 1) and offset every note by +45/+51, so the
in-text marker 51 (on the "…perhaps up-dated and revised Wellsian?… wide gaps in
understanding and sympathy" paragraph — its real note 51 is a Wells reference) bound instead
to the renumbered note 51 = Christopher Chase-Dunn, and the marker even rendered as "28".

Fix: the heuristic reset now requires a genuine REF restart, so a definition-only endnotes
page no longer offsets the note list away from its markers.

The fixture OCR is a proprietary book (git-ignored fixtures-local); the test skips when it is
absent rather than failing on a fresh checkout.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
_PY = os.path.join(_REPO, 'app', 'Python')
_OCR = os.path.join(_REPO, 'tests', 'conversion', 'fixtures-local', 'pdf', 'sequential',
                    '9045b32e-33f4-4793-92d2-0e3efb7e31c4', 'ocr_response.json')

_MARKER_ANCHOR = 'wide gaps in understanding and sympathy'


def _run_pdf_pipeline(ocr_path):
    """Replay the cached OCR through the full PDF pipeline; return (nodes_html, defs_by_id)."""
    env = dict(os.environ, PYTHONHASHSEED='0')
    tmp = tempfile.mkdtemp(prefix='docendnote_')
    try:
        shutil.copy2(ocr_path, os.path.join(tmp, 'ocr_response.json'))
        for cmd in (
            [sys.executable, os.path.join(_PY, 'mistral_ocr.py'), '/dev/null', tmp],
            [sys.executable, os.path.join(_PY, 'simple_md_to_html.py'),
             os.path.join(tmp, 'main-text.md'), os.path.join(tmp, 'intermediate.html')],
            [sys.executable, os.path.join(_PY, 'process_document.py'),
             os.path.join(tmp, 'intermediate.html'), tmp, 'docendnote'],
        ):
            r = subprocess.run(cmd, env=env, capture_output=True, text=True)
            assert r.returncode == 0, f'{cmd[1]} failed: {r.stderr[-400:]}'
        nodes = [json.loads(l) for l in open(os.path.join(tmp, 'nodes.jsonl'))]
        html = ''.join(n.get('content', '') for n in nodes)
        defs = {json.loads(l)['footnoteId']: json.loads(l)['content']
                for l in open(os.path.join(tmp, 'footnotes.jsonl'))}
        return html, defs
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.skipif(not os.path.isfile(_OCR), reason='proprietary fixture (fixtures-local) not present')
def test_endnote_marker_links_to_its_own_note_not_a_renumber_offset_victim():
    html, defs = _run_pdf_pipeline(_OCR)

    m = re.search(_MARKER_ANCHOR + r'.{0,40}?<sup[^>]*id="([^"]+)"[^>]*>(\d+)</sup>', html)
    assert m, "could not find the in-text marker on the 'wide gaps' paragraph"
    marker_id, displayed = m.group(1), m.group(2)
    linked = re.sub('<[^>]+>', '', defs.get(marker_id, ''))

    # The marker renders its true number (51), not a renumber artifact ("28").
    assert displayed == '51', f'marker rendered as {displayed!r}, expected 51'
    # It links to its OWN note (a Wells reference, matching the paragraph's "Wellsian" theme),
    # not the renumber-collision victim (Chase-Dunn).
    assert 'Wells' in linked and 'Chase-Dunn' not in linked, f'marker links to the wrong note: {linked[:80]!r}'


@pytest.mark.skipif(not os.path.isfile(_OCR), reason='proprietary fixture (fixtures-local) not present')
def test_every_endnote_marker_matches_a_definition():
    # With the false reset gone, the continuous 1..N numbering is intact: every in-text marker
    # resolves to a real definition (was 34/… mislinked under the bogus +45/+51 offsets).
    html, defs = _run_pdf_pipeline(_OCR)
    markers = set(re.findall(r'class="footnote-ref"[^>]*id="([^"]+)"', html))
    assert markers, 'no in-text footnote markers found'
    unmatched = markers - set(defs)
    assert not unmatched, f'{len(unmatched)} markers link to a missing definition'

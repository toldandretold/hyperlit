"""Real-PDF pypdf-recovery integration — the one place the test suite runs the FULL footnote
resurrection path (scan_footnote_mojibake + the assemble_markdown pypdf fallback) against the actual
source PDFs, instead of the deterministic-but-blind `pdf_path=None` replay every other PDF test uses.

WHY this exists: the snapshot/regression harness replays cached `ocr_response.json` with pdf_path=None
for determinism, which means the pypdf recovery NEVER runs there — so a book can look like it lost
footnotes when the real import would claw them back from the PDF bytes. This test closes that blind
spot for the corpus books that ship their PDF, and pins the invariant that recovery NEVER loses defs.

OPT-IN (slow: reads multi-hundred-page PDFs with pypdf). Run with:
    RUN_PYPDF_RECOVERY=1 pytest tests/conversion/unit/test_pdf_recovery_real.py
It is SKIPPED by default so the fast unit suite stays fast + deterministic. pypdf extraction is
deterministic (verified: same PDF → same recovered count), so when run it is a stable gate.
"""

import glob
import os
import re
from pathlib import Path

import pytest

import mistral_ocr as M

_HERE = os.path.dirname(__file__)
_CORPUS = os.path.abspath(os.path.join(_HERE, '..', 'corpus'))

_ENABLED = os.environ.get('RUN_PYPDF_RECOVERY') == '1'
pytestmark = pytest.mark.skipif(
    not _ENABLED, reason="opt-in: set RUN_PYPDF_RECOVERY=1 (reads real PDFs via pypdf; slow)")


def _books_with_pdfs():
    out = []
    for d in sorted(glob.glob(os.path.join(_CORPUS, '*', ''))):
        ocr = os.path.join(d, 'ocr_response.json')
        pdfs = glob.glob(os.path.join(d, '*.pdf'))
        if os.path.exists(ocr) and pdfs:
            out.append((os.path.basename(d.rstrip('/')), ocr, pdfs[0]))
    return out


def _harvested(md):
    return len(re.findall(r'^\[\^\d+\]\s*:', md, re.MULTILINE))


def _assemble(ocr_path, pdf_path):
    import json
    rd = json.loads(open(ocr_path, encoding='utf-8').read())
    meta = M.classify_footnotes(rd)
    warnings = []
    if pdf_path is not None:
        warnings = M.scan_footnote_mojibake(rd, meta, Path(pdf_path))
    md = M.assemble_markdown(rd, classification=meta['classification'], footnote_meta=meta,
                             pdf_path=(Path(pdf_path) if pdf_path else None),
                             segment_boundaries=[], footnote_warnings=warnings)
    return meta, md, warnings


@pytest.mark.parametrize('name,ocr,pdf', _books_with_pdfs(), ids=lambda v: v if isinstance(v, str) else '')
def test_recovery_never_loses_definitions(name, ocr, pdf):
    """Running WITH the real PDF must harvest >= the blind (pdf_path=None) run — pypdf only ever ADDS
    back missing definitions, never removes. This is the invariant that lets the live import trust the
    recovery path the replay harness can't exercise."""
    _, md_blind, _ = _assemble(ocr, None)
    _, md_real, warnings = _assemble(ocr, pdf)
    blind, real = _harvested(md_blind), _harvested(md_real)
    recovered = sum(len(w.get('recovered', [])) for w in warnings)
    assert real >= blind, f"{name}: real-PDF harvest {real} < blind {blind} (recovery LOST defs)"


def test_recovery_demonstrably_works_on_a_known_book():
    """Concrete regression guard: soviet_marxism is known to gain real definitions from pypdf (the
    replay harness drops them). If this stops recovering, the pypdf path has silently broken."""
    hit = [b for b in _books_with_pdfs() if b[0].startswith('soviet_marxism')]
    if not hit:
        pytest.skip("soviet_marxism corpus book not present")
    name, ocr, pdf = hit[0]
    blind = _harvested(_assemble(ocr, None)[1])
    real = _harvested(_assemble(ocr, pdf)[1])
    assert real > blind, f"{name}: expected pypdf to recover defs, got blind={blind} real={real}"


def test_fidelity_record_is_pypdf_aware_with_real_pdf():
    """With the real PDF, the fidelity record must carry recovery_attempted=True (so a fidelity_loss
    verdict is CONFIRMED, not untested)."""
    for name, ocr, pdf in _books_with_pdfs():
        meta, md, warnings = _assemble(ocr, pdf)
        rec = M.assess_harvest_fidelity(meta, md, warnings)
        assert rec['evidence']['pypdf_recovery_attempted'] is True

"""The 'fusion' footnote layout: a single back-of-book Notes section split by chapter (definitions
clustered at the END like document_endnotes, but numbering restarts per chapter like chapter_endnotes).

This file PROVES the pipeline handles it — rather than assuming. FIXED: the classifier picks
chapter_endnotes, and the chapter-offset assembler now applies ONE offset to a pure single-chapter
notes page (only splitting per-def on a genuine two-chapter transition — a real internal gap + a high
old-chapter-tail cluster). So a back-of-book Notes section split by chapter gets globally-unique
definition numbers (chapter 2's note 1 → 25, etc.).

Was a PRE-EXISTING bug in mistral_ocr.assemble_markdown's chapter-offset machinery: the notes-section
offsets were indexed into body-derived offsets (from ref-reset detection), which OCR noise can make
under-count chapters — once the index ran past them, later chapters got NO fresh offset and collided.
The fix (ChapterEndnotesAssembler.setup) anchors each new notes-chapter's offset to the highest global
number emitted so far (`running_max`), making global uniqueness PROVABLE and immune to segmentation
noise. The registry decomposition had preserved the old bug byte-for-byte.

CAVEAT — the real book corpus/production_power_and_world_order_social_forces_i (Cox, 515pp) improved
24 → 10 collisions. The OCR is NOT the problem: assess_harvest_fidelity shows we harvest 505/512 of the
def-lines OCR captured (≈99%) across 12 clean chapter restarts. The residual 10 are page_summary
DETECTION noise (false def-lines — numbered lists inside note bodies — and a couple of restarts the
`def_min < max*0.3` heuristic misses), a separate upstream layer from the offset logic this test pins.
The harvest-fidelity record classifies Cox as `assembly_collisions` (our bug, flagged), correctly.
"""

import re
from collections import Counter

import pytest

import mistral_ocr as M


def _page(md, header=""):
    return {"markdown": md, "header": header}


def _fusion_doc():
    """Body: ch1 refs 1..24 (increasing), ch2 RESTARTS 1..24. Back-of-book Notes: ch1 defs 1..24 on its
    own page, ch2 defs RESTART 1..24 on the next — chapter boundary aligned to a page boundary."""
    def refs(lo, hi):
        return "Body text " + " ".join(f"point[^{i}]" for i in range(lo, hi + 1)) + " end."
    def defs(lo, hi, lbl):
        return "\n".join(f"{i}. {lbl} note {i} text." for i in range(lo, hi + 1))
    return {"pages": [
        _page(refs(1, 10), "The Book"),
        _page(refs(11, 24), "The Book"),
        _page(refs(1, 10), "The Book"),       # ch2 reset (ref_max 10 < 24*0.5)
        _page(refs(11, 24), "The Book"),
        _page(defs(1, 24, "ch1"), "Notes"),   # back-of-book notes, ch1
        _page(defs(1, 24, "ch2"), "Notes"),   # ch2 — restarts
    ]}


def _assembled(rd):
    meta = M.classify_footnotes(rd)
    md = M.assemble_markdown(rd, classification=meta['classification'], footnote_meta=meta,
                             pdf_path=None, segment_boundaries=[], footnote_warnings=[])
    return meta, md


def test_fusion_is_classified_chapter_endnotes():
    """The classifier DOES recognise the fusion shape (this part works)."""
    meta, _ = _assembled(_fusion_doc())
    assert meta['classification'] == 'chapter_endnotes'


def test_fusion_definition_numbers_should_be_globally_unique():
    """Per-chapter offsets make every definition number unique (chapter 2's note 1 becomes 25, etc.),
    so no marker resolves to the wrong note. This now PASSES (was the collision bug)."""
    _, md = _assembled(_fusion_doc())
    def_nums = [int(n) for n in re.findall(r'^\[\^(\d+)\]\s*:', md, re.MULTILINE)]
    dupes = sorted(n for n, c in Counter(def_nums).items() if c > 1)
    assert not dupes, f"definition numbers collided across chapters: {dupes}"

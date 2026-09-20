"""Unit tests for PUA footnote-marker recovery (ingestion/pdf/recovery.py).

Some publisher PDFs (Advanced Typesetting's "AdvOT*" subset fonts, used across Cambridge journals)
map their DIGIT glyphs into the Unicode Private Use Area and ship no usable ToUnicode CMap: the
shapes on the page are digits, but the file declares them as U+F6xx and names the glyphs
"/uniF646" — restating the codepoint, not the digit. Nothing in the PDF says these are numbers.

Measured on cambridge-voluntariness (2026-09-19): Mistral OCR emitted 8 of the article's 34 footnote
markers, so 26 citations were never linked and the citation review produced 7 claims where the paste
twin produced 29. The superscripts are plainly visible on the page.

These tests exist because the PDF regression suite CANNOT cover this: it replays PDF-less, so the
whole path (gated on a real pdf_path) never executes there. That is the fixture blindness the
marker-loss work has hit before, so the logic is pinned directly here instead.
"""

import pytest

from ingestion.pdf.recovery import (
    derive_pua_digit_map,
    filter_ascending_marker_chain,
    resurrect_pua_markers,
    _pua_only,
)

# The real mapping measured on cambridge-voluntariness: ten consecutive PUA codepoints = 0..9,
# cross-checked against that file's own DOI, which renders as U+F644 U+F643 "." … for "10.1017/…".
CAMBRIDGE_MAP = {0xF643 + i: str(i) for i in range(10)}


# ---------------------------------------------------------------------------
# _pua_only — isolation IS the superscript signal
# ---------------------------------------------------------------------------
def test_a_fragment_of_only_pua_digits_is_a_marker():
    # A marker is its own text-show operation because it is set in a different font, so the pypdf
    # visitor hands it over isolated: "topic," then " " then " we identified".
    assert _pua_only('', CAMBRIDGE_MAP) == '3'
    assert _pua_only('  ', CAMBRIDGE_MAP) == '10'


def test_a_pua_digit_EMBEDDED_in_prose_is_not_a_marker():
    # A PUA digit inside a longer fragment is ordinary body text — a year, a page number — and
    # must be left alone.
    assert _pua_only('page ', CAMBRIDGE_MAP) is None
    assert _pua_only(' The third condition', CAMBRIDGE_MAP) is None


def test_an_ordinary_digit_fragment_is_not_claimed():
    # Real digits are already visible to the OCR; this path is only for glyphs it could not read.
    assert _pua_only('3', CAMBRIDGE_MAP) is None
    assert _pua_only('', CAMBRIDGE_MAP) is None


# ---------------------------------------------------------------------------
# derive_pua_digit_map — refuse to guess
# ---------------------------------------------------------------------------
def test_an_unreadable_pdf_yields_no_map_rather_than_an_exception():
    # Called on every PDF import, so it must degrade quietly: no map simply means no recovery.
    assert derive_pua_digit_map('/nonexistent/does-not-exist.pdf') is None


# ---------------------------------------------------------------------------
# filter_ascending_marker_chain — contiguity is what survives the noise
# ---------------------------------------------------------------------------
def test_the_contiguous_chain_is_kept():
    seams = {0: [('1', 'seam one'), ('2', 'seam two')], 2: [('3', 'seam three')]}
    kept = filter_ascending_marker_chain(seams, 34)
    assert [n for p in sorted(kept) for n, _ in kept[p]] == ['1', '2', '3']


def test_junk_that_merely_ASCENDS_is_rejected():
    # The real failure this encodes: cambridge's title page offers "4" and "10" (volume and issue,
    # same font), which an ascending-only filter accepts — and those then lock out the genuine
    # 3..9 that follow on page 3, producing the chain 1,2,4,10,11,... Contiguity rejects both.
    seams = {
        0: [('1', 'a'), ('2', 'b'), ('37', 'c'), ('4', 'd'), ('406', 'e'), ('10', 'f')],
        2: [('3', 'g'), ('4', 'h'), ('5', 'i')],
    }
    kept = filter_ascending_marker_chain(seams, 34)
    assert [n for p in sorted(kept) for n, _ in kept[p]] == ['1', '2', '3', '4', '5']


def test_numbers_beyond_the_definition_range_are_rejected():
    seams = {0: [('1', 'a')], 1: [('2', 'b'), ('3', 'c')]}
    assert [n for p in sorted(filter_ascending_marker_chain(seams, 2)) for n, _ in
            filter_ascending_marker_chain(seams, 2)[p]] == ['1', '2']


def test_the_endnote_pages_page_numbers_cannot_extend_a_finished_chain():
    # Endnote pages set their own page numbers and years in the SAME PUA font ("406", "783"), and
    # they come AFTER the last real marker — so nothing they offer is last+1.
    seams = {0: [('1', 'a'), ('2', 'b')], 18: [('406', 'x'), ('783', 'y'), ('3', 'z')]}
    kept = filter_ascending_marker_chain(seams, 34)
    # '3' on the endnote page IS last+1, so it is kept — contiguity cannot tell it apart, and the
    # seam gate in resurrect_pua_markers is what refuses it when the context does not match.
    assert [n for p in sorted(kept) for n, _ in kept[p]] == ['1', '2', '3']


def test_a_non_numeric_candidate_is_skipped_without_breaking_the_chain():
    seams = {0: [('1', 'a'), ('x', 'b'), ('2', 'c')]}
    kept = filter_ascending_marker_chain(seams, 34)
    assert [n for p in sorted(kept) for n, _ in kept[p]] == ['1', '2']


# ---------------------------------------------------------------------------
# resurrect_pua_markers — never guess where the marker goes
# ---------------------------------------------------------------------------
def test_a_marker_is_inserted_at_the_end_of_its_seam():
    md = 'In our previous treatment of the topic, we identified four necessary conditions.'
    seam = 'In our previous treatment of the topic,'
    out, n = resurrect_pua_markers(md, [('3', seam)])
    assert n == 1
    assert out == 'In our previous treatment of the topic,[^3] we identified four necessary conditions.'


def test_matching_survives_ligature_and_spacing_disagreement():
    # pypdf splits ligatures into their own fragments ("identi" + "ﬁ" + "ed") and disagrees with
    # Mistral about whitespace; the fold used for matching removes both.
    md = 'the unfulfillment of people’s fundamental human needs, where "fundamental" comprise'
    seam = 'the unful ﬁllment of  people ’s fundamental human needs,'
    out, n = resurrect_pua_markers(md, [('4', seam)])
    assert n == 1
    assert '[^4]' in out
    assert out == 'the unfulfillment of people\u2019s fundamental human needs,[^4] where "fundamental" comprise'


def test_an_AMBIGUOUS_seam_is_refused():
    # Two identical contexts: inserting at either is a coin flip, and a wrong marker attributes a
    # claim to the wrong work. A missing marker is recoverable; a wrong one is not.
    md = 'the same sentence repeated here. and the same sentence repeated here. done'
    out, n = resurrect_pua_markers(md, [('5', 'the same sentence repeated here.')])
    assert n == 0
    assert out == md


def test_a_seam_the_OCR_REWORDED_is_skipped():
    md = 'Something entirely different appears on this page.'
    out, n = resurrect_pua_markers(md, [('6', 'a seam that does not appear anywhere at all')])
    assert (n, out) == (0, md)


def test_a_marker_already_present_is_not_duplicated():
    md = 'In our previous treatment of the topic,[^3] we identified four conditions.'
    out, n = resurrect_pua_markers(md, [('3', 'In our previous treatment of the topic,')])
    assert (n, out) == (0, md)


def test_a_seam_too_short_to_place_safely_is_refused():
    md = 'It is so. And it is so again.'
    out, n = resurrect_pua_markers(md, [('7', 'so.')])
    assert (n, out) == (0, md)


def test_no_seams_is_a_no_op():
    md = 'Untouched.'
    assert resurrect_pua_markers(md, []) == (md, 0)

"""Footnote RESURRECTION — the recovery layers that run between assembly and the harvest-fidelity
check, turning OCR-mangled or OCR-missed footnotes back into clean [^N] / [^N]: pairs. These are the
nodes in the decision tree's "recovery" group; this file is their fast (no-PDF) checkpoint.

Three layers, in order of how hard they reach:
  1. MARKER resurrection  — normalize_all_footnote_refs: OCR rendered the marker as a superscript,
     LaTeX $^5$, a bare [N], or a bare ".46 " after punctuation → restore [^N], BUT only when the
     number fits between the surrounding known refs (sequential validation), so years / table numbers
     are never mis-converted. No PDF needed.
  2. MOJIBAKE def re-OCR  — scan_footnote_mojibake: a garbled definition page is re-extracted from the
     PDF via pypdf. Needs the real PDF → covered by the opt-in test_pdf_recovery_real.py.
  3. MISSING-def fill     — recover_missing_defs: refs that have no definition get their text pulled
     from the pypdf extraction. The extraction needs the PDF, but the MATCHER (which recovered def
     fills which missing number, with range/dedup/overwrite rules) is pure logic — pinned here.
"""

import mistral_ocr as M


# --- Layer 1: marker resurrection + its sequential-validation safety check --------------------------

def test_bare_number_after_punctuation_is_resurrected_between_known_refs():
    """A footnote marker OCR dropped to a bare '.46 ' is restored — because 46 fits between 45 and 47."""
    out = M.normalize_all_footnote_refs('A claim[^45] then text.46 More words[^47] here.')
    assert '[^46]' in out


def test_sequential_validation_rejects_years_and_table_numbers():
    """The safety check: out-of-sequence numbers (a year, a table ref) must NOT be converted."""
    assert M.normalize_all_footnote_refs('Year was 2015 and table 3 shows.') == \
        'Year was 2015 and table 3 shows.'


def test_marker_after_closing_quote_or_paren_is_resurrected():
    """A footnote number right after a CLOSING quote — curly (” ’) OR straight (" ') — or a close paren
    is restored. Curly closers are directional (their openers “ ‘ are different glyphs); a STRAIGHT quote
    is accepted only when preceded by a letter / sentence-punct (a closing context). (46 fits 45–47.)"""
    assert '[^46]' in M.normalize_all_footnote_refs('a[^45] end of quote.”46 next b[^47]')    # curly "
    assert '[^46]' in M.normalize_all_footnote_refs('a[^45] a single quote.’46 next b[^47]')   # curly '
    assert '[^46]' in M.normalize_all_footnote_refs('a[^45] end of quote."46 next b[^47]')     # straight "
    assert '[^46]' in M.normalize_all_footnote_refs("a[^45] end of quote.'46 next b[^47]")     # straight '
    assert '[^46]' in M.normalize_all_footnote_refs('a[^45] (an aside)46 next b[^47]')         # paren


def test_opening_quotes_and_inch_marks_are_NOT_resurrected():
    """A straight quote is the SAME glyph open or closed, so it's accepted ONLY in a closing context
    (letter/sentence-punct before it). An OPENING quote (space or '(' before it) or an inch-mark (digit
    before it) must NOT fire — otherwise titles like  "5 Questions with..."  get a phantom footnote (a
    real false positive once seen in the whole_document fixture). Curly OPENERS (“ ‘) are excluded too."""
    assert '[^5]' not in M.normalize_all_footnote_refs('a[^45] Summit. "5 Questions with b[^47]')  # space before "
    assert '[^5]' not in M.normalize_all_footnote_refs('a[^45] (\"5 things) b[^47]')               # ( before "
    assert '[^4]' not in M.normalize_all_footnote_refs('a[^45] a 6"4 inch board b[^47]')           # digit before " (inch)
    assert '[^46]' not in M.normalize_all_footnote_refs('a[^45] then ‘46 quoted b[^47]')           # opening curly


def test_decade_apostrophe_is_not_mistaken_for_a_footnote():
    """'90s — the trailing 's' (not whitespace) means the \\s requirement never even forms a candidate,
    so a curly apostrophe before a decade can't be resurrected as a footnote."""
    assert '[^90]' not in M.normalize_all_footnote_refs('a[^45] the ’90s era b[^47]')


def test_unicode_and_latex_superscripts_become_markers():
    assert M.convert_footnotes('text¹² here') == 'text[^12] here'
    assert M.normalize_all_footnote_refs('see $^{5}$ here') == 'see [^5] here'


# --- The shared per-page marker converter (was copy-pasted in 3 assemblers) -------------------------

def test_per_page_converter_handles_each_marker_form():
    """convert_inline_footnote_markers is the single shared per-page converter (page_bottom /
    chapter_endnotes / document_endnotes). It converts superscript, LaTeX, [N], and bare-number-after-
    punctuation (capital-after heuristic, since per-page can't sequence-validate)."""
    assert M.convert_inline_footnote_markers('text¹ here') == 'text[^1] here'
    assert M.convert_inline_footnote_markers('see $^{5}$ here') == 'see [^5] here'
    assert M.convert_inline_footnote_markers('a claim[5] then') == 'a claim[^5] then'
    assert '[^46]' in M.convert_inline_footnote_markers('end of sentence.46 The next one')


def test_per_page_converter_guards_decimals_and_initials():
    """The (?<!\\d\\.) / (?<![A-Z]\\.) guards: decimals (4.0) and initials (V.2) are not markers."""
    assert M.convert_inline_footnote_markers('about 4.0 Million people') == 'about 4.0 Million people'
    assert M.convert_inline_footnote_markers('see V.2 Above here') == 'see V.2 Above here'


def test_per_page_converter_strip_italic_brackets_flag():
    """document_endnotes variant: *[2]* unwraps to [2] then converts to [^2]."""
    assert '[^2]' in M.convert_inline_footnote_markers('a point*[2]* then', strip_italic_brackets=True)


# --- Layer 3: the missing-def matcher (pure logic, was untested) ------------------------------------

def test_recovers_only_numbers_absent_from_ocr():
    """Defs already present in the OCR are left alone; only the genuinely-missing ones come back."""
    got = M.recover_missing_defs({1, 2}, {0: [(1, 'a'), (3, 'c')], 1: [(4, 'd')]}, max_ref_number=4)
    assert got == [(3, 'c'), (4, 'd')]


def test_range_filter_drops_out_of_range_numbers():
    """A pypdf 'def' numbered above the document's max ref (or < 1) is noise, not a footnote."""
    got = M.recover_missing_defs(set(), {0: [(3, 'real'), (99, 'noise'), (0, 'bad')]}, max_ref_number=5)
    assert got == [(3, 'real')]


def test_dedup_keeps_first_occurrence_across_pages():
    got = M.recover_missing_defs(set(), {0: [(3, 'first')], 1: [(3, 'second')]}, max_ref_number=5)
    assert got == [(3, 'first')]


def test_page_offsets_shift_pypdf_numbers_before_matching():
    """Multi-paper PDFs: pypdf returns ORIGINAL per-paper numbers; the page offset maps them onto the
    assembled doc's shifted IDs before the present/range checks."""
    got = M.recover_missing_defs(set(), {1: [(2, 'x')]}, max_ref_number=200, page_offsets={1: 100})
    assert got == [(102, 'x')]


def test_allow_overwrite_emits_even_when_present():
    """Mojibake recovery path: the existing OCR def is corrupt, so re-emit even though the number is
    already in the set."""
    got = M.recover_missing_defs({3}, {0: [(3, 'clean text')]}, max_ref_number=5, allow_overwrite=True)
    assert got == [(3, 'clean text')]
    # default (no overwrite) skips it
    assert M.recover_missing_defs({3}, {0: [(3, 'clean text')]}, max_ref_number=5) == []


def test_targeted_pages_restricts_scan():
    got = M.recover_missing_defs(set(), {0: [(1, 'a')], 1: [(2, 'b')]}, max_ref_number=5,
                                 targeted_pages={1})
    assert got == [(2, 'b')]

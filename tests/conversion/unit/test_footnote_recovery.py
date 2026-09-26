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


def test_run_on_affiliation_def_splits_on_ascending_boundaries():
    # a280cf5b: items 2..5 glued mid-line into item 1's text — only 1 starts a line.
    from ingestion.pdf.recovery import split_run_on_numbered_def
    text = ('School of International Development, University of East Anglia, Norwich, UK '
            '2 Programme Strategy and Impact Team (PSIT), Oxfam GB, Oxford, UK '
            '3 African Climate and Development Initiative, University of Cape Town, South Africa '
            '4 Institute for Environment and Sanitation Studies, University of Ghana, Accra '
            '5 Watershed Organisation Trust, Satara road, Pune, India '
            'Correspondence: (e-mail: r.few@uea.ac.uk)')
    out = split_run_on_numbered_def(1, text)
    assert [n for n, _t in out] == [1, 2, 3, 4, 5]
    assert out[1][1].startswith('Programme Strategy and Impact Team')
    assert out[4][1] == 'Watershed Organisation Trust, Satara road, Pune, India'  # chrome trimmed


def test_def_merely_mentioning_a_number_never_splits():
    from ingestion.pdf.recovery import split_run_on_numbered_def
    text = 'As examined in section 2 of the report, the committee reviewed all materials.'
    assert split_run_on_numbered_def(1, text) == [(1, text)]


def test_running_footer_chrome_rejected_by_duplicate_text():
    # Page-number + running-footer lines pattern-match as defs under DIFFERENT numbers.
    from ingestion.pdf.recovery import recover_missing_defs
    chrome = 'PALGRAVE COMMUNICATIONS | 3:17092 | DOI: 10.1057/palcomms.2017.92'
    defs = {1: [(2, chrome)], 3: [(4, chrome)], 0: [(1, 'A genuine footnote definition text here.')]}
    out = recover_missing_defs(set(), defs, 10)
    assert out == [(1, 'A genuine footnote definition text here.')]


# --- Layer 4: DEF TEXT repair — pypdf's letters, the OCR's word boundaries ---------------------------
# The two witnesses fail in OPPOSITE directions, which is the whole basis of the repair. The embedded
# text layer is not recognised, so its LETTERS are exact — but PDF text is positioned glyph by glyph,
# so its spacing is junk ("John Braithw aite", "Commo nwealth"). OCR reads the page as an image, so it
# gets word boundaries right and invents letters ("Breithwaite", "Gentelink"). Before this layer, the
# OCR's invented words shipped as the author's own citation: deloitte2025independent had 55 of 136
# notes damaged ("Gentelink's Automated Debt Raising" for Centrelink's, "Minelle Hildebrandt" /
# "Rigorthmic Regulation" for Mireille Hildebrandt's 'Algorithmic Regulation', "No TUV/W Law Journal"
# for "No 1 UNSW Law Journal"), every one of them clean in the PDF's own text layer, and citation
# resolution could not match any of them. The merge is pure logic — pinned here, no PDF needed.

def test_invented_words_are_replaced_with_the_text_layers_letters():
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, ratio = _respace_from_pypdf(
        'Commonwealth Ombudsman, Gentelink’s Automated Debt Raising and Recovery System '
        '(Report No 3 of 2017, April 2017) 79.',
        'Commo nwealth Ombudsman , Centrelink’s Au tomated Debt Raising and Recovery System '
        '(R eport No 3 of 2017, April 2017) 7–9.',
    )
    # OCR's invented "Gentelink" loses to the text layer, and the mangled pinpoint is fixed too.
    assert 'Centrelink’s' in out
    assert 'Gentelink' not in out
    assert out.endswith('April 2017) 7–9.')
    assert ratio > 0.9


def test_text_layer_spacing_never_survives_the_repair():
    """pypdf's spacing is positional junk — the OCR's word boundaries are mapped onto its letters."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, _ratio = _respace_from_pypdf(
        'Minelle Hildebrandt, *Rigorthmic Regulation and the Rule of Law* (2018) 376 '
        '*Philosophical Transactions of the Royal Society A: Mathematical, Physical* 1, 3–4.',
        'Mireille Hildebrandt, ‘Algo rith mic Regu lation and the R ule of Law’ (2018) 376 '
        'Philosophical Transactions of the Royal Society A: Mat hematical, Physical 1, 3–4.',
    )
    assert 'Mireille' in out and 'Algorithmic Regulation' in out
    for split_word in ('Algo rith mic', 'Regu lation', 'R ule', 'Mat hematical'):
        assert split_word not in out


def test_markdown_emphasis_is_carried_across_the_repair():
    """The text layer has no markdown, so emphasis must be lifted out and put back — and a CLOSING
    asterisk belongs BEFORE the following space ("Regulation* (Oxford", not "Regulation *(Oxford")."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, _ratio = _respace_from_pypdf(
        'John Breithwaite, *Restorative Justice and Responsive Regulation* '
        '(Oxford University Press, 2002) 29–32.',
        'John Braithw aite,Restorativ e Justice and Responsive Regulation '
        '(Oxford University Press, 2002) 29 –32.',
    )
    assert out == ('John Braithwaite, *Restorative Justice and Responsive Regulation* '
                   '(Oxford University Press, 2002) 29–32.')


def test_the_authors_name_is_corrected_without_importing_text_layer_spacing():
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, _ratio = _respace_from_pypdf(
        'Roger Brownword, ‘Respect and Technol Regulation’ (2020) 6(1) Law Technology and Humans 1.',
        'Roger Brownsw ord,‘Respect and Techno -Regulatio n’ (2020) 6(1)Law , Technology and Humans 1.',
    )
    assert 'Brownsword' in out and 'Brownword' not in out
    assert 'Regulation' in out and 'Regulatio n' not in out


# The three artifact classes below are why the repair substitutes INDIVIDUAL TOKENS rather than
# rebuilding a definition from the text layer. An earlier version did rebuild, and the regression
# fixtures caught it importing each of these along with the genuine fix.

def test_line_break_hyphenation_is_never_pulled_into_a_word():
    """Justified PDF text carries the hyphen from its line wrap. pypdf reports "anderer-seits" and
    "Blu-men"; the OCR correctly joined them up. A repair that trusts the text layer here corrupts
    prose (fixture 5fc4aad4) — a hyphen between LETTERS is not a difference worth acting on."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    ocr = ('Translation from German: „Wo man sich einerseits ausgeschlossen fühlt, andererseits '
           'plötzlich neue Formen von Blumen.')
    out, ratio = _respace_from_pypdf(
        ocr,
        ('Translation from German: „Wo man sich einerseits ausgeschlossen fühlt, anderer-seits '
         'plötzlich neue Formen von Blu-men.'),
    )
    assert out is None, out
    assert ratio > 0.9  # similar enough to repair — refused on the hyphen rule, not the gate


def test_a_hyphen_between_digits_IS_repaired():
    """The flip side: "7-9" flattened to "79" is a real pinpoint error, so a hyphen between DIGITS
    stays significant even though a hyphen between letters does not."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, _ratio = _respace_from_pypdf(
        'Commonwealth Ombudsman, Report No 3 of 2017, April 2017, 79.',
        'Commonwealth Ombudsman, Report No 3 of 2017, April 2017, 7–9.',
    )
    assert out is not None and out.endswith('7–9.')


def test_quote_glyph_direction_is_left_to_the_ocr():
    """pypdf reads German „…“ as „…” . OCR is the better witness for directional quotes, so a
    difference that is only punctuation must not trigger a substitution (fixture 5fc4aad4)."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, _ratio = _respace_from_pypdf(
        'Translation from German: „Zwangsentschleunigung“.',
        'Translation from German: „Zwangsentschleunigung”.',
    )
    assert out is None


def test_trailing_page_chrome_is_never_appended():
    """The extractor's continuation glue can carry a copyright footer onto a definition. Because the
    repair walks the OCR's OWN tokens, there is nothing to append it to (fixture 7fa30289)."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    ocr = 'Elaborated in further works: Fuchs/Hofkirchner/Klauninger (2001), Fuchs 2002b-f, i-k, 2003a'
    out, _ratio = _respace_from_pypdf(
        ocr, ocr + ')©ViennaUniversityofTechnology2003.')
    assert out is None or 'ViennaUniversity' not in out


def test_a_different_note_is_refused_rather_than_overwritten():
    """The gate that stops the repair becoming corruption: below the similarity floor the pypdf def is
    a DIFFERENT note (or extractor noise), and rewriting from it would destroy a good definition."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, ratio = _respace_from_pypdf(
        'Karen Yeung, ‘Algorithmic Regulation: A Critical Interrogation’ (2018) 12(4) '
        'Regulation & Governance 505, 510–13.',
        'Torben M Andersen and Michael Svarer, ‘Flexicurity: Labour Market Performance in '
        'Denmark’ (2007) 53(3) CESifo Economic Studies 389, 395–401.',
    )
    assert out is None
    assert ratio < 0.85


def test_spacing_only_difference_keeps_the_ocr_text():
    """Same letters, different spaces: the OCR's spacing is the GOOD one, so nothing is rewritten."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    ocr = 'Ian Ayres and John Braithwaite, Responsive Regulation (Oxford University Press, 1992) 35.'
    out, ratio = _respace_from_pypdf(ocr, 'Ian Ayres and John Braithw aite, Responsiv e Regulation '
                                          '(Oxford University Press, 1992) 35.')
    assert out is None
    assert ratio == 1.0


def test_repair_rewrites_defs_in_place_without_adding_or_dropping_any():
    """The pass is text-only: definition COUNT and numbering are untouched (recovery owns those)."""
    from ingestion.pdf.recovery import repair_def_text_from_pypdf
    combined = (
        'Body text with a ref[^72] and another[^73].\n\n'
        '[^72]: John Breithwaite, *Restorative Justice and Responsive Regulation* '
        '(Oxford University Press, 2002) 29–32.\n'
        '[^73]: Australian Law Reform Commission, Traditional Rights and Problems—Encroachments '
        'by Commonwealth Laws (ALRC Report No 129, December 2015) 149–54.\n'
    )
    pypdf_defs = {
        67: [
            (72, 'John Braithw aite,Restorativ e Justice and Responsive Regulation '
                 '(Oxford University Press, 2002) 29 –32.'),
            (73, 'Au stralian Law Reform Co mmission ,Traditional Right s and Freedoms—Encroachment s '
                 'by Commonwealth Laws (ALRC Report No 129, December 2015) 149 –54.'),
        ],
    }
    out, repairs = repair_def_text_from_pypdf(combined, pypdf_defs)
    assert len(repairs) == 2
    assert 'Braithwaite' in out and 'Breithwaite' not in out
    assert 'Traditional Rights and Freedoms' in out and 'Rights and Problems' not in out
    # Same definitions, same order, body untouched.
    import re as _re
    assert _re.findall(r'^\[\^(\d+)\]:', out, _re.MULTILINE) == ['72', '73']
    assert 'Body text with a ref[^72] and another[^73].' in out


def test_repair_honours_page_offsets_like_recovery_does():
    """Multi-paper PDFs shift the assembled ids; pypdf always returns print-space numbers."""
    from ingestion.pdf.recovery import repair_def_text_from_pypdf
    combined = '[^102]: Commonwealth Ombudsman, Gentelink’s Automated Debt System (2017) 79.\n'
    out, repairs = repair_def_text_from_pypdf(
        combined,
        {5: [(2, 'Commo nwealth Ombudsman , Centrelink’s Au tomated Debt System (2017) 7–9.')]},
        page_offsets={5: 100},
    )
    assert [r['number'] for r in repairs] == [102]
    assert 'Centrelink’s' in out


def test_underscores_in_a_repaired_url_survive():
    """Underscore is NOT held aside as emphasis. Held aside, it is stripped from the alignment stream
    and therefore DELETED from any substituted token — which turns a working government URL into a
    dead one ("…/Parliamentary_Business/…/Education_and_Employment/…" came back as
    "…/ParliamentaryBusiness/…/EducationandEmployment/…", deloitte fn20). Wrong-but-plausible links
    are worse than none, so this is pinned."""
    from ingestion.pdf.recovery import _respace_from_pypdf
    out, _ratio = _respace_from_pypdf(
        'Sanate Education and Employment Committee (Report, February 2019) '
        'https://www.ohr.gov.au/Parliamentary_Business/Committees/Sanate/Education_and_Employment/Report',
        'Senate Education and Employment Committee (Report, February 2019) '
        'https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Education_and_Employment/Report',
    )
    assert out is not None
    assert 'Parliamentary_Business' in out
    assert 'Education_and_Employment' in out
    assert 'aph.gov.au' in out and 'ohr.gov.au' not in out


def test_stray_digits_are_never_appended_to_a_pinpoint():
    """A pinpoint is short, so a few stray characters change its meaning. With a flat 4-character
    allowance "510–13." became "510–13.7268" — page furniture appended to a citation, i.e. an INVENTED
    page range (deloitte fn72). The tolerance scales with the token and floors at 2."""
    from ingestion.pdf.recovery import _respace_from_pypdf, _plausible_substitution
    assert _plausible_substitution('510–13.7268', len('510–13.')) is False
    assert _plausible_substitution('Centrelink’s', len('Gentelink’s')) is True
    assert _plausible_substitution('Responsibility', len('Respondility')) is True
    out, _ratio = _respace_from_pypdf(
        'Karen Yeung, ‘Algorithmic Regulation’ (2018) 12(4) Regulation and Governance 505, 510–13.',
        'Karen Yeung, ‘Algorithmic Regulation’ (2018) 12(4) Regulation and Governance 505, 510–13.7268',
    )
    assert out is None or '7268' not in out


# ---------------------------------------------------------------------------
# Layer 5 — a definition whose CONTINUATION LINE the OCR dropped
#
# deloitte note 1 prints over two lines: the citation, then its aph.gov.au URL. The OCR kept
# only the first, so the def is a truncated PREFIX of the note — and the whole-string
# similarity then reads "different note" and refuses the repair, so "Failing Thaw" (for
# "Failing Those") shipped from a text layer that had it right all along. The URL went with
# it, which is the one thing citation resolution can act on directly.
# ---------------------------------------------------------------------------

NOTE1_OCR = ('Senate Education and Employment References Committee, *Jobactive: Failing Thaw '
             'It Is Intended to Serve* (Report, February 2019)')
NOTE1_LAYER = ('Senate Education and Employment Ref erences Committee, Jobactiv e: Failing '
               'Those It Is Int ended to Serve(Report, February 2019) '
               'https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/'
               'Education_and_Employment/JobActive2018/Report .')


def test_a_dropped_url_line_no_longer_defeats_the_repair():
    """The failure is arithmetic, not semantic: our def is ~120 chars against the layer's
    ~230, so the symmetric ratio is 0.65 and the 0.85 floor refuses a note it matches word
    for word. Both numbers are pinned because the gap between them IS the bug."""
    import difflib
    whole_ratio = difflib.SequenceMatcher(
        None, M._strip_tokens(NOTE1_OCR)[0].lower(),
        M._strip_tokens(NOTE1_LAYER)[0].lower(), autojunk=False).ratio()
    assert whole_ratio < 0.70, 'the pre-fix comparison, which refused at the 0.85 floor'

    repaired, ratio = M._respace_from_pypdf(NOTE1_OCR, NOTE1_LAYER)
    assert ratio > 0.97
    assert 'Failing Those' in repaired and 'Thaw' not in repaired


def test_the_dropped_line_is_restored_when_it_is_a_url():
    repaired, _ratio = M._respace_from_pypdf(NOTE1_OCR, NOTE1_LAYER)
    assert repaired.endswith(
        'https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/'
        'Education_and_Employment/JobActive2018/Report')
    # the emphasis the OCR added survives untouched
    assert '*Jobactive: Failing Those It Is Intended to Serve*' in repaired


def test_a_wrapped_url_is_de_whitespaced_on_the_way_in():
    """pypdf breaks a URL wherever the glyphs fell, so the restored link has to be rejoined
    or it is as dead as the one it replaces."""
    ocr = ('Department of Employment and Workplace Relations, Workforce Australia Caseload '
           'Time Series (Report, 17 April 2025)')
    layer = ocr + (' https://www.dewr.gov.au/employment -\nservices-data/resources/workfo '
                   'rce-australia-caseload-time-series.')
    repaired, _ratio = M._respace_from_pypdf(ocr, layer)
    assert repaired.endswith('https://www.dewr.gov.au/employment-services-data/resources/'
                             'workforce-australia-caseload-time-series')


def test_page_chrome_glued_to_the_layer_def_is_never_appended():
    """The extractor glues up to 700 characters of the following page onto a page's last
    note. Restoring THAT is the whole-def rebuild this module exists to avoid."""
    ocr = 'Karl Marx, *Capital* (Penguin, 1976) 12.'
    layer = ('Karl Marx, Capital (Penguin, 1976) 12. Independent Review of Targeted '
             'Compliance Framework | Executive Summary')
    assert M._respace_from_pypdf(ocr, layer)[0] is None


def test_a_prose_continuation_is_not_restored():
    """Only a URL. There is no syntactic check for prose, so a non-URL tail is left for the
    content-fidelity verdict to make VISIBLE rather than guessed at."""
    ocr = 'Department of Employment and Workplace Relations (Cth), Statement of Work'
    layer = ocr + ' (copy on file with author).'
    repaired, _ratio = M._respace_from_pypdf(ocr, layer)
    assert repaired is None or 'copy on file' not in repaired


def test_a_def_that_already_carries_the_url_is_not_given_a_second_one():
    ocr = 'Dept, *Report* (2025) https://www.dewr.gov.au/x'
    assert M._respace_from_pypdf(ocr, 'Dept, Report (2025) https://www.dewr.gov.au/x')[0] is None


def test_a_confirmed_pairing_lowers_the_floor_for_that_number_only():
    """Once the page's whole block has been aligned against the text layer, identity is
    settled and the similarity floor is only in the way: "Michael Avasarheya and Miklos A.
    Alas, 'The Naw Economy'" scores 0.42 against the note it plainly is."""
    ocr = ('Michael Avasarheya and Miklos A. Alas, "The \'Naw\' Economy and the Need for '
           'Continuous Assurance and Reporting" (2008) 22(2) *International Journal of '
           'Accounting Information Systems* 1, 3-4.')
    # ...and the reason it scores so low is the extractor's own 700-character glue: this is
    # a page's LAST note, so the text layer's copy carries the next page's opening.
    layer = ('Michael A Vasarhelyi and Miklos A Alles, \'The "N ow" Eco nomy and the Need f or '
             'Continuous Assurance and Reporting\' (2008) 22(2) International Journal of '
             'Accounting Information Systems 1, 3-4. 1.3.4 Compliance Model Design and '
             'Maturity (Cont.) In relation to the defect issues identified by the Department, '
             'evidence shows that despite processing flaws, the IT system still proceeded to '
             'progress participant cases into compliance action.')
    combined = '[^20]: ' + ocr + '\n'
    defs = {0: [(20, layer)]}

    untouched, repairs = M.repair_def_text_from_pypdf(combined, defs)
    assert repairs == [] and untouched == combined

    fixed, repairs = M.repair_def_text_from_pypdf(combined, defs, confirmed_numbers={20})
    assert repairs and 'Vasarhelyi' in fixed and 'Alles' in fixed
    assert 'Avasarheya' not in fixed
    # the glue that dragged the ratio down must not be dragged in with the fix
    assert 'Compliance Model Design' not in fixed


# ---------------------------------------------------------------------------
# The printed PAGE NUMBER glued to the first note's number
# ---------------------------------------------------------------------------

def test_a_page_number_glued_to_a_note_number_is_split():
    """deloitte page 7 arrives as "75 Department of Employment…" — folio 7, note 5. Read
    literally it is note 75, which belongs to no page map, so the note gets no witness at
    all: its definition shipped with a wholly invented URL the text layer could have fixed."""
    defs = {5: [(4, 'The previous page last note.')],
            6: [(75, 'Department of Employment and Workplace Relations (Cth), Secretary'),
                (6, 'See as examples, Social Security.')]}
    M._unglue_page_numbers(defs)
    assert [n for n, _t in defs[6]] == [5, 6]


def test_a_genuine_high_note_number_is_left_alone():
    """The negative that matters: on folio 7, a real note 75 on an already-ascending page
    must not be silently renumbered to 5 — that is the same class of damage as the bug."""
    defs = {5: [(74, 'The previous page last note.')],
            6: [(75, 'A real note seventy-five.'), (76, 'And seventy-six.')]}
    M._unglue_page_numbers(defs)
    assert [n for n, _t in defs[6]] == [75, 76]


# ---------------------------------------------------------------------------
# Whose words are these? — the CONTENT twin of assess_harvest_fidelity
# ---------------------------------------------------------------------------

def test_a_fabricated_definition_is_reported_as_unwitnessed():
    layer = {5: [(1, NOTE1_LAYER), (2, 'Ibid.'),
                 (3, 'Social Security (Administ ration) Act 1999 (Cth) pt 3 div 3AA.'),
                 (4, 'Department of Employment and Workplace Relations (Cth), Statement of '
                     'Work - Statement of Assurance on t he Operat ions of t he T argeted '
                     'Compliance Framework (ESE24/1263, 28 November 2024).')]}
    md = ('[^1]: ' + NOTE1_OCR + '\n'
          '[^2]: EIER (2019) *How to Make a World: A Guide to the TCF* (Report, February 2019)\n'
          '[^3]: Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA.\n'
          '[^4]: Department of Employment and Workplace Relations (Cth), Statement of Work - '
          'Statement of Assurance on the Operations of the Targeted Compliance Framework '
          '(ESE24/1263, 28 November 2024).\n')
    record = M.assess_def_content_fidelity(md, layer)
    assert record['decision'] == 'def_content=content_unwitnessed'
    assert [u['number'] for u in record['evidence']['unwitnessed_defs']] == [2]


def test_no_text_layer_means_no_verdict():
    """The cached-OCR replay runs without a PDF. A verdict there would be unsupported."""
    assert M.assess_def_content_fidelity('[^1]: Anything at all, at length.\n', {}) is None


def test_a_layer_that_corroborates_nothing_is_reported_as_an_unusable_witness():
    """A scanned PDF, a subset font, an excerpt whose pages we never had — the unreliable
    party is the LAYER, and calling the book's citations fabricated on that evidence is the
    very error this exists to prevent."""
    layer = {0: [(1, 'Utterly unrelated text about something else entirely, at length.')]}
    md = ('[^1]: Senate Education and Employment References Committee, Jobactive.\n'
          '[^2]: Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA.\n')
    record = M.assess_def_content_fidelity(md, layer)
    assert record['decision'] == 'def_content=not_witnessable'
    assert record['confidence'] == 0.9


def test_a_short_definition_is_not_judged_either_way():
    layer = {0: [(1, 'Social Security (Administ ration) Act 1999 (Cth) pt 3 div 3AA.')]}
    md = '[^1]: Ibid.\n[^2]: Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA.\n'
    record = M.assess_def_content_fidelity(md, layer)
    assert record['evidence']['too_short_to_judge'] == 1
    assert record['evidence']['defs_judged'] == 1


def test_a_confirmed_pair_drops_page_glue_before_comparing():
    """The third appearance of the same length trap, and the reason the fix is scoped to a
    CONFIRMED pair. The extractor glues up to 700 characters of the FOLLOWING PAGE onto a
    page's last note, so deloitte's 229-character note 6 is matched against a 678-character
    layer copy ending "1.3 Analysis and Findings Over the past two years…". The surplus drags
    the ratio to 0.52 and the repair declines a note that otherwise matches almost exactly —
    leaving a dead URL (guides.dss.gov/socialsecurity-guide for guides.dss.gov.au/social-
    security-guide) in a citation the text layer had right.

    Dropping the tail is only safe once IDENTITY is settled, which for a confirmed pair the
    block alignment has already done; unconfirmed, the length gate is still the guard against
    a wrongly-paired note and must keep refusing.
    """
    ocr = ('See as examples, Social Security Administration (Non-Compliance) Determination '
           '2018 (No 1) (Cth); Department of Social Services (Cth), Social Security Guide '
           '(Version 1.329, 12 May 2025) https://guides.dss.gov/socialsecurity-guide')
    layer = ('See as examples, Social Security (Administration) (No n -Compliance) Determinatio n '
             '2018 (N o 1) (Cth); Department o f So cial Services (Cth), So cial Security Guide '
             '(Version 1.329, 12 May 2025) https://guides.dss.gov.au/social -security-guide. '
             '1.3 Analysis and Findings Over the past two years, the Department has taken steps '
             'to identify and address issues with the TCF and its supporting IT system.')

    refused, glued_ratio = M._respace_from_pypdf(ocr, layer, min_similarity=0.40)
    assert refused is None, 'unconfirmed, the glue still defeats the repair'

    repaired, ratio = M._respace_from_pypdf(ocr, layer, min_similarity=0.40,
                                            identity_confirmed=True)
    # Dropping the tail is the whole difference; assert the lift rather than a tuned figure,
    # since how much glue the extractor caught varies per page.
    assert ratio > 0.95 and ratio > glued_ratio
    assert 'https://guides.dss.gov.au/social-security-guide' in repaired
    # the glue that was cut off must not come back in with the fix
    assert 'Analysis and Findings' not in repaired


def test_a_repeated_short_form_is_not_running_footer_chrome():
    """The anti-chrome rule rejects any text appearing under two or more numbers, because a
    running footer does exactly that ("2 PALGRAVE COMMUNICATIONS | 3:17092 | DOI…" on page 2,
    "4 PALGRAVE…" on page 4). A back-reference also does exactly that — it is what it is FOR.
    deloitte prints "Ibid." twenty-odd times, so every one of them was silently discarded and
    its marker left with no definition; one of those slots came back carrying a fragment of
    the page's table instead."""
    defs = {0: [(21, 'Terry Carney, Automating Compliance and Administrative Justice.'),
                (22, 'Ibid.')],
            1: [(30, 'Another real note, long enough to be distinct from the first.'),
                (31, 'Ibid.')]}
    got = dict(M.recover_missing_defs(set(), defs, max_ref_number=40))
    assert got.get(22) == 'Ibid.' and got.get(31) == 'Ibid.'


def test_real_running_footer_chrome_is_still_rejected():
    footer = 'PALGRAVE COMMUNICATIONS | 3:17092 | DOI: 10.1057/palcomms.2017.92 | www.nature.com'
    assert M.recover_missing_defs(set(), {1: [(2, footer)], 3: [(4, footer)]}, 40) == []


def test_a_repeated_paragraph_is_furniture_whatever_it_opens_with():
    """The exemption is for SHORT forms. A repeated paragraph that happens to begin "Ibid."
    is still page furniture."""
    long_repeat = 'Ibid. ' + ('and then a long repeated run of page furniture text ' * 3)
    assert M.recover_missing_defs(set(), {0: [(5, long_repeat)], 1: [(6, long_repeat)]}, 40) == []


def test_a_date_is_not_a_marker_seam():
    """"(Report, 17 April 2025)" is word, punctuation, number, capitalised word — the exact
    shape of a glued marker seam. Planting [^17] there puts a marker inside another note's
    definition; nothing about the seam itself can tell the two apart."""
    seams = list(M._marker_seams('Workforce Australia Caseload Time Series (Report, 17 April '
                                 '2025) https://example.org/x\n'))
    assert all(n != 17 for _w, n, _a, _f in seams)


def test_the_ordinary_glued_seam_still_fires():
    seams = [(w, n, f) for w, n, _a, f in M._marker_seams('mitigate risk.9 This ensures that\n')]
    assert ('risk', 9, 'This') in seams

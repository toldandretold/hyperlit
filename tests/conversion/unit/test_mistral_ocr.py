"""Unit tests for the PDF (Mistral OCR) front-end text transforms — mistral_ocr.py.

PDFs are the hardest, most varied pathway and a primary driver for vibe-conversion. All
the footnote logic here is pure text->text (the OCR JSON is replayed, no API call), so it
unit-tests cleanly. These pin: superscript/bracket/LaTeX -> [^N] conversion, the SEQUENTIAL
VALIDATION that stops years/table-numbers becoming footnotes, page-local -> global
renumbering (page_bottom docs restart at [^1] every page), body/footnote splitting,
page-break paragraph rejoining, and OCR-mojibake detection.
"""

import mistral_ocr as M


# ---------------------------------------------------------------------------
# convert_footnotes — Unicode superscripts -> [^N]
# ---------------------------------------------------------------------------
def test_convert_single_superscript():
    assert M.convert_footnotes('claim² here') == 'claim[^2] here'


def test_convert_multidigit_superscript_run():
    # ¹² (consecutive superscripts) -> 12
    assert M.convert_footnotes('claim¹² here') == 'claim[^12] here'


def test_convert_footnotes_leaves_plain_text():
    assert M.convert_footnotes('no superscripts at all') == 'no superscripts at all'


# ---------------------------------------------------------------------------
# normalize_all_footnote_refs — [N]/LaTeX/bare -> [^N] with sequential validation
# ---------------------------------------------------------------------------
def test_latex_superscript_becomes_ref():
    assert M.normalize_all_footnote_refs('mass$^{5}$ energy') == 'mass[^5] energy'


def test_bracket_ref_validated_between_knowns():
    # [2] sits between known [^1] and [^3] -> valid footnote ref
    out = M.normalize_all_footnote_refs('a[^1] b [2] c[^3] d')
    assert out == 'a[^1] b [^2] c[^3] d'


def test_year_in_brackets_not_converted():
    # [2015] is a year (>500) and there's no footnote sequence -> left alone
    text = 'as reported [2015] in the data'
    assert M.normalize_all_footnote_refs(text) == text


def test_out_of_sequence_bracket_rejected():
    # [9] does not fit between known [^1] and [^2] -> NOT converted (no confident guess)
    out = M.normalize_all_footnote_refs('a[^1] b [9] c[^2] d')
    assert '[9]' in out
    assert out.count('[^') == 2   # only the two known refs


# ---------------------------------------------------------------------------
# normalize_footnote_defs — line-start [N] -> [^N] definitions
# ---------------------------------------------------------------------------
def test_def_line_start_converted_when_in_sequence():
    out = M.normalize_footnote_defs('[^1]: first\n[2] second note here')
    assert '[^2] second note here' in out


def test_def_without_known_sequence_unchanged():
    text = '[3] this has no known [^N] def anywhere'
    assert M.normalize_footnote_defs(text) == text


# ---------------------------------------------------------------------------
# renumber_page_footnotes — page-local -> global sequential
# ---------------------------------------------------------------------------
def test_renumber_offsets_from_counter():
    out, counter = M.renumber_page_footnotes('a[^1] and b[^2].', 5)
    assert out == 'a[^5] and b[^6].'
    assert counter == 7


def test_renumber_restart_across_two_pages():
    # page_bottom: each page restarts at [^1]; global numbering must keep climbing
    p1, c = M.renumber_page_footnotes('first[^1]', 1)
    p2, c = M.renumber_page_footnotes('second[^1]', c)
    assert p1 == 'first[^1]'
    assert p2 == 'second[^2]'
    assert c == 3


def test_renumber_converts_superscript_first():
    out, counter = M.renumber_page_footnotes('claim¹.', 1)
    assert out == 'claim[^1].'
    assert counter == 2


def test_renumber_detects_bottom_definition():
    page = 'Claim[^1].\n\n1. The footnote definition text.'
    out, counter = M.renumber_page_footnotes(page, 1)
    assert '[^1]: The footnote definition text.' in out
    assert counter == 2


# ---------------------------------------------------------------------------
# split_body_and_footnotes
# ---------------------------------------------------------------------------
def test_split_separates_definitions():
    body, foot = M.split_body_and_footnotes('Body text[^1] here.\n[^1]: the note content')
    assert body == 'Body text[^1] here.'
    assert foot.startswith('[^1]: the note content')


def test_split_no_definitions_returns_empty_footnotes():
    body, foot = M.split_body_and_footnotes('Just body text[^1] with a ref.')
    assert body == 'Just body text[^1] with a ref.'
    assert foot == ''


# ---------------------------------------------------------------------------
# is_page_number_header / extract_section_name
# ---------------------------------------------------------------------------
def test_is_page_number_header():
    assert M.is_page_number_header('42') is True
    assert M.is_page_number_header('  42  ') is True
    assert M.is_page_number_header('Chapter One') is False
    assert M.is_page_number_header('') is False


def test_extract_section_name_strips_page_numbers():
    assert M.extract_section_name('Introduction 35') == 'Introduction'
    assert M.extract_section_name('42 The Title') == 'The Title'
    assert M.extract_section_name('Plain Heading') == 'Plain Heading'
    assert M.extract_section_name('42') is None
    assert M.extract_section_name('') is None


# ---------------------------------------------------------------------------
# rejoin_page_breaks
# ---------------------------------------------------------------------------
def test_rejoin_hyphenated_word_break():
    out = M.rejoin_page_breaks('accumu-\n\nlation of capital')
    assert 'accumulation of capital' in out


def test_rejoin_paragraph_continuation():
    out = M.rejoin_page_breaks('This is a fairly long opening line\n\nthat continues onward')
    assert 'opening line that continues onward' in out


def test_rejoin_keeps_sentence_boundary():
    # ends with a period + next line is a new sentence -> must NOT be merged
    text = 'A complete sentence ends here.\n\nNew paragraph begins here'
    out = M.rejoin_page_breaks(text)
    assert 'ends here. New paragraph' not in out


def test_rejoin_footnote_ref_not_mistaken_for_sentence_end():
    # trailing [^3] is stripped before the sentence-end check, so the paragraph still joins
    out = M.rejoin_page_breaks('a long clause carrying on[^3]\n\nand finishing the thought')
    assert 'carrying on[^3] and finishing the thought' in out


# ---------------------------------------------------------------------------
# compute_printable_ratio — OCR mojibake detection
# ---------------------------------------------------------------------------
def test_printable_ratio_clean_text():
    assert M.compute_printable_ratio('Hello, world! Café — naïve.') == 1.0


def test_printable_ratio_empty_is_one():
    assert M.compute_printable_ratio('') == 1.0


def test_printable_ratio_mojibake_low():
    assert M.compute_printable_ratio('\x00\x01\x02\x03\x04') < 0.2


# ---------------------------------------------------------------------------
# classify_footnotes — the PDF footnote-STRATEGY decision (page_bottom vs
# document_endnotes vs none ...). The hardest, most error-prone PDF judgement.
# ---------------------------------------------------------------------------
def _resp(*page_markdowns, headers=None):
    pages = []
    for i, md in enumerate(page_markdowns):
        page = {"markdown": md}
        if headers and i < len(headers) and headers[i]:
            page["header"] = headers[i]
        pages.append(page)
    return {"pages": pages}


def test_classify_none_when_no_footnotes():
    out = M.classify_footnotes(_resp(
        'Just plain prose with no notes whatsoever.',
        'A second page, also free of any footnote markers.',
    ))
    assert out['classification'] == 'none'
    assert out['confidence'] == 1.0


def _page_bottom_page(a, b):
    # co-located refs (inline) + defs (line-start), restarting each page
    return (f'Some claim[^{a}] and another claim[^{b}] in the body.\n\n'
            f'[^{a}]: First note on this page.\n'
            f'[^{b}]: Second note on this page.')


def test_classify_page_bottom_with_resets():
    # every page restarts at [^1]/[^2] with notes at the bottom -> page_bottom
    out = M.classify_footnotes(_resp(
        _page_bottom_page(1, 2), _page_bottom_page(1, 2),
        _page_bottom_page(1, 2), _page_bottom_page(1, 2),
    ))
    assert out['classification'] == 'page_bottom'
    assert out['signals']['reset_count'] >= 1


def test_classify_document_endnotes():
    # 11 body pages each carrying one inline ref, all definitions clustered on a
    # single trailing page -> document_endnotes (no co-location, defs not clustered per-page)
    body_pages = [f'Body prose carrying a claim[^{i}] mid-sentence here.' for i in range(1, 12)]
    defs_page = '\n'.join(f'[^{i}]: note number {i} content.' for i in range(1, 12))
    out = M.classify_footnotes(_resp(*body_pages, defs_page))
    assert out['classification'] == 'document_endnotes'


def test_classify_returns_signals_and_summary():
    out = M.classify_footnotes(_resp(_page_bottom_page(1, 2)))
    assert out['version'] == 1
    assert 'co_location_ratio' in out['signals']
    assert isinstance(out['page_summary'], list)


# ---------------------------------------------------------------------------
# classify_footnotes fork-story (assessment.json) — considered / margin / rationale
# ---------------------------------------------------------------------------
def test_classify_emits_falsifiable_fork_story():
    out = M.classify_footnotes(_resp(
        _page_bottom_page(1, 2), _page_bottom_page(1, 2),
        _page_bottom_page(1, 2), _page_bottom_page(1, 2),
    ))
    # rationale + margin present
    assert out['rationale']
    assert out['margin']
    # considered lists every OTHER layout, each with rejected_because + would_need
    opts = {c['option'] for c in out['considered']}
    assert out['classification'] not in opts          # not itself
    assert 'document_endnotes' in opts and 'none' in opts
    for c in out['considered']:
        assert c['rejected_because'] and c['would_need']


def test_unknown_classification_margin_is_loud_fallthrough():
    # The 'unknown' fall-through must be a flagged, visible record (where silent PDF
    # failures hide) — test the story-builder directly so it's deterministic.
    sig = {'co_location_ratio': 0.25, 'reset_frequency': 0.2, 'notes_page_count': 0,
           'ref_number_max_page_spread': 1, 'def_clustering_ratio': 0.3, 'max_ref_number': 5,
           'pages_with_refs': 3}
    rationale, considered, margin = M._pdf_classification_story('unknown', sig)
    assert 'FALL-THROUGH' in margin
    assert 'fell through' in rationale
    assert {c['option'] for c in considered} == set(M._PDF_CLASSES) - {'unknown'}


# ---------------------------------------------------------------------------
# Footer footnote-definition recovery — assemble_markdown must pull page-bottom
# definitions the OCR split into the `footer` field back into the body. Dropping
# them was the Calvo-Clause bug: 58 defs collapsed to 5, every marker unmatched.
# ---------------------------------------------------------------------------
import re as _re


def _assemble(pages, classification='unknown'):
    return M.assemble_markdown({'pages': pages}, classification=classification,
                               footnote_meta=None, pdf_path=None)


def test_footer_superscript_defs_recovered_into_body():
    pages = [
        {'index': 0, 'markdown': 'A claim.[^1] Another claim.[^2]', 'footer': '', 'header': ''},
        {'index': 1, 'markdown': 'More prose.[^3]',
         'footer': '¹ First note.\n² Second note.\n³ Third note.', 'header': ''},
    ]
    md = _assemble(pages)
    assert _re.findall(r'^\[\^(\d+)\]:', md, _re.M) == ['1', '2', '3']
    assert 'First note.' in md


def test_footer_latex_defs_recovered():
    pages = [{'index': 0, 'markdown': 'Body.[^25]',
              'footer': '$^{25}$ Hackworth, Digest, pp. 501-526.', 'header': ''}]
    md = _assemble(pages)
    assert '[^25]: Hackworth' in md


def test_plain_number_footer_not_pulled_in():
    # "6 Engels…" is ambiguous with list items / page numbers; the normaliser leaves it as
    # prose, so we must NOT pull it in (else it becomes an unlinked paragraph). This is the
    # soviet_marxism case that a broader gate wrongly injected.
    pages = [{'index': 0, 'markdown': 'Body text here.',
              'footer': '6 Engels, Letter to Franz Mehring, July 14, 1893.', 'header': ''}]
    md = _assemble(pages)
    assert '[^6]:' not in md
    assert 'Engels, Letter to Franz Mehring' not in md


def test_pure_chrome_footer_ignored():
    pages = [{'index': 0, 'markdown': 'Body.', 'footer': 'Journal of Something  •  509', 'header': ''}]
    md = _assemble(pages)
    assert 'Journal of Something' not in md


def test_chapter_endnotes_skips_footer_recovery():
    # chapter_endnotes applies a per-chapter offset; a stray page-bottom def would be re-keyed
    # to the wrong note (a confident wrong link), so footer recovery is intentionally skipped.
    pages = [{'index': 0, 'markdown': 'Body.[^1]', 'footer': '¹ A page-bottom note.', 'header': ''}]
    md = _assemble(pages, classification='chapter_endnotes')
    assert 'A page-bottom note.' not in md


def test_footer_helper_gate_direct():
    assert M._footer_footnote_defs('¹ note') == '¹ note'
    assert M._footer_footnote_defs('$^{7}$ note') == '$^{7}$ note'
    assert M._footer_footnote_defs('[^7] note') == '[^7] note'
    assert M._footer_footnote_defs('6 plain note') == ''
    assert M._footer_footnote_defs('509') == ''
    assert M._footer_footnote_defs('') == ''

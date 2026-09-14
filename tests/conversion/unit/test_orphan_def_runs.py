"""Orphan-def recovery for BARE-NUMBER definitions left in the body, and the URL opener that made
half of them invisible.

Two shapes, both from 5fc4aad4 / ffbb3ac7:

  • A RUN of sibling page-bottom notes ("4 Translation from German: …" … "8 Translation from
    German: …") whose numbers are all orphaned in-text markers. The run rule used to demand that
    the run CONTINUE an already-converted def ([^first-1]: exists) — 5fc4aad4's notes start at 4
    (1–3 never survived OCR), so it never fired, and the prose-length gate on the single-paragraph
    path rescued only the two long notes. The three short ones stayed in the body as paragraphs.

  • A note whose text is nothing but a URL. Every def scan demanded a capital / quote opener, so
    "2 http://wokinfo.com/…, accessed on July 26, 2013" was not a definition anywhere in the
    pipeline — not in the OCR-side scan, not in the pypdf text-layer rescue.
"""

import re

import ingestion.pdf.assembly as A
from ingestion.pdf.pdf_shared import collect_page_refs_and_defs


def _body(refs, defs):
    return ('Prose citing the notes ' + ' '.join(f'[^{n}]' for n in refs)
            + ' and continuing afterwards.\n\n' + '\n\n'.join(defs))


def test_run_of_orphaned_bare_number_defs_is_recovered_without_a_preceding_def():
    md = _body([4, 5, 6, 7, 8], [
        '4 Translation from German: „Zwangsentschleunigung“.',
        '5 Translation from German: „Dem steht eine massive Verlangsamung im realen physischen '
        'Leben gegenüber, wo man sich einerseits stillgelegt fühlt.“',
        '6 Translation from German: „Beziehungen werden suspekt“.',
        '7 Translation from German: „wachsende Entfremdung“.',
        '8 Translation from German: „Wir haben Zeit. Wir können plötzlich hören.“',
    ])
    out = A._recover_orphan_plain_defs(md)
    for n in (4, 5, 6, 7, 8):
        assert f'[^{n}]: Translation from German' in out
    # the def paragraphs left the body — no bare "6 Translation…" line survives
    assert not re.search(r'(?m)^\d Translation from German', out)


def test_a_numbered_list_is_not_a_def_run():
    # The numbers are not orphaned markers, so the run rule must not touch the list.
    md = ('Prose with no footnote markers at all.\n\n'
          '1. First item of a genuine list.\n\n2. Second item.\n\n3. Third item.')
    assert A._recover_orphan_plain_defs(md) == md


def test_two_line_run_still_needs_the_preceding_def_anchor():
    # Below three, the anchor is the only thing separating a def run from a stray pair of lines.
    md = _body([4, 5], ['4 Some short note.', '5 Another short note.'])
    assert A._recover_orphan_plain_defs(md) == md


def test_url_only_definition_is_recognised_by_the_ocr_side_scan():
    page = ('Body text with a marker[^2] in it.\n\n'
            '2 http://wokinfo.com/essays/journal-selection-process/, accessed on July 26, 2013.')
    _refs, defs = collect_page_refs_and_defs(page)
    assert 2 in defs


def test_url_only_run_is_recovered_as_definitions():
    md = _body([1, 2, 3], [
        '1 http://thecostofknowledge.com/, accessed on July 26, 2013.',
        '2 http://wokinfo.com/essays/journal-selection-process/, accessed on July 26, 2013.',
        '3 http://www.doaj.org/doaj?func=loadTemplate&template=about, accessed on July 26, 2013.',
    ])
    out = A._recover_orphan_plain_defs(md)
    for n in (1, 2, 3):
        assert f'[^{n}]: http' in out


# ---------------------------------------------------------------------------
# The document-end footnote block must read 1..N — the pypdf rescue appends what it found after
# the defs the OCR already produced (ffbb3ac7: 4,7,8,9,10,11 then 1,2,3,5).
# ---------------------------------------------------------------------------
def test_trailing_def_block_is_ordered_by_number():
    md = ('Body prose.\n\n[^4]: Fourth note.\n\n[^7]: Seventh note.\n\n[^10]: Tenth note.\n\n'
          '[^1]: First note.\n\n[^2]: Second note.')
    out = A._order_trailing_def_block(md)
    nums = [int(m) for m in re.findall(r'(?m)^\[\^(\d+)\]:', out)]
    assert nums == [1, 2, 4, 7, 10]
    assert out.startswith('Body prose.')


def test_ordering_never_detaches_a_continuation_paragraph():
    # A non-def paragraph inside the block is the previous def's page-spanning continuation; the
    # run stops there rather than reordering across it.
    md = ('Body prose.\n\n[^4]: Fourth note that runs on\n\n'
          'and continues in lowercase here.\n\n[^2]: Second note.\n\n[^1]: First note.')
    out = A._order_trailing_def_block(md)
    assert 'Fourth note that runs on\n\nand continues in lowercase here.' in out
    nums = [int(m) for m in re.findall(r'(?m)^\[\^(\d+)\]:', out)]
    assert nums == [4, 1, 2]


# ---------------------------------------------------------------------------
# A page-bottom note the text layer glued to the END of another line, after the whitespace run that
# stands in for the footnote rule. pypdf's content-stream order does this constantly, and the
# line-anchored scan can never see it (5fc4aad4 note 11: "…out right-wing radio talk show host Rush
# ␣␣␣11 Data source: https://www.alexa.com/siteinfo/breitbart.com, …").
# ---------------------------------------------------------------------------
def test_gap_glued_definition_is_extracted():
    from ingestion.pdf.recovery import _GAP_DEF_RE
    text = ('out right-wing radio talk show host Rush                     '
            '11 Data source: https://www.alexa.com/siteinfo/breitbart.com, accessed 27 March 2020')
    m = _GAP_DEF_RE.search(text)
    assert m and int(m.group(1)) == 11
    assert m.group(2).startswith('Data source:')


def test_gap_glued_scan_ignores_a_short_table_value():
    from ingestion.pdf.recovery import _GAP_DEF_RE, MIN_GAP_DEF_CHARS
    text = 'Share of OA journals in the sample        12 Value'
    m = _GAP_DEF_RE.search(text)
    assert m is None or len(m.group(2).strip()) < MIN_GAP_DEF_CHARS


def test_gap_glued_scan_needs_a_definition_opener():
    from ingestion.pdf.recovery import _GAP_DEF_RE
    # lowercase prose after the number is not a definition
    assert _GAP_DEF_RE.search('continues the argument       12 and then the sentence goes on here') is None

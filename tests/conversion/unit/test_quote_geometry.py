"""Geometric blockquote detection (quote_geometry.py) — pure-function tests on synthetic
line data mirroring the real measurements from 244ae673 (body x=72, quote block x=106,
body FIRST-LINE indents at x=108, i.e. 2pt from the quote indent).

The PDF-reading entry (detect_indented_quote_blocks) needs a real PDF and is validated at
reconvert time; everything below it is deterministic geometry + alignment and is pinned here.
"""

import re
from ingestion.pdf.quote_geometry import (
    lines_from_fragments, body_margin, indented_runs, run_paragraphs,
    wrap_geometry_blockquotes,
)


def _page(specs):
    """specs: list of (x, y, text) lines already in top-down order."""
    return [(x, y, t) for x, y, t in specs]


def test_fragments_group_into_lines_min_x_wins():
    frags = [(270.7, 653.2, 'e about being a Sioux'), (106.1, 653.2, 'At times I became defensiv'),
             (106.1, 639.5, 'had a pedigree')]
    lines = lines_from_fragments(frags)
    assert lines[0] == (106.1, 653.2, 'At times I became defensive about being a Sioux')
    assert lines[1][0] == 106.1


def test_body_margin_is_document_mode():
    lines = [(72.0, y, 'body line') for y in range(700, 400, -14)] + \
            [(106.0, y, 'quote line') for y in range(390, 350, -14)]
    assert body_margin(lines) == 72.0


def test_indented_run_detected_and_first_line_indent_ignored():
    lines = _page([
        (72.0, 700, 'body text at the margin'),
        (108.0, 686, 'a body paragraph FIRST line (108 = first-line indent)'),
        (72.0, 672, 'its continuation back at the margin'),
        (106.0, 658, 'quote line one'),
        (106.0, 644, 'quote line two'),
        (106.0, 630, 'quote line three'),
        (72.0, 616, 'body resumes'),
    ])
    runs = indented_runs(lines, 72.0, page_height=800)
    assert len(runs) == 1
    assert [t for _x, _y, t in runs[0]] == ['quote line one', 'quote line two', 'quote line three']


def test_far_column_and_bottom_strip_excluded():
    lines = _page([
        (72.0, 700, 'left column body'),
        (330.0, 700, 'right column line one'),      # beyond MAX_INDENT — another column
        (330.0, 686, 'right column line two'),
        (106.0, 60, 'footnote def line one'),        # bottom strip
        (106.0, 46, 'footnote def line two'),
    ])
    assert indented_runs(lines, 72.0, page_height=800) == []


def test_run_paragraphs_split_on_pitch_jump():
    run = [(106.0, 700, 'para one line one'), (106.0, 686, 'para one line two'),
           (106.0, 658, 'para two line one'), (106.0, 644, 'para two line two')]
    paras = run_paragraphs(run)
    assert paras == ['para one line one para one line two', 'para two line one para two line two']


QUOTE1 = ('During my three years as Executive Director of the National Congress of American '
          'Indians it was a rare day when some white person did not visit my office.')
QUOTE2 = ('At times I became quite defensive about being a Sioux when these white people had '
          'a pedigree that was so much more respectable than mine.')
BODY = ('Settler nativism is a settler move to innocence with a long history in the United '
        'States and elsewhere, discussed at length in what follows here.')
# Geometry skips the first FRONT_MATTER_PARAS paragraphs (title/authors/affiliations zone) —
# tests place their targets beyond it, as real quotes are.
PAD = '\n\n'.join(f'Front matter filler paragraph number {i} for the front-matter guard.'
                  for i in range(10))


def test_matched_block_paragraphs_merge_into_one_blockquote():
    md = (PAD + '\n\n' + BODY + '\n\n' + QUOTE1 + '\n\n' + QUOTE2
          + '\n\nMore body text follows after the quotation.')
    out, n = wrap_geometry_blockquotes(md, [[QUOTE1, QUOTE2]])
    assert n == 2
    assert '> ' + QUOTE1 + '\n>\n> ' + QUOTE2 in out
    assert '> ' + BODY not in out


def test_ambiguous_prefix_wraps_nothing():
    md = QUOTE1 + '\n\n' + QUOTE1 + '\n\nOther text.'
    out, n = wrap_geometry_blockquotes(md, [[QUOTE1]])
    assert n == 0 and '> ' not in out


def test_list_paragraphs_never_wrap():
    listy = ('i. Settler nativism\nii. Fantasizing adoption\niii. Colonial equivocation')
    bullet = '- the Orientalism of Indigenous Americans (Berger, 2004; Marez, 2007)'
    md = listy + '\n\n' + bullet + '\n\n' + BODY
    out, n = wrap_geometry_blockquotes(md, [[('i. Settler nativism ii. Fantasizing adoption '
                                              'iii. Colonial equivocation')], [bullet]])
    assert n == 0 and '> ' not in out


def test_typographically_wrapped_member_absorbed_into_merge():
    md = PAD + '\n\n' + QUOTE1 + '\n\n' + '> ' + QUOTE2
    out, n = wrap_geometry_blockquotes(md, [[QUOTE1, QUOTE2]])
    assert '> ' + QUOTE1 + '\n>\n> ' + QUOTE2 in out


def test_multiline_paragraph_gets_every_line_prefixed():
    poem = 'when you take away the punctuation\nhe says of\nlines lifted from the documents about'
    md = PAD + '\n\n' + BODY + '\n\n' + poem
    out, _n = wrap_geometry_blockquotes(md, [[poem.replace('\n', ' ')]])
    assert ('> when you take away the punctuation\n> he says of\n'
            '> lines lifted from the documents about') in out


def test_short_generic_block_paragraph_skipped():
    md = 'A body paragraph that must stay untouched by tiny block fragments.\n\nYes indeed.'
    out, n = wrap_geometry_blockquotes(md, [['Yes indeed.']])
    assert n == 0 and '> ' not in out


def test_no_margin_candidates_on_chaotic_layout():
    # deloitte: no x holds >= 10% of lines — the margin model does not apply.
    from ingestion.pdf.quote_geometry import margin_candidates
    lines = [(float(x), 700 - i, f'line {i}') for i, x in enumerate(range(20, 320, 3))]
    assert margin_candidates(lines) == []


def test_mirrored_margins_resolve_per_page():
    from ingestion.pdf.quote_geometry import margin_candidates, page_body_margin
    recto = [(45.0, y, 'recto body') for y in range(700, 400, -14)]
    verso = [(54.0, y, 'verso body') for y in range(700, 400, -14)]
    cands = margin_candidates(recto + verso)
    assert set(cands) == {45.0, 54.0}
    assert page_body_margin(recto, cands) == 45.0
    assert page_body_margin(verso, cands) == 54.0


def test_quote_heavy_page_still_resolves_body_margin():
    # 244ae673 p10: 27 quote lines at 106 vs 11 body lines at 72 — the quote indent is never
    # a document-level candidate, so the page still resolves to the body margin.
    from ingestion.pdf.quote_geometry import page_body_margin
    page = [(106.0, 700 - i * 14, 'quote line') for i in range(27)] + \
           [(72.0, 300 - i * 14, 'body line') for i in range(11)]
    assert page_body_margin(page, [72.0]) == 72.0


def test_abstract_neighboured_by_keywords_never_wraps():
    abstract = ('This article explores the implications of the shift of environmental '
                'education towards education for sustainable development in some depth.')
    md = (PAD + '\n\n(Received 19 July 2011; final version received 23 December 2011)\n\n'
          + abstract + '\n\n'
          'Keywords: education for sustainable development; environmental education')
    out, n = wrap_geometry_blockquotes(md, [[abstract]])
    assert n == 0 and '> ' not in out


def test_wrap_share_cap_aborts_mass_wrapping():
    paras = [f'Body paragraph number {i} with enough length to match its block text safely.'
             for i in range(20)]
    md = '\n\n'.join(paras)
    out, n = wrap_geometry_blockquotes(md, [[p] for p in paras])
    assert n == 0 and '> ' not in out


def test_references_section_and_captions_never_wrap():
    entry = ('2016850). Rochester, NY: Social Science Research Network. Retrieved from '
             'http://papers.ssrn.com/abstract=2016850 with a hanging indent continuation.')
    caption = 'Table 2: Percentage of papers published in 2013-2014 with citation counts below the JIF.'
    md = (PAD + '\n\n' + caption + '\n\n## References\n\n'
          'Author, A. (2012). A cited work with a long title that wraps lines.\n\n' + entry)
    out, n = wrap_geometry_blockquotes(md, [[caption], [entry]])
    assert n == 0 and '> ' not in out


def test_front_matter_paragraphs_never_wrap():
    affil = 'Library Technology Services and Strategic Initiatives, University of Pennsylvania Libraries'
    md = 'Title of the paper here today\n\n' + affil + '\n\n' + PAD
    out, n = wrap_geometry_blockquotes(md, [[affil]])
    assert n == 0 and '> ' not in out


def test_table_rows_never_wrap():
    table = ('|  Table 2. Privacy Strategies  |   |\n| --- | --- |\n'
             '|  Used privacy settings to limit who can see posts | 76% |')
    md = PAD + '\n\n' + table + '\n\nBody paragraph after the table for good measure.'
    out, n = wrap_geometry_blockquotes(md, [[re.sub(r'\s+', ' ', table)]])
    assert n == 0 and '> ' not in out


def test_doubled_text_layer_deduped_so_first_line_indents_stay_single():
    # 709c9348: every line appears TWICE (original + overlay layer, ligature variants,
    # ~4-11pt apart) — undeduped, a body paragraph's single first-line indent becomes a
    # "2-line run" and plain body text wraps as a quote.
    from ingestion.pdf.quote_geometry import dedupe_text_layers, indented_runs
    lines = [
        (97.8, 699.3, 'In 1960, Garfield founded the Institute for Scientific Information'),
        (97.8, 688.5, 'In 1960, Garﬁeld founded the Institute for Scientiﬁc Information'),
        (76.6, 685.8, 'which became a powerful engine for developing innovative products'),
        (76.1, 675.0, 'which became a powerful engine for developing innovative products'),
    ]
    deduped = dedupe_text_layers(lines)
    assert len(deduped) == 2
    assert indented_runs(deduped, 76.0, page_height=800) == []


def test_small_font_footnote_lines_filtered():
    # 3f202e8f: a page-bottom FOOTNOTE CONTINUATION (small font, indented) rode above the
    # bottom-strip cut and wrapped as a quote — footnotes are set smaller than body text.
    from ingestion.pdf.quote_geometry import filter_small_font_lines
    lines = [(72.0, 700 - i * 14, f'body line {i}') for i in range(10)] + \
            [(106.0, 120, 'footnote continuation line one'), (106.0, 108, 'footnote line two')]
    sizes = {(x, y): 0.2 for x, y, _t in lines[:10]}
    sizes[(106.0, 120)] = 0.16
    sizes[(106.0, 108)] = 0.16
    kept = filter_small_font_lines(lines, sizes)
    assert len(kept) == 10 and all(x == 72.0 for x, _y, _t in kept)
    # unknown sizes are kept (degrade safe)
    assert len(filter_small_font_lines(lines, {})) == 12

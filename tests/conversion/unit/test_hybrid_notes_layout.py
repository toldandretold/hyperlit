"""A book that mixes THREE note layouts and prints numbered lists (book_1794776136517, "The Black
Panthers Speak"): a Foreword with its own end-notes, an Introduction with page-bottom notes, body
chapters whose notes sit at the back of the book — plus the Ten-Point Program, the 26 Rules and two
13-point lists set as "1. …" lines.

What went wrong, and what each block below pins:

  • the numbered LISTS were def-heavy pages, so their items became footnote definitions, while the
    Foreword's real notes (five on one page, one carried over) were never harvested
    → qualify_def_heavy_pages;
  • a marker whose own section lacked its note was wired to the first other section holding that
    number — "…women's liberation groups.⁶" opened a list item
    → MarkerLinkContext._find_in_sequential;
  • two printed shapes of page-bottom note ("⁶See…", "7 The entire issue…") never became definitions
    → harvest_page_bottom_notes;
  • a page-bottom definition left inline swallowed the body that followed it, up to the next
    definition (eight pages of the Introduction inside one note)
    → split_off_page_bottom_notes + the hoist in ChapterEndnotesAssembler;
  • a front-matter folio ("xxxiv") was injected as a heading mid-essay
    → extract_section_name.

The house rule throughout: an unlinked marker is recoverable, a wrong link is not.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pytest
from bs4 import BeautifulSoup

import mistral_ocr as M
from digestion.footnoteLinking.footnote_link_rules import MarkerLinkContext
from ingestion.pdf.assembly import (
    _fold_note_continuations,
    harvest_page_bottom_notes,
    insert_before_first_heading,
    qualify_def_heavy_pages,
    split_off_page_bottom_notes,
)
from ingestion.pdf.pdf_shared import extract_section_name


def _pages(*entries):
    """page_summary from (refs, defs) pairs, indexed in order."""
    return [{'index': i, 'refs': list(r), 'defs': list(d)} for i, (r, d) in enumerate(entries)]


# ---------------------------------------------------------------------------
# qualify_def_heavy_pages — which def-heavy pages are NOTES pages
# ---------------------------------------------------------------------------
def test_back_of_book_notes_cluster_qualifies_as_before():
    summary = _pages(([1, 2, 3], []), ([4, 5], []), ([], [1, 2, 3]), ([], [4, 5, 6]))
    assert qualify_def_heavy_pages(summary) == {2, 3}


def test_lone_def_heavy_page_never_qualifies():
    # No def-heavy neighbour: the pre-existing rule, unchanged at the back of the book…
    assert qualify_def_heavy_pages(_pages(([1, 2], []), ([], [1, 2, 3]))) == set()
    # …and mid-book, where a single page of "1. 2. 3." is a list.
    assert qualify_def_heavy_pages(_pages(([1, 2], []), ([], [1, 2, 3]), ([1, 2], []))) == set()


def test_list_between_continuing_markers_is_not_a_notes_section():
    # Markers 1–3, then a two-page numbered list, then markers 4–5: the numbering carries straight
    # on across the list, so the list did not close the run — it is not that run's notes.
    summary = _pages(([1, 2, 3], []), ([], [1, 2, 3, 4]), ([], [5, 6, 7, 8, 9, 10]), ([4, 5], []))
    assert qualify_def_heavy_pages(summary) == set()


def test_list_after_page_bottom_resolved_markers_is_not_claimed():
    # Every marker before the list already has its note at the foot of its own page.
    summary = _pages(([1, 2], [1, 2]), ([3], [3]), ([], [1, 2, 3, 4, 5]), ([], [6, 7, 8, 9, 10]),
                     ([1], []))
    assert qualify_def_heavy_pages(summary) == set()


def test_list_whose_numbers_stop_short_of_the_markers_is_not_claimed():
    # Markers run to 9; a 5-item list cannot be their notes.
    summary = _pages(([7, 8, 9], []), ([], [1, 2, 3]), ([], [4, 5]), ([1], []))
    assert qualify_def_heavy_pages(summary) == set()


def test_claimed_and_closing_block_qualifies_with_its_carry_over_page():
    # The Foreword: markers 2–6 (marker 1 lost), notes 1–5 on one page and 6 alone on the next,
    # then the Introduction restarts at 1. The carry-over page holds one note — never def-heavy.
    summary = _pages(([2, 3], []), ([4, 5, 6], []), ([], [1, 2, 3, 4, 5]), ([], [6]), ([1, 2], []))
    assert qualify_def_heavy_pages(summary) == {2, 3}


def test_carry_over_must_continue_the_numbering_exactly():
    # The following page starts at 9, not 6 — not the same block, so the block is one page: refused.
    summary = _pages(([2, 3], []), ([4, 5], []), ([], [1, 2, 3, 4, 5]), ([], [9]), ([1, 2], []))
    assert qualify_def_heavy_pages(summary) == set()


def test_mid_book_and_back_of_book_blocks_coexist():
    summary = _pages(([2, 3], []), ([4, 5, 6], []), ([], [1, 2, 3, 4, 5]), ([], [6]),   # foreword
                     ([1, 2], []), ([], [1, 2, 3]), ([], [4, 5, 6]), ([3, 4], []),       # a list
                     ([], [1, 2, 3]), ([], [4, 5, 6]))                                   # the Notes
    assert qualify_def_heavy_pages(summary) == {2, 3, 8, 9}


def test_chapter_assembler_setup_uses_the_qualifier():
    meta = {'page_summary': _pages(([1, 2, 3], []), ([], [1, 2, 3, 4]), ([], [5, 6, 7, 8]),
                                   ([4, 5], []))}
    ctx = M.AssemblyContext({"pages": [{"markdown": ""}] * 4}, 'chapter_endnotes', meta)
    M.ChapterEndnotesAssembler().setup(ctx)
    assert ctx.def_heavy_pages == set()


# ---------------------------------------------------------------------------
# harvest_page_bottom_notes — the glued and bare shapes of a page-bottom note
# ---------------------------------------------------------------------------
_LONG = 'The entire issue of The Black Panther for that week was devoted to the case.'


def test_glued_note_is_taken_as_the_next_note_of_a_run():
    run = [0, -1]
    harvest_page_bottom_notes('Body.\n\n[^5] In addition to the works cited above.', 4, run)
    assert run == [5, 4]
    out = harvest_page_bottom_notes('Body.\n\n[^6]See Eldridge Cleaver, a letter.', 5, run)
    assert '[^6]: See Eldridge Cleaver, a letter.' in out
    assert run == [6, 5]


def test_glued_shape_without_a_run_is_left_alone():
    md = 'Body.\n\n[^6]See Eldridge Cleaver, a letter.'
    assert harvest_page_bottom_notes(md, 5, [0, -1]) == md


def test_bare_note_is_taken_only_as_exactly_the_next_number():
    out = harvest_page_bottom_notes('Body.\n\n7 ' + _LONG, 9, [6, 8])
    assert '[^7]: ' + _LONG in out
    # two on is not "the next note"
    md = 'Body.\n\n8 ' + _LONG
    assert harvest_page_bottom_notes(md, 9, [6, 8]) == md


def test_bare_heading_like_line_is_too_short_to_be_a_note():
    md = 'Body.\n\n7 The Road Ahead'
    assert harvest_page_bottom_notes(md, 9, [6, 8]) == md


def test_bare_list_items_are_never_notes():
    # "2 …" is the next number after note 1, but "1 …" stands bare on the same page: a list.
    md = ('1 We want freedom. We want power to determine the destiny of our community.\n'
          '2 We want full employment for our people, and we want it now and for all.')
    assert harvest_page_bottom_notes(md, 3, [1, 2]) == md


def test_run_expires_after_a_few_pages():
    md = 'Body.\n\n7 ' + _LONG
    assert harvest_page_bottom_notes(md, 40, [6, 8]) == md


def test_a_notes_page_ends_the_run():
    run = [6, 8]
    harvest_page_bottom_notes('[^1]: Curtis J. Austin, Up Against the Wall.', 9, run)
    assert run == [0, -1]
    md = '7 ' + _LONG
    assert harvest_page_bottom_notes(md, 10, run) == md


# ---------------------------------------------------------------------------
# split_off_page_bottom_notes / _fold_note_continuations / insert_before_first_heading
# ---------------------------------------------------------------------------
def test_split_takes_everything_from_the_first_definition_to_the_page_foot():
    md = ('…thirty members of the Party should not go to\n\n'
          '[^1] In addition to the works cited.\n\n[^2]: A second note.')
    body, notes = split_off_page_bottom_notes(md)
    assert body == '…thirty members of the Party should not go to'
    assert notes == '[^1] In addition to the works cited.\n\n[^2]: A second note.'


def test_split_keeps_the_page_anchor_with_the_body():
    md = 'Body cut mid\n\n[^1]: A note. <a class="pageNumber" data-page="23"></a>'
    body, notes = split_off_page_bottom_notes(md)
    assert body == 'Body cut mid <a class="pageNumber" data-page="23"></a>'
    assert notes == '[^1]: A note.'


@pytest.mark.parametrize('md', [
    'Plain body with no note at all.',
    '## Footnotes\n\n[^1]: Curtis J. Austin, Up Against the Wall.',      # a notes section, not a foot
    '[^1]: A definition opening the page.',                             # nothing above it
    'Body.\n\n[^1]: A note.\n\n# Next Chapter\n\nMore body.',            # a heading after the def
    'Body.\n\n[^3]: Third.\n\n[^2]: Second.',                           # not ascending
])
def test_split_refuses_anything_but_an_unmistakable_page_foot(md):
    assert split_off_page_bottom_notes(md) == (md, '')


def test_inline_marker_is_not_a_definition_line():
    md = 'Body.\n\nA sentence ends here.[^4]\n\n[^4]. is not how a definition opens'
    assert split_off_page_bottom_notes(md) == (md, '')


def test_note_continuation_paragraphs_fold_into_the_definition():
    # Left as paragraphs of their own, extraction's interleaved-body test puts a long
    # capital-initial paragraph back into the body — it is the note's second paragraph.
    notes = ('[^1] In addition to the works cited.\n\n'
             'A criticism of a different nature, most sharply\nvoiced by Harold Cruse.\n\n'
             '[^2]: Second note.\n\n![img-0.jpeg](img-0.jpeg)\n\nIn view of the above.')
    assert _fold_note_continuations(notes) == (
        '[^1] In addition to the works cited.<br><br>A criticism of a different nature, most '
        'sharply voiced by Harold Cruse.\n\n'
        '[^2]: Second note.<br><br>![img-0.jpeg](img-0.jpeg)<br><br>In view of the above.')


def test_block_level_continuation_is_not_folded_and_ends_folding():
    notes = '[^1]: A note.\n\n> A quotation block.\n\nProse after the block.'
    assert _fold_note_continuations(notes) == notes


def test_insert_before_first_heading():
    assert insert_before_first_heading('tail of essay.\n\n# Next\n\nBody.', '[^1]: N.') == (
        'tail of essay.\n\n[^1]: N.\n\n# Next\n\nBody.')
    assert insert_before_first_heading('# Next\n\nBody.', '[^1]: N.') == '[^1]: N.\n\n# Next\n\nBody.'
    assert insert_before_first_heading('no heading here', '[^1]: N.') is None


# ---------------------------------------------------------------------------
# The hoist — ChapterEndnotesAssembler carries page-bottom notes to the section's end
# ---------------------------------------------------------------------------
def _assemble(pages):
    ctx = M.AssemblyContext({"pages": pages}, 'chapter_endnotes', None)
    asm = M.ChapterEndnotesAssembler()
    asm.setup(ctx)
    for i, page in enumerate(pages):
        md = page.get("markdown", "")
        asm.per_page(ctx, i, page, md, md.strip())
    return ctx, asm


def test_page_bottom_notes_land_above_the_next_heading():
    ctx, _ = _assemble([
        {"markdown": 'should not go to\n\n[^1] In addition to the works cited.'},
        {"markdown": 'Sacramento, thirty members went.\n\n[^2] A second note here.'},
        {"markdown": 'the essay ends.\n\n# Black Panther National Anthem\n\nYes.'},
    ])
    # the cut sentence's halves are adjacent parts again, with no definition between them
    assert ctx.md_parts[0] == 'should not go to'
    assert ctx.md_parts[1] == 'Sacramento, thirty members went.'
    assert ctx.md_parts[2] == ('the essay ends.\n\n[^1] In addition to the works cited.\n\n'
                               '[^2] A second note here.\n\n# Black Panther National Anthem\n\nYes.')


def test_page_bottom_notes_land_above_a_notes_page():
    ctx, _ = _assemble([
        {"markdown": 'body text\n\n[^1] A page-bottom note.'},
        {"markdown": '[^2]: An end-note.', "header": "Notes"},
    ])
    assert ctx.md_parts == ['body text', '[^1] A page-bottom note.\n\n[^2]: An end-note.']


def test_page_bottom_notes_with_no_later_heading_close_the_document():
    ctx, asm = _assemble([
        {"markdown": 'body text\n\n[^1] A page-bottom note.'},
        {"markdown": 'more body text, and the book ends.'},
    ])
    combined = asm.post_combine(ctx, "\n\n".join(ctx.md_parts))
    assert combined.index('more body text') < combined.index('[^1]: A page-bottom note.')


def test_a_notes_page_is_never_split():
    ctx, _ = _assemble([
        {"markdown": 'Preamble to the notes.\n\n[^1]: An end-note.\n\n[^2]: Another.', "header": "NOTES"},
    ])
    assert ctx.md_parts == ['Preamble to the notes.\n\n[^1]: An end-note.\n\n[^2]: Another.']


# ---------------------------------------------------------------------------
# extract_section_name — a front-matter folio is not a section
# ---------------------------------------------------------------------------
@pytest.mark.parametrize('folio', ['i', 'iv', 'ix', 'xiv', 'xxxiv', 'xl', 'lxxxviii'])
def test_lower_case_roman_folio_is_not_a_section_name(folio):
    assert extract_section_name(folio) is None


@pytest.mark.parametrize('name', ['II', 'IV', 'Introduction', 'Foreword', 'xiii Preface', 'civil'])
def test_real_section_names_survive_the_folio_rule(name):
    # Upper-case numerals can be part dividers; a word that merely uses roman letters is a word.
    assert extract_section_name(name) is not None


# ---------------------------------------------------------------------------
# MarkerLinkContext._find_in_sequential — a marker binds to its OWN section's notes
# ---------------------------------------------------------------------------
_SEQ_HTML = ('<body>'
             '<a class="footnoteSectionStart" id="fnRefSection_1"></a><p id="a">Foreword.</p>'
             '<a class="footnoteSectionStart" id="fnRefSection_2"></a><p id="b">Introduction.</p>'
             '<a class="footnoteSectionStart" id="fnRefSection_3"></a><p id="c">Body.</p>'
             '</body>')


def _seq_ctx(seq_map, html=_SEQ_HTML):
    s = BeautifulSoup(html, 'html.parser')
    return s, MarkerLinkContext(s, s.find_all(True), 'sequential', {}, seq_map, {}, [])


def _notes(*numbers, tag=''):
    return {str(n): {'unique_fn_id': f'{tag}{n}'} for n in numbers}


def test_marker_links_within_its_own_section():
    own, other = {'unique_fn_id': 'A'}, {'unique_fn_id': 'B'}
    s, ctx = _seq_ctx({'1': {'6': own}, '2': {'6': other}})
    assert ctx.find_footnote_data('6', s.find(id='a')) is own
    assert ctx.find_footnote_data('6', s.find(id='b')) is other


def test_out_of_order_definition_does_not_cost_the_rest_their_links():
    # 7fa30289: "[^3]:" is printed before "[^1]:", so ONE run of notes becomes two def sections
    # while the markers stay one ref section. Def sections do not mirror ref sections — a number
    # missing from "its own" section but defined exactly once in the document is still that note.
    html = ('<body><a class="footnoteSectionStart" id="fnRefSection_1"></a>'
            '<p id="a">One[^1] two[^2] three[^3].</p></body>')
    seq_map = {'1': _notes(3), '2': _notes(1, 2, 4)}
    s, ctx = _seq_ctx(seq_map, html)
    for number in ('1', '2', '3'):
        assert ctx.find_footnote_data(number, s.find(id='a'))['unique_fn_id'] == number


def test_section_without_a_definition_block_falls_back_to_a_unique_holder():
    only = {'unique_fn_id': 'B'}
    s, ctx = _seq_ctx({'1': {'6': {'unique_fn_id': 'A'}}, '2': {'7': only}})
    assert ctx.find_footnote_data('7', s.find(id='c')) is only


def test_fallback_refuses_when_several_sections_hold_the_number():
    # The reported bug: a Foreword marker whose note was not harvested, with the same number
    # defined in two LATER sections. First-match picked one; neither is determinable.
    s, ctx = _seq_ctx({'1': {'6': {'unique_fn_id': 'A'}}, '2': {'6': {'unique_fn_id': 'B'}}})
    assert ctx.find_footnote_data('6', s.find(id='c')) is None


# One continuous run of notes cut where a number REPEATS — in the markers and in the definitions
# (f07b7fff: 87 closes one chapter's block and opens the next). Ref sections 1-2 carry the
# markers; def sections 1-2 are numbered independently and sit after them.
_SEAM_HTML = ('<body>'
              '<a class="footnoteSectionStart" id="fnRefSection_1"></a>'
              '<p id="a">Early[^85] and[^86] the last of the chapter.[^87]</p>'
              '<a class="footnoteSectionStart" id="fnRefSection_2"></a>'
              '<p id="b">The next chapter opens.[^87] Then[^88] on[^89].</p>'
              '<a class="footnoteSectionStart" id="fnRefSection_3"></a><p id="c">Tail[^90].</p>'
              '<p id="d1">[^85]: a</p><p id="d2">[^87]: Hayek</p><p id="d3">[^87]: Stallman</p>'
              '</body>')


def _seam_map():
    # Keyed so that NEITHER marker's own-ordinal section holds 87 — the shape the fixture has.
    return {'8': _notes(85, 86, 87, tag='early-'), '9': _notes(87, 88, 89, 90, tag='late-')}


def test_seam_repeat_pairs_each_marker_with_its_own_side_of_the_seam():
    s, ctx = _seq_ctx(_seam_map(), _SEAM_HTML)
    assert ctx.find_footnote_data('87', s.find(id='a'))['unique_fn_id'] == 'early-87'
    assert ctx.find_footnote_data('87', s.find(id='b'))['unique_fn_id'] == 'late-87'


def test_seam_repeat_survives_markers_already_wired():
    # Linking runs in document order: by the time the second 87 is asked about, the first is a
    # <sup>87</sup>. Both shapes must count as "this section cites 87".
    s, ctx = _seq_ctx(_seam_map(), _SEAM_HTML.replace('chapter.[^87]', 'chapter.<sup>87</sup>'))
    assert ctx.find_footnote_data('87', s.find(id='b'))['unique_fn_id'] == 'late-87'


def test_a_definition_line_is_not_counted_as_a_marker():
    # "[^87]: Hayek" sits under ref section 3. Counted as a marker it would make THREE citing
    # sections and the seam would be refused.
    s, ctx = _seq_ctx(_seam_map(), _SEAM_HTML)
    assert 87 not in ctx._marker_numbers_by_ref_section().get('3', set())


def test_a_restart_is_never_read_as_a_seam():
    # Chaptered book: every chapter has a note 3. Marker 3 of a chapter whose notes were lost
    # must not be handed another chapter's note 3 just because two chapters cite it.
    html = ('<body>'
            '<a class="footnoteSectionStart" id="fnRefSection_1"></a><p id="a">A[^1] b[^2] c[^3].</p>'
            '<a class="footnoteSectionStart" id="fnRefSection_2"></a><p id="b">D[^1] e[^2] f[^3].</p>'
            '</body>')
    seq_map = {'8': _notes(1, 2, 3, tag='x-'), '9': _notes(1, 2, 3, 4, tag='y-')}
    s, ctx = _seq_ctx(seq_map, html)
    assert ctx.find_footnote_data('3', s.find(id='a')) is None
    assert ctx.find_footnote_data('3', s.find(id='b')) is None


@pytest.mark.parametrize('html_edit, map_edit', [
    # a third section also cites 87 — which two pair is no longer determinable
    (lambda h: h.replace('Tail[^90]', 'Tail[^87]'), lambda m: m),
    # a third def section also holds 87
    (lambda h: h, lambda m: {**m, '10': _notes(87, 91, tag='x-')}),
    # only ONE section cites 87 (the other marker was lost): two notes, one marker
    (lambda h: h.replace('opens.[^87]', 'opens.'), lambda m: m),
])
def test_seam_rule_refuses_anything_but_the_exact_shape(html_edit, map_edit):
    s, ctx = _seq_ctx(map_edit(_seam_map()), html_edit(_SEAM_HTML))
    assert ctx.find_footnote_data('87', s.find(id='a')) is None


def test_fallback_finds_nothing_when_no_section_holds_the_number():
    s, ctx = _seq_ctx({'1': {'6': {'unique_fn_id': 'A'}}})
    assert ctx.find_footnote_data('9', s.find(id='c')) is None


# ---------------------------------------------------------------------------
# End to end — the real book (git-ignored fixture; skipped where absent)
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
_PY = os.path.join(_REPO, 'app', 'Python')
_FIXTURE = os.path.join(_REPO, 'tests', 'conversion', 'fixtures-local', 'book_1794776136517')
_OCR = os.path.join(_FIXTURE, 'ocr_response.json')
_PDF = os.path.join(_FIXTURE, 'source.pdf')


@pytest.fixture(scope='module')
def panthers():
    """Replay the cached OCR (with the real PDF, as the fixture's stage_pdf does) through the whole
    pipeline; return (nodes, defs_by_id)."""
    env = dict(os.environ, PYTHONHASHSEED='0')
    tmp = tempfile.mkdtemp(prefix='hybridnotes_')
    try:
        shutil.copy2(_OCR, os.path.join(tmp, 'ocr_response.json'))
        for cache in ('quote_geometry.json', 'heading_geometry.json'):
            src = os.path.join(_FIXTURE, cache)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(tmp, cache))
        for cmd in (
            [sys.executable, os.path.join(_PY, 'mistral_ocr.py'), _PDF, tmp],
            [sys.executable, os.path.join(_PY, 'simple_md_to_html.py'),
             os.path.join(tmp, 'main-text.md'), os.path.join(tmp, 'intermediate.html')],
            [sys.executable, os.path.join(_PY, 'process_document.py'),
             os.path.join(tmp, 'intermediate.html'), tmp, 'book_1794776136517'],
        ):
            r = subprocess.run(cmd, env=env, capture_output=True, text=True)
            assert r.returncode == 0, f'{cmd[1]} failed: {r.stderr[-400:]}'
        with open(os.path.join(tmp, 'nodes.jsonl')) as f:
            nodes = [json.loads(line) for line in f]
        with open(os.path.join(tmp, 'footnotes.jsonl')) as f:
            defs = {row['footnoteId']: row['content'] for row in map(json.loads, f)}
        return nodes, defs
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_needs_fixture = pytest.mark.skipif(
    not (os.path.isfile(_OCR) and os.path.isfile(_PDF)),
    reason='fixtures-local/book_1794776136517 (ocr_response.json + source.pdf) not present')

_SUP_AFTER_RE = r'{anchor}\s*<sup class="footnote-ref"[^>]*\bid="([^"]+)"'


def _note_after(nodes, defs, anchor):
    """Content of the note whose marker stands directly after `anchor`, or None when unlinked."""
    pattern = re.compile(_SUP_AFTER_RE.format(anchor=re.escape(anchor)))
    for node in nodes:
        m = pattern.search(node.get('content', ''))
        if m:
            return defs.get(m.group(1))
    return None


@_needs_fixture
def test_the_reported_marker_opens_its_own_foreword_note(panthers):
    nodes, defs = panthers
    note = _note_after(nodes, defs, 'liberation groups.')
    assert note is not None, 'the Foreword marker is unlinked'
    assert 'Liberation and Gay Liberation Movements' in note
    assert 'Huey P. Newton' in note


@_needs_fixture
def test_no_numbered_list_item_became_a_footnote(panthers):
    _, defs = panthers
    notes = ' '.join(defs.values())
    # The Ten-Point Program's first point and the Rules' first rule are body text.
    assert 'We want freedom. We want power' not in notes
    assert 'We want freedom' in ' '.join(n.get('content', '') for n in panthers[0])


@_needs_fixture
def test_no_page_bottom_note_swallows_the_introduction(panthers):
    nodes, defs = panthers
    # The Introduction's closing words are body, and no note runs to pages of text.
    assert not any('continue to speak for a long time to come' in c for c in defs.values())
    assert any('continue to speak for a long time to come' in n.get('content', '') for n in nodes)
    assert max(len(c) for c in defs.values()) < 4000


@_needs_fixture
def test_no_folio_heading_inside_the_introduction(panthers):
    nodes, _ = panthers
    headings = [re.sub(r'<[^>]+>', '', n.get('content', '')).strip()
                for n in nodes if n.get('type', '').startswith('h')]
    assert headings, 'no heading nodes found'
    assert 'xxxiv' not in headings

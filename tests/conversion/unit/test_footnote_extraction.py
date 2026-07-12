"""Characterization tests for footnote-DEFINITION extraction (conversion/footnotes.py:
process_whole_document_footnotes / process_sequential_footnotes).

This is where multi-paragraph footnote definitions are assembled, and it serves BOTH the
markdown and Word (pandoc->html->core) pathways. The key invariant — flagged by the author —
is that each definition must be its OWN paragraph (blank-line separated in source). A
continuation paragraph (no [^N]: marker) is absorbed into the preceding note; the next
[^N]: paragraph starts a new note.

⚠️ KNOWN LIMITATION pinned below (test_two_defs_in_one_paragraph_loses_second): if two
definitions share a single <p> (no line gap — what pandoc produces for consecutive non-blank
lines), the second definition is silently swallowed as text into the first. Source authors /
the md+docx front-ends must keep one blank line between definitions.
"""

from bs4 import BeautifulSoup

from digestion.footnoteExtraction.footnotes import process_whole_document_footnotes


def _whole(html):
    fmap, data = process_whole_document_footnotes(BeautifulSoup(html, 'html.parser'), 'bk')
    return fmap, data


# ---------------------------------------------------------------------------
# Multi-paragraph definitions (the author's reason for the blank-line rule)
# ---------------------------------------------------------------------------
def test_multiparagraph_definition_absorbs_continuation():
    # def <p> + a following non-marker <p> -> ONE note, paragraphs joined with <br><br>
    _, data = _whole(
        '<p>[^1]: First paragraph of note one.</p>'
        '<p>Second paragraph of the same note.</p>'
        '<p>[^2]: Note two.</p>'
    )
    assert len(data) == 2
    assert data[0]['content'] == ('First paragraph of note one.<br><br>'
                                  'Second paragraph of the same note.')
    assert data[1]['content'] == 'Note two.'


def test_two_single_paragraph_definitions():
    _, data = _whole('<p>[^1]: Note one.</p><p>[^2]: Note two.</p>')
    assert [d['content'] for d in data] == ['Note one.', 'Note two.']


def test_continuation_halts_at_heading():
    # body text after the notes must NOT be absorbed — a heading is a hard boundary
    _, data = _whole(
        '<p>[^1]: Note one.</p><p>continues here.</p>'
        '<h2>Next Chapter</h2><p>Body text that is not part of the note.</p>'
    )
    assert len(data) == 1
    assert data[0]['content'] == 'Note one.<br><br>continues here.'
    assert 'Body text' not in data[0]['content']


def test_two_defs_in_one_paragraph_loses_second():
    # ⚠️ FLAGGED LIMITATION: no blank line between the two definitions -> they land in
    # the SAME <p>, so only the first is detected and "[^2]: Note two." is swallowed as
    # literal text. This is the failure mode the blank-line-between-definitions rule avoids.
    # Pinned so the behaviour is visible; the md/docx front-ends must paragraph-separate defs.
    _, data = _whole('<p>[^1]: Note one. [^2]: Note two.</p>')
    assert len(data) == 1
    assert '[^2]: Note two.' in data[0]['content']   # second def lost into the first's text


# ---------------------------------------------------------------------------
# Interleaved BODY between definitions (the Barro 1974 bug) must NOT be absorbed
# ---------------------------------------------------------------------------
def test_body_paragraph_between_definitions_not_absorbed():
    # A LONG, capital-initial body paragraph physically sandwiched between a COMPLETE footnote def and
    # a following def is interleaved body (a page-spanning-footnote leftover), not a continuation — it
    # must NOT pollute the footnote and must remain a separate body node. (Barro 1974 shape.)
    body = ('The first part of this paper deals with the effect of government bond issue on the calculus '
            'of individual wealth in an overlapping-generations economy where individuals have finite lives.')
    _, data = _whole(
        '<p>[^1]: Of course, most analyses do not defend this. Used by Mundell (1971).</p>'
        f'<p>{body}</p>'
        '<p>[^2]: Note two.</p>'
        '<p>[^3]: Note three.</p>'
    )
    assert [d['content'] for d in data] == [
        'Of course, most analyses do not defend this. Used by Mundell (1971).',
        'Note two.', 'Note three.']
    assert all('The first part of this paper' not in d['content'] for d in data)


def test_body_split_out_even_when_def_ends_with_a_ref_marker():
    # The def's own text ends with a trailing "[^3]" ref; stripping it still reads as a complete
    # sentence, so the following long body paragraph is split out.
    body = ('A' + 'x' * 130 + '.')  # long, capital-initial
    _, data = _whole(
        '<p>[^1]: Complete sentence ending in a cross-reference.[^3]</p>'
        f'<p>{body}</p>'
        '<p>[^2]: Note two.</p>'
    )
    assert data[0]['content'] == 'Complete sentence ending in a cross-reference.[^3]'
    assert body not in data[0]['content']


def test_short_continuation_still_absorbed_despite_later_def():
    # A SHORT continuation (<=120 chars) after a complete def is a genuine multi-paragraph footnote
    # continuation even when a later def follows — the length gate keeps it absorbed.
    _, data = _whole(
        '<p>[^1]: A complete first sentence.</p>'
        '<p>A short second para of the note.</p>'
        '<p>[^2]: Note two.</p>'
    )
    assert data[0]['content'] == 'A complete first sentence.<br><br>A short second para of the note.'


def test_long_continuation_of_last_footnote_still_absorbed():
    # A long paragraph after the LAST footnote (no later def) is treated as a genuine continuation —
    # the def-run-interruption gate means we only split BODY that is sandwiched between definitions.
    long_cont = ('This continuation of the final footnote runs well past the length threshold used to '
                 'detect interleaved body and keeps going for a while longer still.')
    _, data = _whole('<p>[^1]: Note one.</p>' f'<p>{long_cont}</p>')
    assert len(data) == 1
    assert long_cont in data[0]['content']


# ---------------------------------------------------------------------------
# Bibliography-heading exclusion (defs under a References heading are NOT footnotes)
# ---------------------------------------------------------------------------
def test_bracket_defs_under_bibliography_heading_excluded():
    # "[26]: Miller..." under a Bibliography heading is a citation, not a footnote —
    # must be excluded so it doesn't pollute the footnote numbering.
    _, data = _whole(
        '<p>[^1]: A real footnote.</p>'
        '<h2>Bibliography</h2>'
        '<p>[26]: Miller, William Ian; something something 1990.</p>'
    )
    ids = len(data)
    assert ids == 1
    assert data[0]['content'] == 'A real footnote.'


# ---------------------------------------------------------------------------
# Marker shapes accepted
# ---------------------------------------------------------------------------
def test_dot_style_marker_accepted():
    # "[1]. text" (dot instead of colon) is also a definition shape
    _, data = _whole('<p>[1]. A footnote written with a dot.</p>')
    assert len(data) == 1
    assert 'dot' in data[0]['content']


# ---------------------------------------------------------------------------
# _is_footnote_definition — the DETECTION predicate (what counts as a definition).
# One place decides "is this line a footnote definition?"; both strategies call it.
# ---------------------------------------------------------------------------
import pytest as _pytest
from digestion.footnoteExtraction.footnotes import (
    _is_footnote_definition, _record_extraction_fork,
)


@_pytest.mark.parametrize('text', [
    '[1]: a note',          # bracket + colon
    '[^1]: a note',         # caret bracket + colon
    '[12]. a note',         # bracket + period
    '^1: a note',           # bare caret marker + colon
    '[5] Smith, A. (1990)', # colon-less "[N] Capital" form
])
def test_is_footnote_definition_accepts_real_openers(text):
    assert _is_footnote_definition(text) is True, f'should be a definition opener: {text!r}'


@_pytest.mark.parametrize('text', [
    'An ordinary sentence of prose.',
    'See [1] for details.',          # a marker mid-sentence, not an opener
    '[1]',                           # a bare marker with no body
    'Smith, William. 1990. A book.', # a bibliography entry, not number-marker shaped
    '',
])
def test_is_footnote_definition_rejects_non_definitions(text):
    assert _is_footnote_definition(text) is False, f'must NOT be a definition opener: {text!r}'


# ---------------------------------------------------------------------------
# The extraction fork (a SUSPICION signal — README §0). It records what was
# extracted; it FLAGS only the falsifiable contradiction (def-shaped lines that
# weren't extracted and weren't bibliography-excluded).
# ---------------------------------------------------------------------------
def _last_extraction_record():
    from shared.assessment import ASSESSMENT
    recs = [r for r in ASSESSMENT.records if r['module'] == 'footnote_extraction']
    return recs[-1] if recs else None


def test_extraction_fork_is_recorded_and_not_flagged_on_clean_doc():
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    _whole('<p>[^1]: A real footnote.</p><p>[^2]: Another one.</p>')
    rec = _last_extraction_record()
    assert rec is not None, 'footnote extraction must emit a fork'
    assert rec['evidence']['defs_extracted'] == 2
    assert rec['evidence']['dropped'] == 0
    assert rec['confidence'] == 0.9          # no contradiction → not flagged

def test_extraction_fork_does_not_flag_bibliography_exclusion():
    # a "[26]:" line under a Bibliography heading is deliberately excluded — that is NOT a fault.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    _whole('<p>[^1]: A real footnote.</p>'
           '<h2>Bibliography</h2><p>[26]: Miller, William Ian; 1990.</p>')
    rec = _last_extraction_record()
    assert rec['evidence']['excluded_under_bibliography'] == 1
    assert rec['evidence']['dropped'] == 0
    assert rec['confidence'] == 0.9          # deliberate exclusion, not a contradiction

def test_extraction_fork_flags_when_shaped_line_dropped():
    # a directly-fed contradiction: 5 def-shaped candidates, 2 extracted, none bibliography-excluded.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    _record_extraction_fork('whole_document', 'footnotes.py:process_whole_document_footnotes',
                            def_candidates=5, defs_extracted=2, excluded_in_bib=0)
    rec = _last_extraction_record()
    assert rec['evidence']['dropped'] == 3
    assert rec['confidence'] < 0.5           # shaped-but-unextracted → flagged as a suspicion
    assert 'MIGHT' in rec['margin']          # phrased as a hypothesis, never a verdict

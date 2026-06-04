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

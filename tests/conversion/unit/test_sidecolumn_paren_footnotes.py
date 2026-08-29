"""Side-column-notes layout (case 9bb2f3aa, IIED/Environment&Urbanization style): body refs are
"(N)" parenthesized numbers GLUED to the preceding word/punctuation ("Document.(5)",
"literature(1)", "involvement,(28)", superscripted "^(14)^" / "^{(33)}"), and the notes arrive
interleaved as line-start "N. Text" entries because Mistral flattens the side column into the
page flow. _convert_sidecolumn_paren_footnotes converts both sides to [^N] / [^N]: under hard
document-shape gates; these tests pin the gates as much as the conversion — a numbered list
that is NOT the notes (the doc carries the 17 SDG goals as "1. End poverty…") must survive.
"""

from ingestion.pdf.assembly import _convert_sidecolumn_paren_footnotes


NOTES = '\n'.join(
    f'{i}. Some Organisation ({2010 + i}), A cited report, accessed 23 May 2015 at http://example.org/{i}.'
    for i in range(1, 7))
BODY = ('The compilation used was the Outcome Document.(1) Later work followed,(2) and the '
        'existing literature(3) grew.^(4)^ More material.^{(5)} It concluded there.(6)')


def test_converts_glued_paren_refs_and_note_lines():
    out = _convert_sidecolumn_paren_footnotes(BODY + '\n\n' + NOTES)
    assert 'Document.[^1]' in out
    assert 'followed,[^2]' in out
    assert 'literature[^3]' in out
    assert 'grew.[^4]' in out and '^(4)^' not in out
    assert 'Material'.lower() in out and '[^5]' in out and '^{(5)}' not in out
    assert '\n[^6]: Some Organisation (2016)' in out


def test_numbered_list_that_is_not_the_notes_survives():
    sdg = '\n'.join(f'{i}. Goal number {i} described in plain words with no apparatus' for i in range(1, 7))
    out = _convert_sidecolumn_paren_footnotes(BODY + '\n\n' + sdg + '\n\n' + NOTES)
    # The apparatus-free list keeps its lines; the note-shaped lines convert.
    assert '\n1. Goal number 1 described in plain words with no apparatus' in out
    assert '\n[^1]: Some Organisation (2011)' in out


def test_unique_plain_note_still_converts():
    notes = NOTES + '\n7. A short apparatus-free note that is nonetheless real.'
    body = BODY.replace('there.(6)', 'there.(6) And once more.(7)')
    out = _convert_sidecolumn_paren_footnotes(body + '\n\n' + notes)
    assert '\n[^7]: A short apparatus-free note' in out
    assert 'once more.[^7]' in out


def test_spaced_parens_never_match():
    md = ('See equation (1) and equation (2) and also (3) plus (4) and (5) again (6).'
          '\n\n' + NOTES)
    assert _convert_sidecolumn_paren_footnotes(md) == md


def test_too_few_refs_no_conversion():
    md = 'One ref only.(1)\n\n' + NOTES
    assert _convert_sidecolumn_paren_footnotes(md) == md


def test_non_ascending_refs_no_conversion():
    md = ('Cites jump around.(4) then.(2) then.(6) then.(1) then.(5) then.(3)\n\n' + NOTES)
    assert _convert_sidecolumn_paren_footnotes(md) == md


def test_refs_without_matching_notes_no_conversion():
    md = ('First.(11) second.(12) third.(13) fourth.(14) fifth.(15)\n\n' + NOTES)
    assert _convert_sidecolumn_paren_footnotes(md) == md

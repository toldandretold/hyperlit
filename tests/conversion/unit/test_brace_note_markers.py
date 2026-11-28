"""Curly-brace note markers — "{12}" in the body, "{12} Mills, H.D., …" in a trailing list.

The typewriter convention of Brooks's "No Silver Bullet" (UNC TR86-020, 1986). No marker scan
read a brace, so the book classified `none` and thirteen markers never linked. The normaliser
rewrites it to the bracket shape (inline "[N]", list "N. Text") BEFORE classification, gated on the
whole document carrying both halves so a brace in prose or maths is never touched.
"""

import mistral_ocr as M


def _doc(*pages):
    return {'pages': [{'index': i, 'markdown': md} for i, md in enumerate(pages)]}


BODY = ('More of the graphs becomes hierarchical {1}.\n\n'
        'Parnas {8} implies that the term is used for glamor.\n\n'
        'Parnas has clarified the terminological chaos {4 }:\n\n'
        'Graphics to software design {9} and {10}. Elsewhere {11}, the flowchart.')
REFS = ('# REFERENCES\n\n'
        '{1} Parnas, D.L., Designing Software for Ease of Extension.\n\n'
        '{4} Parnas, D.L., Software Aspects of Strategic Defense Systems.\n\n'
        '{8} Parnas; D.L., Software Aspects of Strategic Defense Systems.\n\n'
        '{9} Graphton, R.B. & T. Ichikawa, eds., Special Issue on Visual Programming.\n\n'
        '{10} Raeder, G., A Survey of Current Graphical Programming Techniques.\n\n'
        '{11} Brooks, F.P., *The Mythical Man-Month*, Addison Wesley.')


def test_body_markers_and_list_entries_become_bracket_shape():
    d = _doc(BODY, REFS)
    assert M.normalise_brace_note_markers(d) == 12   # 6 markers + 6 entries
    body, refs = d['pages'][0]['markdown'], d['pages'][1]['markdown']
    assert 'hierarchical [1].' in body
    assert 'Parnas [8] implies' in body
    assert 'chaos [4]:' in body                       # OCR's "{4 }" spacing tolerated
    assert 'design [9] and [10].' in body
    assert 'Elsewhere [11],' in body
    assert '\n10. Raeder, G.' in refs
    assert '\n11. Brooks, F.P., *The' in refs
    assert '{' not in body + refs


def test_converted_document_classifies_as_document_endnotes():
    """The point of the rewrite: the classifier now SEES the apparatus. Once-each, in-order markers
    with a trailing numbered list is the 42be715c endnotes shape, not a numbered bibliography."""
    body_pages = BODY.split('\n\n')                 # one marker-bearing paragraph per page
    filler = ['Prose with no markers.\n\n' * 3] * 8
    d = _doc(*filler[:4], *body_pages, *filler[4:], REFS)
    assert M.classify_footnotes(d)['classification'] == 'none'
    M.normalise_brace_note_markers(d)
    assert M.classify_footnotes(d)['classification'] == 'document_endnotes'


def test_latex_braces_are_never_rewritten():
    maths = ('The cost grows as $x^{2}$ and $\\frac{1}{2}$ here {1}, and {8} again.\n\n'
             'A naked a_{12} subscript, x^{3} and \\cite{4} stay too.')
    d = _doc(maths, REFS)
    M.normalise_brace_note_markers(d)
    md = d['pages'][0]['markdown']
    assert '$x^{2}$' in md and '$\\frac{1}{2}$' in md
    assert 'a_{12}' in md and 'x^{3}' in md and '\\cite{4}' in md
    assert 'here [1], and [8] again' in md


def test_braces_without_a_brace_numbered_list_are_left_alone():
    """Inline "{N}" alone (a set literal, a template placeholder) is not a note apparatus."""
    md = 'The set {1} and the set {2} differ; placeholders {3} too.'
    d = _doc(md, 'REFERENCES\n\n1. Someone, A Book.')
    assert M.normalise_brace_note_markers(d) == 0
    assert d['pages'][0]['markdown'] == md


def test_a_brace_numbered_list_with_no_body_markers_is_left_alone():
    refs = '{1} First thing.\n\n{2} Second thing.'
    d = _doc('Prose with no markers at all.', refs)
    assert M.normalise_brace_note_markers(d) == 0
    assert d['pages'][1]['markdown'] == refs


def test_inline_markers_must_match_listed_numbers():
    """Two "{N}" in prose whose numbers the list never prints are coincidence, not citations."""
    d = _doc('Values {70} and {71} appear.', '{1} First thing.\n\n{2} Second thing.')
    assert M.normalise_brace_note_markers(d) == 0

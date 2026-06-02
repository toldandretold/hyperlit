"""Unit tests for conversion/strategy.py — strategy selection + the numbering-linkability guard."""

from conversion.strategy import analyze_document_structure, _footnote_numbering_is_linkable


def _doc(body):
    return f'<html><body>{body}</body></html>'


def test_strategy_sequential_from_markers(soup):
    html = _doc('<a class="footnoteSectionStart"></a><a class="footnoteDefinitionsStart"></a>'
                '<p>x<sup>1</sup></p><p>[1]: note</p>')
    strategy, _ = analyze_document_structure(soup(html))
    assert strategy == 'sequential'


def test_strategy_no_footnotes(soup):
    strategy, _ = analyze_document_structure(soup(_doc('<h1>Title</h1><p>Plain prose, no notes.</p>')))
    assert strategy == 'no_footnotes'


def test_strategy_whole_document(soup):
    # >10 definitions clustered at the end, references scattered through the body.
    refs = ''.join(f'<p>Claim {i}.<sup>{i}</sup></p>' for i in range(1, 13))
    defs = '<h2>Endmatter</h2>' + ''.join(f'<p>[{i}]: note {i}</p>' for i in range(1, 13))
    strategy, info = analyze_document_structure(soup(_doc('<h1>Essay</h1>' + refs + defs)))
    assert strategy == 'whole_document'
    assert info['references_throughout_definitions_at_end'] is True


def test_strategy_sectioned_notes_headers(soup):
    html = _doc('<h1>Ch1</h1><p>A<sup>1</sup></p><h2>Notes</h2><p>[1]: n1</p>'
                '<hr/><h1>Ch2</h1><p>B<sup>1</sup></p><h2>Notes</h2><p>[1]: n2</p>')
    strategy, _ = analyze_document_structure(soup(html))
    assert strategy == 'sectioned'


# --- the suppression guard (modus operandi: never a confident wrong link) ---

def _refs_soup(soup, nums):
    return soup('<body>' + ''.join(f'<sup>{n}</sup>' for n in nums) + '</body>')


def test_linkable_contiguous(soup):
    fmap = {'1': {}, '2': {}, '3': {}}
    assert _footnote_numbering_is_linkable(fmap, _refs_soup(soup, [1, 2, 3])) is True


def test_not_linkable_internal_gap(soup):
    fmap = {'1': {}, '2': {}, '4': {}}   # missing 3 -> renumbered/desynced
    assert _footnote_numbering_is_linkable(fmap, _refs_soup(soup, [1, 2, 4])) is False


def test_not_linkable_ref_without_def(soup):
    fmap = {'1': {}, '2': {}, '3': {}}
    # body marker 4 has no same-numbered definition -> streams don't line up
    assert _footnote_numbering_is_linkable(fmap, _refs_soup(soup, [1, 2, 3, 4])) is False


def test_linkable_trivial_single(soup):
    assert _footnote_numbering_is_linkable({'1': {}}, _refs_soup(soup, [1])) is True

"""Characterization tests for conversion/footnotes.link_footnotes — the soup-mutating
footnote LINKER. Pins the wiring (marker -> correct def id) and the modus operandi:
a suppressed (empty) map links NOTHING rather than guessing."""

from conversion.footnotes import link_footnotes

_BLOCKS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr',
           'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img']


def _whole_doc(soup, body):
    s = soup(f'<html><body>{body}</body></html>')
    return s, s.find_all(_BLOCKS)


def test_whole_document_sup_marker_links_to_correct_def(soup):
    s, elements = _whole_doc(soup, '<p>A claim<sup>1</sup>.</p><p>B claim<sup>2</sup>.</p>')
    gmap = {
        '1': {'unique_fn_id': 'Fn_one', 'content': 'first note'},
        '2': {'unique_fn_id': 'Fn_two', 'content': 'second note'},
    }
    link_footnotes(s, elements, 'whole_document', gmap, {},
                   {'whole_document': gmap}, [])

    sups = s.find_all('sup')
    assert {sp.get('id') for sp in sups} == {'Fn_one', 'Fn_two'}
    for sp in sups:
        assert 'footnote-ref' in sp.get('class', [])
        # the marker that says "1" must carry id Fn_one, "2" -> Fn_two (no cross-wiring)
        assert sp['id'] == ('Fn_one' if sp.get('fn-count-id') == '1' else 'Fn_two')
        assert sp.get_text() == sp['fn-count-id']


def test_suppressed_map_emits_no_links(soup):
    # global_footnote_map == {} is the suppression signal (numbering not alignable).
    s, elements = _whole_doc(soup, '<p>A claim<sup>1</sup>.</p>')
    link_footnotes(s, elements, 'whole_document', {}, {}, {'whole_document': {}}, [])

    sup = s.find('sup')
    assert 'footnote-ref' not in sup.get('class', [])
    assert sup.get('id') is None


def test_unknown_marker_left_unlinked(soup):
    # marker 7 has no definition -> stays plain (never a confident wrong link).
    s, elements = _whole_doc(soup, '<p>x<sup>1</sup> y<sup>7</sup></p>')
    gmap = {'1': {'unique_fn_id': 'Fn_one', 'content': 'n'}}
    link_footnotes(s, elements, 'whole_document', gmap, {}, {'whole_document': gmap}, [])

    by_num = {sp.get_text(): sp for sp in s.find_all('sup')}
    assert 'footnote-ref' in by_num['1'].get('class', [])
    assert 'footnote-ref' not in by_num['7'].get('class', [])


def test_bracket_caret_marker_links(soup):
    # [^1] inline pattern in prose -> wrapped in a footnote-ref sup.
    s, elements = _whole_doc(soup, '<p>A claim[^1] follows.</p>')
    gmap = {'1': {'unique_fn_id': 'Fn_one', 'content': 'n'}}
    link_footnotes(s, elements, 'whole_document', gmap, {}, {'whole_document': gmap}, [])

    sup = s.find('sup', class_='footnote-ref')
    assert sup is not None and sup['id'] == 'Fn_one'
    assert '[^1]' not in s.get_text()


def test_bracket_definition_pattern_not_linked(soup):
    # "[^1]:" is a definition, not an in-text marker -> must NOT become a link.
    s, elements = _whole_doc(soup, '<p>[^1]: the note text</p>')
    gmap = {'1': {'unique_fn_id': 'Fn_one', 'content': 'n'}}
    link_footnotes(s, elements, 'whole_document', gmap, {}, {'whole_document': gmap}, [])

    assert s.find('sup', class_='footnote-ref') is None

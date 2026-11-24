"""Unit tests for the EPUB footnote LINKING rules (conversion/footnote_link_rules.py — Decomposition
A of the LinkRule modularisation). FootnoteConverter.convert used to be a ~300-line method; here each
phase is an isolated LinkRule so a broken phase pinpoints to one class. The nested-dedup that fixed
the aarushi case is now `NoterefConverter` — exercised directly below.
"""

import pytest

from digestion.footnoteLinking.footnote_link_rules import (
    FootnoteLinkContext, IdMappingBuilder, NoterefConverter, LinkingStatsRecorder,
    FootnotesJsonBuilder, DefinitionElementRemover, link_epub_footnotes,
    FOOTNOTE_LINK_RULES,
    strip_leading_footnote_number,
)


def _logs():
    sink = []
    return sink, sink.append


def _ctx(soup, html, noterefs_from=None, defs_from=None):
    """Build a FootnoteLinkContext from an HTML string. `defs_from` / `noterefs_from` are lists of
    (css-ish) selectors resolved against the parsed soup into the all_footnotes/all_noterefs shapes."""
    s = soup(html)
    all_footnotes = []
    for fid in (defs_from or []):
        all_footnotes.append({'id': fid, 'element': s.find(id=fid), 'type': 'footnote'})
    all_noterefs = []
    for marker_el, target in (noterefs_from or []):
        all_noterefs.append({'element': marker_el, 'target_id': target,
                             'original_marker': marker_el.get_text(strip=True)})
    return s, FootnoteLinkContext(s, all_footnotes, all_noterefs, 'book_test')


# ---------------------------------------------------------------------------
# IdMappingBuilder — every definition gets a new Hyperlit id + extracted content
# ---------------------------------------------------------------------------
def test_id_mapping_builder_assigns_ids_and_content(soup):
    s, ctx = _ctx(soup,
                  '<body><p>Claim<a href="#fn1">1</a>.</p>'
                  '<aside id="fn1">the actual note text</aside></body>',
                  defs_from=['fn1'])
    _, log = _logs()
    IdMappingBuilder().apply(ctx, log)
    assert 'fn1' in ctx.id_mapping
    m = ctx.id_mapping['fn1']
    assert m['new_id'].startswith('Fn')
    assert m['count'] == 1
    assert 'the actual note text' in m['content']


# ---------------------------------------------------------------------------
# NoterefConverter — the nested-dedup (aarushi) + backlink exclusion
# ---------------------------------------------------------------------------
def test_noteref_converter_links_simple_ref(soup):
    s = soup('<body><p>Claim<a href="#fn1">1</a>.</p><aside id="fn1">note</aside></body>')
    ref_el = s.find('a', href='#fn1')
    all_footnotes = [{'id': 'fn1', 'element': s.find(id='fn1'), 'type': 'footnote'}]
    all_noterefs = [{'element': ref_el, 'target_id': 'fn1', 'original_marker': '1'}]
    ctx = FootnoteLinkContext(s, all_footnotes, all_noterefs, 'b')
    _, log = _logs()
    IdMappingBuilder().apply(ctx, log)
    NoterefConverter().apply(ctx, log)
    assert ctx.converted_refs == 1
    assert 'fn1' in ctx.linked_targets
    sup = s.find('sup', class_='footnote-ref')
    assert sup is not None and sup.get_text() == '1'


def test_noteref_converter_excludes_nested_ref(soup):
    # A noteref nested INSIDE another noteref is a double-detect — must be skipped (aarushi fix).
    s = soup('<body><p><a href="#fn1">1<a href="#fn1">1</a></a></p>'
             '<aside id="fn1">note</aside></body>')
    outer = s.find('a', href='#fn1')
    inner = outer.find('a', href='#fn1')
    all_footnotes = [{'id': 'fn1', 'element': s.find(id='fn1'), 'type': 'footnote'}]
    all_noterefs = [{'element': outer, 'target_id': 'fn1', 'original_marker': '1'},
                    {'element': inner, 'target_id': 'fn1', 'original_marker': '1'}]
    ctx = FootnoteLinkContext(s, all_footnotes, all_noterefs, 'b')
    _, log = _logs()
    IdMappingBuilder().apply(ctx, log)
    NoterefConverter().apply(ctx, log)
    assert ctx.nested_excluded == 1


def test_noteref_converter_excludes_backlink_inside_definition(soup):
    # A noteref that lives INSIDE a definition element is a back-pointer, not an in-text ref.
    s = soup('<body><aside id="fn1" class="footnote">note '
             '<a href="#fn1">back</a></aside></body>')
    back = s.find('a', href='#fn1')
    all_footnotes = [{'id': 'fn1', 'element': s.find(id='fn1'), 'type': 'footnote'}]
    all_noterefs = [{'element': back, 'target_id': 'fn1', 'original_marker': 'back'}]
    ctx = FootnoteLinkContext(s, all_footnotes, all_noterefs, 'b')
    _, log = _logs()
    IdMappingBuilder().apply(ctx, log)
    NoterefConverter().apply(ctx, log)
    assert ctx.backlinks_excluded == 1
    assert ctx.converted_refs == 0


# ---------------------------------------------------------------------------
# LinkingStatsRecorder + FootnotesJsonBuilder + DefinitionElementRemover
# ---------------------------------------------------------------------------
def test_linking_stats_counts_orphans(soup):
    s = soup('<body><aside id="fn1">a</aside><aside id="fn2">b</aside></body>')
    all_footnotes = [{'id': 'fn1', 'element': s.find(id='fn1'), 'type': 'footnote'},
                     {'id': 'fn2', 'element': s.find(id='fn2'), 'type': 'footnote'}]
    ctx = FootnoteLinkContext(s, all_footnotes, [], 'b')
    ctx.linked_targets.add('fn1')           # only fn1 got linked → fn2 is orphaned
    _, log = _logs()
    LinkingStatsRecorder().apply(ctx, log)
    assert ctx.linking_stats['detected_footnotes'] == 2
    assert ctx.linking_stats['orphaned_defs'] == 1
    assert ctx.linking_stats['orphaned_sample'] == ['fn2']


def test_footnotes_json_and_definition_removed(soup):
    s, ctx = _ctx(soup,
                  '<body><p>x</p><aside id="fn1">the note</aside></body>',
                  defs_from=['fn1'])
    _, log = _logs()
    IdMappingBuilder().apply(ctx, log)
    FootnotesJsonBuilder().apply(ctx, log)
    DefinitionElementRemover().apply(ctx, log)
    assert len(ctx.footnotes_json) == 1
    entry = ctx.footnotes_json[0]
    assert entry['footnoteId'].startswith('Fn')
    assert 'the note' in entry['content']
    # the definition element is decomposed out of the body
    assert s.find(id='fn1') is None


# ---------------------------------------------------------------------------
# link_epub_footnotes — end-to-end through the FOOTNOTE_LINK_RULES registry
# ---------------------------------------------------------------------------
def test_link_epub_footnotes_end_to_end(soup):
    s = soup('<body><p>Claim<a href="#fn1">1</a>.</p>'
             '<aside id="fn1">the note body</aside></body>')
    ref_el = s.find('a', href='#fn1')
    all_footnotes = [{'id': 'fn1', 'element': s.find(id='fn1'), 'type': 'footnote'}]
    all_noterefs = [{'element': ref_el, 'target_id': 'fn1', 'original_marker': '1'}]
    _, log = _logs()
    out = link_epub_footnotes(s, all_footnotes, all_noterefs, 'b', log)
    assert len(out['footnotes_json']) == 1
    assert 'fn1' in out['id_mapping']
    assert out['linking_stats']['linked'] == 1
    # an in-text <sup class="footnote-ref"> replaced the <a>, and the definition was removed
    assert s.find('sup', class_='footnote-ref') is not None
    assert s.find(id='fn1') is None


def test_a_source_that_asks_to_keep_its_notes_has_them_printed_in_place(soup):
    """marxists.org prints "Notes" and then the notes. Removing every definition left a bare heading
    over nothing (prod 2026-11-24). In keep mode the note stays where it stood, under the SAME
    book-wide number its marker shows — the source's own number restarts every chapter — and it is
    still extracted, so tapping the marker works exactly as before."""
    s = soup('<body><p>First<a href="#n1">[1]</a> and second<a href="#n2">[2]</a>.</p><h3>Notes</h3>'
             '<p id="n1"><a href="#x">[1]</a> The first note.</p><p id="n2">[2] The <em>second</em> note.</p></body>')
    all_footnotes = [{'id': i, 'element': s.find(id=i), 'type': 'footnote'} for i in ('n1', 'n2')]
    all_noterefs = [{'element': s.find('a', href='#' + i), 'target_id': i, 'original_marker': m}
                    for i, m in (('n1', '[1]'), ('n2', '[2]'))]
    _, log = _logs()
    out = link_epub_footnotes(s, all_footnotes, all_noterefs, 'b', log, keep_definitions=True)

    assert len(out['footnotes_json']) == 2 and len(s.find_all('sup', class_='footnote-ref')) == 2
    kept = s.find_all(attrs={'role': 'doc-footnote'})
    assert [k.get_text(' ', strip=True) for k in kept] == ['[1] The first note.', '[2] The second note.']
    assert kept[1].find('em') is not None                     # the note's own markup survives
    assert s.find('h3').find_next_sibling() is kept[0]        # …where the definitions stood
    # A printed note is text, never a second marker: nothing here may be counted or renumbered.
    assert not any(k.find('sup') or k.find(attrs={'fn-count-id': True}) for k in kept)


def test_notes_are_removed_from_the_body_unless_the_source_asks(soup):
    s = soup('<body><p>Claim<a href="#n1">[1]</a>.</p><p id="n1">[1] The note.</p></body>')
    _, log = _logs()
    link_epub_footnotes(s, [{'id': 'n1', 'element': s.find(id='n1'), 'type': 'footnote'}],
                        [{'element': s.find('a', href='#n1'), 'target_id': 'n1', 'original_marker': '[1]'}], 'b', log)
    assert 'The note.' not in s.get_text() and not s.find(attrs={'role': 'doc-footnote'})


def test_link_epub_footnotes_noop_when_empty(soup):
    s = soup('<body><p>nothing to link</p></body>')
    _, log = _logs()
    out = link_epub_footnotes(s, [], [], 'b', log)
    assert out == {'footnotes_json': [], 'id_mapping': {}, 'linking_stats': None}


def test_registry_is_ordered_and_complete():
    # The registry order IS the pipeline order — id-mapping must precede the conversion loop.
    names = [r.name for r in FOOTNOTE_LINK_RULES]
    assert names.index('id_mapping') < names.index('noteref_convert')
    assert names.index('noteref_convert') < names.index('footnotes_json')


# --- a definition's own printed marker is not part of its text ---------------------------------
# marxists.org restarts numbering every chapter, so a "1." left in the note reads against the
# book-wide number Hyperlit shows on the marker (Capital: marker 2 opened a note headed "1.").

@pytest.mark.parametrize('html, expected', [
    # Capital: the back-link sits inside an inline wrapper.
    ('<p><span class="info"><a href="#p005-1b" id="p005-n1">1.</a></span> <cite>Geschichtliche Darstellung</cite>, von Gülich.</p>',
     '<p><cite>Geschichtliche Darstellung</cite>, von Gülich.</p>'),
    # Lenin: bracketed.
    ('<p><a class="anote" href="#bk1" id="fw1">[1]</a>\n\nHobson, op. cit., pp. 59, 62.</p>',
     '<p>Hobson, op. cit., pp. 59, 62.</p>'),
    # Luxemburg: parenthesised, inside a superscript.
    ('<p><sup><a href="#doc-1" id="foot-1">(1)</a></sup> “If production be capitalistic in form…”</p>',
     '<p>“If production be capitalistic in form…”</p>'),
    # MECW lettered notes.
    ('<p><a href="#r91a" id="n91a">91a</a> The Executive Commission.</p>', '<p>The Executive Commission.</p>'),
    ('<p><a href="#ra" id="na">[A]</a> Editor’s note.</p>', '<p>Editor’s note.</p>'),
    # The plain forms it always handled.
    ('<p><a href="#r">5.</a> Text.</p>', '<p>Text.</p>'),
    ('<sup>5</sup>. Text.', 'Text.'),
])
def test_leading_marker_is_stripped_in_every_printed_form(html, expected):
    assert strip_leading_footnote_number(html) == expected


@pytest.mark.parametrize('html', [
    # A wrapper that holds prose is prose, even when short enough to look like a symbol marker.
    '<p><span class="sc">The</span> author resorts here to the economic language in current use.</p>',
    '<p><strong>See</strong> Capital, Vol. 1.</p>',
    # A wrapper holding the marker AND words is not a bare marker.
    '<p><span><a href="#r">1.</a> Note</span> added in the 3rd German edition.</p>',
    # A leading link that is a real citation, not a marker.
    '<p><a href="https://example.org">Listen, Marxist!</a> (1969).</p>',
    # No marker at all.
    '<p>Mephistopheles in Goethe’s <em>Faust</em></p>',
])
def test_leading_prose_is_never_mistaken_for_a_marker(html):
    assert strip_leading_footnote_number(html) == html


# marxists.org's MECW notes: an empty id target, then the number in BOLD with no link.
@pytest.mark.parametrize('html, expected', [
    ('<a id="n5"></a><strong>5.</strong> The <em>German People’s Party</em>, established in 1868.',
     '<a id="n5"></a>The <em>German People’s Party</em>, established in 1868.'),
    ('<p><a id="n7"></a><b>[7]</b> The reference is to the war of 1870-71.</p>',
     '<p><a id="n7"></a>The reference is to the war of 1870-71.</p>'),
    ('<p><strong>12.</strong> Philippe Buchez.</p>', '<p>Philippe Buchez.</p>'),
])
def test_a_bold_unlinked_number_after_the_id_target_is_the_marker(html, expected):
    assert strip_leading_footnote_number(html) == expected


@pytest.mark.parametrize('html', [
    # Bold PROSE opening a note is not a number…
    '<p><a id="n1"></a><strong>See</strong> Capital, Vol. 1.</p>',
    # …and a bold YEAR is not a note number.
    '<p><strong>1848.</strong> The year of revolutions.</p>',
    # An anchor that carries text is not an empty id target to skip past.
    '<p><a id="n1">Marx</a> <strong>5.</strong> wrote.</p>',
])
def test_bold_prose_and_bold_years_are_left_alone(html):
    assert strip_leading_footnote_number(html) == html

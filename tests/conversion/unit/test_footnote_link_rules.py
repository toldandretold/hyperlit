"""Unit tests for the EPUB footnote LINKING rules (conversion/footnote_link_rules.py — Decomposition
A of the LinkRule modularisation). FootnoteConverter.convert used to be a ~300-line method; here each
phase is an isolated LinkRule so a broken phase pinpoints to one class. The nested-dedup that fixed
the aarushi case is now `NoterefConverter` — exercised directly below.
"""

from conversion.footnote_link_rules import (
    FootnoteLinkContext, IdMappingBuilder, NoterefConverter, LinkingStatsRecorder,
    FootnotesJsonBuilder, DefinitionElementRemover, link_epub_footnotes,
    FOOTNOTE_LINK_RULES,
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

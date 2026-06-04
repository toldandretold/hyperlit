"""Unit tests for the in-text MARKER linking rules (conversion/footnote_link_rules.py — Decomposition
B, was conversion/footnotes.py:link_footnotes). Each rule wires one marker shape (<a href="#fnN">,
bare <sup>N</sup>, [^id] text nodes) to its definition, strategy-aware. Isolated here so a broken
shape pinpoints to one class.
"""

from digestion.footnoteLinking.footnote_link_rules import (
    MarkerLinkContext, AnchorLinkConverter, SupTagLinkConverter, BracketTextNodeLinker,
    link_marker_footnotes, MARKER_LINK_RULES,
)


def _whole_doc_ctx(soup, html, fmap):
    """A whole_document-strategy context (the simplest find mode — a flat id→data map)."""
    s = soup(html)
    all_elements = s.find_all(True)
    ctx = MarkerLinkContext(s, all_elements, 'whole_document', fmap, {}, {}, [])
    return s, ctx


# ---------------------------------------------------------------------------
# AnchorLinkConverter — <a href="#fnN">N</a> → <sup class="footnote-ref">
# ---------------------------------------------------------------------------
def test_anchor_link_converter(soup):
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p>Claim<a href="#fn1">1</a>.</p></body>',
                            {'1': {'unique_fn_id': 'FnAAA', 'fn_count': 1}})
    AnchorLinkConverter().apply(ctx)
    sup = s.find('sup', class_='footnote-ref')
    assert sup is not None
    assert sup['id'] == 'FnAAA'
    assert sup['fn-count-id'] == '1'
    assert s.find('a', href='#fn1') is None


def test_anchor_link_converter_skips_when_text_mismatch(soup):
    # The converter only fires when the anchor text equals the identifier (a true marker).
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p>see<a href="#fn1">here</a></p></body>',
                            {'1': {'unique_fn_id': 'FnAAA'}})
    AnchorLinkConverter().apply(ctx)
    assert s.find('sup', class_='footnote-ref') is None
    assert s.find('a', href='#fn1') is not None


# ---------------------------------------------------------------------------
# SupTagLinkConverter — bare <sup>N</sup> wired in place
# ---------------------------------------------------------------------------
def test_sup_tag_link_converter(soup):
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p>Claim<sup>2</sup>.</p></body>',
                            {'2': {'unique_fn_id': 'FnBBB'}})
    SupTagLinkConverter().apply(ctx)
    sup = s.find('sup')
    assert 'footnote-ref' in sup.get('class', [])
    assert sup['id'] == 'FnBBB'
    assert sup['fn-count-id'] == '2'


def test_sup_tag_link_converter_skips_already_linked(soup):
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p><sup class="footnote-ref" id="x">2</sup></p></body>',
                            {'2': {'unique_fn_id': 'FnSHOULD_NOT'}})
    SupTagLinkConverter().apply(ctx)
    assert s.find('sup')['id'] == 'x'   # untouched


# ---------------------------------------------------------------------------
# BracketTextNodeLinker — [^id] in text → <sup>, definitions ([^id]:) skipped
# ---------------------------------------------------------------------------
def test_bracket_text_node_linker(soup):
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p>Claim [^3] continues.</p></body>',
                            {'3': {'unique_fn_id': 'FnCCC'}})
    BracketTextNodeLinker().apply(ctx)
    sup = s.find('sup', class_='footnote-ref')
    assert sup is not None and sup['id'] == 'FnCCC'
    assert '[^3]' not in s.get_text()


def test_bracket_text_node_linker_skips_definition_pattern(soup):
    # "[^3]:" is a definition line, not an in-text marker — must NOT be linked.
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p>[^3]: the definition body</p></body>',
                            {'3': {'unique_fn_id': 'FnCCC'}})
    BracketTextNodeLinker().apply(ctx)
    assert s.find('sup', class_='footnote-ref') is None


def test_bracket_text_node_linker_gate_noop_without_pattern(soup):
    s, ctx = _whole_doc_ctx(soup,
                            '<body><p>plain prose, no markers</p></body>',
                            {'3': {'unique_fn_id': 'FnCCC'}})
    BracketTextNodeLinker().apply(ctx)
    assert s.find('sup') is None


# ---------------------------------------------------------------------------
# link_marker_footnotes — end-to-end through MARKER_LINK_RULES
# ---------------------------------------------------------------------------
def test_link_marker_footnotes_end_to_end(soup):
    s = soup('<body><p>A<a href="#fn1">1</a> and B<sup>2</sup>.</p></body>')
    all_elements = s.find_all(True)
    fmap = {'1': {'unique_fn_id': 'Fn1'}, '2': {'unique_fn_id': 'Fn2'}}
    link_marker_footnotes(s, all_elements, 'whole_document', fmap, {}, {}, [])
    sups = s.find_all('sup', class_='footnote-ref')
    assert {sup['id'] for sup in sups} == {'Fn1', 'Fn2'}


def test_link_marker_footnotes_noop_with_empty_map(soup):
    # The pre_processed path: empty maps → nothing links (preserved no-op).
    s = soup('<body><p>Claim<sup>1</sup>.</p></body>')
    link_marker_footnotes(s, s.find_all(True), 'whole_document', {}, {}, {}, [])
    assert s.find('sup', class_='footnote-ref') is None


def test_marker_registry_order():
    assert [r.name for r in MARKER_LINK_RULES] == ['anchor_link', 'sup_link', 'bracket_link']

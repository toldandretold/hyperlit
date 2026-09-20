"""Unit tests for finalize.flatten_grouping_wrappers — the "one node per block" invariant.

THE BUG (nicholls/chacko EPUB, phase2-pathways, 2026-09-18): node generation takes the DIRECT
CHILDREN of the content root, one node each. Every lane that emits flat HTML satisfies that; a
publisher file does not. A Taylor & Francis EPUB is `<article><section id="bodymatter">…` so the
whole book arrived as TWO nodes of ~60k chars — and it failed SILENTLY, because the reference scan
is recursive and still found all 66 entries, so the import looked healthy. It is not EPUB-only:
any `<article>`-wrapped HTML import collapsed the same way.
"""

from bs4 import BeautifulSoup

from digestion.finalize.finalize import flatten_grouping_wrappers


def _flatten(html):
    soup = BeautifulSoup(html, 'html.parser')
    root = soup.body if soup.body else soup
    flatten_grouping_wrappers(root, soup)
    return soup, root, [c.name for c in root.find_all(recursive=False)]


def test_article_wrapper_is_flattened_to_its_blocks():
    _, _, names = _flatten('<body><article><h1>T</h1><p>one</p><p>two</p></article></body>')
    assert names == ['h1', 'p', 'p']


def test_nested_sections_flatten_all_the_way_down():
    # The real shape: <article><section id="bodymatter"><p>…
    _, _, names = _flatten(
        '<body><article data-type="research-article">'
        '<section id="frontmatter"><h1>Title</h1></section>'
        '<section id="bodymatter"><p>a</p><p>b</p></section>'
        '<section id="backmatter"><h2>References</h2><p>Ostrom, E. 1990.</p></section>'
        '</article></body>')
    assert names == ['h1', 'p', 'p', 'h2', 'p']


def test_a_wrapper_with_no_block_children_stays_one_node():
    # <div class="core-license"><a><img/></a></div> is a single content unit, not a group.
    # Promoting its <a> would mint an inline node AND strip its class in the node loop.
    _, _, names = _flatten('<body><div class="core-license"><a href="/oa"><img src="oa.png"/></a></div></body>')
    assert names == ['div']


def test_loose_inline_run_becomes_ONE_paragraph_not_a_node_each():
    # The failure this guards: the source article carried bare `text <a>1982</a> , 436). text`
    # runs. Wrapping each text node on its own left the anchors as siblings, so one sentence
    # became `<p>He as…</p>` + `<a>1982</a>` + `<p>, 436)…</p>` — three nodes, and the citation
    # lost its class because the node loop deletes `class` from the node it is building.
    soup, root, names = _flatten(
        '<body><article><p>before</p>'
        'He asked (Amin <a class="in-text-citation" href="#amin1982">1982</a>, 436). Indeed.'
        '<p>after</p></article></body>')
    assert names == ['p', 'p', 'p']
    middle = root.find_all(recursive=False)[1]
    assert middle.get_text() == 'He asked (Amin 1982, 436). Indeed.'
    # the citation is still a citation
    assert middle.find('a', class_='in-text-citation') is not None


def test_lifted_footnote_list_items_stay_separate_nodes():
    # The footnote pass lifts `<li>` definitions OUT of their list to sit at the root ("Unwrapping
    # N traditional footnote items to be processed as individual nodes"). Treating those as loose
    # inline content merged a document's two footnotes into ONE paragraph.
    soup, root, names = _flatten(
        '<body><p>body</p><li>First footnote.</li><li>Second footnote.</li></body>')
    assert names == ['p', 'li', 'li']


def test_a_standalone_image_stays_an_image_node():
    # The PDF lane emits top-level <img> nodes; folding them into a <p> retypes every one for no
    # gain (15 PDF goldens flipped img -> p when this was missed).
    _, _, names = _flatten('<body><p>text</p><img src="fig1.png"/><p>more</p></body>')
    assert names == ['p', 'img', 'p']


def test_whitespace_between_blocks_does_not_become_an_empty_node():
    _, _, names = _flatten('<body><article>\n  <p>one</p>\n  <p>two</p>\n</article></body>')
    assert names == ['p', 'p']


def test_wrapper_id_is_preserved_as_an_anchor_inside_the_first_block():
    # An EPUB nav points at `#bodymatter`; unwrapping must not silently kill that link target,
    # and must not mint an empty node to hold it either.
    soup, root, names = _flatten(
        '<body><article><section id="bodymatter"><p>one</p><p>two</p></section></article></body>')
    assert names == ['p', 'p']
    assert soup.find('a', id='bodymatter') is not None
    assert soup.find('a', id='bodymatter').find_parent('p').get_text() == 'one'


def test_already_flat_html_is_untouched():
    # Every other lane already emits this shape — flattening must be a no-op for them.
    html = '<body><h1>T</h1><p>one</p><ul><li>x</li></ul><blockquote><p>q</p></blockquote></body>'
    soup, _, names = _flatten(html)
    assert names == ['h1', 'p', 'ul', 'blockquote']
    # the list and the quote keep their internal structure — they are ONE node each
    assert soup.find('ul').find('li') is not None
    assert soup.find('blockquote').find('p') is not None

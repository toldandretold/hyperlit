"""Unit tests for the arXiv/HTML front-end — ar5iv_preprocessor.py.

ar5iv (LaTeXML) HTML encodes references as <li class="ltx_bibitem">, citations as
<cite class="ltx_cite"><a href="#bib.X">, and footnotes inline inside
<span class="ltx_role_footnote">. These transforms rewrite all three into the Hyperlit
shapes (bib-entry / in-text-citation / footnote-ref sup) that the core pipeline expects.
"""

from bs4 import BeautifulSoup

import ar5iv_preprocessor as A


def _s(html):
    return BeautifulSoup(html, 'html.parser')


# ---------------------------------------------------------------------------
# looks_like_ar5iv
# ---------------------------------------------------------------------------
def test_looks_like_ar5iv_positive():
    assert A.looks_like_ar5iv(_s('<ul><li class="ltx_bibitem" id="bib.bib1">x</li></ul>')) is True


def test_looks_like_ar5iv_negative():
    assert A.looks_like_ar5iv(_s('<p>plain html, no LaTeXML classes</p>')) is False


# ---------------------------------------------------------------------------
# extract_bibitem_number
# ---------------------------------------------------------------------------
def test_bibitem_number_from_tag_span():
    li = _s('<li class="ltx_bibitem" id="bib.bib19">'
            '<span class="ltx_tag_bibitem">[19]</span>'
            '<span class="ltx_bibblock">Smith, J. 2023.</span></li>').find('li')
    assert A.extract_bibitem_number(li) == '19'


def test_bibitem_number_falls_back_to_id():
    li = _s('<li class="ltx_bibitem" id="bib.bib7">'
            '<span class="ltx_bibblock">No tag span here.</span></li>').find('li')
    assert A.extract_bibitem_number(li) == '7'


# ---------------------------------------------------------------------------
# rewrite_bibitems
# ---------------------------------------------------------------------------
def test_rewrite_bibitems_makes_bib_entries():
    soup = _s('<ul class="ltx_biblist">'
              '<li class="ltx_bibitem" id="bib.bib1">'
              '<span class="ltx_tag_bibitem">[1]</span>'
              '<span class="ltx_bibblock">Ostrom, E. 1990. Governing the Commons.</span></li>'
              '</ul>')
    refs = A.rewrite_bibitems(soup)

    assert len(refs) == 1
    assert refs[0]['referenceId'] == 'bib.bib1'
    assert refs[0]['content'].startswith('[1] Ostrom, E. 1990')
    # DOM now has a bib-entry anchor, and the ltx_biblist wrapper is unwrapped
    assert soup.find('a', class_='bib-entry', id='bib.bib1') is not None
    assert soup.find(class_='ltx_biblist') is None


# ---------------------------------------------------------------------------
# rewrite_cites
# ---------------------------------------------------------------------------
def test_rewrite_cites_converts_anchor_class():
    soup = _s('<p>As shown <cite class="ltx_cite">[<a href="#bib.bib19">'
              '<span>19</span></a>]</cite> here.</p>')
    n = A.rewrite_cites(soup)

    assert n == 1
    a = soup.find('a', class_='in-text-citation')
    assert a is not None and a['href'] == '#bib.bib19'
    assert a.get_text(strip=True) == '19'          # cosmetic inner <span> unwrapped
    assert soup.find('cite') is None               # <cite> wrapper removed


# ---------------------------------------------------------------------------
# rewrite_footnotes
# ---------------------------------------------------------------------------
def test_rewrite_footnotes_inline_note_to_sup_marker():
    soup = _s(
        '<p>A claim'
        '<span id="footnote1" class="ltx_note ltx_role_footnote">'
        '<sup class="ltx_note_mark">1</sup>'
        '<span class="ltx_note_outer"><span class="ltx_note_content">'
        '<sup class="ltx_note_mark">1</sup>'
        '<span class="ltx_tag ltx_tag_note">1</span>'
        'The actual footnote body text.'
        '</span></span></span>'
        ' continues.</p>'
    )
    footnotes = A.rewrite_footnotes(soup)

    assert len(footnotes) == 1
    assert footnotes[0]['content'] == 'The actual footnote body text.'
    sup = soup.find('sup', class_='footnote-ref')
    assert sup is not None
    assert sup['fn-count-id'] == '1'
    assert sup.get_text(strip=True) == '1'
    # the note body is no longer inlined in the paragraph text
    assert 'The actual footnote body text.' not in soup.find('p').get_text()


# ---------------------------------------------------------------------------
# flatten_document_structure + strip_ar5iv_footer
#
# Regression for "the whole arXiv paper imports as ONE giant node": real ar5iv
# wraps the entire paper in <div class="ltx_page_main"><div class="ltx_page_content">
# <article class="ltx_document"><section>… . The node-builder
# (digestion/finalize.py:GenerateNodeChunks) emits one node per DIRECT child of
# <body>, so without flattening, <body>'s single wrapper child = one node for the
# whole document. (The earlier flat fixture never exercised the wrappers.)
# ---------------------------------------------------------------------------
def _wrapped_ar5iv():
    return _s(
        '<html><body>'
        '<div class="ltx_page_main"><div class="ltx_page_content">'
        '<article class="ltx_document">'
        '<h1 class="ltx_title">Title</h1>'
        '<div class="ltx_authors">Jane Doe<br>Some University<br>jane@uni.edu</div>'
        '<div class="ltx_abstract"><h6>Abstract</h6><p>Abstract body.</p></div>'
        '<section class="ltx_section"><h2 class="ltx_title">1 Intro</h2>'
        '<p class="ltx_p">First para.</p><p class="ltx_p">Second para.</p>'
        '<section class="ltx_subsection"><h3 class="ltx_title">1.1 Sub</h3>'
        '<p class="ltx_p">Nested para.</p></section>'
        '<div><table><tr><td>cell</td></tr></table>'
        '<blockquote>Table 1: caption</blockquote></div>'  # lift_figures-style wrapper
        '</section>'
        '</article>'
        '</div></div>'
        '<div class="ar5iv-footer"><a>◄</a><a>Feeling<br>lucky?</a></div>'
        '<footer class="ltx_page_footer"><a>Copyright</a>'
        '<div class="ltx_page_logo">Generated by LaTeXML</div></footer>'
        '</body></html>'
    )


def test_flatten_lifts_blocks_to_body_level():
    soup = _wrapped_ar5iv()
    A.strip_ar5iv_footer(soup)
    A.flatten_document_structure(soup)

    body = soup.body
    kids = [c for c in body.find_all(recursive=False) if getattr(c, 'name', None)]
    # Each heading / paragraph is now its own body-level block (would be 1 before the fix).
    assert len(kids) > 1
    # The structural wrappers are gone…
    assert soup.find('article') is None
    assert soup.find('section') is None
    assert soup.find('div', class_='ltx_page_main') is None
    assert soup.find('div', class_='ltx_page_content') is None
    # The nested subsection's heading + paragraph were lifted too (no section survives).
    names = [c.name for c in kids]
    assert 'h3' in names


def test_no_body_level_divs_survive():
    """The node-builder makes one node per body child — a surviving <div> would be a node that
    HOUSES headings/paragraphs, which the reader/editor can't treat as a standard node."""
    soup = _wrapped_ar5iv()
    A.strip_ar5iv_footer(soup)
    A.flatten_document_structure(soup)
    body = soup.body

    # No bare div nodes at all.
    assert body.find_all('div', recursive=False) == []

    kids = [c for c in body.find_all(recursive=False) if getattr(c, 'name', None)]
    names = [c.name for c in kids]
    # authors div (inline-only) → a <p> paragraph node; nothing lost.
    assert any(c.name == 'p' and 'jane@uni.edu' in c.get_text() for c in kids)
    # abstract div → its <h6> heading + <p> body became separate nodes.
    assert any(c.name == 'h6' and c.get_text(strip=True) == 'Abstract' for c in kids)
    # lift_figures wrapper div → its <table> + <blockquote> caption became separate nodes.
    assert 'table' in names and 'blockquote' in names


def test_strip_ar5iv_footer_removes_chrome():
    soup = _wrapped_ar5iv()
    A.strip_ar5iv_footer(soup)

    assert soup.find(class_='ar5iv-footer') is None
    assert soup.find(class_='ltx_page_footer') is None
    assert soup.find(class_='ltx_page_logo') is None
    text = soup.get_text()
    assert '◄' not in text and 'Feeling' not in text and 'Copyright' not in text

"""`plainText` extraction (finalize.GenerateNodeChunks) — the node's text as a reader would say it.

Not cosmetic: plainText backs full-text search (SearchController), embeddings / AI context, and
BackendHighlightService's `mb_strpos` offset lookup for highlight reattachment. It used to be
`node.get_text(strip=True)`, which strips each text node individually and THEN concatenates —
destroying real whitespace around every inline element — and which also dropped `<latex>` entirely,
because KaTeX renders math from a `data-math` attribute on an EMPTY element.
"""

import base64

from digestion.finalize.finalize import _latex_to_readable, node_plain_text


def _p(soup, body):
    return soup(f'<html><body><p>{body}</p></body></html>').find('p')


def _math(latex):
    return f'<latex data-math="{base64.b64encode(latex.encode()).decode()}"></latex>'


def test_math_contributes_readable_text(soup):
    """93d34a74 stored '… matched the queries.of the Connotea posts' — three real statistics
    (88.1%, 99.3%, 61.4%) contributed nothing AND took the surrounding spaces with them."""
    n = _p(soup, f'matched the queries.  {_math(r"88.1\%")}  of the Connotea posts')
    assert node_plain_text(n) == 'matched the queries. 88.1% of the Connotea posts'


def test_stored_html_keeps_the_latex(soup):
    """The reader renders `content`, and KaTeX needs the LaTeX — extraction must work on a copy."""
    n = _p(soup, f'a {_math(r"88.1\%")} b')
    before = str(n)
    node_plain_text(n)
    assert str(n) == before
    assert 'data-math' in str(n)


def test_whitespace_around_inline_elements_survives(soup):
    n = _p(soup, 'the <em>Journal</em> of X and <strong>more</strong> text')
    assert node_plain_text(n) == 'the Journal of X and more text'


def test_no_whitespace_is_invented(soup):
    """Passing a separator to get_text() would turn `(<a>2009</a>)` into `( 2009 )`, breaking the
    very mb_strpos lookup this exists to fix. The document's own spacing is authoritative."""
    n = _p(soup, 'Robinson (<a class="in-text-citation" href="#r">2009</a>) quote a report')
    assert node_plain_text(n) == 'Robinson (2009) quote a report'


def test_deliberate_gluing_is_preserved(soup):
    """A superscript marker is glued in the source and reads glued — that is faithful."""
    n = _p(soup, 'capitalism<sup>7</sup> because')
    assert node_plain_text(n) == 'capitalism7 because'


def test_latex_readable_rendering():
    assert _latex_to_readable(r'88.1\%') == '88.1%'
    assert _latex_to_readable(r'(99.3\%)') == '(99.3%)'
    assert _latex_to_readable(r'\text{ratio}') == 'ratio'
    # a macro's NAME is kept — '\Delta t' must not collapse to a bare 't', a different quantity
    assert _latex_to_readable(r'$\Delta t = t2 - t1$') == 'Delta t = t2 - t1'
    # purely typographic macros carry no meaning
    assert _latex_to_readable(r'88.1\% \, of') == '88.1% of'


def test_unparseable_data_math_is_passed_through_not_dropped(soup):
    """Better a slightly raw string than silent deletion — the failure mode being fixed."""
    n = _p(soup, 'a <latex data-math="not-base64!!">x</latex> b')
    assert 'not-base64' in node_plain_text(n)

"""Unit tests for the CSS "universal key" — StyleProfiler + TocIndex (ingestion/epub/styleProfiler.py).

These pin the typographic-fingerprint reading that StyleHeadingDetector / StyledSuperscriptFootnoteDetector
build on: a heading style out-ranks the body baseline; a CSS-superscript is flagged; a sans-serif family is
not misread as serif; and a toc.ncx `src` resolves to the SAME prefixed id the spine-combine assigns.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'app', 'Python'))

from ingestion.epub.styleProfiler import StyleProfiler, TocIndex, spine_id_prefix  # noqa: E402


CSS = """
.body { font-family: Georgia, serif; margin-top: 1em; }
.chap { font-family: Arial, sans-serif; font-weight: bold; font-variant: small-caps; font-size: 1.5em; text-align: center; }
.sub  { font-family: Arial, sans-serif; font-weight: bold; font-size: 1.2em; }
.fnmark { vertical-align: super; font-size: 0.8em; }
.pageref { color: blue; text-decoration: underline; }
"""


class _El:
    """Minimal BeautifulSoup-tag stand-in for fingerprint(): .name + .get('class'/'style')."""
    def __init__(self, classes=None, style=None, name='div'):
        self._classes = classes or []
        self._style = style
        self.name = name

    def get(self, key, default=None):
        if key == 'class':
            return self._classes
        if key == 'style':
            return self._style
        return default


@pytest.fixture
def prof():
    return StyleProfiler.from_css_text(CSS)


def test_has_css(prof):
    assert prof.has_css is True
    assert StyleProfiler.from_css_text("").has_css is False
    assert StyleProfiler.from_css_text(None).has_css is False


def test_sans_not_misread_as_serif(prof):
    # 'serif' is a substring of 'sans-serif' — the bucket must read Arial/sans-serif as sans.
    assert prof.fingerprint(_El(['chap'])).serif is False
    assert prof.fingerprint(_El(['body'])).serif is True


def test_heading_outranks_body(prof):
    base = prof.fingerprint(_El(['body']))
    chap = prof.fingerprint(_El(['chap']))
    sub = prof.fingerprint(_El(['sub']))
    assert StyleProfiler.prominence(chap, base) > StyleProfiler.prominence(sub, base) > 0.0
    # Body vs itself is not prominent.
    assert StyleProfiler.prominence(base, base) == 0.0


def test_superscript_marker_flagged(prof):
    assert prof.fingerprint(_El(['fnmark'], name='a')).vertical_align == 'super'
    # A page-reference link carries no typographic role signal at all.
    assert prof.fingerprint(_El(['pageref'], name='a')) is None


def test_inline_style_overrides_class(prof):
    sig = prof.fingerprint(_El(['body'], style='font-weight: bold; text-align: center'))
    assert sig.bold is True and sig.text_align == 'center'


def test_categorical_signals(prof):
    chap = prof.fingerprint(_El(['chap']))
    assert chap.bold and chap.caps and chap.text_align == 'center'


def test_toc_prefix_matches_loader():
    # The loader prefixes ids as splitext(basename(href)) + '_'; TocIndex MUST match exactly.
    assert spine_id_prefix('text/part0004.html') == 'part0004_'
    assert spine_id_prefix('chapter.xhtml') == 'chapter_'


def test_toc_index_resolves_fragment_to_prefixed_id():
    ncx = """<?xml version="1.0"?>
    <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint><navLabel><text>Chapter One</text></navLabel><content src="text/part0004.html#BF-9"/>
        <navPoint><navLabel><text>A Section</text></navLabel><content src="text/part0004.html#CN-3"/></navPoint>
      </navPoint>
    </navMap></ncx>"""
    toc = TocIndex.from_ncx(ncx)
    assert toc.navpoint_count == 2
    assert toc.depth_for_id('part0004_BF-9') == 1       # top-level navPoint → depth 1
    assert toc.depth_for_id('part0004_CN-3') == 2       # nested → depth 2
    assert toc.label_for_id('part0004_bf-9'.replace('bf', 'BF')) == 'chapter one'
    assert 'a section' in toc.labels


def test_empty_ncx_is_inert():
    toc = TocIndex.from_ncx(None)
    assert toc.navpoint_count == 0 and toc.has_toc is False
    assert toc.depth_for_id('anything') is None

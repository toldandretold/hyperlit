"""Unit tests for the epub_normalizer footnote DETECTOR classes — the "identifying
footnotes in epubs" stage. Each detector is exercised three ways:
  * detect() fires on its target structure (true positive)
  * detect() does NOT fire on plain prose (false-positive guard — mis-identification is
    the main failure mode here)
  * transform() extracts the expected footnote ids with the right `strategy` tag

These ran only end-to-end via the regression fixtures before; here they're isolated so a
broken detector pinpoints to one class.
"""

import epub_normalizer as E


def _logs():
    sink = []
    return sink, sink.append


# Plain prose with a couple of ordinary internal links — must NOT look like footnotes
# to any of the *specific* detectors (the heuristic fallback is excepted below).
PLAIN = ('<body><h2>Introduction</h2><p>Some ordinary prose with a '
         '<a href="#sec2">cross reference</a> to another section.</p>'
         '<h2 id="sec2">Second Section</h2><p>More prose.</p></body>')


# ---------------------------------------------------------------------------
# Epub3SemanticFootnoteDetector — epub:type attributes (W3C standard)
# ---------------------------------------------------------------------------
def test_epub3_semantic_detect_and_extract(soup):
    s = soup('<body><p>Claim<a epub:type="noteref" href="#fn1">1</a>.</p>'
             '<aside epub:type="footnote" id="fn1">the note</aside></body>')
    det = E.Epub3SemanticFootnoteDetector()
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert [f['id'] for f in out['footnotes']] == ['fn1']
    assert out['footnotes'][0]['strategy'] == 'epub3_semantic'
    assert out['noterefs'][0]['target_id'] == 'fn1'


def test_epub3_semantic_no_false_positive(soup):
    assert E.Epub3SemanticFootnoteDetector().detect(soup(PLAIN)) is False


# ---------------------------------------------------------------------------
# AriaRoleFootnoteDetector — role="doc-footnote"/"doc-noteref"
# ---------------------------------------------------------------------------
def test_aria_role_detect_and_extract(soup):
    s = soup('<body><p>Claim<a role="doc-noteref" href="#fn1">1</a>.</p>'
             '<aside role="doc-footnote" id="fn1">the note</aside></body>')
    det = E.AriaRoleFootnoteDetector()
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert [f['id'] for f in out['footnotes']] == ['fn1']
    assert out['footnotes'][0]['strategy'] == 'aria_role'


def test_aria_role_no_false_positive(soup):
    assert E.AriaRoleFootnoteDetector().detect(soup(PLAIN)) is False


# ---------------------------------------------------------------------------
# ClassPatternFootnoteDetector — CSS class names
# ---------------------------------------------------------------------------
def test_class_pattern_detect_and_extract(soup):
    s = soup('<body><p>Claim<a class="footnote-ref" href="#fn1">1</a>.</p>'
             '<p class="footnote" id="fn1">the note</p></body>')
    det = E.ClassPatternFootnoteDetector()
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert 'fn1' in [f['id'] for f in out['footnotes']]
    assert out['noterefs'][0]['target_id'] == 'fn1'


def test_class_pattern_no_false_positive(soup):
    assert E.ClassPatternFootnoteDetector().detect(soup(PLAIN)) is False


# ---------------------------------------------------------------------------
# NotesClassFootnoteDetector — <p class="notes"> with child anchor + backlink
# ---------------------------------------------------------------------------
def test_notes_class_detect_and_extract(soup):
    s = soup('<body><p class="notes"><a id="n1" href="#ref1">1</a> the note</p></body>')
    det = E.NotesClassFootnoteDetector()
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert [f['id'] for f in out['footnotes']] == ['n1']
    assert out['footnotes'][0]['strategy'] == 'notes_class'


def test_notes_class_requires_backlink(soup):
    # anchor without an href (no backlink) is NOT treated as a footnote definition
    s = soup('<body><p class="notes"><a id="n1">1</a> the note</p></body>')
    out = E.NotesClassFootnoteDetector().transform(s, _logs()[1])
    assert out['footnotes'] == []


def test_notes_class_no_false_positive(soup):
    assert E.NotesClassFootnoteDetector().detect(soup(PLAIN)) is False


# ---------------------------------------------------------------------------
# TableFootnoteDetector — table layouts
# ---------------------------------------------------------------------------
def test_table_detect_by_class(soup):
    s = soup('<body><table class="footnotes"><tr><td>'
             '<a id="fn1" href="#r1">1</a> the note</td></tr></table></body>')
    assert E.TableFootnoteDetector().detect(s) is True


def test_table_no_false_positive(soup):
    s = soup('<body><table class="data"><tr><td>plain cell</td></tr></table></body>')
    assert E.TableFootnoteDetector().detect(s) is False


# ---------------------------------------------------------------------------
# PandocFootnoteDetector — <section class="footnotes">
# ---------------------------------------------------------------------------
def test_pandoc_detect(soup):
    s = soup('<body><section class="footnotes"><ol><li id="fn1">note</li></ol></section></body>')
    assert E.PandocFootnoteDetector().detect(s) is True


def test_pandoc_no_false_positive(soup):
    assert E.PandocFootnoteDetector().detect(soup(PLAIN)) is False


# ---------------------------------------------------------------------------
# EndnoteCharactersFootnoteDetector — <span class="EndnoteCharacters">
# ---------------------------------------------------------------------------
def test_endnote_characters_detect(soup):
    s = soup('<body><p>Claim<a href="#n1"><span class="EndnoteCharacters">1</span></a>.</p>'
             '<p><a id="n1"></a>the note</p></body>')
    assert E.EndnoteCharactersFootnoteDetector().detect(s) is True


def test_endnote_characters_no_false_positive(soup):
    assert E.EndnoteCharactersFootnoteDetector().detect(soup(PLAIN)) is False


# ---------------------------------------------------------------------------
# EnoteFootnoteDetector — <sup class="enote...">
# ---------------------------------------------------------------------------
def test_enote_detect(soup):
    s = soup('<body><p>Claim<sup class="enote"><a href="#n1">1</a></sup>.</p>'
             '<p id="n1">the note</p></body>')
    assert E.EnoteFootnoteDetector().detect(s) is True


def test_enote_no_false_positive(soup):
    # a plain superscript (no enote class) must not trip it
    s = soup('<body><p>E = mc<sup>2</sup>.</p></body>')
    assert E.EnoteFootnoteDetector().detect(s) is False


# ---------------------------------------------------------------------------
# AnchorHeadingFootnoteDetector — <hN id=X>Note N</hN> + content, linked by <a href=#X>
# ---------------------------------------------------------------------------
def test_anchor_heading_detect_and_extract(soup):
    s = soup('<body><p>Claim<a href="#n33">Note 33</a>.</p>'
             '<h2 id="n33">Note 33</h2><p>the note content</p></body>')
    det = E.AnchorHeadingFootnoteDetector()
    assert det.detect(s) is True
    out = det.transform(s, _logs()[1])
    assert any(f['id'] == 'n33' for f in out['footnotes'])


def test_anchor_heading_requires_linked_heading(soup):
    # "Note 33" heading exists but nothing links to its id -> not a footnote definition
    s = soup('<body><h2 id="n33">Note 33</h2><p>content</p></body>')
    assert E.AnchorHeadingFootnoteDetector().detect(s) is False


# ---------------------------------------------------------------------------
# HeuristicFootnoteDetector — always-on fallback
# ---------------------------------------------------------------------------
def test_heuristic_always_detects(soup):
    assert E.HeuristicFootnoteDetector().detect(soup(PLAIN)) is True


# ---------------------------------------------------------------------------
# Cross-detector false-positive sweep: on plain prose, NO specific detector fires.
# ---------------------------------------------------------------------------
def test_no_specific_detector_fires_on_plain_prose(soup):
    specific = [
        E.Epub3SemanticFootnoteDetector, E.AriaRoleFootnoteDetector,
        E.ClassPatternFootnoteDetector, E.NotesClassFootnoteDetector,
        E.TableFootnoteDetector, E.PandocFootnoteDetector,
        E.EndnoteCharactersFootnoteDetector, E.EnoteFootnoteDetector,
        E.AnchorHeadingFootnoteDetector,
    ]
    fired = [d.__name__ for d in specific if d().detect(soup(PLAIN))]
    assert fired == []

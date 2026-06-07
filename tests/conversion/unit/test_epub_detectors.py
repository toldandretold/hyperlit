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


# ---------------------------------------------------------------------------
# Assessment "considered" set: every footnote detector must declare its would_need
# (the markup it keys on), so the no-footnotes diagnostic never has a gap.
# ---------------------------------------------------------------------------
def test_detector_needs_covers_every_footnote_detector():
    import inspect
    detectors = [name for name, obj in inspect.getmembers(E, inspect.isclass)
                 if name.endswith('FootnoteDetector')]
    needs = E.EpubNormalizer._DETECTOR_NEEDS
    missing = [d for d in detectors if d not in needs]
    assert missing == [], f"_DETECTOR_NEEDS missing would_need for: {missing}"
    assert len(detectors) >= 10


# ---------------------------------------------------------------------------
# SectionNumberHeadingDetector — bold, section-numbered blocks in a non-<p> wrapper
# (the christian2014digital scheme: <blockquote class="calibre_21"><span class="bold">1.1. …)
# ---------------------------------------------------------------------------
def test_section_number_heading_levels_from_numbering(soup):
    s = soup('<body>'
             '<blockquote class="calibre_21"><a href="#x"><span class="bold">1. Introduction</span></a></blockquote>'
             '<blockquote class="calibre_21"><span class="bold">1.1. The Need for Studying Digital Labour</span></blockquote>'
             '<blockquote class="calibre_21"><span class="bold">2.3.2.1. Use-Value and Value</span></blockquote>'
             '<blockquote class="calibre_21"><span class="bold">PART I Theoretical Foundations</span></blockquote>'
             '</body>')
    det = E.SectionNumberHeadingDetector()
    assert det.detect(s) is True
    det.transform(s, _logs()[1])
    got = [(h.name, h.get_text(strip=True)) for h in s.find_all(['h1', 'h2', 'h3', 'h4'])]
    assert ('h1', '1. Introduction') in got               # depth 1 → h1
    assert ('h2', '1.1. The Need for Studying Digital Labour') in got
    assert ('h4', '2.3.2.1. Use-Value and Value') in got  # depth 4 → h4
    assert ('h1', 'PART I Theoretical Foundations') in got # PART → h1
    # the TOC back-link is stripped — a heading is not a link
    assert s.find('h1', string=None).find('a') is None


def test_section_number_heading_skips_toc_and_body(soup):
    # the discriminators: a body line with no bold, an un-numbered bold quote, and a real
    # container (block child) — none should become headings (esp. the non-bold TOC twin).
    s = soup('<body>'
             '<blockquote class="toc"><a href="#x">1.1. The Need for Studying Digital Labour</a></blockquote>'  # TOC: no bold
             '<p>711 Third Avenue, New York, NY 10017</p>'                       # body <p> starting with a number
             '<blockquote><span class="bold">An epigraph with no section number</span></blockquote>'
             '<blockquote><p>2.1 a real paragraph container</p></blockquote>'
             '</body>')
    det = E.SectionNumberHeadingDetector()
    assert det.detect(s) is False
    det.transform(s, _logs()[1])
    assert s.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) == []


def test_heading_needs_covers_section_number_detector():
    # the human-readable heading index must describe this detector (anti-drift, like footnotes above)
    assert 'SectionNumberHeadingDetector' in E.EpubNormalizer._HEADING_NEEDS


# ---------------------------------------------------------------------------
# StyledSectionTitleHeadingDetector — bold section-title <p> (BIBLIOGRAPHY/INDEX/…) → h1
# (christian2014digital: 'BIBLIOGRAPHY' as a bold <p> hid the 573-entry reference list)
# ---------------------------------------------------------------------------
_REF_ENTRY = ('Adorno, Theodor W. 1968/2003. Late capitalism or industrial society? '
              'The fundamental question of the present structure of society.')


def test_section_title_detector_converts_real_section_heading(soup):
    # 'BIBLIOGRAPHY' as a bold styled <p> followed by reference CONTENT → h1 (TOC back-link stripped)
    s = soup('<body>'
             '<p class="x"><a href="#t"><span class="calibre1"><span class="bold">BIBLIOGRAPHY</span></span></a></p>'
             f'<p>{_REF_ENTRY}</p><p>{_REF_ENTRY}</p>'
             '</body>')
    det = E.StyledSectionTitleHeadingDetector()
    assert det.detect(s) is True
    det.transform(s, _logs()[1])
    assert [h.get_text(strip=True) for h in s.find_all('h1')] == ['BIBLIOGRAPHY']
    assert s.find('h1').find('a') is None       # TOC back-link stripped


def test_section_title_detector_skips_toc_entry(soup):
    # the false positive this closes: a bold 'glossary' TOC entry — same title text, but FOLLOWED BY
    # MORE nav links (other TOC entries), not section content → must NOT become a heading.
    s = soup('<body>'
             '<p class="toc"><a href="glossary.xhtml#g"><b>glossary</b></a></p>'
             '<p class="toc"><a href="index.xhtml#i"><b>index</b></a></p>'
             '<p class="toc"><a href="notes.xhtml#n"><b>notes</b></a></p>'
             '</body>')
    det = E.StyledSectionTitleHeadingDetector()
    assert det.detect(s) is False
    det.transform(s, _logs()[1])
    assert s.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) == []


def test_section_title_detector_no_false_positive(soup):
    # a bold REFERENCE ENTRY, and prose that merely mentions a section word, must NOT convert
    s = soup('<body>'
             f'<p><span class="bold">{_REF_ENTRY}</span></p>'                     # bold but not a bare title
             '<p>See the bibliography for the full list of references below.</p>' # mentions it, not a title
             f'<p>Bibliography</p><p>{_REF_ENTRY}</p>'                            # title text but NOT bold
             '</body>')
    det = E.StyledSectionTitleHeadingDetector()
    assert det.detect(s) is False
    det.transform(s, _logs()[1])
    assert s.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) == []


def test_heading_needs_covers_section_title_detector():
    assert 'StyledSectionTitleHeadingDetector' in E.EpubNormalizer._HEADING_NEEDS


# ---------------------------------------------------------------------------
# _document_profile — the raw structural fingerprint (tags + classes + shape signals)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# NavStripper — drop page-list / landmarks machine-nav (else page anchors → false footnotes)
# (rudolph1981finance: a 478-anchor page-list put 66 false <sup footnote-ref> at the front)
# ---------------------------------------------------------------------------
def test_nav_stripper_removes_machine_nav_keeps_toc(soup):
    s = soup('<body>'
             '<nav epub:type="toc"><ol><li><a href="#c1">Chapter 1</a></li></ol></nav>'
             '<nav epub:type="page-list"><ol><li><a href="#page_406">406</a></li>'
             '<li><a href="#page_407">407</a></li></ol></nav>'
             '<nav epub:type="landmarks"><ol><li><a href="#cover">Cover</a></li></ol></nav>'
             '<p>body</p></body>')
    det = E.NavStripper()
    assert det.detect(s) is True
    out = det.transform(s, _logs()[1])
    assert out['navs_removed'] == 2 and out['anchors_removed'] == 3
    navs = s.find_all('nav')
    assert len(navs) == 1 and 'toc' in (navs[0].get('epub:type') or '')     # toc kept
    assert s.find('a', href='#page_406') is None                            # page-list gone
    assert s.find('a', href='#cover') is None                               # landmarks gone


def test_nav_stripper_noop_without_machine_nav(soup):
    s = soup('<body><nav epub:type="toc"><a href="#c1">Chapter 1</a></nav><p>x</p></body>')
    assert E.NavStripper().detect(s) is False


def test_document_profile_fingerprints_faked_headings(soup):
    # a Calibre-style book: 0 real headings, bold styled <p> section titles → "headings are faked" signal
    s = soup('<body>'
             '<p class="calibre_"><span class="bold">BIBLIOGRAPHY</span></p>'
             '<p class="calibre_45">Adorno, Theodor W. 1968. Late capitalism. Frankfurt: Suhrkamp.</p>'
             '<p class="calibre_45">Marx, Karl. 1867. Capital. London: Penguin.</p>'
             '</body>')
    prof = E._document_profile(s)
    assert prof['shape_signals']['semantic_headings'] == 0       # no real <h*>
    assert prof['shape_signals']['bold_short_blocks'] >= 1       # the bold 'BIBLIOGRAPHY' title
    assert prof['tag_histogram']['p'] == 3
    assert prof['top_classes']['p.calibre_45'] == 2              # publisher fingerprint surfaces


# ---------------------------------------------------------------------------
# Resilience: one detector throwing must NOT kill the whole conversion. The error is reported in the
# `[detector-error]` format the vibe loop captures + feeds back to the model.
# ---------------------------------------------------------------------------
def test_report_detector_error_emits_model_facing_line(capsys):
    class _Boom:
        name = 'BoomFootnoteDetector'
    logs, log = _logs()
    try:
        raise AttributeError("'NoneType' object has no attribute 'find_next'")
    except AttributeError as e:
        E._report_detector_error(_Boom(), e, log)
    err = capsys.readouterr().err
    assert '[detector-error] BoomFootnoteDetector raised AttributeError' in err   # header the model sees
    assert 'find_next' in err                                                     # the actual cause
    assert any('[detector-error]' in m for m in logs)                             # also in the debug log


# ---------------------------------------------------------------------------
# InlineAnchorNoteFootnoteDetector — empty <a id=X></a> + following note block, linked by <a href=#X><sup>
# ---------------------------------------------------------------------------
def test_inline_anchor_note_detect_extract_and_pair(soup):
    s = soup('<body>'
             '<p>Claim<a href="#fn1"><sup>1</sup></a> and<a href="#fn2"><sup>2</sup></a>.</p>'
             '<h2>NOTES</h2>'
             '<a id="fn1"> </a><p class="smallhangingpara">1 First note text.</p>'
             '<a id="fn2"> </a><p class="smallhangingpara">2 Second note text.</p>'
             '</body>')
    det = E.InlineAnchorNoteFootnoteDetector()
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert [f['id'] for f in out['footnotes']] == ['fn1', 'fn2']     # paired by EXPLICIT id, in order
    assert out['footnotes'][0]['strategy'] == 'inline_anchor_note'
    body = out['footnotes'][0]['element'].get_text(strip=True)
    assert body == 'First note text.'                                # content from following block, '1 ' stripped


def test_inline_anchor_note_excludes_toc_links(soup):
    # A TOC <a><sup> link whose target is a chapter HEADING (no following note block) is NOT a footnote.
    s = soup('<body>'
             '<nav><a href="#ch1"><sup>I.</sup></a></nav>'
             '<a id="ch1"></a><h1>Chapter One</h1><p>Body text.</p>'
             '</body>')
    det = E.InlineAnchorNoteFootnoteDetector()
    assert det.detect(s) is False
    _, log = _logs()
    assert det.transform(s, log)['footnotes'] == []


def test_inline_anchor_note_ignores_non_sup_link_targets(soup):
    # A page-nav / cross-ref <a href> (NO <sup>) pointing at an empty anchor must not make it a footnote.
    s = soup('<body>'
             '<a href="#pg1">go to page</a>'
             '<a id="pg1"> </a><p>Page one starts here.</p>'
             '</body>')
    det = E.InlineAnchorNoteFootnoteDetector()
    assert det.detect(s) is False
    _, log = _logs()
    assert det.transform(s, log)['footnotes'] == []

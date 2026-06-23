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
# BlindNotesFootnoteDetector — "blind notes": no in-text marker; the back-of-book
# note carries the only link (a reversed <p class="link_to_text"> back-link to an
# empty <span id> body anchor). Pairs by the back-link id; injects numbered markers.
# ---------------------------------------------------------------------------
def test_blind_notes_detect_and_pair(soup):
    # Body has an empty, hrefless anchor; the note links BACK to it (reversed).
    s = soup('<body><p>Claim by <span id="EndnotePhraseInText0"/>some critics.</p>'
             '<ol class="blindnotes"><li class="x13-BM-Endnotes">'
             '<p class="x13-BM-Endnotes">the note text</p>'
             '<p class="link_to_text"><a href="#EndnotePhraseInText0">GO TO NOTE REFERENCE IN TEXT</a></p>'
             '</li></ol></body>')
    det = E.BlindNotesFootnoteDetector()
    assert det.detect(s) is True
    out = det.transform(s, _logs()[1])
    # definition keyed by the back-link target id, paired with an in-text marker of the same id
    assert [f['id'] for f in out['footnotes']] == ['EndnotePhraseInText0']
    assert out['footnotes'][0]['strategy'] == 'blind_notes'
    assert [n['target_id'] for n in out['noterefs']] == ['EndnotePhraseInText0']
    # empty marker → routes the linker's numeric branch (sequential <sup> injection)
    assert out['noterefs'][0]['original_marker'] == ''
    # the bare <span> anchor was swapped to an <a> so the shared converter can rewrite it
    assert out['noterefs'][0]['element'].name == 'a'
    # the reversed back-link is stripped so "GO TO NOTE…" can't leak into the note content
    assert s.find('p', class_='link_to_text') is None


def test_blind_notes_definition_without_anchor_is_orphan_def(soup):
    # A note whose back-link target is missing from the body → registered as a definition
    # only (the linker counts it as orphaned), never a phantom marker.
    s = soup('<body><p>Prose with no anchor.</p>'
             '<ol class="blindnotes"><li class="x13-BM-Endnotes">'
             '<p class="x13-BM-Endnotes">dangling note</p>'
             '<p class="link_to_text"><a href="#EndnotePhraseInText9">GO TO NOTE REFERENCE IN TEXT</a></p>'
             '</li></ol></body>')
    out = E.BlindNotesFootnoteDetector().transform(s, _logs()[1])
    assert [f['id'] for f in out['footnotes']] == ['EndnotePhraseInText9']
    assert out['noterefs'] == []


def test_blind_notes_marker_relocated_to_sentence_end(soup):
    # The anchor sits BEFORE its key phrase; the marker must move to the end of the sentence.
    s = soup('<body><p>The model is contested by <span id="X0"/>several critics who favour '
             'openness. A later sentence follows.</p>'
             '<ol class="blindnotes"><li class="x13-BM-Endnotes"><p>the note</p>'
             '<p class="link_to_text"><a href="#X0">GO TO NOTE REFERENCE IN TEXT</a></p></li></ol></body>')
    E.BlindNotesFootnoteDetector().transform(s, _logs()[1])
    a = s.find('a', id='X0')
    prev = a.previous_sibling
    assert isinstance(prev, str) and prev.rstrip().endswith('favour openness.')


def test_blind_notes_between_blocks_anchor_moves_inline(soup):
    # Anchor between paragraphs would convert to a stray top-level <sup>; it must move INTO text.
    s = soup('<body><p>Prior paragraph ends here.</p><span id="X1"/>'
             '<p>The next sentence carries the note. And more.</p>'
             '<ol class="blindnotes"><li class="x13-BM-Endnotes"><p>note</p>'
             '<p class="link_to_text"><a href="#X1">GO TO NOTE REFERENCE IN TEXT</a></p></li></ol></body>')
    E.BlindNotesFootnoteDetector().transform(s, _logs()[1])
    a = s.find('a', id='X1')
    assert a.parent.name == 'p'  # now inline in the following paragraph, not a body-level sibling


def test_blind_notes_same_sentence_markers_keep_ascending_order(soup):
    # Two anchors in one sentence resolve to the same full stop — order must stay ascending.
    s = soup('<body><p>A claim <span id="X0"/>and another <span id="X1"/>point all here. Next.</p>'
             '<ol class="blindnotes">'
             '<li class="x13-BM-Endnotes"><p>n0</p><p class="link_to_text"><a href="#X0">GO</a></p></li>'
             '<li class="x13-BM-Endnotes"><p>n1</p><p class="link_to_text"><a href="#X1">GO</a></p></li>'
             '</ol></body>')
    E.BlindNotesFootnoteDetector().transform(s, _logs()[1])
    p = s.find('p')
    assert [a.get('id') for a in p.find_all('a', id=True)] == ['X0', 'X1']


def test_blind_notes_no_false_positive(soup):
    assert E.BlindNotesFootnoteDetector().detect(soup(PLAIN)) is False


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
        E.BlindNotesFootnoteDetector,
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


# ---------------------------------------------------------------------------
# AriaHiddenOrnamentRemover — drop decorative aria-hidden scene-break glyphs (PRH "—" overhang)
# ---------------------------------------------------------------------------
def test_aria_hidden_ornament_removed_keeps_hr_and_text(soup):
    # PRH scene break: <hr> + decorative aria-hidden em-dash + the next paragraph.
    s = soup('<body><hr class="transition"/>'
             '<div aria-hidden="true" class="x04-Space-Break-Orn">—</div>'
             '<p class="x04-Space-Break-FL">On Musk’s list was a real sentence.</p></body>')
    det = E.AriaHiddenOrnamentRemover()
    assert det.detect(s) is True
    det.transform(s, _logs()[1])
    assert s.find('hr') is not None                       # the real scene break survives
    assert s.find(attrs={'aria-hidden': 'true'}) is None  # the decorative ornament is gone
    assert 'On Musk' in s.get_text()                      # real content untouched


def test_aria_hidden_keeps_real_words_and_structure(soup):
    # aria-hidden on something with actual words, or wrapping block content, must NOT be dropped.
    s = soup('<body>'
             '<div aria-hidden="true">Important spoken caption text</div>'
             '<div aria-hidden="true"><p>nested real paragraph</p></div>'
             '</body>')
    E.AriaHiddenOrnamentRemover().transform(s, _logs()[1])
    assert 'Important spoken caption text' in s.get_text()
    assert s.find('p') is not None


def test_aria_hidden_ornament_no_false_positive(soup):
    assert E.AriaHiddenOrnamentRemover().detect(soup(PLAIN)) is False


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


# ---------------------------------------------------------------------------
# AnchoredFootnoteScheme — the declarative factory the two detectors above are now instances of
# ---------------------------------------------------------------------------
def test_anchored_scheme_inline_anchor_via_factory(soup):
    s = soup('<body><p>x<a href="#fn1"><sup>1</sup></a></p>'
             '<a id="fn1"> </a><p class="smallhangingpara">1 note one.</p></body>')
    det = E.AnchoredFootnoteScheme(name='X', marker='sup-link', definition='empty-anchor')
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert [f['id'] for f in out['footnotes']] == ['fn1']
    assert out['footnotes'][0]['element'].get_text(strip=True) == 'note one.'   # number stripped (empty-anchor default)


def test_anchored_scheme_note_heading_via_factory(soup):
    s = soup('<body><p>x<a href="#n1">Note 1</a></p>'
             '<h2 id="n1">Note 1</h2><p>The note body.</p><h2>Next chapter</h2></body>')
    det = E.AnchoredFootnoteScheme(name='Y', marker='any-href', definition='note-heading')
    assert det.detect(s) is True
    _, log = _logs()
    out = det.transform(s, log)
    assert [f['id'] for f in out['footnotes']] == ['n1']
    assert out['footnotes'][0]['element'].get_text(strip=True) == 'The note body.'
    assert s.find('a', href='#n1').get_text(strip=True) == '1'                  # 'Note 1' marker normalised → '1'


def test_anchored_scheme_rejects_unknown_enum():
    import pytest
    with pytest.raises(ValueError):
        E.AnchoredFootnoteScheme(name='Z', marker='bogus', definition='empty-anchor')
    with pytest.raises(ValueError):
        E.AnchoredFootnoteScheme(name='Z', marker='sup-link', definition='bogus')
    with pytest.raises(ValueError):
        E.AnchoredFootnoteScheme(name='Z', marker='sup-link', definition='empty-anchor', content='nope')

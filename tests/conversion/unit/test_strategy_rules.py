"""Unit tests for the STRATEGY_RULES registry (conversion/strategy.py) — the footnote-strategy
decision tree decomposed into ordered StrategyRule units, and the bibliography phase helpers
(conversion/bibliography.py). End-to-end behaviour is guarded by the regression golden; these isolate
the units.
"""

from conversion import strategy as S
from conversion import bibliography as B


def _sig(**over):
    base = {
        'has_footnote_resets': False, 'has_distributed_hrs': False, 'hr_count': 0,
        'references_throughout_definitions_at_end': False, 'has_structured_sections': False,
        'footnotes_at_end': False, 'has_section_pattern': False,
        'position_ratio': 0.5, 'ref_position_ratio': None, 'duplicate_count': 0,
    }
    base.update(over)
    return base


def _pick(sig):
    """Mirror the dispatch in analyze_document_structure."""
    return next((r for r in S.STRATEGY_RULES if r.matches(sig)), S._DEFAULT_STRATEGY_RULE)


# ---------------------------------------------------------------------------
# Registry shape + first-match-wins order
# ---------------------------------------------------------------------------
def test_registry_order_and_default_excluded():
    strategies = [r.strategy for r in S.STRATEGY_RULES]
    assert len(S.STRATEGY_RULES) == 6
    assert S._DEFAULT_STRATEGY_RULE.strategy == 'whole_document'
    # the catch-all is NOT in the registered list (so op:register lands before it)
    assert not any(isinstance(r, S.DefaultStrategyRule) for r in S.STRATEGY_RULES)


def test_resets_with_hrs_wins_over_plain_resets():
    # both reset rules could match; the distributed-HR one is registered first
    r = _pick(_sig(has_footnote_resets=True, has_distributed_hrs=True, hr_count=3, duplicate_count=2))
    assert isinstance(r, S.ResetsWithDistributedHrsRule)
    assert r.strategy == 'sectioned' and r.confidence(_sig()) == 0.85


def test_plain_resets_rule():
    r = _pick(_sig(has_footnote_resets=True, hr_count=1, duplicate_count=1))
    assert isinstance(r, S.ResetsWithHrRule)
    assert r.confidence(_sig()) == 0.7


def test_refs_throughout_defs_at_end_confidence_scales_with_gap():
    sig = _sig(references_throughout_definitions_at_end=True, position_ratio=0.9, ref_position_ratio=0.5)
    r = _pick(sig)
    assert isinstance(r, S.RefsThroughoutDefsAtEndRule)
    assert r.strategy == 'whole_document'
    # gap = 0.4 → min(0.9, 0.6+0.4) = 0.9
    assert r.confidence(sig) == 0.9
    assert '0.90' in r.margin(sig) and 'gap 0.40' in r.margin(sig)


def test_footnotes_at_end_rule():
    sig = _sig(footnotes_at_end=True, position_ratio=0.9)
    r = _pick(sig)
    assert isinstance(r, S.FootnotesAtEndRule)
    # 0.5 + (0.9-0.8)*2 = 0.7
    assert r.confidence(sig) == 0.7


def test_section_header_rule():
    r = _pick(_sig(has_section_pattern=True))
    assert isinstance(r, S.SectionHeaderRule)
    assert r.strategy == 'sectioned' and r.confidence(_sig()) == 0.6


def test_fallthrough_default():
    r = _pick(_sig())   # no positive signal
    assert r is S._DEFAULT_STRATEGY_RULE
    assert r.strategy == 'whole_document' and r.confidence(_sig()) == 0.3
    assert 'FALL-THROUGH' in r.margin(_sig())


# ---------------------------------------------------------------------------
# analyze_document_structure end-to-end (thin shell over the registry) — a few classic cases
# ---------------------------------------------------------------------------
def test_analyze_no_footnotes(soup_html=None):
    from bs4 import BeautifulSoup
    s = BeautifulSoup('<body><p>Just prose with no notes at all.</p></body>', 'html.parser')
    strategy, info = S.analyze_document_structure(s)
    assert strategy == 'no_footnotes'


def test_analyze_sequential_markers():
    from bs4 import BeautifulSoup
    s = BeautifulSoup('<body><a class="footnoteSectionStart"></a>'
                      '<a class="footnoteDefinitionsStart"></a></body>', 'html.parser')
    strategy, info = S.analyze_document_structure(s)
    assert strategy == 'sequential'


# ---------------------------------------------------------------------------
# bibliography phase helper — _find_reference_paragraphs (heading vs reverse scan)
# ---------------------------------------------------------------------------
def test_find_reference_paragraphs_by_heading():
    from bs4 import BeautifulSoup
    html = ('<body><h2>References</h2>'
            '<p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon.</p>'
            '<p>Amin, S. 1974. Accumulation on a World Scale. New York: Monthly Review.</p>'
            '</body>')
    s = BeautifulSoup(html, 'html.parser')
    tags, used_reverse = B._find_reference_paragraphs(s)
    assert len(tags) == 2
    assert used_reverse is False


def test_find_reference_paragraphs_reverse_scan():
    from bs4 import BeautifulSoup
    # no References heading → reverse scan picks up the reference-like trailing paragraphs
    html = ('<body><p>Some body text without citations.</p>'
            '<p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon.</p>'
            '<p>Amin, S. 1974. Accumulation on a World Scale. New York: Monthly Review.</p>'
            '</body>')
    s = BeautifulSoup(html, 'html.parser')
    tags, used_reverse = B._find_reference_paragraphs(s)
    assert used_reverse is True
    assert len(tags) >= 2


# ---------------------------------------------------------------------------
# detect_footnote_sections phase helpers (the positional algorithm, in pieces)
# ---------------------------------------------------------------------------
_ELEMENT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr',
                 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img']


def _elements(html):
    from bs4 import BeautifulSoup
    return BeautifulSoup(html, 'html.parser').find_all(_ELEMENT_TAGS)


def test_find_headers_and_hrs_quirk_hr_counts_as_header():
    # PRE-EXISTING QUIRK (faithfully preserved by the refactor): `'hr'.startswith('h')` is True, so
    # an <hr> falls into the headers branch (empty text) and the `elif name == 'hr'` never fires —
    # `hrs` is always empty, and the header_with_footnotes boundary path is effectively dead. The
    # live section paths are notes_header + the HR fallback (which detects hr by name directly).
    els = _elements('<body><h2>Intro</h2><p>text</p><hr><h3>Notes</h3></body>')
    headers, hrs = S._find_headers_and_hrs(els)
    assert [h['text'] for h in headers] == ['Intro', '', 'Notes']   # the '' is the <hr>
    assert hrs == []


def test_detect_section_boundaries_standalone_notes_header():
    # a "Notes" header with footnotes after → notes_header boundary (the live path)
    els = _elements('<body><h2>Body</h2><p>prose</p>'
                    '<h2>Notes</h2><p>[^1]: a note</p><p>[^2]: another</p></body>')
    headers, hrs = S._find_headers_and_hrs(els)
    bounds = S._detect_section_boundaries(els, headers, hrs)
    assert any(b['type'] == 'notes_header' for b in bounds)


def test_build_sections_sets_index_ranges():
    els = _elements('<body><h2>Body</h2><p>body text</p>'
                    '<h2>Notes</h2><p>[^1]: a note</p><p>[^2]: another</p></body>')
    headers, hrs = S._find_headers_and_hrs(els)
    bounds = S._detect_section_boundaries(els, headers, hrs)
    sections = S._build_sections_from_boundaries(els, bounds)
    assert len(sections) == 1
    sec = sections[0]
    assert sec['id'] == 'section_1'
    assert sec['footnotes_start_idx'] < sec['footnotes_end_idx']
    assert len(sec['footnotes']) == 2


def test_fallback_sections_default_when_no_structure():
    # footnotes but no headers/hrs → one default_section spanning the document
    els = _elements('<body><p>body</p><p>[^1]: a note</p><p>[^2]: another</p></body>')
    sections = S._fallback_sections(els)
    assert len(sections) == 1 and sections[0]['id'] == 'default_section'
    assert len(sections[0]['footnotes']) == 2


def test_fallback_sections_hr_separated_groups():
    els = _elements('<body><p>[^1]: g1 note</p><hr>'
                    '<p>[^2]: g2 note</p><hr><p>tail</p></body>')
    sections = S._fallback_sections(els)
    # two HRs → HR-based grouping (not the default single section)
    assert sections and all(s['id'].startswith('hr_section_') for s in sections)


def test_detect_footnote_sections_end_to_end():
    from bs4 import BeautifulSoup
    s = BeautifulSoup('<body><h2>Chapter</h2><p>body</p>'
                      '<h3>Notes</h3><p>[^1]: a note</p><hr></body>', 'html.parser')
    sections, all_elements = S.detect_footnote_sections(s)
    assert len(sections) == 1
    assert isinstance(all_elements, list) and len(all_elements) > 0

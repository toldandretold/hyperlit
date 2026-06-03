"""Unit tests for the CITATION linking rules (conversion/citation_link_rules.py — Decomposition C,
was conversion/citations.py:link_citations). Each rule is one phase: pre-linked anchor conversion,
the pattern gate, the parenthesized + square-bracket scans, and the assessment record. The modus
operandi (link only on a real bibliography-key match) is exercised per rule.

`bibliography_map` keys are computed via generate_ref_keys so the tests track the real key generation
rather than hard-coding a key shape.
"""

from conversion.citation_link_rules import (
    CitationLinkContext, PreLinkedAnchorConverter, CitationPatternGate,
    ParenthesizedCitationLinker, SquareBracketCitationLinker, AssessmentRecorder,
    link_citations_rules, CITATION_LINK_RULES,
)
from conversion.refkeys import generate_ref_keys


def _key(cite):
    return generate_ref_keys(cite, context_text='')[0]


# ---------------------------------------------------------------------------
# PreLinkedAnchorConverter — existing #id anchors → in-text-citation
# ---------------------------------------------------------------------------
def test_pre_linked_anchor_converter(soup):
    s = soup('<body><p>see <a href="#raw1">Marcuse</a></p></body>')
    ctx = CitationLinkContext(s, {'raw1': 'bib-primary'})
    PreLinkedAnchorConverter().apply(ctx)
    a = s.find('a')
    assert a['href'] == '#bib-primary'
    assert 'in-text-citation' in a.get('class', [])
    assert ctx.anchor_converted == 1


def test_pre_linked_anchor_converter_skips_bib_and_unmatched(soup):
    # The #nope anchor (its own paragraph) has no bibliography match → unmatched. The bib-entry
    # anchor, and any anchor sharing a bibliography paragraph, are skipped entirely.
    s = soup('<body><p>see <a href="#nope">x</a></p>'
             '<p><a class="bib-entry" href="#b">y</a> <a href="#b">backref</a></p></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    assert ctx.anchor_converted == 0
    assert ctx.anchor_unmatched == 1   # only the #nope anchor; the bib paragraph is skipped


# ---------------------------------------------------------------------------
# CitationPatternGate — the two skip reasons
# ---------------------------------------------------------------------------
def test_gate_skips_when_no_bibliography(soup):
    s = soup('<body><p>(Marcuse 2009) is here.</p></body>')
    ctx = CitationLinkContext(s, {})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is True
    assert ctx.skip_reason == 'no_bibliography'


def test_gate_skips_when_no_paren_patterns(soup):
    s = soup('<body><p>no parenthesised citations here</p></body>')
    ctx = CitationLinkContext(s, {'marcuse2009': 'bib1'})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is True
    assert ctx.skip_reason == 'no_paren_patterns'


def test_gate_proceeds_when_patterns_present(soup):
    s = soup('<body><p>As shown (Marcuse 2009).</p></body>')
    ctx = CitationLinkContext(s, {'marcuse2009': 'bib1'})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is False
    assert ctx.skip_reason is None


# ---------------------------------------------------------------------------
# ParenthesizedCitationLinker — (Author YEAR) → <a class="in-text-citation">
# ---------------------------------------------------------------------------
def test_parenthesized_linker_links_matching_citation(soup):
    s = soup('<body><p>As argued (Marcuse 2009).</p></body>')
    ctx = CitationLinkContext(s, {_key('Marcuse 2009'): 'bib-marcuse'})
    ParenthesizedCitationLinker().apply(ctx)
    a = s.find('a', class_='in-text-citation')
    assert a is not None
    assert a['href'] == '#bib-marcuse'
    assert a.get_text() == '2009'          # only the year is wrapped; the author stays as text
    assert ctx.citations_linked == 1


def test_parenthesized_linker_leaves_unmatched_as_plain_text(soup):
    s = soup('<body><p>As argued (Marcuse 2009).</p></body>')
    ctx = CitationLinkContext(s, {'someoneelse1990': 'bib-x'})
    ParenthesizedCitationLinker().apply(ctx)
    assert s.find('a', class_='in-text-citation') is None
    assert ctx.citations_found == 1
    assert ctx.citations_linked == 0
    assert ctx.citations_unlinked and ctx.citations_unlinked[0]['citation'] == 'Marcuse 2009'


def test_parenthesized_linker_skipped_when_gate_set(soup):
    s = soup('<body><p>(Marcuse 2009)</p></body>')
    ctx = CitationLinkContext(s, {_key('Marcuse 2009'): 'bib'})
    ctx.skip_citation_scan = True
    ParenthesizedCitationLinker().apply(ctx)
    assert s.find('a', class_='in-text-citation') is None


# ---------------------------------------------------------------------------
# SquareBracketCitationLinker — [Author YEAR]
# ---------------------------------------------------------------------------
def test_square_bracket_linker_links_matching_citation(soup):
    s = soup('<body><p>As argued [Marcuse 2009].</p></body>')
    ctx = CitationLinkContext(s, {_key('Marcuse 2009'): 'bib-marcuse'})
    SquareBracketCitationLinker().apply(ctx)
    a = s.find('a', class_='in-text-citation')
    assert a is not None and a['href'] == '#bib-marcuse'
    assert ctx.citations_linked == 1


# ---------------------------------------------------------------------------
# AssessmentRecorder — records the pass without mutating the soup
# ---------------------------------------------------------------------------
def test_assessment_recorder_runs_for_each_branch(soup):
    # no_bibliography branch
    ctx = CitationLinkContext(soup('<body><p>x</p></body>'), {})
    ctx.skip_reason = 'no_bibliography'
    AssessmentRecorder().apply(ctx)   # must not raise
    # linked branch
    ctx2 = CitationLinkContext(soup('<body><p>x</p></body>'), {'k': 'v'})
    ctx2.citations_found, ctx2.citations_linked = 2, 1
    ctx2.citations_unlinked = [{'citation': 'Foo 1999', 'generated_keys': ['foo1999']}]
    AssessmentRecorder().apply(ctx2)  # must not raise


# ---------------------------------------------------------------------------
# link_citations_rules — end-to-end tuple return
# ---------------------------------------------------------------------------
def test_link_citations_rules_end_to_end(soup):
    s = soup('<body><p>As argued (Marcuse 2009) and [Smith 2010].</p></body>')
    bib = {_key('Marcuse 2009'): 'bib-m', _key('Smith 2010'): 'bib-s'}
    found, linked, unlinked = link_citations_rules(s, bib)
    assert found == 2
    assert linked == 2
    assert unlinked == []
    hrefs = {a['href'] for a in s.find_all('a', class_='in-text-citation')}
    assert hrefs == {'#bib-m', '#bib-s'}


def test_link_citations_rules_noop_without_bibliography(soup):
    s = soup('<body><p>(Marcuse 2009) with no bibliography.</p></body>')
    found, linked, unlinked = link_citations_rules(s, {})
    assert (found, linked, unlinked) == (0, 0, [])
    assert s.find('a', class_='in-text-citation') is None


def test_citation_registry_order():
    names = [r.name for r in CITATION_LINK_RULES]
    assert names.index('citation_pattern_gate') < names.index('parenthesized_citation_linker')
    assert names.index('parenthesized_citation_linker') < names.index('square_bracket_citation_linker')
    assert names[-1] == 'citation_assessment_recorder'

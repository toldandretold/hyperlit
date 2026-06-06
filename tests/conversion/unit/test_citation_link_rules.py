"""Unit tests for the CITATION linking rules (conversion/citation_link_rules.py — Decomposition C,
was conversion/citations.py:link_citations). Each rule is one phase: pre-linked anchor conversion,
the pattern gate, the parenthesized + square-bracket scans, and the assessment record. The modus
operandi (link only on a real bibliography-key match) is exercised per rule.

`bibliography_map` keys are computed via generate_ref_keys so the tests track the real key generation
rather than hard-coding a key shape.
"""

from digestion.citationLinking.citation_link_rules import (
    CitationLinkContext, PreLinkedAnchorConverter, CitationPatternGate,
    ParenthesizedCitationLinker, SquareBracketCitationLinker, AssessmentRecorder,
    link_citations_rules, CITATION_LINK_RULES,
)
from shared.refkeys import generate_ref_keys


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
# CitationPatternGate — skip reasons + the (Author YEAR) / [Author YEAR] pre-check
# ---------------------------------------------------------------------------
def test_gate_skips_when_no_bibliography(soup):
    s = soup('<body><p>(Marcuse 2009) is here.</p></body>')
    ctx = CitationLinkContext(s, {})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is True
    assert ctx.skip_reason == 'no_bibliography'


def test_gate_skips_when_no_citation_patterns(soup):
    s = soup('<body><p>no parenthesised or bracketed citations here</p></body>')
    ctx = CitationLinkContext(s, {'marcuse2009': 'bib1'})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is True
    assert ctx.skip_reason == 'no_citation_patterns'


def test_gate_proceeds_when_paren_patterns_present(soup):
    s = soup('<body><p>As shown (Marcuse 2009).</p></body>')
    ctx = CitationLinkContext(s, {'marcuse2009': 'bib1'})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is False
    assert ctx.skip_reason is None


def test_gate_proceeds_on_square_bracket_author_date(soup):
    # [Author, YEAR] with NO parentheses anywhere — must still fire (the fix).
    s = soup('<body><p>As shown [Baldwin, 2018] in recent work.</p></body>')
    ctx = CitationLinkContext(s, {'baldwin2018': 'bib1'})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is False
    assert ctx.skip_reason is None


def test_gate_does_not_fire_on_numeric_or_bare_year_brackets(soup):
    # Numeric STEM cites [36] / [6-8] (handled by the PDF wrap_stem_citations) and bare bracketed dates
    # [2013] (no author letter) must NOT trip the gate — only AUTHOR-date brackets do.
    s = soup('<body><p>see [36] and [6-8]; the book [2013] is older.</p></body>')
    ctx = CitationLinkContext(s, {'x2013': 'bib1'})
    CitationPatternGate().apply(ctx)
    assert ctx.skip_citation_scan is True
    assert ctx.skip_reason == 'no_citation_patterns'


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


def test_bracket_only_document_links_through_full_chain(soup):
    # The regression case for the fix: a source citing ONLY with [Author, YEAR] (NO parentheses) must
    # link end-to-end — the gate now fires on the bracket pattern, so SquareBracketCitationLinker runs.
    s = soup('<body><p>Recent work [Baldwin, 2018] and others [Wolfe, 2018] agree.</p></body>')
    bib = {_key('Baldwin 2018'): 'bib-baldwin', _key('Wolfe 2018'): 'bib-wolfe'}
    found, linked, unlinked = link_citations_rules(s, bib)
    assert linked == 2, 'both square-bracket author-date citations should link'
    hrefs = sorted(a['href'] for a in s.find_all('a', class_='in-text-citation'))
    assert hrefs == ['#bib-baldwin', '#bib-wolfe']


# ---------------------------------------------------------------------------
# AssessmentRecorder — records the pass without mutating the soup
# ---------------------------------------------------------------------------
def test_assessment_recorder_raises_suspicion_on_full_miss(soup):
    # A bibliography exists but 0 of N bracketed-year candidates linked → a SUSPICION (not a verdict):
    # MIGHT be missing references upstream, OR prose-years. Low confidence + a "please read" margin.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    ctx = CitationLinkContext(soup('<body><p>x</p></body>'), {'but1936': 'but1936'})
    ctx.citations_found, ctx.citations_linked = 158, 0
    ctx.citations_unlinked = [{'citation': 'March, 1923', 'generated_keys': ['march1923']}]
    AssessmentRecorder().apply(ctx)
    rec = [r for r in ASSESSMENT.records if r['module'] == 'citation_link_audit'][-1]
    assert rec['evidence']['full_miss'] is True
    assert rec['confidence'] < 0.5                # flagged as a suspicion, never asserted as a fault
    assert 'MIGHT' in rec['margin'] and 'read the text' in rec['margin']


def test_assessment_recorder_does_not_flag_markup_cited_doc(soup):
    # Citations wired via source id/class anchors (anchor_converted > 0) — the text "(Year)" scan
    # linking 0 is EXPECTED, NOT a miss. The full-miss suspicion must not fire.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    ctx = CitationLinkContext(soup('<body><p>x</p></body>'), {'a0': 'a0', 'a1': 'a1'})
    ctx.citations_found, ctx.citations_linked = 12, 0
    ctx.anchor_converted = 12               # all citations came pre-wired in the source markup
    AssessmentRecorder().apply(ctx)
    rec = [r for r in ASSESSMENT.records if r['module'] == 'citation_link_audit'][-1]
    assert rec['evidence']['markup_cited'] is True
    assert rec['evidence']['full_miss'] is False     # NOT flagged as a miss
    assert rec['confidence'] >= 0.8
    assert 'EXPECTED' in rec['margin']


def test_assessment_recorder_full_miss_with_populated_bib(soup):
    # Same suspicion shape with a populated bibliography — still a flag, framed as a question.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    bib = {f'a{i}': f'a{i}' for i in range(5)}
    ctx = CitationLinkContext(soup('<body><p>x</p></body>'), bib)
    ctx.citations_found, ctx.citations_linked = 4, 0
    ctx.citations_unlinked = [{'citation': 'Foo 1999', 'generated_keys': ['foo1999']}]
    AssessmentRecorder().apply(ctx)
    rec = [r for r in ASSESSMENT.records if r['module'] == 'citation_link_audit'][-1]
    assert rec['evidence']['full_miss'] is True
    assert rec['confidence'] < 0.5
    assert rec['evidence']['bibliography_entries'] == 5


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

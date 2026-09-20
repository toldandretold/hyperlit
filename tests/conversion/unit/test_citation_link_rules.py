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
# PreLinkedAnchorConverter — a PUBLISHER's anchor resolved through the DOM
#
# A real EPUB/HTML arrives already cited: every year is an
# `<a epub:type="biblioref" href="#index_CIT0061">1974a</a>` aimed at the reference paragraph's
# own id. That id is the publisher's, not one of our generated author-year keys, so the
# bibliography_map lookup missed EVERY one of them — nicholls-nieo-epub: 171 anchors, 0 converted,
# and the fallback text scan then found 3 citations because the years now live inside <a> tags.
# PASS 1A has already stamped `<a class="bib-entry">` into the target paragraph, so the answer is
# in the DOM.
# ---------------------------------------------------------------------------
def test_publisher_anchor_resolves_through_the_reference_paragraph(soup):
    s = soup('<body><p>as argued (UNGA <a href="#index_CIT0061">1974a</a>).</p>'
             '<p id="index_CIT0061"><a class="bib-entry" id="unga1974a"></a>'
             'United Nations General Assembly. 1974a. Declaration.</p></body>')
    ctx = CitationLinkContext(s, {})          # deliberately EMPTY — the key map cannot help here
    PreLinkedAnchorConverter().apply(ctx)
    a = s.find('a', href=True)
    assert a['href'] == '#unga1974a'
    assert 'in-text-citation' in a.get('class', [])
    assert (ctx.anchor_converted, ctx.anchor_unmatched) == (1, 0)


def test_publisher_anchor_resolves_when_the_id_is_on_a_marker_inside_the_entry(soup):
    # Some publishers put the target id on an empty anchor at the head of the entry rather than
    # on the <p> itself.
    s = soup('<body><p>see (Ostrom <a href="#cit7">1990</a>).</p>'
             '<p><a id="cit7"></a><a class="bib-entry" id="ostrom1990"></a>'
             'Ostrom, E. 1990. Governing the Commons.</p></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    assert s.find('a', href=True)['href'] == '#ostrom1990'
    assert ctx.anchor_converted == 1


def test_anchor_to_a_section_wrapper_is_not_resolved_to_its_first_entry(soup):
    # "#references" names the SECTION, not a work. Resolving it to whichever entry came first
    # would be a confident wrong link — leave it alone and count it unmatched.
    s = soup('<body><p>see the <a href="#references">reference list</a>.</p>'
             '<section id="references">'
             '<p><a class="bib-entry" id="ostrom1990"></a>Ostrom, E. 1990. Governing.</p>'
             '</section></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    assert s.find('a', href=True)['href'] == '#references'   # untouched
    assert (ctx.anchor_converted, ctx.anchor_unmatched) == (0, 1)


def test_anchor_to_a_non_bibliography_target_is_left_alone(soup):
    s = soup('<body><p>see <a href="#fig1">Figure 1</a>.</p>'
             '<figure id="fig1"><img src="x.png"/></figure></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    assert s.find('a', href=True)['href'] == '#fig1'
    assert (ctx.anchor_converted, ctx.anchor_unmatched) == (0, 1)


def test_publisher_anchor_resolves_from_a_SELF_REFERENTIAL_ABSOLUTE_url(soup):
    # eLife cites itself absolutely: `https://elifesciences.org/articles/60080#bib24`, never a bare
    # `#bib24`. Requiring startswith('#') threw all 32 of barnett-2020's citations away as
    # "external", and since they were already <a> tags the text scan would not touch them either —
    # the book converted with ZERO linked citations and its review extracted no claims at all.
    # The URL's shape cannot be the test (a pasted fragment has no <head> to compare against);
    # landing on a bibliography entry in THIS document is.
    s = soup('<body><p>acronyms hinder reading '
             '(<a href="https://elifesciences.org/articles/60080#bib24">Sword, 2012</a>).</p>'
             '<p id="bib24"><a class="bib-entry" id="sword2012"></a>'
             'Sword, H. 2012. Stylish Academic Writing.</p></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    a = s.find('a', href=True)
    assert a['href'] == '#sword2012'
    assert 'in-text-citation' in a.get('class', [])
    assert (ctx.anchor_converted, ctx.anchor_unmatched) == (1, 0)


def test_absolute_url_whose_fragment_is_not_a_reference_is_left_untouched(soup):
    # The safety property: an ordinary outbound link is not captured just because it carries a
    # fragment. Its target names nothing here, so it stays exactly as the author wrote it.
    s = soup('<body><p>see the <a href="https://example.com/guide#section-3">style guide</a>.</p>'
             '<p><a class="bib-entry" id="sword2012"></a>Sword, H. 2012. Stylish.</p></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    assert s.find('a', href=True)['href'] == 'https://example.com/guide#section-3'
    assert ctx.anchor_converted == 0


def test_absolute_url_with_no_fragment_is_never_a_candidate(soup):
    # No fragment at all means there is nothing to resolve; it must not even be counted as an
    # unmatched citation anchor, or every outbound link in a book would inflate that number.
    s = soup('<body><p>see <a href="https://example.com/paper">the paper</a>.</p>'
             '<p><a class="bib-entry" id="sword2012"></a>Sword, H. 2012. Stylish.</p></body>')
    ctx = CitationLinkContext(s, {})
    PreLinkedAnchorConverter().apply(ctx)
    assert s.find('a', href=True)['href'] == 'https://example.com/paper'
    assert (ctx.anchor_converted, ctx.anchor_unmatched) == (0, 0)


def test_markup_wired_counts_reach_the_caller_through_stats(soup):
    # The (found, linked, unlinked) tuple counts the TEXT scan only. A publisher EPUB is cited
    # entirely through markup, so without this the book reported citations_linked: 0 while
    # carrying 170 working links.
    s = soup('<body><p>as argued (UNGA <a href="#c1">1974a</a>).</p>'
             '<p id="c1"><a class="bib-entry" id="unga1974a"></a>UNGA. 1974a. Declaration.</p>'
             '</body>')
    stats = {}
    link_citations_rules(s, {}, None, stats)
    assert stats['anchor_converted'] == 1
    assert stats['anchor_unmatched'] == 0


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
    # the bib-entry anchors must EXIST: extract_bibliography creates the anchor and the map
    # entry together, and UnresolvedCitationDemoter rightly unwraps an href naming no anchor.
    s = soup('<body><p>Recent work [Baldwin, 2018] and others [Wolfe, 2018] agree.</p>'
             '<p><a class="bib-entry" id="bib-baldwin"></a>Baldwin 2018.</p>'
             '<p><a class="bib-entry" id="bib-wolfe"></a>Wolfe 2018.</p></body>')
    bib = {_key('Baldwin 2018'): 'bib-baldwin', _key('Wolfe 2018'): 'bib-wolfe'}
    found, linked, unlinked = link_citations_rules(s, bib)
    assert linked == 2, 'both square-bracket author-date citations should link'
    hrefs = sorted(a['href'] for a in s.find_all('a', class_='in-text-citation'))
    assert hrefs == ['#bib-baldwin', '#bib-wolfe']


# ---------------------------------------------------------------------------
# AssessmentRecorder — records the pass without mutating the soup
# ---------------------------------------------------------------------------
def test_assessment_recorder_raises_suspicion_on_full_miss(soup):
    # A REAL-sized bibliography exists but 0 of N bracketed-year candidates linked → a SUSPICION (not a
    # verdict): MIGHT be missing references upstream, OR prose-years. Low confidence + a "please read" margin.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    bib = {f'auth{i}198{i}': f'auth{i}198{i}' for i in range(6)}   # 6 entries — NOT the reading-list signature
    ctx = CitationLinkContext(soup('<body><p>x</p></body>'), bib)
    ctx.citations_found, ctx.citations_linked = 158, 0
    ctx.citations_unlinked = [{'citation': 'March, 1923', 'generated_keys': ['march1923']}]
    AssessmentRecorder().apply(ctx)
    rec = [r for r in ASSESSMENT.records if r['module'] == 'citation_link_audit'][-1]
    assert rec['evidence']['full_miss'] is True
    assert rec['confidence'] < 0.5                # flagged as a suspicion, never asserted as a fault
    assert 'MIGHT' in rec['margin'] and 'read the text' in rec['margin']


def test_assessment_recorder_treats_reading_list_as_confident_non_action(soup):
    # A reading-list / footnote-cited source: only 1 "reference" but dozens of bracketed-year candidates,
    # NONE linkable (bare years / prose numbers). Not a suspicion to chase — a CONFIDENT non-action (1.0),
    # so the vibe loop is not routed to citation modules and stays focused on footnotes.
    from shared.assessment import ASSESSMENT
    ASSESSMENT.reset('/tmp')
    ctx = CitationLinkContext(soup('<body><p>x</p></body>'), {'but1936': 'but1936'})   # 1 entry
    ctx.citations_found, ctx.citations_linked = 55, 0
    ctx.citations_unlinked = [{'citation': 'March, 1923', 'generated_keys': ['march1923']}]
    AssessmentRecorder().apply(ctx)
    rec = [r for r in ASSESSMENT.records if r['module'] == 'citation_link_audit'][-1]
    assert rec['evidence']['full_miss'] is True
    assert rec['confidence'] == 1.0              # confident non-action — NOT flagged (>= 0.5)
    assert 'reading-list' in rec['margin']


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
    s = soup('<body><p>As argued (Marcuse 2009) and [Smith 2010].</p>'
             '<p><a class="bib-entry" id="bib-m"></a>Marcuse 2009.</p>'
             '<p><a class="bib-entry" id="bib-s"></a>Smith 2010.</p></body>')
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
    assert 'numbered_bracket_citation_linker' in names


# ---------------------------------------------------------------------------
# NumberedBracketCitationLinker — [N] / [N,M] / [N--M] against an ordinal bibliography
# (6c4e7d58: Current Opinion Vancouver citations into a "1. Adger W, …: Title…" list).
# Same hard self-gates as the paren sibling: dense ordinal list, every member resolves.
# ---------------------------------------------------------------------------
def _ordinal_bib(soup_fn, n=6, body=''):
    entries = ''.join(
        f'<p>{i}. <a class="bib-entry" id="bib{i}" href="#c{i}">Author {i}</a> Title {i}. J 2020.</p>'
        for i in range(1, n + 1))
    s = soup_fn(f'<body>{body}{entries}</body>')
    return s, CitationLinkContext(s, {f'k{i}': f'bib{i}' for i in range(1, n + 1)})


def test_numbered_bracket_linker_links_group_and_range(soup):
    from digestion.citationLinking.citation_link_rules import NumberedBracketCitationLinker
    s, ctx = _ordinal_bib(soup, 6, '<p>diverse groups [2,3]. anxieties [4--6] end.</p>')
    NumberedBracketCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [a.get_text() for a in anchors[:2]] == ['2', '3']
    assert anchors[0]['href'] == '#bib2'
    rng = anchors[2]
    assert rng['href'] == '#bib4' and rng['data-refs'] == 'bib4,bib5,bib6'
    assert ctx.citations_linked == 5


def test_numbered_bracket_linker_leaves_out_of_range_groups(soup):
    from digestion.citationLinking.citation_link_rules import NumberedBracketCitationLinker
    s, ctx = _ordinal_bib(soup, 6, '<p>a year [2015] and a gap group [5,9] stay.</p>')
    NumberedBracketCitationLinker().apply(ctx)
    assert s.find_all('a', class_='in-text-citation') == []
    assert '[2015]' in s.get_text() and '[5,9]' in s.get_text()


def test_numbered_bracket_linker_requires_dense_ordinal_bib(soup):
    from digestion.citationLinking.citation_link_rules import NumberedBracketCitationLinker
    # only 3 ordinal entries — below the >=5 gate; nothing links.
    s, ctx = _ordinal_bib(soup, 3, '<p>claim [2,3].</p>')
    NumberedBracketCitationLinker().apply(ctx)
    assert s.find_all('a', class_='in-text-citation') == []


def test_numbered_bracket_linker_keeps_special_interest_stars(soup):
    # Current Opinion annotates special-interest papers ON the citation: "[8*]", "[52*,31*]".
    from digestion.citationLinking.citation_link_rules import NumberedBracketCitationLinker
    s, ctx = _ordinal_bib(soup, 6, '<p>a cascade of uncertainties [4*]. and paired [5*,6*] end.</p>')
    NumberedBracketCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [a.get_text() for a in anchors] == ['4*', '5*', '6*']
    assert anchors[0]['href'] == '#bib4'


# ---------------------------------------------------------------------------
# NumberedParenCitationLinker enumeration guard — "(1) x, (2) y, (3) z" is a prose LIST, not
# three citations (2c0544c4: a Nature paper cited by superscript whose only parenthesised numbers
# were a five-item enumeration; against its dense ordinal bibliography all five "linked").
# ---------------------------------------------------------------------------
def test_numbered_paren_linker_skips_prose_enumeration(soup):
    from digestion.citationLinking.citation_link_rules import NumberedParenCitationLinker
    s, ctx = _ordinal_bib(soup, 6, '<p>the impact of the SDGs on (1) global governance, '
                                   '(2) domestic political systems and (3) the integration of policies.</p>')
    NumberedParenCitationLinker().apply(ctx)
    assert s.find_all('a', class_='in-text-citation') == []
    assert ctx.citations_linked == 0
    assert ctx.enumerations_skipped == 3
    assert '(1) global governance' in s.get_text()


def test_numbered_paren_linker_still_links_real_citations(soup):
    # The PNAS shapes the enumeration guard must NOT touch (965f6773): a phrase-boundary cite, a
    # narrative cite after an author, and a range. None is an ascending run of list markers.
    from digestion.citationLinking.citation_link_rules import NumberedParenCitationLinker
    s, ctx = _ordinal_bib(soup, 6, '<p>inflated subscription prices (1-3). Dewatripont et al. (4) '
                                   'found that libraries pay more. Varian (5) pointed out why.</p>')
    NumberedParenCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [a.get_text() for a in anchors] == ['1-3', '4', '5']
    assert anchors[0]['data-refs'] == 'bib1,bib2,bib3'
    assert ctx.enumerations_skipped == 0


def test_numbered_paren_linker_enumeration_run_must_start_at_one(soup):
    # Consecutive-but-not-from-1 numbers are citation order, not a list — link them.
    from digestion.citationLinking.citation_link_rules import NumberedParenCitationLinker
    s, ctx = _ordinal_bib(soup, 6, '<p>as noted in (3) and later in (4) the argument holds.</p>')
    NumberedParenCitationLinker().apply(ctx)
    assert [a.get_text() for a in s.find_all('a', class_='in-text-citation')] == ['3', '4']


# ---------------------------------------------------------------------------
# Bibliography-region guard — a reference the extractor MISSED still sits inside the reference
# list, and its publication year must not be "linked" to some other entry (2c0544c4 node 74:
# "7. Transforming Our World … (United Nations General Assembly, 2015)." → #biermann2017b via the
# fuzzy-year fallback).
# ---------------------------------------------------------------------------
def test_scan_skips_unextracted_entry_wedged_in_the_reference_list(soup):
    s = soup('<body><p>Body prose citing (Marcuse 2009) here.</p>'
             '<p><a class="bib-entry" id="b1"></a>1. Marcuse, H. Work (2009).</p>'
             '<p>2. Transforming Our World (United Nations General Assembly, 2009).</p>'
             '<p><a class="bib-entry" id="b2"></a>3. Smith, J. Other (2010).</p></body>')
    found, linked, _ = link_citations_rules(s, {_key('Marcuse 2009'): 'b1'})
    anchors = s.find_all('a', class_='in-text-citation')
    assert len(anchors) == 1 and anchors[0].find_parent('p').get_text().startswith('Body prose')
    assert (found, linked) == (1, 1)


def test_bibliography_region_does_not_swallow_prose_between_distant_entries(soup):
    # A long run of body paragraphs between two bib anchors means they are NOT one contiguous
    # list — the prose in between must still be scanned.
    body = ''.join(f'<p>Paragraph {i} citing (Marcuse 2009) here.</p>' for i in range(4))
    s = soup(f'<body><p><a class="bib-entry" id="b1"></a>Marcuse, H. Work (2009).</p>'
             f'{body}<p><a class="bib-entry" id="b2"></a>Smith, J. Other (2010).</p></body>')
    found, linked, _ = link_citations_rules(s, {_key('Marcuse 2009'): 'b1'})
    assert (found, linked) == (4, 4)


def test_stale_citation_href_from_reconverted_source_is_repointed(soup):
    """A source that is itself previously-converted output carries `class="in-text-citation"`
    anchors whose hrefs an OLDER key generator wrote (study_phase1_aczel-2021-billion: 48 of them,
    zero bib-entries). The already-classed guard used to skip every one, so they stayed permanently
    dead even where the current map still knew the answer — 15 of 33 on that book."""
    s = soup('<body><p>A claim <a href="#uglyconcatenatedkey2019" class="in-text-citation">1</a>.</p>'
             '<p><a class="bib-entry" id="smith2019"></a>Smith, J. (2019).</p></body>')
    found, linked, unlinked = link_citations_rules(s, {'uglyconcatenatedkey2019': 'smith2019'})

    a = s.find('a', class_='in-text-citation')
    assert a is not None and a['href'] == '#smith2019'
    assert a.get('class').count('in-text-citation') == 1        # not duplicated by re-pointing


def test_a_resolving_citation_is_never_touched_twice(soup):
    """The already-classed guard still holds for our OWN output — an href whose target exists is
    left exactly as it is, so the rule stays idempotent."""
    s = soup('<body><p>A claim <a href="#smith2019" class="in-text-citation">1</a>.</p>'
             '<p><a class="bib-entry" id="smith2019"></a>Smith, J. (2019).</p></body>')
    before = str(s)
    link_citations_rules(s, {'smith2019': 'smith2019'})
    assert str(s) == before


# ---------------------------------------------------------------------------
# Year RANGES are date spans, not citations (the chacko-2025-conspiracy bug class).
# "in Modi's first term (2014-2019), it intensified in its second term (2019-2024)" minted two
# phantom links, because the paren is a perfect "(…YYYY…)" candidate and the author's name sits
# right in front of it. A phantom link then feeds the citation review a claim-source pairing the
# author never made.
# ---------------------------------------------------------------------------
def test_year_range_after_a_possessive_author_is_not_linked(soup):
    s = soup("<body><p>Rhetoric in Modi's first term (2014-2019) intensified later.</p>"
             '<p><a class="bib-entry" id="modi2014"></a>Modi, N. (2014). Address.</p>'
             '<p><a class="bib-entry" id="modi2019"></a>Modi, N. (2019). Speech.</p></body>')
    ctx = CitationLinkContext(s, {'modi2014': 'modi2014', 'modi2019': 'modi2019'})
    ParenthesizedCitationLinker().apply(ctx)
    assert s.find('a', class_='in-text-citation') is None
    assert "(2014-2019)" in s.find('p').get_text()
    # not a citation candidate at all — counted as a skipped span, never as an unlinked citation
    assert ctx.year_ranges_skipped == 1
    assert (ctx.citations_found, ctx.citations_unlinked) == (0, [])


def test_year_range_without_any_author_in_front_is_not_linked(soup):
    # The walk-back arm of the same bug: a BARE parenthesised span whose author lives in the prose.
    s = soup('<body><p>The UPA governed (2009-2014) amid crisis, Chacko notes.</p>'
             '<p><a class="bib-entry" id="chacko2009"></a>Chacko, P. (2009). Book.</p></body>')
    ctx = CitationLinkContext(s, {'chacko2009': 'chacko2009'})
    ParenthesizedCitationLinker().apply(ctx)
    assert s.find('a', class_='in-text-citation') is None
    assert ctx.year_ranges_skipped == 1


def test_year_range_punctuation_variants_are_all_spans(soup):
    # hyphen, en dash, em dash, and the abbreviated tail form "(1623–62)" — every one is a span.
    for span in ('1646-1716', '1646–1716', '1646—1716', '1623–62', '1550 - 1617'):
        s = soup(f'<body><p>Leibniz ({span}) was a polymath.</p></body>')
        ctx = CitationLinkContext(s, {'leibniz1646': 'b1', 'leibniz1716': 'b2',
                                      'leibniz1623': 'b3', 'leibniz1550': 'b4'})
        ParenthesizedCitationLinker().apply(ctx)
        assert s.find('a', class_='in-text-citation') is None, span
        assert ctx.year_ranges_skipped == 1, span


def test_a_genuine_adjacent_citation_still_links(soup):
    # The guard must not cost the ordinary narrative form the possessive introduces.
    s = soup("<body><p>Modi's speech (Modi, 2019) and Chacko's (2018) argument.</p></body>")
    ctx = CitationLinkContext(s, {'modi2019': 'modi2019', 'chacko2018': 'chacko2018'})
    ParenthesizedCitationLinker().apply(ctx)
    hrefs = [a['href'] for a in s.find_all('a', class_='in-text-citation')]
    assert hrefs == ['#modi2019', '#chacko2018']
    assert ctx.year_ranges_skipped == 0


def test_page_range_that_looks_like_years_does_not_steal_the_citation_key(soup):
    """A page range whose endpoints are year-shaped: the citation year is not one of them, and
    key generation (which takes the LAST plausible year it can see) must not key on 1994 —
    that lost the link outright."""
    s = soup('<body><p>As shown (Smith, 2001: 1990-1994).</p></body>')
    ctx = CitationLinkContext(s, {'smith2001': 'smith2001', 'smith1990': 'smith1990'})
    ParenthesizedCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [(a.get_text(), a['href']) for a in anchors] == [('2001', '#smith2001')]
    assert '1990-1994' in s.find('p').get_text()


# ---------------------------------------------------------------------------
# Multi-year lists — "one author, several works" resolves per YEAR.
# `generate_ref_keys` reads "(Modi, 2019, 2023)" as ONE reference and takes its LAST year, while
# the linker anchors the FIRST — so both years pointed at the 2023 entry and the genuine Modi 2019
# citation was never reviewed (study_phase1_chacko-2025-conspiracy).
# ---------------------------------------------------------------------------
def test_multi_year_list_resolves_each_year_to_its_own_entry(soup):
    s = soup('<body><p>He fashioned himself thus (Modi, 2019, 2023).</p></body>')
    ctx = CitationLinkContext(s, {'modi2019': 'modi2019', 'modi2023': 'modi2023'})
    ParenthesizedCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [(a.get_text(), a['href']) for a in anchors] == [('2019', '#modi2019'),
                                                            ('2023', '#modi2023')]


def test_multi_year_list_survives_an_unresolvable_first_year(soup):
    """(Merton 1968, 1988) with only a 1988 entry: the 1968 link was a confident-wrong one AND the
    only reason 1988 linked at all (the trailing-year loop lived inside the first year's success
    branch). Dropping the phantom must not drop the real one."""
    s = soup('<body><p>The Matthew effect (Merton 1968, 1988) compounds.</p></body>')
    ctx = CitationLinkContext(s, {'merton1988': 'merton1988'})
    ParenthesizedCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [(a.get_text(), a['href']) for a in anchors] == [('1988', '#merton1988')]
    assert '1968' in s.find('p').get_text()


def test_multi_year_list_keeps_letter_suffixed_years_apart(soup):
    s = soup('<body><p>As claimed (Modi, 2024a, 2024b).</p></body>')
    ctx = CitationLinkContext(s, {'modi2024a': 'modi2024a', 'modi2024b': 'modi2024b'})
    ParenthesizedCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [a['href'] for a in anchors] == ['#modi2024a', '#modi2024b']


def test_locator_after_the_year_is_not_read_as_a_second_work(soup):
    # "2018: 1761–1764" is a page range, so the citation stays ONE reference keyed on 2018.
    s = soup('<body><p>Long-standing (Anderson and Clibbens, 2018: 1761-1764).</p></body>')
    ctx = CitationLinkContext(s, {'anderson2018': 'anderson2018'})
    ParenthesizedCitationLinker().apply(ctx)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [(a.get_text(), a['href']) for a in anchors] == [('2018', '#anderson2018')]


def test_chacko_paragraph_end_to_end(soup):
    """The live paragraph both bugs were found in (book_1789025680384 node 2700)."""
    ids = ('modi2019', 'modi2023', 'modi2024a', 'modi2024b', 'shah2024', 'news2024')
    bib = {k: k for k in ids}
    entries = ''.join(f'<p><a class="bib-entry" id="{k}"></a>Entry {k}.</p>' for k in ids)
    s = soup("<body><p>While this rhetoric mostly took 'dog whistle' forms in Modi's first term "
             "(2014-2019), it intensified in its second term (2019-2024), spurred by crises "
             "(Modi, 2024a, 2024b; Shah, 2024). Modi fashioned himself as a representative of God "
             "(News18, 2024; Modi, 2019, 2023).</p>" + entries + "</body>")
    link_citations_rules(s, bib)
    anchors = s.find_all('a', class_='in-text-citation')
    assert [(a.get_text(), a['href']) for a in anchors] == [
        ('2024a', '#modi2024a'), ('2024b', '#modi2024b'), ('2024', '#shah2024'),
        ('2024', '#news2024'), ('2019', '#modi2019'), ('2023', '#modi2023')]
    assert '(2014-2019)' in s.get_text() and '(2019-2024)' in s.get_text()

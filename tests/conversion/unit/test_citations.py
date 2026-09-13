"""Characterization tests for conversion/citations.link_citations — the soup-mutating
citation LINKER (PASS 2A). Pins that (Author Year) / [Author Year] only link when a key
actually matches the bibliography, and that an unmatched cite is left as plain text
(modus operandi: never a confident wrong link)."""

from digestion.citationLinking.citations import link_citations


def _doc(soup, body, bib=None):
    """Build a test document. `bib` mirrors the map handed to link_citations, and its ENTRY IDS are
    materialised as `bib-entry` anchors — exactly as extract_bibliography does, which creates the
    anchor and the map entry together. Without them the document promises link targets it does not
    contain, and UnresolvedCitationDemoter rightly unwraps the citation rather than leaving a dead
    link; a map whose values exist nowhere is not a state the real pipeline can produce."""
    refs = ''.join(f'<p><a class="bib-entry" id="{entry_id}"></a>Reference {entry_id}.</p>'
                   for entry_id in dict.fromkeys((bib or {}).values()))
    return soup(f'<html><body>{body}{refs}</body></html>')


def test_parenthesized_citation_links_year_to_bib_entry(soup):
    bib = {'ostrom1990': 'bib_ostrom_1990'}
    s = _doc(soup, '<p>Commons govern themselves (Ostrom 1990) well.</p>', bib)
    found, linked, unlinked = link_citations(s, bib)

    a = s.find('a', class_='in-text-citation')
    assert a is not None
    assert a['href'] == '#bib_ostrom_1990'
    assert a.get_text() == '1990'                 # only the YEAR is wrapped, author stays prose
    assert 'Ostrom' in s.get_text()
    assert (found, linked) == (1, 1)
    assert unlinked == []


def test_unmatched_citation_left_unlinked(soup):
    s = _doc(soup, '<p>A claim (Nobody 1999) here.</p>')
    found, linked, unlinked = link_citations(s, {'ostrom1990': 'bib_ostrom_1990'})

    assert s.find('a', class_='in-text-citation') is None
    assert linked == 0 and found == 1
    assert unlinked and unlinked[0]['citation'].startswith('Nobody')


def test_bracket_citation_links_when_scan_active(soup):
    # The [Author Year] scan only runs once the parenthesized pre-check has unlocked
    # the text-node walk, so include a (paren) cite to activate it; then the bracket
    # cite links too.
    bib = {'ostrom1990': 'bib_o', 'hardin1968': 'bib_h'}
    s = _doc(soup, '<p>Both (Ostrom 1990) and [Hardin 1968] agree.</p>', bib)
    found, linked, unlinked = link_citations(s, bib)

    hrefs = {a['href'] for a in s.find_all('a', class_='in-text-citation')}
    assert '#bib_h' in hrefs            # bracket cite linked
    assert linked == 2


def test_bracket_only_document_links(soup):
    # FIXED (was a latent bug): the scan used to be gated on a PARENTHESIZED `(...YYYY...)` pre-check,
    # so a document citing ONLY with [Author Year] brackets was silently skipped. The gate now fires on
    # [Author YEAR] brackets too, so a pure square-bracket source links end-to-end.
    s = _doc(soup, '<p>As shown [Hardin 1968] clearly.</p>', {'hardin1968': 'bib_hardin_1968'})
    found, linked, unlinked = link_citations(s, {'hardin1968': 'bib_hardin_1968'})

    a = s.find('a', class_='in-text-citation')
    assert a is not None and a['href'] == '#bib_hardin_1968'
    assert (found, linked) == (1, 1)


def test_multi_citation_semicolon_links_each(soup):
    bib = {'ostrom1990': 'bib_o', 'hardin1968': 'bib_h'}
    s = _doc(soup, '<p>Many agree (Ostrom 1990; Hardin 1968).</p>', bib)
    found, linked, unlinked = link_citations(s, bib)

    hrefs = {a['href'] for a in s.find_all('a', class_='in-text-citation')}
    assert hrefs == {'#bib_o', '#bib_h'}
    assert linked == 2


def test_empty_bibliography_links_nothing(soup):
    s = _doc(soup, '<p>A claim (Ostrom 1990).</p>')
    found, linked, unlinked = link_citations(s, {})

    assert s.find('a', class_='in-text-citation') is None
    assert (found, linked) == (0, 0)   # scan skipped entirely when bib is empty


def test_existing_anchor_converted_to_citation(soup):
    # a pre-existing <a href="#x"> whose target is a bib entry becomes an in-text-citation
    s = _doc(soup, '<p>See <a href="#raw_ostrom">Ostrom</a>.</p>', {'raw_ostrom': 'bib_ostrom_1990'})
    found, linked, unlinked = link_citations(s, {'raw_ostrom': 'bib_ostrom_1990'})

    a = s.find('a', href=True)
    assert 'in-text-citation' in a.get('class', [])
    assert a['href'] == '#bib_ostrom_1990'


# --- the citation-linking pass records its story (incl. the bracket-only gate) ---

from shared.assessment import ASSESSMENT


def test_bracket_only_records_a_link_not_a_skip(soup):
    ASSESSMENT.reset()
    s = _doc(soup, '<p>As shown [Hardin 1968] clearly.</p>', {'hardin1968': 'bib_h'})   # bracket-only
    link_citations(s, {'hardin1968': 'bib_h'})
    rec = ASSESSMENT.records[-1]
    assert rec['module'] == 'citation_link_audit'
    assert 'skipped' not in rec['decision']                    # the scan now RUNS for brackets
    assert rec['evidence']['linked'] == 1


def test_unlinked_citation_recorded_with_keys_tried(soup):
    ASSESSMENT.reset()
    s = _doc(soup, '<p>A claim (Nobody 1999) here.</p>')
    link_citations(s, {'ostrom1990': 'bib_o'})
    rec = ASSESSMENT.records[-1]
    assert rec['evidence']['unlinked'] == 1
    assert rec['evidence']['unlinked_sample'][0]['keys_tried']   # the keys that failed are recorded


def test_empty_bibliography_skip_recorded(soup):
    ASSESSMENT.reset()
    link_citations(_doc(soup, '<p>A claim (Ostrom 1990).</p>'), {})
    rec = ASSESSMENT.records[-1]
    assert 'no bibliography' in rec['decision']
    assert rec['confidence'] == 1.0


# --- UnresolvedCitationDemoter: a dead link is worse than no link ---

def test_citation_to_a_missing_anchor_is_demoted_to_text(soup):
    """The linkers resolve through bibliography_map, but the map and the anchors are built in
    separate steps and can drift — study_phase1_aczel-2021-billion had 26 of 48 hrefs naming
    key-shaped ids that were never assigned as an entry id. A dead link looks live, goes nowhere,
    and inflates the linked-count the maintainer loop reads, so it is returned to plain text."""
    # map promises 'bib_ghost', document contains no such anchor (bib= omitted on purpose)
    s = _doc(soup, '<p>A claim (Ostrom 1990) here.</p>')
    found, linked, unlinked = link_citations(s, {'ostrom1990': 'bib_ghost'})

    assert s.find('a', class_='in-text-citation') is None
    assert '(Ostrom 1990)' in s.get_text()          # the text itself is never lost
    assert linked == 0
    assert any(u.get('reason') == 'anchor_absent' for u in unlinked)


def test_demoter_is_indifferent_to_attribute_order(soup):
    """Anchor discovery must not depend on whether `id` precedes `class` — the JATS lane emits
    `<p id="CR1" class="bib-entry">`, and an ordered regex over the serialised HTML misses it."""
    body = ('<p>A claim (Ostrom 1990) here.</p>'
            '<p id="bib_ostrom_1990" class="bib-entry">Ostrom, E. (1990).</p>')
    s = _doc(soup, body)
    found, linked, unlinked = link_citations(s, {'ostrom1990': 'bib_ostrom_1990'})

    a = s.find('a', class_='in-text-citation')
    assert a is not None and a['href'] == '#bib_ostrom_1990'
    assert linked == 1

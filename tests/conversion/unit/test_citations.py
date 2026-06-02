"""Characterization tests for conversion/citations.link_citations — the soup-mutating
citation LINKER (PASS 2A). Pins that (Author Year) / [Author Year] only link when a key
actually matches the bibliography, and that an unmatched cite is left as plain text
(modus operandi: never a confident wrong link)."""

from conversion.citations import link_citations


def _doc(soup, body):
    return soup(f'<html><body>{body}</body></html>')


def test_parenthesized_citation_links_year_to_bib_entry(soup):
    s = _doc(soup, '<p>Commons govern themselves (Ostrom 1990) well.</p>')
    bib = {'ostrom1990': 'bib_ostrom_1990'}
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
    s = _doc(soup, '<p>Both (Ostrom 1990) and [Hardin 1968] agree.</p>')
    bib = {'ostrom1990': 'bib_o', 'hardin1968': 'bib_h'}
    found, linked, unlinked = link_citations(s, bib)

    hrefs = {a['href'] for a in s.find_all('a', class_='in-text-citation')}
    assert '#bib_h' in hrefs            # bracket cite linked
    assert linked == 2


def test_bracket_only_is_skipped_by_paren_gate(soup):
    # LATENT BUG (faithfully preserved): the whole citation scan is gated on a
    # PARENTHESIZED `(...YYYY...)` pre-check. A document that uses ONLY [Author Year]
    # brackets never reaches the bracket linker — its citations are silently skipped.
    # A book in pure square-bracket style would convert with zero in-text links.
    s = _doc(soup, '<p>As shown [Hardin 1968] clearly.</p>')
    found, linked, unlinked = link_citations(s, {'hardin1968': 'bib_hardin_1968'})

    assert s.find('a', class_='in-text-citation') is None
    assert (found, linked) == (0, 0)


def test_multi_citation_semicolon_links_each(soup):
    s = _doc(soup, '<p>Many agree (Ostrom 1990; Hardin 1968).</p>')
    bib = {'ostrom1990': 'bib_o', 'hardin1968': 'bib_h'}
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
    s = _doc(soup, '<p>See <a href="#raw_ostrom">Ostrom</a>.</p>')
    found, linked, unlinked = link_citations(s, {'raw_ostrom': 'bib_ostrom_1990'})

    a = s.find('a', href=True)
    assert 'in-text-citation' in a.get('class', [])
    assert a['href'] == '#bib_ostrom_1990'

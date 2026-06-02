"""Characterization tests for conversion/bibliography.extract_bibliography (PASS 1A).
Pins the bibliography_map (key -> entry_id) that the citation linker matches against —
especially the author+year collision suffixing, which is what keeps two different works
by the same author/year from collapsing onto one id (a confident wrong link)."""

from conversion.bibliography import extract_bibliography


def _doc(soup, body):
    return soup(f'<html><body>{body}</body></html>')


def _refs_section(*paras):
    inner = ''.join(f'<p>{p}</p>' for p in paras)
    return f'<h2>References</h2>{inner}'


def test_single_reference_under_heading(soup):
    s = _doc(soup, _refs_section('Ostrom, E. (1990). Governing the Commons. CUP.'))
    bib, data = extract_bibliography(s)

    assert len(data) == 1
    entry_id = data[0]['referenceId']
    assert 'ostrom1990' in bib
    assert bib['ostrom1990'] == entry_id
    # a bib-entry anchor was inserted into the DOM
    assert s.find('a', class_='bib-entry', id=entry_id) is not None


def test_collision_same_author_year_gets_distinct_suffixes(soup):
    # Two DIFFERENT works, both Ostrom 1990 -> must become ostrom1990a / ostrom1990b,
    # never collapse to one id (that would mislink half the citations).
    s = _doc(soup, _refs_section(
        'Ostrom, E. (1990). Governing the Commons. CUP.',
        'Ostrom, E. (1990). A Different Book Entirely. OUP.',
    ))
    bib, data = extract_bibliography(s)

    ids = {d['referenceId'] for d in data}
    assert len(ids) == 2                       # two distinct entries — NEVER collapsed onto one id
    assert ids == {'ostrom1990a', 'ostrom1990b'}
    # NOTE (inherent ambiguity): both entries produce the same bare key 'ostrom1990',
    # so the base key resolves to the LAST-defined entry (…b) — a citation that says only
    # "(Ostrom 1990)" with no a/b disambiguator links to ostrom1990b. The disambiguated
    # forms still resolve precisely if present. The important guarantee — two different
    # works keep separate ids — holds.
    assert bib['ostrom1990'] == 'ostrom1990b'


def test_true_duplicate_is_deduped(soup):
    # Identical entry repeated -> one data row, key still present.
    s = _doc(soup, _refs_section(
        'Hardin, G. (1968). The Tragedy of the Commons. Science.',
        'Hardin, G. (1968). The Tragedy of the Commons. Science.',
    ))
    bib, data = extract_bibliography(s)

    assert len(data) == 1
    assert 'hardin1968' in bib


def test_dash_repeat_author_inherits_previous(soup):
    # "—. 2014." means same author as the previous entry.
    s = _doc(soup, _refs_section(
        'Piketty, T. (2013). Capital in the Twenty-First Century. Harvard.',
        '—. 2014. Another Piketty Work. Seuil.',
    ))
    bib, data = extract_bibliography(s)

    assert len(data) == 2
    assert any('piketty2014' in k for k in bib)


def test_no_reference_section_returns_empty(soup):
    s = _doc(soup, '<h2>Introduction</h2><p>Just prose with no citations at all.</p>')
    bib, data = extract_bibliography(s)

    assert bib == {}
    assert data == []

"""Characterization tests for conversion/bibliography.extract_bibliography (PASS 1A).
Pins the bibliography_map (key -> entry_id) that the citation linker matches against —
especially the author+year collision suffixing, which is what keeps two different works
by the same author/year from collapsing onto one id (a confident wrong link)."""

import os

from digestion.bibliographyExtraction.bibliography import extract_bibliography

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


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


# --- bibliography extraction records its story (collision ambiguity surfaced) ---

from shared.assessment import ASSESSMENT


def test_collision_recorded_with_ambiguity_flag(soup):
    ASSESSMENT.reset()
    s = _doc(soup, _refs_section('Ostrom, E. (1990). Book One. CUP.',
                                 'Ostrom, E. (1990). Book Two. OUP.'))
    extract_bibliography(s)
    rec = ASSESSMENT.records[-1]
    assert rec['module'] == 'bibliography_extraction'
    assert rec['evidence']['collisions_suffixed'] == 1
    assert rec['considered'] and 'a/b' in rec['considered'][0]['would_need']


# ---------------------------------------------------------------------------
# Reference DETECTION as a seam (Part C) — what is / isn't collected as a reference.
# The per-paragraph predicate is_likely_reference is LOOSE by design (a within-section
# filter); _find_reference_paragraphs is the real seam — it gates the predicate behind a
# References heading (or a reverse scan). These pin that gating, and the looseness it covers.
# ---------------------------------------------------------------------------
from digestion.bibliographyExtraction.bibliography import _find_reference_paragraphs, is_likely_reference


def test_predicate_alone_is_loose_so_the_seam_must_gate_it(soup):
    # A body sentence with an in-text "(Author Year)" LOOKS reference-like to the bare predicate
    # (capitalised start + a year). This is WHY _find_reference_paragraphs gates it behind a heading —
    # the predicate alone must NOT be trusted on arbitrary body prose.
    prose = soup('<p>Smith (1999) argued that markets fail under information asymmetry.</p>').p
    assert is_likely_reference(prose) is True   # loose in isolation — documents the looseness


def test_seam_excludes_body_prose_outside_the_references_section(soup):
    # The same prose sentence, sitting in the body BEFORE a real References heading, must NOT be
    # collected — only the entries under the heading are.
    s = _doc(soup,
             '<h2>Discussion</h2>'
             '<p>Smith (1999) argued that markets fail under information asymmetry.</p>'
             '<h2>References</h2>'
             '<p>Ostrom, E. (1990). Governing the Commons. CUP.</p>')
    tags, used_reverse = _find_reference_paragraphs(s)
    collected = [t.get_text(' ', strip=True) for t in tags]
    assert any('Ostrom' in c for c in collected)            # the real entry IS collected
    assert not any('markets fail' in c for c in collected)  # the body prose is NOT
    assert used_reverse is False                            # found via the heading, not the fallback


def test_seam_skips_non_reference_paragraph_under_the_heading(soup):
    # A lowercase / yearless paragraph sitting under the References heading is not a reference.
    s = _doc(soup,
             '<h2>References</h2>'
             '<p>see the appendix for the full dataset.</p>'
             '<p>Ostrom, E. (1990). Governing the Commons. CUP.</p>')
    tags, _ = _find_reference_paragraphs(s)
    collected = [t.get_text(' ', strip=True) for t in tags]
    assert any('Ostrom' in c for c in collected)
    assert not any('appendix' in c for c in collected)


def test_reverse_scan_ignores_lone_trailing_prose_as_junk_reference(soup):
    # A footnote-cited paper has NO references heading. Its last sentence starts with a capital and
    # contains a year, so is_likely_reference (rule #5) matches — the reverse scan used to emit ONE
    # junk "reference" from it (and a phantom "0/N citations"). Below the run threshold → discard.
    s = _doc(soup,
             '<p>The doctrine developed through the 1970s and beyond.</p>'
             '<p>Nor should we have much confidence in the manner it was applied after 1990.</p>')
    tags, used_reverse = _find_reference_paragraphs(s)
    assert used_reverse is True
    assert tags == []


def test_reverse_scan_keeps_a_real_headingless_bibliography_run(soup):
    # A genuine heading-less reference list (a RUN of entries) must still be collected.
    s = _doc(soup,
             '<p>Some concluding body text about the topic.</p>'
             '<p>Ostrom, E. (1990). Governing the Commons. CUP.</p>'
             '<p>Hardin, G. (1968). The Tragedy of the Commons. Science.</p>'
             '<p>Olson, M. (1965). The Logic of Collective Action. Harvard.</p>')
    tags, used_reverse = _find_reference_paragraphs(s)
    assert used_reverse is True
    collected = [t.get_text(' ', strip=True) for t in tags]
    assert len(collected) == 3
    assert any('Ostrom' in c for c in collected) and any('Olson' in c for c in collected)
    assert not any('concluding body text' in c for c in collected)


def test_reverse_scan_does_not_mine_the_footnote_section(soup):
    """Pandoc parks its notes in a trailing <section id="footnotes" role="doc-endnotes">, which
    is exactly where the reverse scan STARTS. A note is prose about a work and routinely carries
    an author and a year, so the last one was collected as a phantom bibliography entry — its
    text duplicated into references while the footnote system still owned it (nicholls-nieo-docx:
    an "An exception is Caroline Thomas … (1985, 156)" note became reference thomas1985b)."""
    s = _doc(soup,
             '<p>Ostrom, E. (1990). Governing the Commons. CUP.</p>'
             '<p>Hardin, G. (1968). The Tragedy of the Commons. Science.</p>'
             '<p>Olson, M. (1965). The Logic of Collective Action. Harvard.</p>'
             '<section id="footnotes" class="footnotes" role="doc-endnotes"><hr/><ol>'
             '<li id="fn1"><p>An exception is Caroline Thomas, who argued the opposite '
             '(1985, 156).</p></li></ol></section>')
    tags, used_reverse = _find_reference_paragraphs(s)
    collected = [t.get_text(' ', strip=True) for t in tags]
    assert used_reverse is True
    assert len(collected) == 3
    assert not any('Caroline Thomas' in c for c in collected)


def test_headingless_footnote_paper_yields_no_bibliography(soup):
    # End-to-end: extract_bibliography on such a doc returns an EMPTY reference set (no junk entry).
    s = _doc(soup,
             '<p>A body paragraph discussing investment law since 2001.</p>'
             '<p>Nor should we have much confidence in the outcome after 1990.</p>')
    bib, data = extract_bibliography(s)
    assert data == []
    assert bib == {}


# ---------------------------------------------------------------------------
# Pre-1900 citation years (7fa30289) + a deterministic canonical id
# ---------------------------------------------------------------------------

def test_historical_citation_years_generate_keys():
    """A 1900 year floor made generate_ref_keys return NO KEYS AT ALL for a 19th-century
    citation, so "(Engels 1886a: 356f; Hegel 1874: §§97f)" linked to nothing — even though both
    bibliography entries existed and were keyed correctly (an entry's parenthesized year takes a
    branch with no floor, which is why only the in-text side broke)."""
    from shared.refkeys import HISTORICAL_YEAR_MIN, generate_ref_keys
    for cite, want in [('Engels 1886a: 356f', 'engels1886a'), ('Hegel 1874: §§97f', 'hegel1874'),
                       ('Marx 1867', 'marx1867'), ('Smith 1776: 12', 'smith1776')]:
        assert generate_ref_keys(cite) == []                      # modern floor: invisible
        assert want in generate_ref_keys(cite, min_year=HISTORICAL_YEAR_MIN)


def test_a_historical_year_never_outranks_a_modern_one():
    """Strictly a FALLBACK. Admitted to the same pool, a historical year WINS the last-year rule
    ("Author 2005: 1850" → author1850) and cost 93d34a74 a link that used to resolve."""
    from shared.refkeys import HISTORICAL_YEAR_MIN as H, generate_ref_keys
    for cite in ('Author 2005: 1850', 'Jones 1999, 1850', 'Giddens 1984: 25'):
        assert generate_ref_keys(cite, min_year=H) == generate_ref_keys(cite)


def test_canonical_reference_id_is_deterministic_across_processes():
    """`keys[0]` becomes the entry's bibliography ANCHOR id, and the alt-year path built it with
    `list(set(...))[0]` — set() iteration over strings is randomised PER PROCESS, so the same book
    reconverted twice got a different anchor and silently orphaned every citation pointing at the
    old one. The regression harness pins PYTHONHASHSEED=0; production does not."""
    import subprocess
    import sys as _sys
    code = (
        "import sys; sys.path.insert(0, 'app/Python');"
        "from shared.refkeys import generate_ref_keys;"
        "from digestion.bibliographyExtraction.bibliography import _ordered_unique;"
        "t='Spencer, Herbert (1884) The Man Versus The State. Indianapolis. Liberty Fund. 1992.';"
        "k=generate_ref_keys(t);"
        "a=[x.replace('1884','1992') for x in k if '1884' in x];"
        "print(_ordered_unique(k+a)[0])"
    )
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONHASHSEED'}
    ids = {subprocess.run([_sys.executable, '-c', code], capture_output=True, text=True,
                          env=env, cwd=_REPO_ROOT).stdout.strip() for _ in range(6)}
    assert len(ids) == 1, f'canonical id varies across processes: {ids}'
    # the PRINTED year stays canonical; the reprint year is a match-only alias
    assert ids == {'spencer1884'}


# ---------------------------------------------------------------------------
# The REFERENCE_HEADERS lookup is an exact match by design (a containment check swallows "Sources of
# Error"), but a typesetter's trailing colon is not a different word: "## References:" missed by ONE
# COLON, the heading-anchored walk never ran, the weak reverse scan salvaged a single entry, and 2 of
# that article's 105 citations linked (9a266e34).
# ---------------------------------------------------------------------------
def test_reference_heading_with_a_trailing_colon_is_recognised():
    from digestion.bibliographyExtraction.bibliography import reference_header_key, REFERENCE_HEADERS
    for raw in ('References:', 'References', 'REFERENCES:', ' Bibliography. ', 'Works Cited:'):
        assert reference_header_key(raw) in REFERENCE_HEADERS, raw


def test_reference_header_key_does_not_widen_the_match():
    from digestion.bibliographyExtraction.bibliography import reference_header_key, REFERENCE_HEADERS
    for raw in ('Sources of Error', 'Reference frame', 'Bibliographic essay'):
        assert reference_header_key(raw) not in REFERENCE_HEADERS, raw


# ---------------------------------------------------------------------------
# The OCR-error ALT-YEAR alias is a guess, and it used to be written with the same authority as an
# entry's printed year. Two consequences, both live on chacko-2025-conspiracy: every web-cited
# entry aliased itself onto its ACCESS DATE, and the last one to do so took `news2024` away from
# "News18 (2024)" — so the article's only News18 citation resolved to an Al Jazeera piece.
# ---------------------------------------------------------------------------
def test_access_date_is_not_an_alternative_publication_year(soup):
    s = _doc(soup, _refs_section(
        "News Agencies (2023) India warns citizens on Canada travel. Al Jazeera, 23 September. "
        "Available at: https://example.org/x (accessed 1 July 2024)."))
    bib_map, _ = extract_bibliography(s)
    assert bib_map.get('agencies2023') == 'agencies2023'
    assert not [k for k in bib_map if k.endswith('2024')], bib_map


def test_an_alias_never_takes_a_key_an_entry_actually_prints(soup):
    # News18 is keyed news2024 from its OWN year; the later entry may only alias into free keys.
    s = _doc(soup, _refs_section(
        "News18 (2024) Whatever I'm doing is inspired by a divine power. 29 April.",
        "News Agencies (2023) India warns citizens on Canada travel. Al Jazeera, 23 September, 2024."))
    bib_map, _ = extract_bibliography(s)
    assert bib_map['news2024'] == 'news2024'
    assert bib_map['agencies2023'] == 'agencies2023'


def test_an_alias_still_fills_a_key_nobody_claims(soup):
    # The rule earns its keep when the printed year IS an OCR error — the alias remains reachable.
    s = _doc(soup, _refs_section(
        "Spencer, Herbert (1884) The Man Versus The State. Indianapolis. Liberty Fund. 1992."))
    bib_map, refs = extract_bibliography(s)
    assert refs[0]['referenceId'] == 'spencer1884'      # the PRINTED year stays canonical
    assert bib_map['spencer1992'] == 'spencer1884'      # …and the alias still resolves

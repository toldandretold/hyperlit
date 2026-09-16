"""Unit tests for conversion/refkeys.py — citation key generation + reference detection."""

import pytest

from shared.refkeys import generate_ref_keys, normalize_unicode_name, is_likely_reference


@pytest.mark.parametrize("text, expected_key", [
    ("Ostrom, Elinor (1990). Governing the Commons. Cambridge UP.", "ostrom1990"),
    ("Hardin, Garrett. 1968. The Tragedy of the Commons. Science.", "hardin1968"),
    ("Ostrom, E. (1990a). Governing the Commons.", "ostrom1990a"),
    ("WHO (2020). World Health Report.", "who2020"),
])
def test_generate_ref_keys_contains(text, expected_key):
    assert expected_key in generate_ref_keys(text)


def test_generate_ref_keys_multi_author():
    keys = generate_ref_keys("Smith, A. and Jones, B. (2009). A Study. Journal.")
    assert "smith2009" in keys
    assert any("jones" in k and "smith" in k for k in keys)  # combined sorted-surnames key


def test_generate_ref_keys_noble_particle():
    assert any("neumann1944" in k for k in generate_ref_keys("von Neumann, John (1944). Theory of Games."))


def test_generate_ref_keys_no_year_is_empty():
    assert generate_ref_keys("Just a sentence with no year at all.") == []


@pytest.mark.parametrize("name, expected", [
    ("Weiß", "Weiss"),
    ("Müller", "Muller"),
    ("Ingersleben-Seip", "IngerslebenSeip"),
])
def test_normalize_unicode_name(name, expected):
    assert normalize_unicode_name(name) == expected


@pytest.mark.parametrize("text, expected", [
    ("Ostrom, E. (1990). Governing the Commons.", True),    # standard author-first
    ("[1] Author, A. (2023). Title.", True),                # numbered
    ("[2023] Author. Title.", True),                        # bracketed year
    ("von Neumann, J. (1944). Theory.", True),              # noble particle
    ("—. (2021). Another work by the same author.", True),  # em-dash repeat-author
    ("This is ordinary body prose without a year.", False),
    ("and then the story continued for a while.", False),   # lowercase start, no year
])
def test_is_likely_reference(soup, text, expected):
    assert is_likely_reference(soup(f"<p>{text}</p>").p) is expected


def test_ref_id_is_surname_not_given_name_first_last_format():
    # "First Last" bibliography format: keys[0] (the canonical id) must be the SURNAME, not the
    # given name. Regression: a set's arbitrary order used to hand the id to the all-authors
    # concatenation ("leobreiman2001") or the given name ("leo2001").
    keys = generate_ref_keys("Leo Breiman (2001). Random Forests. Machine Learning 45.")
    assert keys[0] == "breiman2001"


def test_ref_id_is_surname_comma_first_format():
    # "Surname, Initials" format: surname is the first token.
    keys = generate_ref_keys("Breiman, L. (2001). Random Forests.")
    assert keys[0] == "breiman2001"


def test_ref_id_multi_author_is_first_surname_not_concatenation():
    # The id must be the FIRST author's surname, never the giant all-authors concatenation.
    keys = generate_ref_keys("Tianqi Chen and Carlos Guestrin (2016). XGBoost. KDD.")
    assert keys[0] == "chen2016"
    # …but the concatenated form still exists as a MATCH key so a fully-spelled citation resolves.
    assert any("chen" in k and "guestrin" in k for k in keys)


def test_ref_keys_first_element_is_stable_and_short():
    # keys[0] is a single-surname key, never a 40+ char concatenation.
    keys = generate_ref_keys("Albathan, Albishre, Khaled, Mubarak, Yuefeng (2015). A Method.")
    assert len(keys[0]) < 25 and keys[0].endswith("2015")


# ---------------------------------------------------------------------------
# Pre-1900 works: the MODERN_YEAR_MIN floor keeps a long bibliography entry from keying on an
# incidental 4-digit number, but it also meant a 19th-century entry produced NO keys at all — so
# the entry was dropped as unkeyable and every "(Marx 1875)" in the body linked to nothing
# (24d86fb9 lost four consecutive Marx/Engels entries). Position is the evidence: an entry states
# its year immediately after the author block.
# ---------------------------------------------------------------------------
def test_historical_entry_keys_on_the_year_after_the_author_block():
    keys = generate_ref_keys(
        "Marx, Karl. 1875. Critique of the Gotha Programme. In *Marx and Engels Collected Works "
        "(MECW) Volume 24*, 75-76, London: Lawrence & Wishart.")
    assert keys[0] == "marx1875"


def test_historical_entry_prefers_the_author_adjacent_year_over_a_title_year():
    keys = generate_ref_keys(
        "Engels, Frederick. 1888. Preface to the 1888 English Edition of the Manifesto of the "
        "Communist Party. In *MECW Volume 26*, 512-518. London: Lawrence & Wishart")
    assert "engels1888" in keys


def test_modern_year_still_wins_over_a_historical_one():
    keys = generate_ref_keys("Anonymous pamphlet, 1789 and its aftermath, printed 1913 in Paris.")
    assert any(k.endswith("1913") for k in keys)
    assert not any(k.endswith("1789") for k in keys)


def test_a_decade_is_not_a_year():
    assert generate_ref_keys("Smith, John. The 1850s in review. Some Journal 4: 12-19.") == []


# ---------------------------------------------------------------------------
# An ACCESS DATE is not a publication year — and it sits exactly where the last-year rule looks.
# ---------------------------------------------------------------------------
def test_access_date_does_not_become_the_publication_year():
    keys = generate_ref_keys(
        "European Commission. 2012. Towards Better Access to Scientific Information. "
        "http://ec.europa.eu/research/x.pdf (accessed on September 8, 2013)")
    assert "commission2012" in keys
    assert not any("september" in k for k in keys)


def test_access_date_without_parentheses_is_also_ignored():
    keys = generate_ref_keys(
        "Bergstrom, Carl T. and Theodore C. Bergstrom. 2002. The Economics of Scholarly Journal "
        "Publishing. http://octavia.zoology.washington.edu/x.html, accessed on July 4, 2013.")
    assert "bergstrom2002" in keys


# ---------------------------------------------------------------------------
# A NARRATIVE citation takes its author from the prose in front of it, so a sentence-opening
# discourse marker was read as a co-author ("Indeed, Engels (1888, 517)" → indeed1888).
# ---------------------------------------------------------------------------
def test_discourse_marker_is_not_an_author():
    from shared.refkeys import HISTORICAL_YEAR_MIN
    keys = generate_ref_keys('1888, 517', context_text='at the heart of Marxism. Indeed, Engels ',
                             min_year=HISTORICAL_YEAR_MIN)
    assert keys == ["engels1888"]


def test_real_coauthors_survive_the_marker_filter():
    from shared.refkeys import HISTORICAL_YEAR_MIN
    keys = generate_ref_keys('2018', context_text='However, Graham and Woodcock ',
                             min_year=HISTORICAL_YEAR_MIN)
    assert keys[0] == "graham2018"
    assert any("woodcock" in k for k in keys)


# ---------------------------------------------------------------------------
# A narrative citation spells its authors out IN FULL ("Michael Hardt and Antonio Negri (2017)").
# With a single-word author atom the match could only reach the suffix "Negri", so the keys were
# negri2017 while the entry is keyed on the first author, hardt2017 (a7fc96d5).
# ---------------------------------------------------------------------------
def test_full_names_in_a_narrative_citation_key_on_the_first_surname():
    from shared.refkeys import HISTORICAL_YEAR_MIN
    keys = generate_ref_keys('2017', context_text='Michael Hardt and Antonio Negri ',
                             min_year=HISTORICAL_YEAR_MIN)
    assert keys[0] == 'hardt2017'
    assert any('negri' in k for k in keys)


def test_surname_only_authors_still_key_the_same_way():
    from shared.refkeys import HISTORICAL_YEAR_MIN
    keys = generate_ref_keys('2018', context_text='However, Graham and Woodcock ',
                             min_year=HISTORICAL_YEAR_MIN)
    assert keys[0] == 'graham2018'


# ---------------------------------------------------------------------------
# The ANTECEDENT walk-back: candidates for a bare-year citation whose author sits earlier in the
# paragraph ("…argues the philosopher (2002: 33)"). Nearest first; the bibliography is the gate.
# ---------------------------------------------------------------------------
def test_trailing_author_candidates_are_nearest_first():
    from shared.refkeys import trailing_author_candidates
    ctx = ('Similarly, Lévy anticipated the fall of dictatorships and the advent of what he refers '
           'to as cyberdemocracy. "The destiny of democracy and cyberspace are intimately linked" '
           'argues the philosopher ')
    assert trailing_author_candidates(ctx)[0] == 'levy'


def test_trailing_author_candidates_skip_discourse_markers_and_stopwords():
    from shared.refkeys import trailing_author_candidates
    got = trailing_author_candidates('Häyhtio and Rinne consider that "most interventions differ" ')
    assert got[:2] == ['rinne', 'hayhtio']
    assert 'and' not in got and 'the' not in got


def test_trailing_author_candidates_are_bounded():
    from shared.refkeys import trailing_author_candidates
    ctx = ' '.join(f'Name{i}' for i in range(40)) + ' '
    assert len(trailing_author_candidates(ctx)) <= 8


# ---------------------------------------------------------------------------
# SLASH-PAIR years: "1845/46" (The German Ideology), "1857/1858" (Grundrisse), "1892/2012" (a
# reprint). One work, two years, and citations use EITHER — so the entry must be reachable by
# both. Before this, a pre-1900 slash pair produced NO KEYS AT ALL (both years under the modern
# floor, and the historical fallback demanded [.,)\s] after the year — '/' killed it), so The
# German Ideology was dropped as unkeyable and unreachable by every citation in the corpus.
# ---------------------------------------------------------------------------
def test_slash_pair_entry_keys_on_both_years():
    keys = generate_ref_keys('Marx, Karl and Friedrich Engels. 1845/46. The German Ideology. '
                             'In MECW Volume 5, 19-539. London: Lawrence & Wishart.')
    assert keys[0] == 'marx1845'
    assert 'marx1846' in keys


def test_four_digit_slash_pair_keys_on_both_years():
    keys = generate_ref_keys('Marx, Karl. 1857/1858. Grundrisse. London: Penguin.')
    assert 'marx1857' in keys and 'marx1858' in keys


def test_reprint_slash_pair_reaches_the_original_year():
    keys = generate_ref_keys('Kropotkin, Peter. 1892/2012. The Conquest of Bread. London: Penguin.')
    assert 'kropotkin2012' in keys and 'kropotkin1892' in keys


def test_ordinary_single_year_entries_gain_no_phantom_variants():
    keys = generate_ref_keys('Smith, Jane. 2019. Ordinary entry. Journal 4: 1-20.')
    assert all(k.endswith('2019') for k in keys)

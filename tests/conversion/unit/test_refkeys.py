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

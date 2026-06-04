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

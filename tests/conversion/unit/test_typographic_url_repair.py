"""Unit tests for TypographicUrlRepairer (ingestion/epub/finalNormalisation.py).

Taylor & Francis percent-encodes thin spaces into EPUB hrefs ("?ln%E2%80%89=%E2%80%89en") and
prints them literally (U+2009) in visible text, so a long link can wrap. Either spelling leaves a
link the server never indexed — the citation resolver cannot FETCH the source and falls back to
matching bibliographic metadata, which hands the reviewer a TITLE where the full text was freely
available. Measured on the paste twin of the same article: 22 of 34 reference URLs unusable, and
Nkrumah's "Neo-Colonialism" judged on its title alone while the full text sat on marxists.org.
"""

from bs4 import BeautifulSoup

from ingestion.epub.finalNormalisation import TypographicUrlRepairer


def _soup(html):
    return BeautifulSoup(html, 'html.parser')


def test_percent_encoded_thin_space_in_href_is_removed():
    soup = _soup('<p><a href="https://un.org/record/696640?ln%E2%80%89=%E2%80%89en">x</a></p>')
    TypographicUrlRepairer().transform(soup)
    assert soup.find('a')['href'] == 'https://un.org/record/696640?ln=en'


def test_literal_thin_space_in_href_is_removed():
    soup = _soup('<p><a href="https://un.org/r/1?ln = en">x</a></p>')
    TypographicUrlRepairer().transform(soup)
    assert soup.find('a')['href'] == 'https://un.org/r/1?ln=en'


def test_plain_text_url_is_repaired_too():
    # A bibliography often prints the link with no <a> at all — all three survivors in the paste
    # twin were this shape, where no href repair can reach them.
    soup = _soup('<p>UNCTAD. https://un.org/record/218451?ln = en.</p>')
    TypographicUrlRepairer().transform(soup)
    assert 'record/218451?ln=en' in soup.get_text()
    assert ' ' not in soup.get_text()


def test_an_ordinary_space_still_ends_a_url():
    # The distinction the repair rests on: a normal space is a real boundary, and swallowing it
    # would drag the next words of the entry into the link.
    html = '<p>See https://example.com/a?b=c then more words here.</p>'
    soup = _soup(html)
    TypographicUrlRepairer().transform(soup)
    assert 'https://example.com/a?b=c then more words here.' in soup.get_text()


def test_clean_markup_is_left_alone():
    soup = _soup('<p><a href="https://example.com/a?b=c">x</a></p>')
    TypographicUrlRepairer().transform(soup)
    assert soup.find('a')['href'] == 'https://example.com/a?b=c'


def test_detect_is_false_for_a_clean_document():
    # detect() gates the pass; firing on every document would cost a full tree walk for nothing.
    assert TypographicUrlRepairer().detect(_soup('<p><a href="https://example.com">x</a></p>')) is False


def test_detect_is_true_when_a_gap_is_present():
    assert TypographicUrlRepairer().detect(
        _soup('<p><a href="https://un.org/r?ln%E2%80%89=%E2%80%89en">x</a></p>')
    ) is True

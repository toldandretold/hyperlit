"""Guardrail: journal back-matter is never collected as a bibliography entry.

`is_likely_reference` rule #5 accepts ANY paragraph that starts with a capital and contains a
4-digit year. Every line of a journal article's back matter qualifies — the copyright
statement, the ORCID line, the article's own "to cite this article" self-citation, the
publisher imprint, the submitted/accepted/published history — so all of them read as
references. Three UKSG Insights fixtures (0fb751c1, 85542c5e, 95a61ad0) each shipped a
"bibliography" made entirely of that chrome, and 42be715c turned it into 4 references and 18
phantom citations in a document whose only reference layer is its footnotes.

The rejection lives in shared/refkeys because it has to hold on EVERY collection path: the
heading-anchored walk in bibliography.py runs past the end of the References section whenever
it recognises nothing inside it, so "under a real References heading" is not a safe place for
chrome to be trusted.
"""

import pytest
from bs4 import BeautifulSoup

from shared.refkeys import is_article_chrome, is_likely_reference


def _p(text):
    tag = BeautifulSoup(f'<div><p>{text}</p></div>', 'html.parser').find('p')
    assert tag is not None, 'fixture built no <p> — the assertions below would pass vacuously'
    return tag


CHROME = [
    'Article copyright: © 2017 Stuart Lawson. This is an open-access article distributed '
    'under the terms of the Creative Commons Public Domain Dedication 1.0.',
    'Copyright © and Moral Rights are retained by the author(s) and/or other copyright owners.',
    'ORCID ID: http://orcid.org/0000-0002-1972-8953',
    'Published by UKSG in association with Ubiquity Press on 10 March 2017',
    'Submitted on 05 November 2018 Revised on 28 November 2018 Published on 30 January 2019',
    'Submitted on 24 August 2021 Accepted on 17 November 2021 Published on 16 March 2022',
    'To cite this article:',
    'Competing interests: the author declares none, 2019.',
    'E-mail: slawso03@mail.bbk.ac.uk, 2017',
]

REAL_ENTRIES = [
    'Ostrom, E. (1990). Governing the Commons. Cambridge University Press.',
    '[12] Martin J D III, Piracy, Public Access, and Preservation, 2016.',
    'von Hippel, E. (2005). Democratizing Innovation. MIT Press.',
    'Lawson, S. (2017). Access, ethics and piracy. Insights, 30(1), 25-30.',
    '—. 1972. The Limits to Growth. Universe Books.',
    # Opens with a chrome-ish word but is a genuine entry: the pattern requires the label
    # punctuation / date that a real entry never carries here.
    'Published Papers of the Royal Society, volume 12, 1904.',
    'Received Wisdom and Other Essays, A. Author, 1998.',
]


@pytest.mark.parametrize('text', CHROME)
def test_chrome_is_rejected(text):
    assert is_article_chrome(text) is True, f'not recognised as chrome: {text[:60]}'
    assert is_likely_reference(_p(text)) is False, f'chrome collected as a reference: {text[:60]}'


@pytest.mark.parametrize('text', REAL_ENTRIES)
def test_real_entries_survive(text):
    assert is_article_chrome(text) is False, f'genuine entry misread as chrome: {text[:60]}'
    assert is_likely_reference(_p(text)) is True, f'genuine entry rejected: {text[:60]}'


def test_self_citation_after_cite_label_is_rejected():
    """The self-citation is shaped exactly like a real entry — only the label above it tells.

    "Lawson, S, Access, ethics and piracy, Insights, 2017, 30(1), 25-30" is a bibliography
    entry in every respect except that it is this article citing itself, which is why the
    rule is a look-behind at the preceding "To cite this article:" paragraph.
    """
    soup = BeautifulSoup(
        '<div>'
        '<p>To cite this article:</p>'
        '<p>Lawson, S, Access, ethics and piracy, Insights, 2017, 30(1), 25-30; '
        'DOI: https://doi.org/10.1629/uksg.333</p>'
        '</div>',
        'html.parser',
    )
    self_citation = soup.find_all('p')[1]
    assert is_likely_reference(self_citation) is False


def test_identical_line_without_the_label_is_still_a_reference():
    """The look-behind must not blanket-reject the citation SHAPE — only the labelled instance."""
    soup = BeautifulSoup(
        '<div>'
        '<p>Some ordinary preceding sentence about the topic.</p>'
        '<p>Lawson, S, Access, ethics and piracy, Insights, 2017, 30(1), 25-30; '
        'DOI: https://doi.org/10.1629/uksg.333</p>'
        '</div>',
        'html.parser',
    )
    entry = soup.find_all('p')[1]
    assert is_likely_reference(entry) is True

"""A user's own Markdown file is not a printed page (`process_document.py --markdown-source`).

`[^1]: note` and a trailing ` ^block-id` are MARKUP in an authored Markdown file. They used to reach
the book as body text: every definition was both a footnote and a paragraph, so a vault exported from
Hyperlit and dropped back in carried its notes twice — and once more for every further cycle.

The flag is OFF for the OCR lane, which feeds the same pipeline Markdown generated from a printed
page: there the notes block is part of the document and must stay in the body. Both sides are pinned
here; the end-to-end round trip is tests/Feature/ArchiveExport/VaultRoundTripTest.php (PHP suite).
"""
import json
import os

from bs4 import BeautifulSoup

import process_document as P
from digestion.footnoteExtraction.footnotes import (
    process_sequential_footnotes, process_whole_document_footnotes,
)
from ingestion.markdown_and_pdf_to_html.simple_md_to_html import convert_markdown_to_html

NOTE = """# Title

Claim one[^1] and two.[^2] Networks (Harvey [2020](#^harvey2020); Cox [1981](https://doi.org/10.1/x "Cox, Robert W. 1981. Social Forces (Beyond Theory). Millennium 10(2).")).

## References

Harvey, David. 2020. *Anti-Capitalist Politics*. London: Pluto Press. ^harvey2020

Cox, Robert W. 1981. Social Forces (Beyond Theory). *Millennium* 10(2). ^cox1981

---

[^1]: As one account has it:

    > the commons is about groups

[^2]: A short note.

[^9]: A definition no marker points at.
"""


def _convert(tmp_path, markdown, markdown_source):
    html_path = os.path.join(tmp_path, 'in.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(convert_markdown_to_html(markdown))
    out = os.path.join(tmp_path, 'out')
    os.makedirs(out)
    P.main(html_path, out, 'book1', markdown_source=markdown_source)
    with open(os.path.join(out, 'nodes.jsonl'), encoding='utf-8') as f:
        nodes = [json.loads(line) for line in f if line.strip()]
    with open(os.path.join(out, 'footnotes.jsonl'), encoding='utf-8') as f:
        footnotes = [json.loads(line) for line in f if line.strip()]
    with open(os.path.join(out, 'references.json'), encoding='utf-8') as f:
        references = json.load(f)
    return nodes, footnotes, references


def _body_text(nodes):
    return [BeautifulSoup(n['content'], 'html.parser').get_text(' ', strip=True) for n in nodes]


def test_authored_markdown_definitions_become_footnotes_and_leave_the_body(tmp_path):
    nodes, footnotes, _ = _convert(str(tmp_path), NOTE, markdown_source=True)
    body = ' | '.join(_body_text(nodes))

    assert len(footnotes) == 3
    assert 'As one account has it' not in body
    assert 'the commons is about groups' not in body
    assert 'A short note.' not in body
    # The rule the author put between the text and its notes went with them.
    assert not any(BeautifulSoup(n['content'], 'html.parser').find('hr') for n in nodes)


def test_a_definition_no_marker_links_stays_in_the_body(tmp_path):
    """Removing it would make its text unreachable — it is a footnote nothing opens."""
    nodes, _, _ = _convert(str(tmp_path), NOTE, markdown_source=True)
    assert any('A definition no marker points at.' in t for t in _body_text(nodes))


def test_ocr_markdown_keeps_its_notes_block_in_the_body(tmp_path):
    """Flag off (the PDF lane): the printed notes are part of the page."""
    nodes, footnotes, _ = _convert(str(tmp_path), NOTE, markdown_source=False)
    body = ' | '.join(_body_text(nodes))

    assert len(footnotes) == 3
    assert 'A short note.' in body
    assert 'As one account has it' in body


def test_block_ids_are_not_printed_and_block_links_cite_the_reference(tmp_path):
    nodes, _, references = _convert(str(tmp_path), NOTE, markdown_source=True)
    html = ' '.join(n['content'] for n in nodes)

    assert '^harvey2020' not in html and '^cox1981' not in html
    assert all('^' not in r['content'] for r in references)
    assert {r['referenceId'] for r in references} == {'harvey2020', 'cox1981'}
    soup = BeautifulSoup(html, 'html.parser')
    cites = {a.get_text(): a['href'] for a in soup.find_all('a', class_='in-text-citation')}
    assert cites == {'2020': '#harvey2020', '1981': '#cox1981'}


def test_a_titled_link_is_a_link_with_a_title_not_a_broken_href():
    html = convert_markdown_to_html('See [1981](https://doi.org/10.1/x "Cox (1981). Social Forces.") and [a](b).')
    soup = BeautifulSoup(html, 'html.parser')
    first, second = soup.find_all('a')
    assert first['href'] == 'https://doi.org/10.1/x'
    assert first['title'] == 'Cox (1981). Social Forces.'
    assert second['href'] == 'b' and not second.get('title')


def test_a_title_that_fits_two_references_claims_neither(tmp_path):
    note = """Text (Smith [2001](https://example.org/a "Smith, John. 2001. Collected Essays on Method")).

## References

Smith, John. 2001. Collected Essays on Method, Volume One. London: Sage.

Smith, John. 2001. Collected Essays on Method, Volume Two. London: Sage.
"""
    nodes, _, _ = _convert(str(tmp_path), note, markdown_source=True)
    soup = BeautifulSoup(' '.join(n['content'] for n in nodes), 'html.parser')
    link = soup.find('a', href='https://example.org/a')
    assert link is not None, 'an ambiguous title must leave the link exactly as written'


def test_a_quotation_inside_a_footnote_is_stored_once():
    """find_all hands back the <blockquote> AND the <p> inside it; both used to be appended."""
    html = ('<p>Body<sup>1</sup>.</p><p>[^1]: As in:</p>'
            '<blockquote><p>the commons is about groups</p></blockquote>')
    _, footnotes = process_whole_document_footnotes(BeautifulSoup(html, 'html.parser'), 'b')
    assert footnotes[0]['content'].count('the commons is about groups') == 1

    html = ('<a class="footnoteSectionStart" id="fnRefSection_1"></a><p>Body[^1].</p>'
            '<a class="footnoteDefinitionsStart" id="fnDefSection_1"></a><p>[^1]: As in:</p>'
            '<blockquote><p>the commons is about groups</p></blockquote>')
    _, footnotes = process_sequential_footnotes(BeautifulSoup(html, 'html.parser'), 'b')
    assert footnotes[0]['content'].count('the commons is about groups') == 1

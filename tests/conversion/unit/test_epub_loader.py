"""Unit tests for the epub_normalizer SPINE LOADER — the `_load_from_directory` stage that
concatenates an extracted EPUB's spine documents into one combined soup.

Regression guard for the percent-encoded-href content-loss bug: OPF manifest hrefs are
percent-encoded URIs, so a calibre/Sigil book whose chapters are named "Chapter 01.xhtml"
carries `href="Chapter%2001.xhtml"`. The loader must percent-decode before hitting the
filesystem — otherwise os.path.exists() is False for every spaced filename and those spine
documents get SILENTLY dropped (the file just `continue`s past them). In the wild this ate
all 20 chapters of a book, leaving only the space-free front/back matter, so "PART FOUR"
appeared to be the start.

These also assert the spine ORDER survives (the publisher's reading order, NOT manifest or
alphabetical order).
"""

import os

import epub_normalizer as E


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def _xhtml(heading, body="Some prose."):
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>'
        f'<body><h1>{heading}</h1><p>{body}</p></body></html>'
    )


def _build_extracted_epub(root):
    """Lay out an extracted EPUB whose chapters have SPACES in their filenames (so their
    manifest hrefs are percent-encoded) and whose SPINE order deliberately differs from both
    alphabetical and manifest order. Returns the input dir to hand to EpubNormalizer."""
    oebps = os.path.join(root, 'OEBPS')

    _write(os.path.join(root, 'mimetype'), 'application/epub+zip')
    _write(os.path.join(root, 'META-INF', 'container.xml'),
           '<?xml version="1.0"?>'
           '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
           '<rootfiles><rootfile full-path="OEBPS/content.opf" '
           'media-type="application/oebps-package+xml"/></rootfiles></container>')

    # Files ON DISK have spaces; the heading text identifies each so we can assert order.
    _write(os.path.join(oebps, 'Text', 'Section0001.xhtml'), _xhtml('FRONT MATTER'))
    _write(os.path.join(oebps, 'Text', 'Chapter 01.xhtml'), _xhtml('CHAPTER ONE'))
    _write(os.path.join(oebps, 'Text', 'Chapter 02.xhtml'), _xhtml('CHAPTER TWO'))
    _write(os.path.join(oebps, 'Text', 'Section0023.xhtml'), _xhtml('BACK MATTER'))

    # Manifest hrefs are percent-encoded (the bug trigger). Spine order = front, ch1, ch2, back
    # — which is NOT the manifest order below and NOT alphabetical (Section sorts before Chapter).
    _write(os.path.join(oebps, 'content.opf'),
           '<?xml version="1.0" encoding="utf-8"?>'
           '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:title>spine loader fixture</dc:title>'
           '<dc:identifier id="uid">spine-loader</dc:identifier><dc:language>en</dc:language>'
           '</metadata>'
           '<manifest>'
           '<item id="ch1" href="Text/Chapter%2001.xhtml" media-type="application/xhtml+xml"/>'
           '<item id="ch2" href="Text/Chapter%2002.xhtml" media-type="application/xhtml+xml"/>'
           '<item id="front" href="Text/Section0001.xhtml" media-type="application/xhtml+xml"/>'
           '<item id="back" href="Text/Section0023.xhtml" media-type="application/xhtml+xml"/>'
           '</manifest>'
           '<spine>'
           '<itemref idref="front"/>'
           '<itemref idref="ch1"/>'
           '<itemref idref="ch2"/>'
           '<itemref idref="back"/>'
           '</spine></package>')
    return root


def _load(tmp_path):
    src = _build_extracted_epub(os.path.join(str(tmp_path), 'epub_original'))
    out = os.path.join(str(tmp_path), 'out')
    os.makedirs(out, exist_ok=True)
    norm = E.EpubNormalizer(src, out, book_id='spine_loader_test')
    norm._load_from_directory()
    return norm


def test_percent_encoded_spine_files_are_not_dropped(tmp_path):
    """The chapters with spaces in their filenames (percent-encoded hrefs) must load — the
    exact content-loss regression. Before the unquote() fix, only FRONT/BACK MATTER survived."""
    norm = _load(tmp_path)
    headings = [h.get_text() for h in norm.combined_soup.find_all('h1')]
    assert 'CHAPTER ONE' in headings, f'spaced-filename chapter was dropped; got {headings}'
    assert 'CHAPTER TWO' in headings, f'spaced-filename chapter was dropped; got {headings}'
    assert len(headings) == 4, f'expected all 4 spine docs, got {headings}'


def test_spine_documents_load_in_spine_order(tmp_path):
    """Combined soup must follow the publisher's spine order, not manifest or alphabetical."""
    norm = _load(tmp_path)
    headings = [h.get_text() for h in norm.combined_soup.find_all('h1')]
    assert headings == ['FRONT MATTER', 'CHAPTER ONE', 'CHAPTER TWO', 'BACK MATTER'], headings

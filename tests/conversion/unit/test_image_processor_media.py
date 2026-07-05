"""Unit tests for the unified ImageProcessor (docs/e2ee.md).

The EPUB image path was unified onto the same media/ handoff every other
importer uses: ImageProcessor copies images into {output_dir}/media/ and
rewrites each <img src> to the BARE filename — finalize.py then injects
width/height and the canonical /{book}/media/ prefix. This replaces the old
/storage/books/{id}/images/ public scheme (unauthenticated leak).
"""

import os
import pathlib
import tempfile

from ingestion.epub.structuralNormalisation import ImageProcessor
from bs4 import BeautifulSoup


def _logs():
    sink = []
    return sink, sink.append


def _tiny_png(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    # 1x1 transparent PNG
    path.write_bytes(bytes.fromhex(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
        '0000000b4944415478da6360000002000133f6a5d70000000049454e44ae426082'
    ))


def test_copies_into_media_and_rewrites_to_bare_filename():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        input_dir = tmp / 'src'
        output_dir = tmp / 'out'
        _tiny_png(input_dir / 'images' / 'fig1.png')

        soup = BeautifulSoup(
            '<body><p><img src="images/fig1.png"></p></body>', 'html.parser'
        )

        proc = ImageProcessor()
        proc.set_context('book_x', str(input_dir), str(output_dir))
        sink, log = _logs()
        result = proc.transform(soup, log)

        # Copied into the media handoff dir
        assert (output_dir / 'media' / 'fig1.png').is_file()
        # src rewritten to the BARE filename (finalize adds /{book}/media/)
        assert soup.find('img')['src'] == 'fig1.png'
        assert result['images_processed'] == 1
        # No trace of the old public /storage scheme anywhere
        assert '/storage/books/' not in str(soup)


def test_skips_external_and_data_uris():
    with tempfile.TemporaryDirectory() as tmp:
        output_dir = pathlib.Path(tmp) / 'out'
        soup = BeautifulSoup(
            '<body>'
            '<img src="https://example.com/x.png">'
            '<img src="data:image/png;base64,AAAA">'
            '</body>', 'html.parser'
        )
        proc = ImageProcessor()
        proc.set_context('book_x', tmp, str(output_dir))
        sink, log = _logs()
        result = proc.transform(soup, log)

        assert result['images_processed'] == 0
        imgs = soup.find_all('img')
        assert imgs[0]['src'].startswith('https://')
        assert imgs[1]['src'].startswith('data:')


def test_no_output_dir_is_a_safe_noop():
    soup = BeautifulSoup('<body><img src="images/a.png"></body>', 'html.parser')
    proc = ImageProcessor()
    proc.set_context('book_x', '/tmp', None)  # output_dir missing
    sink, log = _logs()
    result = proc.transform(soup, log)
    assert result['images_processed'] == 0

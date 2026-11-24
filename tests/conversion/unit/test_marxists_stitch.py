"""The marxists.org stitcher: one work spread over many pages -> one EPUB the epub pipeline reads.

Every case here is a trap the real site sprang during the recon (docs/marxists-import.md): footers
that look like contents, related works under the contents, a preface living in another folder, note
ids that restart every chapter, three note-marker styles in one work, thumbnails linking the real
image, cp1252 served as iso-8859-1, and an author index that is a list of works rather than a work.

The site is held in memory (DictFetcher) — these tests never touch the network. The pages are
synthetic: they copy marxists.org's MARKUP shapes, not its texts.
"""
import io
import json
import os
import re
import subprocess
import sys
import zipfile

import pytest

from ingestion.marxists import stitch

BASE = 'https://www.marxists.org/archive/tester/works/1900/work/'
PY = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'app', 'Python'))

INDEX = '''<html><head><title>Economic Manuscripts: The Test Work: Volume One</title>
<meta name="author" content="Karl Marx"><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head><body>
<p class="title">Karl Marx 1900</p>
<h2>Karl Marx</h2>
<h1>The Test Work<br>A Critique of Testing <sup>[1]</sup></h1>
<p class="information">
<span class="info">Written:</span> 1899\x96 1900;<br>
<span class="info">Source:</span> Selected Tests, Progress Publishers; translated by A. Translator;<br>
<span class="info">Public Domain:</span> Tester Internet Archive 2005. You may freely copy this work.
</p>
<p class="information"><a href="/archive/tester/download/work.epub">Download: Epub</a></p>
<p class="index"><a href="ch01.htm">Chapter One</a><br>
<a href="ch02.htm">Chapter Two</a><br>
<a href="../../1885/prefaces/preface.htm">Preface of 1885</a><br>
<a href="/glossary/terms/v/a.htm">a glossary term</a></p>
<p class="footer"><a href="../../index.htm">Tester Works Archive</a> | <a href="../other/index.htm">Next work</a></p>
</body></html>'''.encode('latin-1')  # raw bytes 0x92 / 0x96: cp1252 punctuation

CH01 = '''<html><body>
<p class="title">Chapter One</p>
<h3>Chapter One</h3>
<p>Prose of the first chapter <span class="note"><a id="1b" href="#1">[1]</a></span> and a term
<sup><a href="/glossary/terms/v/a.htm">[*]</a></sup>, long enough to be a paragraph of real text.</p>
<p><a href="pics/big.gif"><img src="pics/small.gif" width="120" border="0" alt="A plate"></a></p>
<p><img src="pics/missing.gif"></p>
<hr class="end">
<p class="information"><a id="1" href="#1b">1.</a> The first chapter\x92s only note.</p>
<p class="footer"><a href="index.htm">Contents</a> | <a href="ch02.htm">next</a></p>
</body></html>'''.encode('latin-1')  # raw bytes 0x92 / 0x96: cp1252 punctuation

CH02 = '''<html><body>
<h3>Chapter Two</h3>
<p>Mr. Wirth says so<a href="#n6">[6]</a>, and the editors add a note <sup class="enote"><a href="notes.htm#n64">[64]</a></sup>.
The same note id as chapter one appears again <span class="note"><a id="1b" href="#1">[1]</a></span>.</p>
<p class="information"><a id="1" href="#1b">1.</a> Chapter two\x92s first note.</p>
<p class="information"><a name="n6">6.</a> A note with no link back.</p>
</body></html>'''.encode('latin-1')  # raw bytes 0x92 / 0x96: cp1252 punctuation

NOTES = '''<html><body><h3>Notes</h3>
<p><a id="n64" href="ch02.htm">64.</a> An editorial note on the shared notes page.</p>
</body></html>'''

PREFACE = '<html><body><h3>Preface of 1885</h3><p>The preface, kept though it lives in another folder.</p></body></html>'

GIF = b'GIF89a' + b'\x00' * 40


def site(**extra):
    pages = {
        BASE + 'index.htm': INDEX,
        BASE + 'ch01.htm': CH01,
        BASE + 'ch02.htm': CH02,
        BASE + 'notes.htm': NOTES,
        'https://www.marxists.org/archive/tester/works/1885/prefaces/preface.htm': PREFACE,
        BASE + 'pics/big.gif': GIF + b'big',
        BASE + 'pics/small.gif': GIF,
        # In the folder but NOT in the contents: an alternate translation. Never crawled.
        BASE + 'alternate.htm': '<html><body><h3>Alternate</h3><p>Other translation.</p></body></html>',
    }
    pages.update(extra)
    return stitch.DictFetcher(pages)


@pytest.fixture
def built(tmp_path):
    result = stitch.Stitcher(site()).build(BASE + 'index.htm', str(tmp_path))
    epub = zipfile.ZipFile(io.BytesIO((tmp_path / 'original.epub').read_bytes()))
    provenance = json.loads((tmp_path / 'marxists_provenance.json').read_text())
    return result, epub, provenance, tmp_path


def page(epub, name):
    return epub.read(name).decode('utf-8')


# ---------------------------------------------------------------- metadata

def test_metadata_reads_title_author_year_language_and_the_stated_licence():
    meta, _ = stitch.Stitcher(site()).metadata(BASE + 'index.htm')

    # <br> in the heading becomes a colon, the trailing note marker goes, and the volume that only
    # <title> carries is appended. The <h2> holding the AUTHOR's name is not the title.
    assert meta['title'] == 'The Test Work: A Critique of Testing, Volume One'
    assert meta['author'] == 'Karl Marx'
    assert meta['year'] == 1899
    assert meta['language'] == 'en'
    assert meta['licence']['code'] == 'PDM'
    # cp1252 en dash survived a page that DECLARES iso-8859-1.
    assert meta['info']['Written'] == '1899– 1900'
    assert 'translated by A. Translator' in meta['note']


@pytest.mark.parametrize('info, code', [
    ({'Copyleft': 'Marxists Internet Archive 2002. Permission is granted under the Creative Commons ShareAlike License'}, 'CC-BY-SA-2.0'),
    ({'Public Domain': 'Lenin Internet Archive 2005. You may freely copy'}, 'PDM'),
    # Silence is Unknown, never a guess (the MECW translations state no rights).
    ({'Source': 'MECW Volume 11'}, 'Unknown'),
    ({'Copyleft': 'some other terms'}, 'Unknown'),
])
def test_licence_comes_only_from_what_the_page_states(info, code):
    assert stitch.licence_from_info(info)['code'] == code


@pytest.mark.parametrize('info, title, year', [
    ({'Written': 'December 1851 – March 1852', 'First Published': '1852'}, None, 1851),
    # A lecture has no "Written" line.
    ({'Delivered': 'December 1847', 'First Published (in German)': 'April 1849', 'Transcription/Markup': 'Zodiac 1999'}, None, 1847),
    ({'First Published (in German)': 'April 1849', 'Proofed': '2005'}, None, 1849),
    # The transcription date is never the work's year; the page title is the last resort.
    ({'Transcription/Markup': 'Zodiac 1999'}, 'Wage Labour and Capital (1847)', 1847),
    ({'Transcription/Markup': 'Zodiac 1999'}, 'Wage Labour and Capital', None),
])
def test_the_year_is_when_the_work_was_written_not_when_it_was_transcribed(info, title, year):
    assert stitch.work_year(info, title) == year


def test_a_page_with_no_date_takes_the_year_it_is_filed_under():
    assert stitch.year_from_path('https://www.marxists.org/archive/luxemburg/1918/letters-sophie-afterword.htm') == 1918
    assert stitch.year_from_path('https://www.marxists.org/archive/marx/works/1867-c1/index.htm') == 1867
    assert stitch.year_from_path('https://www.marxists.org/archive/james-clr/works/dialecti/index.htm') is None
    # A page id that merely starts with digits is not a year folder.
    assert stitch.year_from_path('https://www.marxists.org/archive/x/works/19180/a.htm') is None
    bare = '<html><head><title>Afterword</title></head><body><h1>Afterword</h1><p>Text.</p></body></html>'
    url = 'https://www.marxists.org/archive/tester/1918/afterword.htm'
    meta, _ = stitch.Stitcher(stitch.DictFetcher({url: bare})).metadata(url)
    assert meta['year'] == 1918


def test_language_falls_back_to_the_sites_language_folder(soup):
    from bs4 import BeautifulSoup
    bare = BeautifulSoup('<html><body></body></html>', 'lxml')
    assert stitch.page_language(bare, 'https://www.marxists.org/deutsch/archiv/marx-engels/1848/manifest/index.htm') == 'de'
    assert stitch.page_language(bare, 'https://www.marxists.org/archive/marx/works/1867-c1/index.htm') == 'en'
    declared = BeautifulSoup('<html lang="fr-FR"><body></body></html>', 'lxml')
    assert stitch.page_language(declared, 'https://www.marxists.org/archive/x/index.htm') == 'fr'


# ---------------------------------------------------------------- the crawl

def test_spine_is_the_contents_in_order_plus_the_notes_page_and_nothing_else(built):
    _, _, provenance, _ = built
    assert [p['source_url'] for p in provenance['pages']] == [
        BASE + 'index.htm',
        BASE + 'ch01.htm',
        BASE + 'ch02.htm',
        # Explicit contents markup may leave the folder (a preface filed elsewhere)…
        'https://www.marxists.org/archive/tester/works/1885/prefaces/preface.htm',
        # …and a page the text links INTO for its notes is appended.
        BASE + 'notes.htm',
    ]
    # Not crawled: the footer's archive/next-work links, the glossary entry, the download, and the
    # alternate translation sitting in the same folder.
    assert any('out-of-folder contents entry kept' in line for line in provenance['crawl_log'])


def test_a_single_page_text_never_crawls_its_folder(tmp_path):
    text = '<html><head><title>Theses</title></head><body><h1>Theses</h1>' + '<p>' + 'Prose. ' * 400 + '</p>' \
        + '<p><a href="alternate.htm">another translation</a></p></body></html>'
    result = stitch.Stitcher(site(**{BASE + 'theses.htm': text})).build(BASE + 'theses.htm', str(tmp_path))
    assert result['pages'] == 1


def test_related_works_listed_under_a_contents_label_are_not_swallowed(tmp_path):
    index = '''<html><head><title>W</title></head><body><h1>The Work</h1>
    <p>Contents:</p>
    <p class="indentb"><a href="ch01.htm">One</a></p>
    <p class="indentb"><a href="../../1848/other-work/index.htm">See also: Another Work</a></p>
    <hr><p><a href="ch02.htm">after the rule: not contents</a></p></body></html>'''
    result = stitch.Stitcher(site(**{BASE + 'index.htm': index})).build(BASE + 'index.htm', str(tmp_path))
    provenance = json.loads((tmp_path / 'marxists_provenance.json').read_text())
    assert [p['source_url'] for p in provenance['pages']] == [BASE + 'index.htm', BASE + 'ch01.htm']
    assert result['pages'] == 2


def test_a_contents_entry_that_is_itself_a_contents_page_is_expanded(tmp_path):
    index = '<html><head><title>W</title></head><body><h1>The Work</h1><p class="index"><a href="part0.htm">Part One</a></p></body></html>'
    part = '<html><body><h3>Part One</h3><p class="index"><a href="a.htm">A</a> <a href="b.htm">B</a> <a href="c.htm">C</a></p></body></html>'
    leaf = '<html><body><h3>Leaf</h3><p>Text.</p></body></html>'
    fetcher = site(**{BASE + 'index.htm': index, BASE + 'part0.htm': part,
                      BASE + 'a.htm': leaf, BASE + 'b.htm': leaf, BASE + 'c.htm': leaf})
    stitch.Stitcher(fetcher).build(BASE + 'index.htm', str(tmp_path))
    provenance = json.loads((tmp_path / 'marxists_provenance.json').read_text())
    assert [p['source_url'].rsplit('/', 1)[1] for p in provenance['pages']] == ['index.htm', 'part0.htm', 'a.htm', 'b.htm', 'c.htm']


# ---------------------------------------------------------------- the epub

def test_the_epub_is_a_real_one(built):
    _, epub, _, _ = built
    first = epub.infolist()[0]
    assert (first.filename, first.compress_type) == ('mimetype', zipfile.ZIP_STORED)
    assert epub.read('mimetype') == b'application/epub+zip'
    opf = page(epub, 'content.opf')
    assert '<dc:title>The Test Work: A Critique of Testing, Volume One</dc:title>' in opf
    assert f'<dc:source>{BASE}index.htm</dc:source>' in opf
    assert '<dc:language>en</dc:language>' in opf
    assert opf.count('<itemref') == 5


def test_site_chrome_is_stripped_and_the_text_is_decoded(built):
    _, epub, _, _ = built
    ch01 = page(epub, 'p001.xhtml')
    assert 'class="footer"' not in ch01 and 'class="title"' not in ch01
    assert 'The first chapter’s only note.' in ch01
    # The download line goes; the information block proper stays in the book.
    index = page(epub, 'p000.xhtml')
    assert 'Download: Epub' not in index and 'Progress Publishers' in index


def test_note_ids_are_namespaced_per_page_so_chapters_cannot_collide(built):
    _, epub, _, _ = built
    ch01, ch02 = page(epub, 'p001.xhtml'), page(epub, 'p002.xhtml')
    assert 'id="p001-1b"' in ch01 and 'href="p001.xhtml#p001-1"' in ch01
    assert 'id="p002-1b"' in ch02 and 'href="p002.xhtml#p002-1"' in ch02
    # A link into another page of the work follows it into the epub; one off the work stays absolute.
    assert 'href="p004.xhtml#p004-n64"' in ch02
    assert 'href="https://www.marxists.org/glossary/terms/v/a.htm"' in ch01


def test_every_note_marker_style_ends_up_in_the_one_shape_the_detector_knows(built):
    result, epub, _, _ = built
    ch01, ch02 = page(epub, 'p001.xhtml'), page(epub, 'p002.xhtml')
    # span.note reciprocal pair -> sup.enote (both chapters).
    assert '<sup class="enote"><a href="p001.xhtml#p001-1" id="p001-1b">[1]</a></sup>' in ch01
    assert '<sup class="enote"><a href="p002.xhtml#p002-1" id="p002-1b">[1]</a></sup>' in ch02
    # A bare ref whose definition has no back-link (Capital ch. 1) -> sup.enote.
    assert '<sup class="enote"><a href="p002.xhtml#p002-n6">[6]</a></sup>' in ch02
    # A glossary marker looks like a note but points off the work: left alone.
    assert '<sup><a href="https://www.marxists.org/glossary/terms/v/a.htm">[*]</a></sup>' in ch01
    assert result['stats']['reciprocal_notes_normalised'] == 2
    assert result['stats']['one_way_notes_normalised'] == 1


def test_images_ride_inside_the_epub_full_size_over_thumbnail(built):
    result, epub, provenance, _ = built
    ch01 = page(epub, 'p001.xhtml')
    assert '<img alt="A plate" src="images/i000.gif"/>' in ch01      # width/border gone, link unwrapped
    assert epub.read('images/i000.gif') == GIF + b'big'
    assert provenance['images'] == [{'file': 'images/i000.gif', 'source_url': BASE + 'pics/big.gif'}]
    # An image that cannot be fetched is dropped and counted, never left as a broken src.
    assert 'missing.gif' not in ch01
    assert result['stats'] == {**result['stats'], 'images_kept': 1, 'images_dropped': 1}


def test_the_thumbnail_stands_in_when_the_full_size_file_is_missing(tmp_path):
    fetcher = site()
    del fetcher.pages[BASE + 'pics/big.gif']
    stitch.Stitcher(fetcher).build(BASE + 'index.htm', str(tmp_path))
    epub = zipfile.ZipFile(tmp_path / 'original.epub')
    assert epub.read('images/i000.gif') == GIF


# ---------------------------------------------------------------- refusals

@pytest.mark.parametrize('url, code', [
    ('https://example.org/archive/marx/works/1867-c1/index.htm', 'not_marxists_org'),
    ('https://marxists.org.evil.example/archive/x/index.htm', 'not_marxists_org'),
    ('https://www.marxists.org/archive/marx/works/download/capital.epub', 'not_a_text_page'),
    ('https://www.marxists.org/glossary/people/m/a.htm', 'not_a_text_page'),
])
def test_urls_that_are_not_a_text_on_marxists_org_are_refused(url, code):
    with pytest.raises(stitch.StitchRefusal) as refusal:
        stitch.Stitcher.check_url(url)
    assert refusal.value.code == code


def test_a_bare_host_spelling_and_a_folder_url_are_normalised():
    assert stitch.Stitcher.check_url('marxists.org/archive/marx/works/1867-c1/') \
        == 'https://www.marxists.org/archive/marx/works/1867-c1/index.htm'
    assert stitch.Stitcher.check_url('http://marxists.org/archive/marx/works/1845/theses/theses.htm#x') \
        == 'https://www.marxists.org/archive/marx/works/1845/theses/theses.htm'


def test_a_list_of_works_is_not_a_work():
    volume = '<html><head><title>Collected Works Volume 22</title></head><body><h1>Volume 22</h1></body></html>'
    author_index = '<html><head><title>Works</title></head><body><h1>Works</h1>' + ''.join(
        f'<p><a href="../{year}/thing/index.htm">Work of {year}</a></p>' for year in range(1900, 1910)) + '</body></html>'
    fetcher = site(**{
        'https://www.marxists.org/archive/tester/works/cw/volume22.htm': volume,
        'https://www.marxists.org/archive/tester/works/1900/listing/list.htm': author_index,
    })
    for url in ('https://www.marxists.org/archive/tester/works/cw/volume22.htm',
                'https://www.marxists.org/archive/tester/works/index.htm',
                'https://www.marxists.org/archive/tester/works/1900/listing/list.htm'):
        with pytest.raises(stitch.StitchRefusal) as refusal:
            stitch.Stitcher(fetcher).metadata(url)
        assert refusal.value.code == 'not_a_single_work', url


def test_a_missing_page_and_a_runaway_crawl_are_refusals_not_crashes(tmp_path, monkeypatch):
    with pytest.raises(stitch.StitchRefusal) as refusal:
        stitch.Stitcher(site()).build(BASE + 'nowhere.htm', str(tmp_path))
    assert refusal.value.code == 'page_unavailable'

    monkeypatch.setattr(stitch, 'MAX_PAGES', 2)
    with pytest.raises(stitch.StitchRefusal) as refusal:
        stitch.Stitcher(site()).build(BASE + 'index.htm', str(tmp_path))
    assert refusal.value.code == 'too_many_pages'
    assert not (tmp_path / 'original.epub').exists()


def test_tls_is_verified_against_certifi_when_it_is_installed():
    """A python.org macOS build wires no system CA bundle to urllib: with the default context every
    HTTPS request failed verification, and the stitcher reported every page "unavailable" (found
    by the first live run — nothing with a faked site can see it). Verification stays ON."""
    import ssl
    context = stitch.NetworkFetcher._tls_context()
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname is True
    try:
        import certifi  # noqa: F401
    except ImportError:
        return
    assert context.cert_store_stats()['x509_ca'] > 0


def test_the_network_fetcher_will_not_leave_marxists_org():
    fetcher = stitch.NetworkFetcher(delay=0)
    # Refused before any request is made: `requests` stays 0, so this test needs no network.
    assert fetcher.binary('https://example.org/pics/x.gif') is None
    assert fetcher.binary('https://marxists.org.evil.example/x.gif') is None
    assert fetcher.requests == 0


def test_progress_is_reported_in_the_import_pipelines_shape(tmp_path):
    # Into a folder that does not exist yet: the first live run lost every progress write here.
    dest = tmp_path / 'not-made-yet'
    stitch.Stitcher(site(), stitch.progress_writer(str(dest))).build(BASE + 'index.htm', str(dest))
    progress = json.loads((dest / 'progress.json').read_text())
    assert progress['status'] == 'processing' and progress['stage'] == 'fetching_pages'
    assert 0 < progress['percent'] <= 40 and progress['detail']


# ---------------------------------------------------------------- end to end

def test_the_stitched_epub_converts_with_every_note_linked(built):
    """The point of the whole exercise: no new footnote parser. The EPUB goes through the SAME two
    scripts a real import runs, and all four notes come out linked to their markers."""
    _, _, _, tmp_path = built
    conv = tmp_path / 'conv'
    src = conv / 'epub_original'
    src.mkdir(parents=True)
    zipfile.ZipFile(tmp_path / 'original.epub').extractall(src)

    for script, args in (('epub_normalizer.py', [str(src), str(conv), 'stitchtest']),
                         ('process_document.py', [str(conv / 'main-text.html'), str(conv), 'stitchtest'])):
        run = subprocess.run([sys.executable, os.path.join(PY, script), *args], capture_output=True, text=True)
        assert run.returncode == 0, run.stderr[-2000:]

    audit = json.loads((conv / 'audit.json').read_text())
    footnotes = json.loads((conv / 'footnotes.json').read_text())
    assert len(footnotes) == 4
    assert not audit.get('unmatched_refs') and not audit.get('unmatched_defs')
    # The source's own number is not left in the note (the book numbers notes itself).
    texts = ' '.join(f['content'] for f in footnotes)
    assert 'The first chapter’s only note.' in texts and '>1.<' not in texts and '>6.<' not in texts
    assert (conv / 'media').is_dir() and len(os.listdir(conv / 'media')) == 1
    # …and the notes are still PRINTED at the foot of the text (the stitcher's keep-notes flag): a
    # reader expects them there, and removing them left "Notes" heading nothing. Each carries the
    # book-wide number of its marker, and none is mistaken for a bibliography entry.
    nodes = [json.loads(line)['content'] for line in (conv / 'nodes.jsonl').read_text().splitlines() if line.strip()]
    printed = [n for n in nodes if 'role="doc-footnote"' in n]
    assert len(printed) == 4 and any('The first chapter’s only note.' in n for n in printed)
    assert all(re.search(r'>\[\d+\] ', n) for n in printed)
    assert json.loads((conv / 'references.json').read_text()) == []
    opf = next(n for n in zipfile.ZipFile(tmp_path / 'original.epub').namelist() if n.endswith('.opf'))
    assert 'hyperlit:keep-notes' in zipfile.ZipFile(tmp_path / 'original.epub').read(opf).decode()


# ---------------------------------------------------------------- listing an author's works

ROOT = 'https://www.marxists.org/archive/tester/'


def _listing(links):
    return '<html><head><title>Tester Archive</title></head><body><h1>Works</h1>' + ''.join(
        f'<p><a href="{href}">{text}</a></p>' for href, text in links) + '</body></html>'


def test_a_listing_becomes_one_address_per_work():
    """The shapes on a real author listing (Lenin's by-date page: 4,189 links for ~3,400 works)."""
    listing = _listing([
        ('works/1893/oct/05.htm', 'To his mother'),                       # /year/month/file  -> a work
        ('works/1894/friends/index.htm', 'Contents'),                     # a work folder…
        ('works/1894/friends/01.htm', 'What the "Friends of the People" Are'),
        ('works/1894/friends/02.htm', 'Part II'),                         # …its chapters are not works
        ('works/1935/abyssinia.htm', 'Abyssinia'),                        # /year/file        -> a work
        ('works/1909/misc/x01.htm', 'A short note'),                      # a "misc" folder: no index,
        ('works/1909/misc/x02.htm', 'Another short note'),                #   so each file is a work
        ('works/dialecti/index.htm', 'Notes on Dialectics'),              # undated folder: a candidate
        ('biograph.htm', 'Biography'),                                    # about the author
        ('quotes.htm', 'Quotes'),
        ('img/index.htm', 'Images'),
        ('works/cw/volume22.htm', 'Collected Works 22'),                  # another listing of the same works
        ('by-title.htm', 'By title'),
        ('works/1893/oct/05.htm#top', 'To his mother (again)'),           # the same work twice
        ('/archive/other/works/1900/x/index.htm', 'Someone else'),        # another author's folder
        ('/glossary/people/t/e.htm', 'Glossary'),
        ('https://example.org/works/1900/01/a.htm', 'Off site'),
    ])
    result = stitch.Lister(stitch.DictFetcher({ROOT + 'index.htm': listing})).list(ROOT + 'index.htm')

    assert [(w['url'].replace(ROOT, ''), w['kind'], w['title']) for w in result['works']] == [
        ('works/1893/oct/05.htm', 'article', 'To his mother'),
        ('works/1935/abyssinia.htm', 'article', 'Abyssinia'),
        ('works/dialecti/index.htm', 'undated_index', 'Notes on Dialectics'),
        # The folder's work is its contents page, titled by the link that NAMED it, not "Contents".
        ('works/1894/friends/index.htm', 'work_folder', 'What the "Friends of the People" Are'),
        ('works/1909/misc/x01.htm', 'folder_member', 'A short note'),
        ('works/1909/misc/x02.htm', 'folder_member', 'Another short note'),
    ]
    assert result['skipped']['not_a_text'] == 5
    assert result['root'] == '/archive/tester/'
    assert result['followed'] == []


def test_a_year_page_is_followed_but_a_work_filed_under_a_year_is_a_work():
    """Marx/Engels: the by-date listing links one page per YEAR, and each year page lists that year's
    works. But Capital is filed straight under a year-shaped folder too (/1867-c1/index.htm). Only
    reading the page tells them apart: a year page fans out into subfolders, a work's contents does not."""
    by_date = _listing([('../1848/index.htm', '1848'), ('../1867-c1/index.htm', 'Capital, Volume One')])
    year_1848 = _listing([
        ('manifesto/index.htm', 'Manifesto of the Communist Party'),
        ('manifesto/ch01.htm', 'Chapter 1'),
        ('free-trade/index.htm', 'On the Question of Free Trade'),
        ('03/24.htm', 'Demands of the Communist Party in Germany'),
        ('12/england.htm', 'England and Revolution'),
        ('letters/index.htm', 'Letters of 1848'),
    ])
    capital = '<html><head><title>Capital</title></head><body><h1>Capital</h1><p class="index">' \
        '<a href="ch01.htm">Chapter 1</a> <a href="ch02.htm">Chapter 2</a> <a href="ch03.htm">Chapter 3</a></p></body></html>'
    fetcher = stitch.DictFetcher({
        ROOT + 'works/date/index.htm': by_date,
        ROOT + 'works/1848/index.htm': year_1848,
        ROOT + 'works/1867-c1/index.htm': capital,
    })
    result = stitch.Lister(fetcher).list(ROOT + 'works/date/index.htm')

    assert result['followed'] == [ROOT + 'works/1848/index.htm']
    assert [(w['url'].replace(ROOT + 'works/', ''), w['kind']) for w in result['works']] == [
        ('1848/03/24.htm', 'article'),
        ('1848/12/england.htm', 'article'),
        ('1848/manifesto/index.htm', 'work_folder'),
        ('1848/free-trade/index.htm', 'work_folder'),
        ('1848/letters/index.htm', 'work_folder'),
        ('1867-c1/index.htm', 'work_folder'),
    ]
    # …and the year page itself is refused as a single work, so it can never be stitched into
    # one book of everything written that year.
    with pytest.raises(stitch.StitchRefusal) as refusal:
        stitch.Stitcher(fetcher).metadata(ROOT + 'works/1848/index.htm')
    assert refusal.value.code == 'not_a_single_work'
    assert stitch.Stitcher(fetcher).metadata(ROOT + 'works/1867-c1/index.htm')[0]['title'] == 'Capital'


def test_year_pages_that_link_each_other_are_each_read_once():
    """Every Marx/Engels year page links the previous and next year. Each of those links used to be
    fetched and classified again, so 62 year pages ran past the listing cap ("too_many_pages", prod
    2026-11-24) before the listing finished."""
    years = list(range(1840, 1900))
    by_date = _listing([(f'../{y}/index.htm', str(y)) for y in years])
    pages = {ROOT + 'works/date/index.htm': by_date}
    for y in years:
        pages[ROOT + f'works/{y}/index.htm'] = _listing([
            (f'../{y - 1}/index.htm', 'Previous year'), (f'../{y + 1}/index.htm', 'Next year'),
            ('a/index.htm', 'A'), ('b/index.htm', 'B'), ('c/index.htm', 'C'), ('01/x.htm', 'X'),
        ])
    lister = stitch.Lister(stitch.DictFetcher(pages))
    result = lister.list(ROOT + 'works/date/index.htm')

    assert len(result['followed']) == len(years)
    assert len(result['works']) == len(years) * 4
    assert lister.fetches <= len(years) + 3      # the listing, each year once, the two off the ends


def test_a_sparse_year_page_is_still_a_listing_not_a_work_called_1838():
    by_date = _listing([('../1838/index.htm', '1838')])
    sparse = _listing([('11/10.htm', 'Letter to his father'), ('poems/index.htm', 'Poems')])
    result = stitch.Lister(stitch.DictFetcher({
        ROOT + 'works/date/index.htm': by_date, ROOT + 'works/1838/index.htm': sparse,
    })).list(ROOT + 'works/date/index.htm')

    assert result['followed'] == [ROOT + 'works/1838/index.htm']
    assert sorted(w['url'].replace(ROOT + 'works/', '') for w in result['works']) == ['1838/11/10.htm', '1838/poems/index.htm']


def test_a_listing_must_be_an_author_folder_and_must_exist():
    with pytest.raises(stitch.StitchRefusal) as refusal:
        stitch.Lister(stitch.DictFetcher({})).list('https://www.marxists.org/history/etol/index.htm')
    assert refusal.value.code == 'not_an_author_listing'
    with pytest.raises(stitch.StitchRefusal) as refusal:
        stitch.Lister(stitch.DictFetcher({})).list(ROOT + 'index.htm')
    assert refusal.value.code == 'page_unavailable'

#!/usr/bin/env python3
"""marxists.org: ONE work, shattered over many pages -> ONE EPUB the existing epub pipeline reads.

The Marxists Internet Archive publishes a work as a contents page plus a page per chapter (Capital
vol. 1 is 47 pages), with footnotes in half a dozen site-specific shapes. Rather than a second
footnote parser, this crawls the work, cleans each page, rewrites the notes into the shape the
epub normalizer's detectors already know, and packs the result as `original.epub` — from there it
is an ordinary EPUB import. Every rule below broke something first; the lessons are in the
docstrings and in docs/marxists-import.md.

usage:
    stitch.py metadata <work url>                      -> JSON on stdout (one page fetched)
    stitch.py build <work url> <dest dir> [--progress] -> writes <dest>/original.epub and
                                                          <dest>/marxists_provenance.json; JSON summary on stdout
    stitch.py list <author listing url>                -> JSON: the works that listing links, one
                                                          address per work (reads the listing only)

Polite by construction: sequential, MIN_DELAY seconds between network requests, an identifying
User-Agent, each URL fetched once per run, hard caps on pages and images. Only marxists.org is ever
contacted — a page cannot point this at another host.

Exit codes: 0 ok; 2 a refusal the caller should show the user (JSON {"error": code} on stdout);
1 anything else.
"""
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timezone
from urllib.parse import urljoin, urldefrag, urlparse

from bs4 import BeautifulSoup, Comment

UA = 'Hyperlit/1.0 (+https://hyperlit.io; sam@hyperlit.io)'
MIN_DELAY = 1.5
HOST = 'www.marxists.org'
MAX_PAGES = 200
MAX_IMAGES = 300
MAX_IMAGE_BYTES = 8 * 1024 * 1024

# Links that are never part of a work's body even when they sit in a contents list.
NOT_WORK = re.compile(r'/(glossary|download|admin|subject|reference/archive|xlang)/|/pics/|\.(gif|jpe?g|png|pdf|doc|epub|azw3?|mp3)$', re.I)
NOTE_MARKER = re.compile(r'^\s*[\[(]?\s*(\d{1,4}|[*†‡]+|[a-z])\s*[\])]?\.?\s*$', re.I)  # [1] (1) 1. *
IMG_EXT = re.compile(r'\.(gif|jpe?g|png|svg)$', re.I)
MEDIA_TYPES = {'gif': 'image/gif', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'svg': 'image/svg+xml'}

LANG_DIRS = {'deutsch': 'de', 'espanol': 'es', 'francais': 'fr', 'italiano': 'it', 'portugues': 'pt',
             'nederlands': 'nl', 'svenska': 'sv', 'russkij': 'ru', 'chinese': 'zh', 'turkce': 'tr', 'polski': 'pl'}
JOINERS = {'u.', 'und', 'and', '&', 'y', 'et', 'e', 'i', 'и'}
FOOTER_SELECTORS = ['p.footer', 'table.footer', '[class^=footer]', 'p.title']
CHROME_SELECTORS = ['p.title', 'p.footer', 'p.skip', 'hr.end', 'p.toc', 'p.index', 'script', 'style', 'link', 'meta']
BLOCKS = ('p', 'div', 'li', 'dd', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td')
BR_MARK = '␞'


class StitchRefusal(Exception):
    """Not a crash: this URL is not something to import. `code` is shown to the user."""

    def __init__(self, code, detail=''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = detail


def is_marxists_host(netloc):
    host = (netloc or '').lower().split(':')[0]
    return host == 'marxists.org' or host.endswith('.marxists.org')


def norm(url):
    """One spelling per page: https, the www host, no fragment."""
    bare = urldefrag(url)[0]
    u = urlparse(bare)
    return f'https://{HOST}{u.path}' if is_marxists_host(u.netloc) else bare


def is_work_link(abs_url):
    u = urlparse(abs_url)
    return bool(is_marxists_host(u.netloc) and re.search(r'\.html?$', u.path, re.I) and not NOT_WORK.search(u.path))


def text_of(el):
    return re.sub(r'\s+', ' ', el.get_text(' ', strip=True)).strip()


def decode(raw):
    """MIA declares iso-8859-1 and means cp1252 (curly quotes, dashes)."""
    head = raw[:2048].decode('ascii', 'ignore').lower()
    return raw.decode('utf-8', 'replace') if 'utf-8' in head else raw.decode('cp1252', 'replace')


# ---------------------------------------------------------------- fetching

class NetworkFetcher:
    """GET from marxists.org only, each URL once, MIN_DELAY apart."""

    def __init__(self, delay=MIN_DELAY):
        self.delay = delay
        self._last = 0.0
        self._pages = {}
        self._media = {}
        self._tls = None
        self.requests = 0

    @staticmethod
    def _tls_context():
        """Verify against certifi's CA bundle when it is installed. A python.org macOS build has
        NO system CA bundle wired to urllib, so the default context fails every HTTPS request
        with CERTIFICATE_VERIFY_FAILED — which first showed up here as every page being
        "unavailable". Verification is never turned off."""
        import ssl
        try:
            import certifi
            return ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            return ssl.create_default_context()

    def _get(self, url, limit):
        import urllib.error
        import urllib.request
        if not is_marxists_host(urlparse(url).netloc):
            return None
        if self._tls is None:
            self._tls = self._tls_context()
        wait = self.delay - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30, context=self._tls) as resp:
                # A redirect off the site is not followed into our book.
                if resp.status != 200 or not is_marxists_host(urlparse(resp.geturl()).netloc):
                    return None
                data = resp.read(limit + 1)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                print(f'marxists fetch: HTTP {e.code} for {url}', file=sys.stderr)
            return None
        except (urllib.error.URLError, OSError, ValueError) as e:
            # Said on stderr (the PHP side logs it): "the page is missing" and "we could not
            # connect at all" must not look the same to whoever debugs this.
            print(f'marxists fetch: {type(e).__name__}: {e} for {url}', file=sys.stderr)
            return None
        finally:
            self._last = time.time()
            self.requests += 1
        return data if 0 < len(data) <= limit else None

    def text(self, url):
        url = norm(url)
        if url not in self._pages:
            raw = self._get(url, 20 * 1024 * 1024)
            self._pages[url] = decode(raw) if raw is not None else None
        return self._pages[url]

    def binary(self, url):
        if url not in self._media:
            self._media[url] = self._get(url, MAX_IMAGE_BYTES)
        return self._media[url]


class DictFetcher:
    """A site held in memory: {url: str | bytes}. For tests — and nothing else."""

    def __init__(self, pages):
        self.pages = {(norm(k) if not IMG_EXT.search(urlparse(k).path) else k): v for k, v in pages.items()}
        self.requests = 0

    def text(self, url):
        self.requests += 1
        v = self.pages.get(norm(url))
        return decode(v) if isinstance(v, bytes) else v

    def binary(self, url):
        self.requests += 1
        v = self.pages.get(url)
        return v if isinstance(v, bytes) else None


# ---------------------------------------------------------------- metadata

def page_language(soup, url):
    """Declared <html lang> / content-language, else the site's language folder, else English
    (everything outside a language folder on MIA is the English archive)."""
    html = soup.find('html')
    if html and html.get('lang'):
        return html['lang'].split('-')[0].lower()
    m = soup.find('meta', attrs={'http-equiv': re.compile('content-language', re.I)})
    if m and m.get('content'):
        return m['content'].split(',')[0].split('-')[0].strip().lower()
    first = urlparse(url).path.strip('/').split('/')[0].lower()
    return LANG_DIRS.get(first, 'en')


def heading_text(h):
    h = BeautifulSoup(str(h), 'lxml').find(h.name)
    for sup in h.find_all('sup'):
        sup.decompose()
    for br in h.find_all('br'):
        br.replace_with(f' {BR_MARK} ')
    t = text_of(h)
    t = re.sub(r'\s*\[\d+\]\s*$', '', t)                 # trailing note marker: "... Capitalism [1]"
    parts = [p.strip(' :') for p in t.split(BR_MARK) if p.strip(' :')]
    # Capital<br>A Critique... -> "Capital: A Critique..."; but a break mid-phrase
    # (The Eighteenth Brumaire<br>of Louis Bonaparte) is just a space.
    out = parts[0] if parts else ''
    for p in parts[1:]:
        out += (': ' if p[:1].isupper() else ' ') + p
    return out


def is_author_line(text, author):
    """"Karl Marx u. Friedrich Engels" against author "Karl Marx, Friedrich Engels": every word is
    one of the author's names or a joining word."""
    if not author:
        return False
    names = set(re.findall(r'[\w.]+', author.lower()))
    words = re.findall(r'[\w.&]+', text.lower())
    return bool(words) and all(w in names or w in JOINERS for w in words)


def work_title(soup, author, html_title):
    """MIA puts the title in an <h1> (Capital, Brumaire), or — on Lenin's pages — in an <h3> under an
    <h2> that holds the AUTHOR's name. A volume number often appears only in <title>
    ("Economic Manuscripts: Capital: Volume One"), so it is appended when the heading lacks it."""
    surname = (author or '').split()[-1].lower() if author else ''
    title = None
    for h in soup.find_all(['h1', 'h2', 'h3']):
        t = heading_text(h)
        low = t.lower()
        if not t or low in ('contents', 'table of contents', 'notes', 'inhalt', 'índice', 'sommaire') \
                or is_author_line(t, author) or (surname and low.endswith(surname) and len(t.split()) <= 4):
            continue
        title = t
        break
    vol = re.search(r'\b(Volume|Vol\.|Band|Tome|Tomo)\s+([IVXLC]+|\d+|One|Two|Three|Four)\b', html_title or '', re.I)
    if title and vol and vol.group(0).lower() not in title.lower():
        title = f'{title}, {vol.group(0)}'
    return title


def licence_from_info(info):
    """MIA states rights in the information block. Two shapes:
    'Copyleft: ... Creative Commons ShareAlike License' -> admin/legal/cc/by-sa.htm, which IS CC BY-SA 2.0
    (verified against that page), and 'Public Domain: <X> Internet Archive ... freely copy ...'.
    Silence is Unknown, never a guess — many Marx/Engels texts here are Progress / MECW translations
    whose rights MIA does not state."""
    for label, val in info.items():
        low = label.lower()
        if low.startswith('copyleft'):
            if re.search(r'sharealike|share alike|by-sa', val, re.I):
                return {'code': 'CC-BY-SA-2.0', 'url': 'https://www.marxists.org/admin/legal/cc/by-sa.htm',
                        'evidence': f'{label}: {val[:200]}'}
            return {'code': 'Unknown', 'url': None, 'evidence': f'{label}: {val[:200]} (copyleft, unrecognised terms)'}
        if low.startswith('public domain'):
            return {'code': 'PDM', 'url': None, 'evidence': f'{label}: {val[:200]}'}
    return {'code': 'Unknown', 'url': None, 'evidence': None}


def work_year(info, html_title):
    """When the work was WRITTEN, from the information block: the labels vary by page ("Written",
    "Delivered" for a lecture, "First Published (in German)"), so they are tried in that order of
    preference before the page <title>. Never the transcription / markup date."""
    def year_in(text):
        m = re.search(r'\b(1[5-9]\d\d)\b', text or '')
        return int(m.group(1)) if m else None

    for prefix in ('written', 'delivered', 'first published', 'published'):
        for label, value in info.items():
            if label.lower().startswith(prefix):
                found = year_in(value)
                if found:
                    return found
    return year_in(html_title)


def year_from_path(url):
    """MIA files a text under the year it was written (/1918/…, /1867-c1/…). The last resort when
    the page itself gives no date — common for short pieces with no information block."""
    for seg in urlparse(url).path.split('/'):
        m = re.match(r'^(1[5-9]\d\d|20[0-2]\d)(?!\d)', seg)
        if m:
            return int(m.group(1))
    return None


def index_metadata(soup, url):
    meta = {'index_url': url, 'language': page_language(soup, url), 'author': None}
    m = soup.find('meta', attrs={'name': re.compile('^author$', re.I)})
    if m and m.get('content'):
        meta['author'] = m['content'].strip()
    t = soup.find('title')
    meta['html_title'] = text_of(t) if t else None
    meta['title'] = work_title(soup, meta.get('author'), meta['html_title'])
    # <span class="info">Label:</span> value<br>  -- the MIA "information" block.
    info = {}
    for span in soup.select('span.info'):
        label = text_of(span).rstrip(':').strip()
        if not label or len(label) > 40:
            continue
        parts = []
        for sib in span.next_siblings:
            name = getattr(sib, 'name', None)
            if name in ('br', 'p') or (name == 'span' and 'info' in (sib.get('class') or [])):
                break
            parts.append(sib.get_text(' ') if hasattr(sib, 'get_text') else str(sib))
        val = re.sub(r'\s+', ' ', ''.join(parts)).strip(' ;')
        if val:
            info[label] = val
    meta['info'] = info
    meta['licence'] = licence_from_info(info)
    meta['year'] = work_year(info, meta.get('html_title')) or year_from_path(url)
    meta['note'] = ' | '.join(f'{k}: {v}' for k, v in info.items()) or None
    return meta


# ---------------------------------------------------------------- contents

def prose_chars(soup):
    return sum(len(text_of(p)) for p in soup.find_all('p')
               if not set(p.get('class') or []) & {'index', 'information', 'toc', 'footer', 'title'})


def is_contents_page(soup):
    return prose_chars(soup) < 1500


def toc_links(soup, url):
    """Ordered work-page links from a contents page.

    Page FOOTERS carry prev/next/archive-index navigation (Lenin's table.footer) and must be
    stripped before anything is read; the contents block is marked many ways (p.index — Brumaire;
    blocks after a "Contents" label — Wage-Labour's p.indentb; table.t2h-toc / span.toc — Lenin).
    Out-of-folder links are accepted ONLY from an explicit contents block (Engels' 1885 preface to
    the Brumaire lives under /1885/prefaces/); the same-folder fallback never leaves the folder.
    """
    soup = BeautifulSoup(str(soup), 'lxml')  # work on a copy
    for sel in FOOTER_SELECTORS:
        for el in soup.select(sel):
            el.decompose()
    base_dir = norm(url).rsplit('/', 1)[0] + '/'
    explicit = soup.select('p.index, span.toc, [class*=toc] a, table[class*=toc]')
    blocks = list(explicit)
    label = soup.find(lambda t: t.name in ('p', 'h2', 'h3', 'h4')
                      and re.match(r'^\s*(table of )?contents:?\s*$', t.get_text(' ', strip=True), re.I))
    if label:
        for sib in label.find_next_siblings():
            if sib.name == 'hr':
                break
            blocks.append(sib)
    links, seen = [], set()

    def take(anchors, same_folder_only):
        for a in anchors:
            href = a.get('href')
            if not href or href.startswith('#') or href.startswith('mailto:'):
                continue
            absu = urljoin(url, href)
            if not is_work_link(absu):
                continue
            n = norm(absu)
            if n == norm(url) or n in seen or n.endswith('/guide.htm'):
                continue
            if same_folder_only and not n.startswith(base_dir):
                continue
            seen.add(n)
            links.append(n)

    # Explicit contents markup may leave the folder; the looser "blocks after a Contents label"
    # may NOT — Socialism: Utopian and Scientific lists related works (the French translation, the
    # Manifesto, Capital) right under its contents, and the first crawl swallowed 54 pages.
    for b in blocks:
        anchors = [b] if b.name == 'a' else b.find_all('a', href=True)
        take(anchors, same_folder_only=not any(b is e for e in explicit))
    if not links and is_contents_page(soup):
        # Last resort for an unmarked contents page. A page that is itself the TEXT (Theses on
        # Feuerbach) never crawls its folder: siblings there are alternate translations.
        body = soup.body or soup
        take(body.find_all('a', href=True), same_folder_only=True)
    return links


def is_index_of_works(url):
    """Recognisable from the address alone: an author's works index, a Collected Works volume, the
    by-date / by-subject listings. Checked BEFORE fetching, so refusing one costs the site nothing."""
    path = urlparse(norm(url)).path.lower()
    return bool(re.search(r'/works/(cw|date|subject|sw)/', path)
                or re.search(r'/(works|archive/[^/]+)/index\.html?$', path))


def collection_reason(soup, url):
    """Why this page is a LIST OF WORKS, not a work — or None.

    An author's index and a Collected Works volume link out to many works, each in its own folder
    with its own contents page. Crawled as one work they stitch into a soup of first chapters. One
    work = one book, so these are refused: import the works one at a time.
    """
    if is_index_of_works(url):
        return 'an index of works'
    if not is_contents_page(soup):
        return None
    base_dir = norm(url).rsplit('/', 1)[0] + '/'
    copy = BeautifulSoup(str(soup), 'lxml')
    for sel in FOOTER_SELECTORS:
        for el in copy.select(sel):
            el.decompose()
    folders = set()
    for a in (copy.body or copy).find_all('a', href=True):
        absu = urljoin(url, a['href'])
        if not is_work_link(absu):
            continue
        n = norm(absu)
        if not n.startswith(base_dir):
            folders.add(n.rsplit('/', 1)[0])
    if len(folders) >= 6:
        return f'links to works in {len(folders)} other folders'
    # A work's chapters sit beside its contents page. A page whose links fan out into several
    # SUBFOLDERS is a listing of works filed under it — the Marx/Engels year pages
    # (/works/1848/index.htm -> communist-manifesto/, free-trade/, 03/, 12/ …). Crawled as a work,
    # one of those stitched a whole year of writing into a single book.
    subfolders = set()
    for a in (copy.body or copy).find_all('a', href=True):
        absu = urljoin(url, a['href'])
        if not is_work_link(absu):
            continue
        n = norm(absu)
        if n.startswith(base_dir) and '/' in n[len(base_dir):]:
            subfolders.add(n[len(base_dir):].split('/')[0])
    return f'links into {len(subfolders)} subfolders' if len(subfolders) >= 3 else None


# ---------------------------------------------------------------- listing an author's works

YEAR_SEG = re.compile(r'^\d{4}')
MONTH_SEG = re.compile(r'^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}|xx)$', re.I)
INDEX_FILE = re.compile(r'^index\.html?$', re.I)
# Path parts that are about the author or the archive, not a text by them.
NOT_A_TEXT = re.compile(r'^(bio|biograph\w*|quotes?|img|images|photo\w*|pics|todo|note|guide|chronolog\w*|'
                        r'by-title|by-date|sw|cw|subject|date|ebooks?|audio\w*|video\w*)$', re.I)
MAX_LISTING_FETCHES = 150


class Lister:
    """An author's listing page -> the WORKS it links, one address per work.

    MIA files a short piece at /<year>/<month>/<file>.htm and a longer work in its own folder,
    /<year>/<slug>/, with a contents page. A listing links the contents page AND, often, some of
    the chapters (Lenin's by-date page lists 4,189 links for about 3,400 works), so:

      - /<year>/<file>.htm, /<year>/<month>/<file>.htm   -> one work each
      - /<year>/<slug>/…  with its index linked          -> ONE work, the index (chapters dropped)
      - /<year>/<slug>/…  with no index linked           -> each linked file is its own work
                                                            (MIA's "misc" folders)
      - /<year>/index.htm                                -> read it: a year LISTING (Marx/Engels)
                                                            is followed one level; a work filed
                                                            straight under a year (Capital,
                                                            /1867-c1/) is a work
      - <undated>/index.htm                              -> a candidate; whether it is a work or a
                                                            subject collection is settled when it
                                                            is imported (a collection is refused)
      - biography, quotes, images, the by-title / collected-works listings -> skipped

    Only links under the listing's own author folder are taken. Nothing is imported here: this
    reads the listing (and any year pages) and returns addresses.
    """

    def __init__(self, fetcher):
        self.fetcher = fetcher
        self.works = {}          # url -> {'url', 'title', 'kind'}, insertion-ordered
        self.followed = []
        self.skipped = {}
        self.fetches = 0
        self.year_pages = {}        # /<year>/index.htm -> its soup: each is FETCHED once
        self.year_settled = set()   # …and added as a work, or followed, once

    def _skip(self, reason):
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def _page(self, url):
        if self.fetches >= MAX_LISTING_FETCHES:
            raise StitchRefusal('too_many_pages', f'more than {MAX_LISTING_FETCHES} listing pages')
        self.fetches += 1
        html = self.fetcher.text(url)
        return BeautifulSoup(html, 'lxml') if html is not None else None

    def _add(self, url, title, kind):
        if url not in self.works:
            self.works[url] = {'url': url, 'title': title or None, 'kind': kind}
        elif not self.works[url]['title'] and title:
            self.works[url]['title'] = title

    def list(self, listing_url, max_depth=1):
        listing_url = Stitcher.check_url(listing_url)
        m = re.match(r'^(/archive/[^/]+/)', urlparse(listing_url).path)
        if not m:
            raise StitchRefusal('not_an_author_listing', listing_url)
        self.root = m.group(1)
        if self._harvest(listing_url, 0, max_depth) is None:
            raise StitchRefusal('page_unavailable', listing_url)
        return {'ok': True, 'listing': listing_url, 'root': self.root, 'works': list(self.works.values()),
                'followed': self.followed, 'skipped': self.skipped, 'requests': getattr(self.fetcher, 'requests', None)}

    def _harvest(self, listing_url, depth, max_depth, soup=None):
        soup = soup if soup is not None else self._page(listing_url)
        if soup is None:
            return None
        folders = {}     # '<prefix>/<year>/<slug>' -> [(url, title, file)]
        for a in (soup.body or soup).find_all('a', href=True):
            absu = urljoin(listing_url, a['href'])
            if not is_work_link(absu):
                continue
            url = norm(absu)
            path = urlparse(url).path
            if url == listing_url or not path.startswith(self.root):
                self._skip('outside_author_folder')
                continue
            segs = path[len(self.root):].split('/')
            body = segs[1:] if segs and segs[0] == 'works' else segs
            if not body or any(NOT_A_TEXT.match(re.sub(r'\.html?$', '', seg)) for seg in body):
                self._skip('not_a_text')
                continue
            title = text_of(a)
            file = body[-1]
            year_at = next((i for i, seg in enumerate(body[:-1]) if YEAR_SEG.match(seg)), None)

            if year_at is None:
                if INDEX_FILE.match(file) and len(body) >= 2:
                    self._add(url, title, 'undated_index')
                else:
                    self._skip('undated_page')
                continue

            rest = body[year_at + 1:]
            if len(rest) == 1 and INDEX_FILE.match(file):
                self._year_index(url, title, depth, max_depth)
            elif len(rest) == 1 or MONTH_SEG.match(rest[0]):
                self._add(url, title, 'article')
            else:
                folder = path.rsplit('/' + '/'.join(rest), 1)[0] + '/' + rest[0]
                folders.setdefault(folder, []).append((url, title, '/'.join(rest[1:])))

        for members in folders.values():
            index = next((m for m in members if INDEX_FILE.match(m[2])), None)
            if index:
                # Prefer a real title over "Contents" from whichever link named the work.
                title = next((t for _, t, _ in members if t and t.lower() not in ('contents', 'index')), index[1])
                self._add(index[0], title, 'work_folder')
            else:
                for url, title, _ in members:
                    self._add(url, title, 'folder_member')
        return True

    def _year_index(self, url, title, depth, max_depth):
        """`/<year>/index.htm`: a year's listing of works, or a work filed straight under a year."""
        # Year pages link each other (prev / next year) and the listing links some twice. Without
        # this, every such link was fetched and classified again and the Marx/Engels archive (62
        # year pages) ran past the listing cap before it finished.
        # A year first met through another year's "next" link is too deep to follow THERE, and must
        # still be followed when the listing itself links it — so "fetched" and "settled" are kept apart.
        if url in self.year_settled:
            return
        if url not in self.year_pages:
            self.year_pages[url] = self._page(url)
        soup = self.year_pages[url]
        if soup is None:
            self.year_settled.add(url)
            self._skip('year_index_unavailable')
            return
        # A folder that is EXACTLY a year (/1838/) is that year's listing however few works it
        # holds: nine sparse Marx/Engels years read as "a contents page" and were listed as works
        # titled "1838". Only a year-shaped folder with more to its name (/1867-c1/) can be a work.
        bare_year = re.search(r'/\d{4}/index\.html?$', url, re.I)
        if not bare_year and collection_reason(soup, url) is None:
            self.year_settled.add(url)
            self._add(url, title, 'work_folder')
        elif depth < max_depth:
            self.year_settled.add(url)
            self.followed.append(url)
            self._harvest(url, depth + 1, max_depth, soup)
        else:
            self._skip('listing_too_deep')


# ---------------------------------------------------------------- note normalisation

def _as_enote(ref):
    wrap = ref.parent
    if wrap.name in ('sup', 'span') and len(wrap.find_all(True)) == 1:
        wrap.name, wrap.attrs = 'sup', {'class': ['enote']}
    else:
        ref.wrap(BeautifulSoup('', 'lxml').new_tag('sup', attrs={'class': 'enote'}))


def normalise_reciprocal_notes(body, stats):
    """One MIA work can mix three marker styles (Socialism: Utopian and Scientific):
    <sup class="enote">, <span class="note"> and <sup class="ednote"> — only the first is known to
    EnoteFootnoteDetector; the rest were unwrapped as dead links and left as a literal "[1]". What
    they share: the reference and the definition POINT AT EACH OTHER (ref id=1b -> #1, def id=1 ->
    #1b). Any such reciprocal same-page pair whose ref comes first is rewritten into the enote shape."""
    by_id = {a['id']: a for a in body.find_all('a', id=True, href=True)}
    order = {id(t): i for i, t in enumerate(body.find_all(True))}
    for ref in list(by_id.values()):
        frag = ref['href'].split('#', 1)[1] if '#' in ref['href'] else None
        d = by_id.get(frag)
        if d is None or d is ref or d['href'].split('#', 1)[-1] != ref['id']:
            continue
        if order.get(id(ref), 0) > order.get(id(d), 0):
            continue  # this is the definition side
        if not NOTE_MARKER.match(ref.get_text() or ''):
            continue
        wrap = ref.parent
        if wrap.name == 'sup' and 'enote' in (wrap.get('class') or []):
            continue
        _as_enote(ref)
        stats['reciprocal_notes_normalised'] += 1


def normalise_one_way_notes(body, stats):
    """Capital vol. 1 breaks reciprocity two ways: chapter 1 has bare refs (`Mr. Wirth<a href="#n6">[6]</a>`,
    no wrapper) whose definitions carry no backlink, and ch. 7 has `span.note` refs whose definitions
    link back to `#1a` — an anchor that does not exist. What still identifies the pair: a marker-text
    ref pointing FORWARD on the same page at an anchor that opens its block and reads as a note number
    ("1.", "[1]"). A ToC link fails the marker test; a glossary link points off-page."""
    order = {id(t): i for i, t in enumerate(body.find_all(True))}
    for ref in body.find_all('a', href=True):
        if '#' not in ref['href'] or not NOTE_MARKER.match(ref.get_text() or ''):
            continue
        wrap = ref.parent
        if wrap.name == 'sup' and 'enote' in (wrap.get('class') or []):
            continue
        t = body.find(id=ref['href'].split('#', 1)[1])
        if t is None or t is ref or order.get(id(t), -1) <= order.get(id(ref), 0):
            continue
        if not NOTE_MARKER.match(t.get_text() or ''):
            continue
        block = t.find_parent(BLOCKS)
        if block is None or not block.get_text(' ', strip=True).startswith(t.get_text(' ', strip=True)):
            continue
        _as_enote(ref)
        stats['one_way_notes_normalised'] += 1


# ---------------------------------------------------------------- the stitcher

XHTML = '''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body>
{body}
</body></html>'''


def esc(s):
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


class Stitcher:
    def __init__(self, fetcher, progress=None):
        self.fetcher = fetcher
        self.progress = progress or (lambda stage, detail, percent: None)
        self.log = []
        self.stats = {'images_kept': 0, 'images_dropped': 0, 'layout_wrappers_unwrapped': 0,
                      'reciprocal_notes_normalised': 0, 'one_way_notes_normalised': 0}

    # -- metadata (one fetch) ------------------------------------------------

    def metadata(self, url):
        url = self.check_url(url)
        if is_index_of_works(url):
            raise StitchRefusal('not_a_single_work', 'an index of works')
        html = self.fetcher.text(url)
        if html is None:
            raise StitchRefusal('page_unavailable', url)
        soup = BeautifulSoup(html, 'lxml')
        reason = collection_reason(soup, url)
        if reason:
            raise StitchRefusal('not_a_single_work', reason)
        meta = index_metadata(soup, url)
        if not meta.get('title'):
            raise StitchRefusal('no_title', url)
        return meta, soup

    @staticmethod
    def check_url(url):
        u = urlparse(url if '://' in url else 'https://' + url)
        if not is_marxists_host(u.netloc):
            raise StitchRefusal('not_marxists_org', url)
        path = u.path or '/'
        if path.endswith('/'):
            path += 'index.htm'
        if not re.search(r'\.html?$', path, re.I) or NOT_WORK.search(path):
            raise StitchRefusal('not_a_text_page', url)
        return f'https://{HOST}{path}'

    # -- spine ---------------------------------------------------------------

    def build_spine(self, index_url, soup):
        links = toc_links(soup, index_url)
        if not links:
            self.log.append('no contents links: single-page work')
            return [index_url]
        # Out-of-folder entries are kept (MIA links prefaces from elsewhere) but flagged.
        base_dir = index_url.rsplit('/', 1)[0]
        spine = [index_url]

        def add(page):
            if len(spine) >= MAX_PAGES:
                raise StitchRefusal('too_many_pages', f'more than {MAX_PAGES} pages')
            spine.append(page)
            self.progress('fetching_pages', f'Fetching pages from marxists.org ({len(spine)})…', min(28, 6 + len(spine) // 2))

        for link in links:
            if not link.startswith(base_dir):
                self.log.append(f'out-of-folder contents entry kept: {link}')
            html = self.fetcher.text(link)
            if html is None:
                self.log.append(f'FETCH FAILED {link}')
                continue
            sub = BeautifulSoup(html, 'lxml')
            sublinks = toc_links(sub, link)
            add(link)
            # A contents entry that is itself a contents page (Capital's part0.htm). Never expand
            # another work's contents page.
            if len(sublinks) >= 3 and is_contents_page(sub) and link.startswith(base_dir):
                self.log.append(f'sub-index expanded ({len(sublinks)} links): {link}')
                for s in sublinks:
                    if s not in spine and s.startswith(link.rsplit('/', 1)[0]) and self.fetcher.text(s) is not None:
                        add(s)
        # Notes pages: anything a spine page links INTO with a fragment, inside the work folder
        # (the MECW editorial notes on a shared notes.htm), not yet in the spine.
        extra = []
        for page in list(spine):
            ps = BeautifulSoup(self.fetcher.text(page), 'lxml')
            for a in ps.find_all('a', href=True):
                absu = urljoin(page, a['href'])
                frag = urldefrag(absu)[1]
                n = norm(absu)
                if frag and is_work_link(absu) and n.startswith(base_dir) and n not in spine and n not in extra:
                    if self.fetcher.text(n) is not None:
                        extra.append(n)
        for e in extra:
            self.log.append(f'notes/target page appended: {e}')
            add(e)
        return spine

    # -- one page ------------------------------------------------------------

    def clean_page(self, html, url, page_map, media):
        soup = BeautifulSoup(html, 'lxml')
        body = soup.body or soup
        for c in body.find_all(string=lambda s: isinstance(s, Comment)):
            c.extract()
        # Layout wrappers: Theses on Feuerbach wraps the whole page in <blockquote><div class="border">,
        # which converted to ONE blockquote node. A blockquote holding headings is layout, not a quotation.
        for wrap in body.select('div.border'):
            wrap.unwrap()
            self.stats['layout_wrappers_unwrapped'] += 1
        for bq in body.find_all('blockquote'):
            if bq.find(['h1', 'h2', 'h3', 'h4']):
                bq.unwrap()
                self.stats['layout_wrappers_unwrapped'] += 1
        for sel in CHROME_SELECTORS + FOOTER_SELECTORS:
            for el in body.select(sel):
                el.decompose()
        for p in body.select('p.information'):
            if p.find('a', href=re.compile('/download/')):
                p.decompose()
        self._take_images(body, url, media)
        # Ids are NAMESPACED per page. MIA restarts note ids in every chapter (id="1", "1b", section
        # anchors "001"), and the epub normalizer flattens the spine into one document — Socialism:
        # Utopian and Scientific linked only 6 of 12 notes until this, because three chapters all
        # carried id="1". A bare-digit id is not a valid HTML id either.
        stem = page_map[url].rsplit('.', 1)[0]
        for a in body.find_all('a', attrs={'name': True}):
            if not a.get('id'):
                a['id'] = a['name']
            del a['name']
        for el in body.find_all(id=True):
            el['id'] = f'{stem}-{el["id"]}'
        # Link rewrite: pages in the work -> their epub file (+ namespaced fragment); else absolute URL.
        for a in body.find_all('a', href=True):
            absu = urljoin(url, a['href'])
            n, frag = urldefrag(absu)
            n = norm(n) if n else url
            if n in page_map:
                tstem = page_map[n].rsplit('.', 1)[0]
                a['href'] = page_map[n] + (f'#{tstem}-{frag}' if frag else '')
            else:
                a['href'] = absu
        normalise_reciprocal_notes(body, self.stats)
        normalise_one_way_notes(body, self.stats)
        return ''.join(str(c) for c in body.contents)

    def _take_images(self, body, url, media):
        """Images ride along as EPUB media (the pipeline's ImageProcessor -> media/). MIA often shows
        a thumbnail linking to the full-size file (Brumaire pics/mairie.gif -> mairie2.gif): take the
        full-size one. Luxemburg's statistical tables are images, so dropping them loses content."""
        for img in body.find_all('img'):
            src = img.get('src')
            thumb_abs = urljoin(url, src) if src else None
            src_abs = thumb_abs
            parent_a = img.find_parent('a')
            if parent_a is not None and parent_a.get('href') and IMG_EXT.search(urlparse(urljoin(url, parent_a['href'])).path):
                src_abs = urljoin(url, parent_a['href'])
                parent_a.unwrap()
            data = self._image(src_abs, media)
            if data is None and thumb_abs and thumb_abs != src_abs:
                src_abs = thumb_abs          # full-size missing -> fall back to the thumbnail
                data = self._image(src_abs, media)
            if data is None:
                self.stats['images_dropped'] += 1
                img.decompose()
                continue
            self.stats['images_kept'] += 1
            for attr in ('width', 'height', 'border', 'align', 'hspace', 'vspace', 'style'):
                img.attrs.pop(attr, None)
            img['src'] = media[src_abs]['file']

    def _image(self, src_abs, media):
        if not src_abs:
            return None
        if src_abs in media:
            return media[src_abs]['data']
        ext = IMG_EXT.search(urlparse(src_abs).path)
        if not ext or not is_marxists_host(urlparse(src_abs).netloc) or len(media) >= MAX_IMAGES:
            return None
        data = self.fetcher.binary(src_abs)
        if data is None:
            return None
        media[src_abs] = {'file': f'images/i{len(media):03d}.{ext.group(1).lower()}', 'data': data, 'source_url': src_abs}
        return data

    # -- the whole work ------------------------------------------------------

    def build(self, url, dest_dir):
        self.progress('fetching_pages', 'Reading the contents page on marxists.org…', 4)
        meta, soup = self.metadata(url)
        index_url = meta['index_url']
        spine = self.build_spine(index_url, soup)
        page_map = {u: f'p{i:03d}.xhtml' for i, u in enumerate(spine)}

        chapters, pages, media = [], [], {}
        for i, page_url in enumerate(spine):
            html = self.fetcher.text(page_url)
            heading = BeautifulSoup(html, 'lxml').find(['h1', 'h2', 'h3'])
            title = text_of(heading) if heading is not None else page_url.rsplit('/', 1)[-1]
            chapters.append((page_map[page_url], title, self.clean_page(html, page_url, page_map, media)))
            pages.append({'file': page_map[page_url], 'source_url': page_url, 'title': title})
            self.progress('fetching_pages', f'Stitching page {i + 1} of {len(spine)}…', 28 + int(10 * (i + 1) / len(spine)))

        os.makedirs(dest_dir, exist_ok=True)
        epub_path = os.path.join(dest_dir, 'original.epub')
        with open(epub_path, 'wb') as fh:
            fh.write(pack_epub(meta, chapters, media))

        provenance = {
            'source': 'marxists.org',
            'index_url': index_url,
            'stitched_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'metadata': meta,
            'pages': pages,
            'images': [{'file': m['file'], 'source_url': m['source_url']} for m in media.values()],
            'crawl_log': self.log,
            'stats': self.stats,
            'requests': getattr(self.fetcher, 'requests', None),
        }
        with open(os.path.join(dest_dir, 'marxists_provenance.json'), 'w', encoding='utf-8') as fh:
            json.dump(provenance, fh, indent=2, ensure_ascii=False)

        return {'ok': True, 'epub': epub_path, 'pages': len(spine), 'images': len(media),
                'title': meta.get('title'), 'stats': self.stats, 'crawl_log': self.log}


def pack_epub(meta, chapters, media):
    """A real EPUB zip: `mimetype` first and stored, everything else deflated.

    @param chapters  [(filename, title, body html)] in reading order
    @param media     {source url: {'file': 'images/i000.gif', 'data': bytes}}
    """
    items, refs, navs = [], [], []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml',
                   '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
                   compress_type=zipfile.ZIP_DEFLATED)
        for i, (fn, title, body) in enumerate(chapters):
            # Through lxml once more so the XHTML is well-formed.
            frag = BeautifulSoup(body, 'lxml')
            inner = ''.join(str(c) for c in (frag.body or frag).contents)
            z.writestr(fn, XHTML.format(title=esc(title), body=inner), compress_type=zipfile.ZIP_DEFLATED)
            items.append(f'<item id="c{i}" href="{fn}" media-type="application/xhtml+xml"/>')
            refs.append(f'<itemref idref="c{i}"/>')
            navs.append(f'<navPoint id="n{i}" playOrder="{i + 1}"><navLabel><text>{esc(title)}</text></navLabel>'
                        f'<content src="{fn}"/></navPoint>')
        for j, m in enumerate(media.values()):
            z.writestr(m['file'], m['data'], compress_type=zipfile.ZIP_DEFLATED)
            media_type = MEDIA_TYPES.get(m['file'].rsplit('.', 1)[-1].lower(), 'application/octet-stream')
            items.append(f'<item id="img{j}" href="{m["file"]}" media-type="{media_type}"/>')
        title, author, source = esc(meta.get('title')), esc(meta.get('author')), esc(meta['index_url'])
        language = esc(meta.get('language') or 'en')
        z.writestr('content.opf', f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title><dc:creator>{author}</dc:creator><dc:identifier id="uid">{source}</dc:identifier><dc:source>{source}</dc:source><dc:language>{language}</dc:language></metadata>
 <manifest>{''.join(items)}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
 <spine toc="ncx">{''.join(refs)}</spine>
</package>''', compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('toc.ncx', f'''<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="{source}"/></head>
<docTitle><text>{title}</text></docTitle><navMap>{''.join(navs)}</navMap></ncx>''', compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


# ---------------------------------------------------------------- cli

def progress_writer(dest_dir):
    """Write the import's progress.json in the shape the PHP pipeline and the front-end poller use."""
    path = os.path.join(dest_dir, 'progress.json')

    def write(stage, detail, percent):
        try:
            os.makedirs(dest_dir, exist_ok=True)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump({'status': 'processing', 'stage': stage, 'percent': percent, 'detail': detail,
                           'updated_at': datetime.now(timezone.utc).isoformat()}, fh)
            os.replace(tmp, path)
        except OSError:
            pass  # progress is diagnostic; never fail the import over it

    return write


def public_metadata(meta):
    return {k: meta.get(k) for k in ('index_url', 'title', 'author', 'year', 'language', 'licence', 'note', 'info')}


def main(argv):
    if len(argv) < 3 or argv[1] not in ('metadata', 'build', 'list') or (argv[1] == 'build' and len(argv) < 4):
        print(__doc__, file=sys.stderr)
        return 1
    try:
        if argv[1] == 'list':
            print(json.dumps(Lister(NetworkFetcher()).list(argv[2]), ensure_ascii=False))
            return 0
        if argv[1] == 'metadata':
            meta, _ = Stitcher(NetworkFetcher()).metadata(argv[2])
            print(json.dumps({'ok': True, 'metadata': public_metadata(meta)}, ensure_ascii=False))
            return 0
        dest = argv[3]
        progress = progress_writer(dest) if '--progress' in argv[4:] else None
        print(json.dumps(Stitcher(NetworkFetcher(), progress).build(argv[2], dest), ensure_ascii=False))
        return 0
    except StitchRefusal as refusal:
        print(json.dumps({'ok': False, 'error': refusal.code, 'detail': refusal.detail}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))

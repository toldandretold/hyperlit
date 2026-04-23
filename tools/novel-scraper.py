#!/usr/bin/env python3
"""
Novel scraper backend for mydramanovel.com.
Serves a web UI and exposes API endpoints for fetching/parsing pages.

Usage:  python3 tools/novel-scraper.py
Open:   http://localhost:8008
"""

import html
import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8008
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(SCRIPT_DIR, "novel-scraper.html")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def fetch_url(url):
    """Fetch a URL and return the decoded HTML string."""
    # macOS Python often lacks system CA certs; skip verification for this local tool
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        data = resp.read()
        # Try to detect encoding from Content-Type header
        ct = resp.headers.get("Content-Type", "")
        charset = "utf-8"
        if "charset=" in ct:
            charset = ct.split("charset=")[-1].strip()
        return data.decode(charset, errors="replace")


def strip_tags(s):
    """Remove HTML tags from a string."""
    return re.sub(r"<[^>]+>", "", s)


def decode_entities(s):
    """Decode HTML entities."""
    return html.unescape(s)


def parse_chapter_list(page_html, source_url):
    """
    Parse a chapter-list page from mydramanovel.com.
    Returns (book_title, [{title, url}, ...]).
    """
    # Book title: <h1 ... class="...tdb-title-text..." ...>Title</h1>
    m = re.search(r'<h1[^>]*class="[^"]*tdb-title-text[^"]*"[^>]*>(.*?)</h1>', page_html, re.S)
    book_title = decode_entities(strip_tags(m.group(1))).strip() if m else "Untitled"

    # Chapter links: <h2|h3 class="entry-title td-module-title"><a href="...">Title</a>
    # Chapter 1 is often in an <h2>, the rest in <h3>
    pattern = (
        r'<h[23][^>]*class="[^"]*entry-title[^"]*td-module-title[^"]*"[^>]*>'
        r'\s*<a\s+href="([^"]+)"[^>]*>(.*?)</a>'
    )
    raw_chapters = re.findall(pattern, page_html, re.S)

    # Determine the book slug from the source URL to filter out unrelated "related posts"
    parsed = urllib.parse.urlparse(source_url)
    # e.g. /gui-luan/ -> gui-luan
    path_parts = [p for p in parsed.path.strip("/").split("/") if p]
    book_slug = path_parts[0] if path_parts else ""

    chapters = []
    seen_urls = set()
    for href, title_html in raw_chapters:
        title = decode_entities(strip_tags(title_html)).strip()
        # Make URL absolute if needed
        if not href.startswith("http"):
            href = urllib.parse.urljoin(source_url, href)
        # Filter: keep only links whose path starts with the same slug
        link_parsed = urllib.parse.urlparse(href)
        link_parts = [p for p in link_parsed.path.strip("/").split("/") if p]
        if book_slug and link_parts and link_parts[0] != book_slug:
            continue
        # Deduplicate
        if href in seen_urls:
            continue
        seen_urls.add(href)
        chapters.append({"title": title, "url": href})

    return book_title, chapters


def parse_chapter(page_html):
    """
    Parse a single chapter page from mydramanovel.com.
    Returns (chapter_title, [paragraph_text, ...]).
    """
    # Chapter title
    m = re.search(r'<h1[^>]*class="[^"]*tdb-title-text[^"]*"[^>]*>(.*?)</h1>', page_html, re.S)
    chapter_title = decode_entities(strip_tags(m.group(1))).strip() if m else "Untitled Chapter"

    # Content: find <div class="...tdb_single_content..."> ... </div> containing <p> tags
    # We grab the inner block first
    content_match = re.search(
        r'<div[^>]*class="[^"]*tdb_single_content[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</div>',
        page_html,
        re.S,
    )
    if not content_match:
        # Broader fallback: just find tdb_single_content and grab everything until a
        # closing pattern
        content_match = re.search(
            r'<div[^>]*class="[^"]*tdb_single_content[^"]*"[^>]*>(.*)',
            page_html,
            re.S,
        )

    paragraphs = []
    if content_match:
        content_html = content_match.group(1)
        # Extract all <p>...</p> blocks
        p_tags = re.findall(r"<p[^>]*>(.*?)</p>", content_html, re.S)
        for p in p_tags:
            text = decode_entities(strip_tags(p)).strip()
            if text:
                paragraphs.append(text)

    return chapter_title, paragraphs


class ScraperHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == "/" or path == "/index.html":
            self.serve_html()
        elif path == "/api/chapters":
            self.handle_chapters(params)
        elif path == "/api/chapter":
            self.handle_chapter(params)
        else:
            self.send_error(404, "Not Found")

    def serve_html(self):
        try:
            with open(HTML_FILE, "r", encoding="utf-8") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(content.encode("utf-8"))
        except FileNotFoundError:
            self.send_error(500, "novel-scraper.html not found")

    def handle_chapters(self, params):
        url = params.get("url", [None])[0]
        if not url:
            self.send_json(400, {"error": "Missing 'url' parameter"})
            return
        try:
            page_html = fetch_url(url)
            book_title, chapters = parse_chapter_list(page_html, url)
            self.send_json(200, {
                "title": book_title,
                "chapters": chapters,
            })
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def handle_chapter(self, params):
        url = params.get("url", [None])[0]
        if not url:
            self.send_json(400, {"error": "Missing 'url' parameter"})
            return
        try:
            page_html = fetch_url(url)
            chapter_title, paragraphs = parse_chapter(page_html)
            self.send_json(200, {
                "title": chapter_title,
                "paragraphs": paragraphs,
            })
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Slightly cleaner log output
        print(f"[server] {args[0]}")


def main():
    server = HTTPServer(("127.0.0.1", PORT), ScraperHandler)
    print(f"Novel scraper running at http://localhost:{PORT}")
    print("Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()

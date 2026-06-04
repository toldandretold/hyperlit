"""HTML sanitization + inner-HTML extraction.

Security plumbing extracted from process_document.py: bleach-based tag/attribute
allowlisting, dangerous-URL/protocol blocking, a fast pre-check that skips the
expensive parse for already-clean content, and block-aware inner-HTML extraction.
Unit-testable: feed hostile HTML, assert scripts/handlers/js-urls are stripped.
"""

import re
import bleach
from bs4 import BeautifulSoup

# --- SECURITY: HTML Sanitization ---

ALLOWED_TAGS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'a', 'em', 'strong', 'i', 'b', 'u', 'sub', 'sup', 'span', 'aside',
    'ul', 'ol', 'li', 'br', 'hr', 'img', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'figure', 'figcaption', 'cite', 'q', 'abbr', 'mark',
    'section', 'nav', 'article', 'header', 'footer', 'div',
    'latex', 'latex-block'
]

ALLOWED_ATTRS = {
    'a': ['href', 'title', 'target', 'id', 'class', 'fn-count-id', 'data-refs', 'data-page'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan'],
    'sup': ['id', 'class', 'fn-count-id'],
    '*': ['id', 'class', 'fn-count-id', 'data-node-id', 'data-math', 'data-chart']
}

# Dangerous URL patterns
DANGEROUS_URL_PATTERN = re.compile(r'^(javascript|vbscript|data|file):', re.IGNORECASE)

# Fast pre-check: skip expensive bleach parse when content is already clean
_ALLOWED_TAGS_SET = set(ALLOWED_TAGS)
_TAG_NAME_RE = re.compile(r'</?([a-zA-Z][a-zA-Z0-9-]*)')
_DANGEROUS_ATTR_RE = re.compile(r'\bon[a-z]+\s*=|javascript:|vbscript:|data:', re.IGNORECASE)


def _needs_sanitization(html_string):
    """Quick check: does this HTML contain anything bleach would change?"""
    # Check for dangerous attributes/URLs
    if _DANGEROUS_ATTR_RE.search(html_string):
        return True
    # Check for disallowed tags
    for m in _TAG_NAME_RE.finditer(html_string):
        if m.group(1).lower() not in _ALLOWED_TAGS_SET:
            return True
    return False




def sanitize_url(url):
    """Sanitize a URL to prevent XSS."""
    if not url:
        return url
    url = url.strip()
    if url.startswith('#'):
        return url
    if DANGEROUS_URL_PATTERN.match(url):
        return None
    return url


def sanitize_html(html_string):
    """Sanitize HTML to prevent XSS."""
    html_string = html_string.replace('\x00', '')  # Strip null bytes (invalid in PostgreSQL)
    # Fast path: skip expensive bleach parse when content only has allowed tags
    # and no dangerous patterns. Covers 99%+ of Pandoc output.
    if not _needs_sanitization(html_string):
        # Still need to check URLs if present
        if 'href=' not in html_string and 'src=' not in html_string:
            return html_string
    cleaned = bleach.clean(
        html_string,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        strip=True
    )
    # Only parse with BeautifulSoup if there are URLs to sanitize
    if 'href=' not in cleaned and 'src=' not in cleaned:
        return cleaned
    soup = BeautifulSoup(cleaned, 'html.parser')
    for elem in soup.find_all(href=True):
        safe_url = sanitize_url(elem['href'])
        if safe_url is None:
            del elem['href']
        else:
            elem['href'] = safe_url
    for elem in soup.find_all(src=True):
        safe_url = sanitize_url(elem['src'])
        if safe_url is None:
            if elem.name == 'img':
                elem.decompose()
            else:
                del elem['src']
        else:
            elem['src'] = safe_url
    return str(soup)


def get_element_html_content(element):
    """
    Extract HTML content from an element, preserving structure for tables etc.
    For block elements like tables, returns the full HTML.
    For text elements, returns inner HTML preserving inline formatting.
    """
    if element.name in ['table', 'pre', 'blockquote', 'ul', 'ol', 'figure', 'img']:
        # Preserve full HTML structure for block elements and images
        return str(element)
    else:
        # For p, div, li, etc. - get inner HTML (children)
        return ''.join(str(c) for c in element.children)



"""Phase 4 — final normalisation. Runs LAST in TRANSFORM_PIPELINE, after footnote detection +
conversion have settled. HeadingNormalizer closes heading-level GAPS (h1 -> h4 becomes h1 -> h2) on the
final set of real headings; DeadInternalLinkUnwrapper unwraps <a> links whose target no longer exists --
it MUST run after footnote conversion, because conversion is what creates the footnote anchor targets (run
it earlier and every footnote noteref looks 'dead' and gets unwrapped). One phase, one file."""
import os
import re
import time
import random
import string
import json
from bs4 import BeautifulSoup, NavigableString
import bleach
from ingestion.epub.epub_base import EpubTransform


class HeadingNormalizer(EpubTransform):
    """
    Normalizes heading hierarchy to eliminate gaps.

    For example, if a document has h1 -> h4 -> h4, this normalizes to h1 -> h2 -> h2.
    This helps with consistent document structure.
    """

    name = "HeadingNormalizer"
    description = "Normalize heading hierarchy (fix gaps like h1->h4)"

    def detect(self, soup) -> bool:
        return bool(soup.find(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']))

    def transform(self, soup, log) -> dict:
        body = soup.body if soup.body else soup
        headings = body.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

        if not headings:
            log("  No headings found")
            return {'changes': 0}

        current_level = 0
        changes = 0

        for heading in headings:
            original_level = int(heading.name[1])

            if original_level == 1:
                new_level = 1
                current_level = 1
            elif original_level <= current_level + 1:
                new_level = original_level
                current_level = max(current_level, original_level)
            else:
                new_level = current_level + 1
                current_level = new_level

            if original_level != new_level:
                heading.name = f'h{new_level}'
                changes += 1

        log(f"  Normalized {len(headings)} headings, {changes} changes")
        return {'total_headings': len(headings), 'changes': changes}


class DeadInternalLinkUnwrapper(EpubTransform):
    """
    Removes dead internal navigation links while preserving external links.

    After EPUB files are combined, internal chapter/page links often point
    to non-existent anchors. This unwraps those links (keeping text content)
    while preserving external URLs and valid internal references.
    """

    name = "DeadInternalLinkUnwrapper"
    description = "Remove dead internal links, keep external URLs"

    def detect(self, soup) -> bool:
        # Run if there are any internal links (fragments or relative file links)
        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            if href.startswith('#'):
                return True
            if href.endswith(('.html', '.xhtml', '.htm')):
                return True
            if '.html#' in href or '.xhtml#' in href:
                return True
        return False

    def transform(self, soup, log) -> dict:
        # Build set of all IDs in document
        all_ids = {elem.get('id') for elem in soup.find_all(id=True)}

        removed = 0
        kept_external = 0
        kept_valid = 0

        for a_tag in list(soup.find_all('a', href=True)):
            href = a_tag.get('href', '')

            # Keep external links
            if href.startswith(('http://', 'https://', 'mailto:')):
                kept_external += 1
                continue

            # Check fragment links
            if href.startswith('#'):
                target_id = href[1:]

                # Keep if target exists (includes footnote anchors)
                if target_id in all_ids:
                    kept_valid += 1
                    continue

                # Unwrap dead link (keep text content)
                a_tag.unwrap()
                removed += 1
                continue

            # Remove relative file links (e.g., chapter03.html, notes.html)
            # These are dead after EPUB files are combined
            if href.endswith(('.html', '.xhtml', '.htm')) or '.html#' in href or '.xhtml#' in href:
                a_tag.unwrap()
                removed += 1
                continue

        log(f"  Removed {removed} dead links, kept {kept_external} external, {kept_valid} valid internal")
        return {'removed': removed, 'kept_external': kept_external, 'kept_valid': kept_valid}


class TypographicUrlRepairer(EpubTransform):
    """Delete the sub-space characters a typesetter puts INSIDE a URL so a long link can wrap.

    Taylor & Francis percent-encodes thin spaces into the href on its EPUBs
    ("?ln%E2%80%89=%E2%80%89en") and prints them literally (U+2009) in the visible text. Either way
    the stored link is not a URL the server ever indexed, so the citation resolver cannot fetch the
    source and falls back to matching bibliographic metadata — which means the reviewer is handed a
    TITLE where the full text was freely available. Measured on the paste twin of the same article:
    22 of 34 reference URLs unusable, and Nkrumah's "Neo-Colonialism" judged on its title alone
    while the full text sat on marxists.org.

    Safe to delete rather than truncate at: a thin/hair/zero-width space is never valid inside a
    URL, so its presence is always this artifact. An ORDINARY space still ends a URL and is left
    alone. Prose typography elsewhere is untouched — only runs that are URLs are considered.
    """

    name = "TypographicUrlRepairer"
    description = "Strip thin/zero-width spaces from URLs (href and plain text)"

    # U+2008..U+200D, U+202F narrow no-break, U+2060 word joiner, U+FEFF ZWNBSP.
    _LITERAL_RE = re.compile('[\u2008-\u200d\u202f\u2060\ufeff]')
    _ENCODED_RE = re.compile('%E2%80%(?:8[89ABCD]|AF)|%E2%81%A0|%EF%BB%BF', re.I)
    # A URL run that CONTAINS at least one such character — so ordinary prose never matches.
    # ONE character class, no nested quantifier: the obvious form
    #   https?://[^\s<>"']*(?:[gap][^\s<>"']*)+
    # backtracks catastrophically on long text (it hung the JS twin's test worker). \s MATCHES a
    # thin space, so excluding only ASCII whitespace lets the run continue THROUGH the gaps in one
    # linear pass.
    _TEXT_URL_RE = re.compile(r'https?://[^ \t\r\n<>"\']*')

    def _clean(self, value):
        return self._ENCODED_RE.sub('', self._LITERAL_RE.sub('', value))

    def detect(self, soup) -> bool:
        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            if self._LITERAL_RE.search(href) or self._ENCODED_RE.search(href):
                return True
        text = soup.get_text()
        return bool('http' in text and self._TEXT_URL_RE.search(text))

    def transform(self, soup, log=print) -> dict:
        fixed = 0

        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            cleaned = self._clean(href)
            if cleaned != href:
                a_tag['href'] = cleaned
                fixed += 1

        # Plain-text URLs too: a bibliography often prints the link with no <a> at all, and the
        # spaces then sit in visible text where no href repair can reach them.
        for node in list(soup.find_all(string=True)):
            value = str(node)
            if 'http' not in value:
                continue
            if not (self._LITERAL_RE.search(value) or self._ENCODED_RE.search(value)):
                continue
            repaired = self._TEXT_URL_RE.sub(lambda m: self._clean(m.group(0)), value)
            if repaired != value:
                node.replace_with(repaired)
                fixed += 1

        if fixed:
            log(f"  Repaired {fixed} URL(s) containing typographic spaces")
        return {'repaired': fixed}

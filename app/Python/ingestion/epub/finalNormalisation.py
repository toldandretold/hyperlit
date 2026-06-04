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

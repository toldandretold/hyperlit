"""Phase 3 — bibliography section DETECTION (finds the references/bibliography section in
the raw EPUB HTML via epub:type, ARIA role, or heading text). NOTE: this only marks the
section; author-date citation LINKING + bibliography extraction proper happen centrally
in digestion/, not here."""
import os
import re
import time
import random
import string
import json
from bs4 import BeautifulSoup, NavigableString
import bleach
from ingestion.epub.epub_base import EpubTransform


class BibliographyDetector(EpubTransform):
    """
    Detects bibliography/references sections.

    Strategies:
    1. epub:type="bibliography" (EPUB3)
    2. role="doc-bibliography" (ARIA)
    3. Heading text matching "References", "Bibliography", etc.
    """

    name = "BibliographyDetector"
    description = "Detect bibliography/references sections"

    HEADER_PATTERNS = [
        'references', 'bibliography', 'works cited',
        'sources', 'literature cited', 'reference list'
    ]

    def detect(self, soup) -> bool:
        return True  # Always run

    def transform(self, soup, log) -> dict:
        sections = []

        # Strategy 1: EPUB3 semantic
        for elem in soup.find_all(attrs={'epub:type': re.compile(r'bibliography', re.I)}):
            sections.append({'element': elem, 'strategy': 'epub3_semantic'})
            log(f"  Found bibliography (epub:type)")

        # Strategy 2: ARIA role
        for elem in soup.find_all(attrs={'role': 'doc-bibliography'}):
            if elem not in [s['element'] for s in sections]:
                sections.append({'element': elem, 'strategy': 'aria_role'})
                log(f"  Found bibliography (role)")

        # Strategy 3: Header-based
        if not sections:
            for heading in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
                heading_text = heading.get_text(strip=True).lower()
                if heading_text in self.HEADER_PATTERNS:
                    sections.append({'element': heading, 'strategy': 'header_based'})
                    log(f"  Found bibliography header: '{heading_text}'")

        return {'bibliography_sections': sections}

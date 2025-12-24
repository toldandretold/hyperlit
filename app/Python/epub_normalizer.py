"""
EPUB Normalizer - Transform Pipeline Architecture
==================================================

THE PROBLEM:
EPUBs come from many sources (Calibre, Pandoc, InDesign, publishers, etc.) and each
produces wildly different HTML. There's no standard - just CSS that makes things
"look right" in readers. We need to extract semantic meaning from this chaos.

THE SOLUTION:
A pipeline of independent, composable transforms. Each transform:
1. DETECTS if a specific problem/pattern exists in this EPUB
2. TRANSFORMS the HTML to fix it (if detected)

This is NOT a "detect source → use module" system (like academic journal parsers)
because the same tool (e.g., Calibre) produces different output depending on input.
Instead, we detect FEATURES and apply relevant fixes compositionally.

ADDING NEW TRANSFORMS:
1. Create a new class inheriting from EpubTransform
2. Implement detect(soup) -> bool
3. Implement transform(soup, log_fn) -> None
4. Add it to TRANSFORM_PIPELINE in the order it should run
5. That's it - it won't affect other transforms

TRANSFORM ORDER MATTERS:
- Structural fixes (unwrapping fake containers) should run BEFORE content detection
- Content detection (footnotes, bibliography) runs on cleaned structure
- Final normalization (headings) runs last

CURRENT TRANSFORMS:
Phase 1 - Structural Fixes:
- CalibreBlockquoteUnwrapper: Fixes Calibre's <blockquote class="calibreN"> abuse
- CalibreSpanHeadingDetector: Converts <span class="calibre5/8"> font-sized spans to h1/h2
- EmptyElementRemover: Removes empty <div> and <p> spacers (Calibre uses for layout)
- SpanUnwrapper: Unwraps remaining <span class="calibreN"> styling wrappers
- CalibreClassStripper: Strips all calibreN classes from elements (clean output)
- DivToSemanticConverter: Converts divs with semantic class names to proper elements

Phase 2 - Footnote Detection:
- Epub3SemanticFootnoteDetector: Uses epub:type attributes (W3C standard)
- AriaRoleFootnoteDetector: Uses role="doc-footnote" etc.
- ClassPatternFootnoteDetector: Matches common CSS class patterns
- PandocFootnoteDetector: Handles <section class="footnotes"> structure
- HeuristicFootnoteDetector: Fallback based on ID patterns and superscripts

Phase 3 - Other Detection:
- BibliographyDetector: Finds reference/bibliography sections

Phase 4 - Final Normalization:
- HeadingNormalizer: Fixes heading hierarchy gaps (h1 -> h4 becomes h1 -> h2)

DEBUG OUTPUT:
Each transform logs when it fires and what it does. Check epub_normalizer_debug.txt
in the output directory to see which transforms ran.

Author: Built iteratively while importing problematic EPUBs
"""

import sys
import os
import re
import time
import random
import string
import json
from abc import ABC, abstractmethod
from ebooklib import epub, ITEM_DOCUMENT
from bs4 import BeautifulSoup
import bleach


# =============================================================================
# SECURITY: HTML Sanitization Config
# =============================================================================

ALLOWED_TAGS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'a', 'em', 'strong', 'i', 'b', 'u', 'sub', 'sup', 'span', 'aside',
    'ul', 'ol', 'li', 'br', 'hr', 'img', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'figure', 'figcaption', 'cite', 'q', 'abbr', 'mark',
    'section', 'nav', 'article', 'header', 'footer', 'div'
]

ALLOWED_ATTRS = {
    'a': ['href', 'title', 'id', 'class', 'epub:type', 'role', 'fn-count-id'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan'],
    'aside': ['epub:type', 'role', 'id', 'class'],
    'section': ['epub:type', 'role', 'id', 'class'],
    'sup': ['id', 'class', 'epub:type', 'fn-count-id'],
    '*': ['id', 'class', 'epub:type', 'role', 'fn-count-id']
}


def sanitize_html(html_string):
    """Sanitize HTML to prevent XSS from malicious EPUB content."""
    return bleach.clean(
        html_string,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        strip=True
    )


# =============================================================================
# BASE TRANSFORM CLASS
# =============================================================================

class EpubTransform(ABC):
    """
    Base class for all EPUB transforms.

    Each transform is self-contained and should:
    1. Detect if its specific pattern/problem exists
    2. Transform the HTML to fix it

    Transforms should be idempotent - running twice should be safe.
    """

    name = "BaseTransform"  # Override in subclass
    description = "Base transform class"  # Override in subclass

    @abstractmethod
    def detect(self, soup) -> bool:
        """
        Check if this transform should run on this EPUB.

        Args:
            soup: BeautifulSoup object of combined EPUB HTML

        Returns:
            True if transform should run, False otherwise
        """
        pass

    @abstractmethod
    def transform(self, soup, log) -> dict:
        """
        Apply the transform to the HTML.

        Args:
            soup: BeautifulSoup object (modified in place)
            log: Function to call for logging (log(message))

        Returns:
            Dict with any extracted data (e.g., footnotes found)
        """
        pass


# =============================================================================
# STRUCTURAL TRANSFORMS (Run first - fix container abuse)
# =============================================================================

class CalibreBlockquoteUnwrapper(EpubTransform):
    """
    Fixes Calibre's misuse of <blockquote> as a layout container.

    Calibre often wraps every paragraph in <blockquote class="calibreN">
    which is semantically wrong - these are just styled containers, not quotes.

    Detection: Looks for blockquotes with class matching "calibre" + digits
    Transform: Unwraps blockquotes that contain single <p> tags
    """

    name = "CalibreBlockquoteUnwrapper"
    description = "Unwrap Calibre's fake blockquote containers"

    def detect(self, soup) -> bool:
        return bool(soup.find('blockquote', class_=re.compile(r'^calibre\d*$')))

    def transform(self, soup, log) -> dict:
        blockquotes = soup.find_all('blockquote', class_=re.compile(r'^calibre\d*$'))
        count = len(blockquotes)

        for bq in blockquotes:
            children = [c for c in bq.children if hasattr(c, 'name') and c.name]
            if len(children) == 1 and children[0].name == 'p':
                bq.unwrap()
            elif len(children) == 0:
                bq.unwrap()
            else:
                bq.name = 'div'

        log(f"  Unwrapped {count} Calibre-style blockquotes")
        return {'unwrapped_count': count}


class CalibreSpanHeadingDetector(EpubTransform):
    """
    Detects headings styled via Calibre's span font-size and bold classes.

    Calibre uses spans with font-size CSS (not semantic markup) for headings:
    - calibre5: font-size: 1.66667em (main title, ~h1)
    - calibre8: font-size: 1.29167em (chapter/section titles, ~h2)
    - bold: font-weight: bold (subsection titles, ~h3)

    This transform finds <p><span class="calibreN">Text</span></p> patterns
    where the CSS indicates larger font = heading, and converts them.
    """

    name = "CalibreSpanHeadingDetector"
    description = "Convert Calibre font-sized spans to headings"

    # Known Calibre heading class patterns
    # font-size classes map to heading levels
    FONT_SIZE_HEADING_CLASSES = {
        'calibre5': 1,   # Typically main title (1.66667em)
        'calibre8': 2,   # Typically chapter/section titles (1.29167em)
    }

    # Bold-only spans are typically subsection headings (h3)
    BOLD_HEADING_CLASSES = ['bold']

    def detect(self, soup) -> bool:
        # Look for spans with calibreN or bold classes inside paragraphs
        for p in soup.find_all('p'):
            spans = p.find_all('span', class_=re.compile(r'^(calibre\d+|bold)$'))
            if spans:
                return True
        return False

    def _is_heading_candidate(self, p):
        """Check if paragraph contains only a single span child."""
        # Skip if paragraph has substantial text outside spans
        direct_text = ''.join(
            str(c) for c in p.children
            if isinstance(c, str) and c.strip()
        )
        if direct_text.strip():
            return None

        # Check for single span child (ignoring whitespace)
        children = [c for c in p.children if hasattr(c, 'name') and c.name]
        if len(children) != 1 or children[0].name != 'span':
            return None

        span = children[0]
        span_classes = span.get('class', [])
        if not span_classes:
            return None

        return span

    def transform(self, soup, log) -> dict:
        converted = 0
        body = soup.body if soup.body else soup

        # Find paragraphs that contain ONLY a span with heading class
        for p in list(body.find_all('p')):
            span = self._is_heading_candidate(p)
            if not span:
                continue

            span_classes = span.get('class', [])
            span_class = span_classes[0] if isinstance(span_classes, list) else span_classes

            level = None

            # Check font-size heading classes first (h1, h2)
            if span_class in self.FONT_SIZE_HEADING_CLASSES:
                level = self.FONT_SIZE_HEADING_CLASSES[span_class]
            # Check bold heading class (h3)
            elif span_class in self.BOLD_HEADING_CLASSES:
                level = 3

            if level:
                text = span.get_text(strip=True)
                if text and len(text) < 200:  # Headings shouldn't be too long
                    # Skip figure/table captions - they look like headings but aren't
                    # Matches: "Figure 1", "Figure P.1", "Figure I.1", "Table 2.3"
                    if re.match(r'^Figure\s+[A-Z0-9]', text, re.I):
                        continue
                    if re.match(r'^Table\s+[A-Z0-9]', text, re.I):
                        continue

                    # Convert p to heading, unwrap span
                    preserved_id = p.get('id') or span.get('id')
                    p.name = f'h{level}'
                    p.attrs = {}
                    if preserved_id:
                        p['id'] = preserved_id
                    span.unwrap()
                    converted += 1
                    log(f"    Converted to h{level}: '{text[:50]}{'...' if len(text) > 50 else ''}'")

        log(f"  Converted {converted} Calibre-styled spans to headings")
        return {'converted': converted}


class EmptyElementRemover(EpubTransform):
    """
    Removes empty divs and other meaningless structural elements.

    Calibre inserts empty divs for spacing (e.g., <div class="calibre6"> </div>).
    These should be removed as they add no semantic value.
    """

    name = "EmptyElementRemover"
    description = "Remove empty divs and spacing elements"

    def detect(self, soup) -> bool:
        return True  # Always run

    def transform(self, soup, log) -> dict:
        removed = 0
        body = soup.body if soup.body else soup

        # Remove empty divs (with only whitespace or &nbsp;)
        for div in list(body.find_all('div')):
            text = div.get_text(strip=True)
            # Empty or only contains non-breaking space
            if not text or text in ['\xa0', ' ', '']:
                # Don't remove if it has child elements
                children = [c for c in div.children if hasattr(c, 'name') and c.name]
                if not children:
                    div.decompose()
                    removed += 1

        # Also remove empty paragraphs
        for p in list(body.find_all('p')):
            text = p.get_text(strip=True)
            if not text or text in ['\xa0', ' ', '']:
                children = [c for c in p.children if hasattr(c, 'name') and c.name]
                if not children:
                    p.decompose()
                    removed += 1

        log(f"  Removed {removed} empty elements")
        return {'removed': removed}


class SpanUnwrapper(EpubTransform):
    """
    Unwraps meaningless spans that only add styling classes.

    After other transforms run, we may have leftover <span class="calibreN">
    wrappers that serve no semantic purpose. This unwraps them.

    Preserves spans with: id, href, epub:type, role, or semantic classes
    """

    name = "SpanUnwrapper"
    description = "Unwrap meaningless styling-only spans"

    # Classes that indicate the span has meaning
    SEMANTIC_CLASSES = ['footnote', 'endnote', 'noteref', 'citation', 'ref']

    def detect(self, soup) -> bool:
        return bool(soup.find('span', class_=re.compile(r'^calibre\d+$')))

    def transform(self, soup, log) -> dict:
        unwrapped = 0
        body = soup.body if soup.body else soup

        for span in list(body.find_all('span')):
            classes = span.get('class', [])
            class_str = ' '.join(classes).lower() if classes else ''

            # Keep spans with semantic attributes
            if span.get('id') or span.get('epub:type') or span.get('role'):
                continue

            # Keep spans with semantic classes
            if any(sc in class_str for sc in self.SEMANTIC_CLASSES):
                continue

            # Unwrap calibre-only styled spans
            if re.match(r'^calibre\d*$', class_str) or not classes:
                span.unwrap()
                unwrapped += 1

        log(f"  Unwrapped {unwrapped} styling-only spans")
        return {'unwrapped': unwrapped}


class CalibreClassStripper(EpubTransform):
    """
    Strips Calibre styling classes from all elements.

    Calibre adds classes like "calibre10", "calibre16" etc. to paragraphs
    and other elements purely for CSS styling. These are meaningless after
    extraction and should be removed for clean output.

    Preserves: id, epub:type, role attributes
    Removes: class attributes that are calibre-only
    """

    name = "CalibreClassStripper"
    description = "Strip Calibre styling classes from elements"

    # Classes worth preserving (semantic meaning)
    SEMANTIC_CLASSES = [
        'footnote', 'endnote', 'noteref', 'citation', 'ref',
        'bibliography', 'toc', 'chapter', 'section', 'epigraph',
        'blockquote', 'pullquote', 'sidebar'
    ]

    def detect(self, soup) -> bool:
        return bool(soup.find(class_=re.compile(r'^calibre\d+$')))

    def transform(self, soup, log) -> dict:
        stripped = 0
        body = soup.body if soup.body else soup

        for elem in body.find_all(class_=True):
            classes = elem.get('class', [])
            if not classes:
                continue

            # Check if any class is worth keeping
            class_str = ' '.join(classes).lower()
            has_semantic = any(sc in class_str for sc in self.SEMANTIC_CLASSES)

            if has_semantic:
                # Keep only semantic classes
                new_classes = [c for c in classes
                               if any(sc in c.lower() for sc in self.SEMANTIC_CLASSES)]
                if new_classes:
                    elem['class'] = new_classes
                else:
                    del elem['class']
                    stripped += 1
            else:
                # All classes are styling-only, remove them
                if all(re.match(r'^calibre\d*$', c) for c in classes):
                    del elem['class']
                    stripped += 1

        log(f"  Stripped classes from {stripped} elements")
        return {'stripped': stripped}


class DivToSemanticConverter(EpubTransform):
    """
    Converts divs with semantic class names to proper HTML elements.

    Many EPUBs use <div class="heading1"> instead of <h1>.
    This converts them based on class patterns.
    """

    name = "DivToSemanticConverter"
    description = "Convert styled divs to semantic HTML (headings, blockquotes)"

    def detect(self, soup) -> bool:
        # Always run - it's a cleanup pass
        return True

    def transform(self, soup, log) -> dict:
        changes = {'headings': 0, 'blockquotes': 0, 'paragraphs': 0}
        body = soup.body if soup.body else soup

        # Pass 1: Divs to headings
        for div in body.find_all('div'):
            class_str = ' '.join(div.get('class', [])).lower()
            if 'heading' in class_str or 'title' in class_str:
                level = 1
                match = re.search(r'[h_s]?(?P<level>\d+)', class_str)
                if match:
                    level = int(match.group('level'))
                    level = max(1, min(6, level))
                div.name = f'h{level}'
                preserved_id = div.get('id')
                div.attrs = {}
                if preserved_id:
                    div['id'] = preserved_id
                changes['headings'] += 1

        # Pass 2: Divs to blockquotes (conservative - only explicit quote classes)
        for div in body.find_all('div'):
            class_str = ' '.join(div.get('class', [])).lower()
            if any(x in class_str for x in ['blockquote', 'epigraph', 'pullquote', 'extract']):
                if not re.search(r'calibre\d*', class_str):
                    div.name = 'blockquote'
                    preserved_id = div.get('id')
                    div.attrs = {}
                    if preserved_id:
                        div['id'] = preserved_id
                    changes['blockquotes'] += 1

        # Pass 3: Remaining divs with text to paragraphs
        for div in body.find_all('div'):
            text = div.get_text(strip=True)
            if text and len(text) > 0:
                has_block = div.find(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                                      'ul', 'ol', 'table', 'blockquote', 'pre'])
                if not has_block:
                    div.name = 'p'
                    preserved_id = div.get('id')
                    div.attrs = {}
                    if preserved_id:
                        div['id'] = preserved_id
                    changes['paragraphs'] += 1

        # Pass 4: Unwrap nested paragraphs
        for _ in range(3):
            for p in body.find_all('p'):
                if p.parent and p.parent.name == 'p':
                    p.parent.unwrap()

        if any(changes.values()):
            log(f"  Converted: {changes['headings']} headings, {changes['blockquotes']} blockquotes, {changes['paragraphs']} paragraphs")

        return changes


# =============================================================================
# FOOTNOTE DETECTION TRANSFORMS (Run after structural fixes)
# =============================================================================

class Epub3SemanticFootnoteDetector(EpubTransform):
    """
    Detects footnotes using EPUB3 epub:type semantic attributes.

    This is the W3C standard way - most reliable when present.
    Looks for epub:type="footnote", epub:type="endnote", epub:type="noteref"

    Reference: https://www.w3.org/TR/epub-ssv-11/
    """

    name = "Epub3SemanticFootnoteDetector"
    description = "Detect footnotes via epub:type attributes (W3C EPUB3 spec)"

    def detect(self, soup) -> bool:
        return bool(soup.find(attrs={'epub:type': True}))

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []

        for elem in soup.find_all(attrs={'epub:type': True}):
            epub_type = elem.get('epub:type', '').lower()

            # Footnote/endnote definitions
            if any(t in epub_type for t in ['footnote', 'endnote', 'note']) and 'noteref' not in epub_type:
                elem_id = elem.get('id', '')
                if elem_id:
                    footnotes.append({
                        'id': elem_id,
                        'element': elem,
                        'type': 'endnote' if 'endnote' in epub_type else 'footnote',
                        'strategy': 'epub3_semantic'
                    })
                    log(f"    Found {footnotes[-1]['type']} (epub:type): id={elem_id}")

            # Note references
            elif 'noteref' in epub_type:
                href = elem.get('href', '')
                if href.startswith('#'):
                    noterefs.append({
                        'element': elem,
                        'target_id': href[1:],
                        'strategy': 'epub3_semantic'
                    })

        return {'footnotes': footnotes, 'noterefs': noterefs}


class AriaRoleFootnoteDetector(EpubTransform):
    """
    Detects footnotes using ARIA role attributes.

    Looks for role="doc-footnote", role="doc-endnote", role="doc-noteref"
    """

    name = "AriaRoleFootnoteDetector"
    description = "Detect footnotes via ARIA role attributes"

    def detect(self, soup) -> bool:
        return bool(soup.find(attrs={'role': re.compile(r'^doc-(foot|end)?note')}))

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []

        for elem in soup.find_all(attrs={'role': True}):
            role = elem.get('role', '').lower()

            if role in ['doc-footnote', 'doc-endnote']:
                elem_id = elem.get('id', '')
                if elem_id:
                    footnotes.append({
                        'id': elem_id,
                        'element': elem,
                        'type': 'endnote' if 'endnote' in role else 'footnote',
                        'strategy': 'aria_role'
                    })
                    log(f"    Found {footnotes[-1]['type']} (role): id={elem_id}")

            elif role == 'doc-noteref':
                href = elem.get('href', '')
                if href.startswith('#'):
                    noterefs.append({
                        'element': elem,
                        'target_id': href[1:],
                        'strategy': 'aria_role'
                    })

        return {'footnotes': footnotes, 'noterefs': noterefs}


class ClassPatternFootnoteDetector(EpubTransform):
    """
    Detects footnotes by CSS class name patterns.

    Looks for classes like "footnote", "endnote", "fn1", "noteref", etc.
    """

    name = "ClassPatternFootnoteDetector"
    description = "Detect footnotes via CSS class patterns"

    FOOTNOTE_PATTERNS = [
        r'\bfootnote\b', r'\bfoot-note\b', r'\bfn\d*\b',
        r'\bendnote\b', r'\bend-note\b', r'\ben\d*\b',
        r'\bnote\b', r'\bannotation\b'
    ]

    NOTEREF_PATTERNS = [
        r'\bnoteref\b', r'\bfootnote-ref\b', r'\bfnref\b',
        r'\bendnoteref\b', r'\bendnote-ref\b'
    ]

    def detect(self, soup) -> bool:
        for elem in soup.find_all(['aside', 'div', 'section', 'p', 'li', 'a']):
            class_str = ' '.join(elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.FOOTNOTE_PATTERNS + self.NOTEREF_PATTERNS):
                return True
        return False

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []

        for elem in soup.find_all(['aside', 'div', 'section', 'p', 'li']):
            class_str = ' '.join(elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.FOOTNOTE_PATTERNS):
                elem_id = elem.get('id', '')
                if elem_id:
                    footnotes.append({
                        'id': elem_id,
                        'element': elem,
                        'type': 'footnote',
                        'strategy': 'class_pattern'
                    })
                    log(f"    Found footnote (class): id={elem_id}")

        for elem in soup.find_all('a'):
            class_str = ' '.join(elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.NOTEREF_PATTERNS):
                href = elem.get('href', '')
                if href.startswith('#'):
                    noterefs.append({
                        'element': elem,
                        'target_id': href[1:],
                        'strategy': 'class_pattern'
                    })

        return {'footnotes': footnotes, 'noterefs': noterefs}


class PandocFootnoteDetector(EpubTransform):
    """
    Detects Pandoc-style footnotes.

    Pandoc generates a <section class="footnotes"> or <div class="footnotes">
    containing an ordered list of footnotes.
    """

    name = "PandocFootnoteDetector"
    description = "Detect Pandoc-style footnotes section"

    def detect(self, soup) -> bool:
        return bool(
            soup.find('section', class_='footnotes') or
            soup.find('div', class_='footnotes')
        )

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []

        fn_section = soup.find('section', class_='footnotes')
        if not fn_section:
            fn_section = soup.find('div', class_='footnotes')

        if fn_section:
            for li in fn_section.find_all('li'):
                li_id = li.get('id', '')
                if li_id:
                    footnotes.append({
                        'id': li_id,
                        'element': li,
                        'type': 'footnote',
                        'strategy': 'pandoc'
                    })
                    log(f"    Found footnote (Pandoc): id={li_id}")

        # Find matching references
        for a_tag in soup.find_all('a', href=re.compile(r'^#fn')):
            href = a_tag.get('href', '')
            if href.startswith('#'):
                target_id = href[1:]
                if any(fn['id'] == target_id for fn in footnotes):
                    noterefs.append({
                        'element': a_tag,
                        'target_id': target_id,
                        'strategy': 'pandoc'
                    })

        return {'footnotes': footnotes, 'noterefs': noterefs}


class HeuristicFootnoteDetector(EpubTransform):
    """
    Fallback heuristic footnote detection.

    Uses patterns when no semantic markup is present:
    - Superscript links to anchors (<sup><a>) or links containing superscripts (<a><sup>)
    - Links with small numeric text (likely footnote refs)
    - Elements with IDs matching footnote patterns (fn1, en0001en, filepos*, etc.)
    - Paragraphs starting with numbered anchors (endnote definitions)
    """

    name = "HeuristicFootnoteDetector"
    description = "Fallback heuristic footnote detection"

    ID_PATTERNS = [
        r'^fn\d+$', r'^footnote\d+$', r'^note\d+$',
        r'^en\d+$', r'^endnote\d+$',
        r'^fn:\d+$', r'^footnote-\d+$',
        r'^en\d+en$', r'^fn\d+fn$',  # Publisher patterns like en0001en
        r'^filepos\d+$',  # Calibre file position anchors
    ]

    def detect(self, soup) -> bool:
        # Always run as fallback
        return True

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []
        seen_ref_ids = set()
        seen_fn_ids = set()

        # Pattern 1a: <sup><a href="#..."> - superscript containing link
        for sup in soup.find_all('sup'):
            a_tag = sup.find('a')
            if a_tag:
                href = a_tag.get('href', '')
                target_id = self._extract_target_id(href)
                if target_id and target_id not in seen_ref_ids:
                    seen_ref_ids.add(target_id)
                    noterefs.append({
                        'element': sup,
                        'target_id': target_id,
                        'strategy': 'heuristic_sup_a'
                    })

        # Pattern 1b: <a><sup> - link containing superscript (Calibre pattern)
        for a_tag in soup.find_all('a'):
            sup = a_tag.find('sup')
            if sup:
                href = a_tag.get('href', '')
                target_id = self._extract_target_id(href)
                if target_id and target_id not in seen_ref_ids:
                    seen_ref_ids.add(target_id)
                    # Use the <a> as the element since it wraps the sup
                    noterefs.append({
                        'element': a_tag,
                        'target_id': target_id,
                        'strategy': 'heuristic_a_sup'
                    })

        # Pattern 2: ID-based detection for footnote definitions
        for elem in soup.find_all(['p', 'div', 'li', 'aside', 'section', 'blockquote']):
            elem_id = elem.get('id', '')
            if elem_id and elem_id not in seen_fn_ids:
                if any(re.match(p, elem_id, re.I) for p in self.ID_PATTERNS):
                    seen_fn_ids.add(elem_id)
                    footnotes.append({
                        'id': elem_id,
                        'element': elem,
                        'type': 'footnote',
                        'strategy': 'heuristic_id'
                    })
                    log(f"    Found footnote def (heuristic id): id={elem_id}")

        # Pattern 3: Paragraphs/blockquotes that ARE footnote definitions
        # Calibre endnote pattern: <p><span><a id="filepos...">1</a>. Content here...</span></p>
        # Key distinction: The footnote NUMBER appears at the START of the element
        # followed by a period and the actual footnote text.
        for elem in soup.find_all(['p', 'blockquote']):
            # Get the text content to check if it starts with a number and period
            elem_text = elem.get_text(strip=True)

            # Check if text starts with "N. " or "N " pattern (footnote definition)
            match = re.match(r'^(\d+)[.\s]', elem_text)
            if not match:
                continue

            fn_num = match.group(1)

            # Now look for the anchor with matching number
            first_a = None
            for child in elem.descendants:
                if hasattr(child, 'name') and child.name == 'a':
                    if child.get_text(strip=True) == fn_num:
                        first_a = child
                        break

            if first_a and first_a.get('id'):
                a_id = first_a.get('id')
                if a_id not in seen_fn_ids:
                    # Additional check: the anchor should have a back-link href
                    # (points back to the in-text reference)
                    has_backlink = first_a.get('href', '').strip() != ''

                    if has_backlink and any(re.match(p, a_id, re.I) for p in self.ID_PATTERNS):
                        seen_fn_ids.add(a_id)
                        footnotes.append({
                            'id': a_id,
                            'element': elem,
                            'type': 'endnote',
                            'strategy': 'heuristic_numbered_anchor'
                        })
                        log(f"    Found endnote def: id={a_id}, num={fn_num}")

        log(f"    Total: {len(footnotes)} definitions, {len(noterefs)} references")
        return {'footnotes': footnotes, 'noterefs': noterefs}

    def _extract_target_id(self, href):
        """Extract target ID from href, handling cross-file links."""
        if not href:
            return None

        # Handle #target (same file)
        if href.startswith('#'):
            return href[1:]

        # Handle file.html#target (cross-file) - extract just the anchor
        if '#' in href:
            return href.split('#')[-1]

        return None


# =============================================================================
# BIBLIOGRAPHY DETECTION
# =============================================================================

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


# =============================================================================
# FINAL NORMALIZATION TRANSFORMS (Run last)
# =============================================================================

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


# =============================================================================
# FOOTNOTE CONVERSION (Converts detected footnotes to Hyperlit format)
# =============================================================================

class FootnoteConverter(EpubTransform):
    """
    Converts detected footnotes to Hyperlit's canonical format.

    This runs AFTER all footnote detectors and converts the accumulated
    footnotes/noterefs to the format expected by Hyperlit:

    In-text reference:
        <sup fn-count-id="1" id="{bookId}_Fn{timestamp}_{random}">
            <a class="footnote-ref" href="#{footnoteId}">1</a>
        </sup>

    Footnote definition (stored in footnotes.json):
        {
            "footnoteId": "{bookId}_Fn{timestamp}_{random}",
            "content": "<a fn-count-id=\"1\" id=\"...\"></a><p>Content...</p>"
        }

    This transform modifies the HTML in-place and builds the footnotes_json
    data structure for later output.
    """

    name = "FootnoteConverter"
    description = "Convert footnotes to Hyperlit format"

    def __init__(self):
        self.book_id = None
        self.footnotes_json = []

    def detect(self, soup) -> bool:
        # This is run manually after pipeline, not auto-detected
        return False

    def convert(self, soup, all_footnotes, all_noterefs, book_id, log) -> dict:
        """
        Convert footnotes to Hyperlit format.

        Args:
            soup: BeautifulSoup object
            all_footnotes: List of detected footnote definitions
            all_noterefs: List of detected note references
            book_id: Book identifier for generating unique IDs
            log: Logging function

        Returns:
            dict with footnotes_json data
        """
        self.book_id = book_id
        self.footnotes_json = []

        if not all_footnotes and not all_noterefs:
            log("  No footnotes to convert")
            return {'footnotes_json': []}

        log(f"  Converting {len(all_footnotes)} footnotes, {len(all_noterefs)} references")

        # Build mapping from old IDs to new Hyperlit IDs
        # Also extract footnote content
        id_mapping = {}  # old_id -> {new_id, count, content}
        count = 1

        for fn in all_footnotes:
            old_id = fn.get('id', '')
            if not old_id:
                continue

            # Generate new Hyperlit-style ID
            timestamp = int(time.time() * 1000)
            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
            new_id = f"{book_id}_Fn{timestamp}_{random_suffix}"

            # Extract content from the footnote element
            elem = fn.get('element')
            if elem:
                # Get the content - might be the element itself or its children
                content_html = self._extract_footnote_content(elem, old_id)
            else:
                content_html = ""

            id_mapping[old_id] = {
                'new_id': new_id,
                'count': count,
                'content': content_html,
                'element': elem
            }
            count += 1

        # Now convert in-text references (noterefs)
        converted_refs = 0
        for noteref in all_noterefs:
            target_id = noteref.get('target_id', '')
            elem = noteref.get('element')

            if not target_id or not elem:
                continue

            # Find the mapping for this target
            if target_id in id_mapping:
                mapping = id_mapping[target_id]
                new_id = mapping['new_id']
                fn_count = mapping['count']

                # Convert the element to Hyperlit format
                self._convert_noteref_element(elem, new_id, fn_count, soup)
                converted_refs += 1

        log(f"  Converted {converted_refs} in-text references")

        # Build footnotes.json data
        for old_id, mapping in id_mapping.items():
            new_id = mapping['new_id']
            fn_count = mapping['count']
            content = mapping['content']

            # Format content with anchor tag
            anchor_html = f'<a fn-count-id="{fn_count}" id="{new_id}"></a>'
            full_content = anchor_html + content

            self.footnotes_json.append({
                'footnoteId': new_id,
                'content': full_content
            })

            # Update the original footnote definition element if it exists
            elem = mapping.get('element')
            if elem:
                self._update_footnote_definition(elem, new_id, fn_count)

        log(f"  Generated {len(self.footnotes_json)} footnote entries for JSON")

        return {'footnotes_json': self.footnotes_json, 'id_mapping': id_mapping}

    def _extract_footnote_content(self, elem, old_id):
        """Extract the content of a footnote definition."""
        # Clone the element to avoid modifying the original during extraction
        from copy import copy

        # Get inner HTML, excluding any back-links
        content_parts = []
        for child in elem.children:
            if hasattr(child, 'name'):
                # Skip back-links (links pointing back to the reference)
                if child.name == 'a':
                    href = child.get('href', '')
                    # Skip if it's a back-reference link
                    if 'backlink' in child.get('class', []) or \
                       child.get('epub:type', '') == 'backlink' or \
                       child.get('role', '') == 'doc-backlink':
                        continue
                content_parts.append(str(child))
            else:
                # Text node
                text = str(child).strip()
                if text:
                    content_parts.append(text)

        content = ''.join(content_parts).strip()

        # If content is empty, use the whole element
        if not content:
            content = elem.decode_contents()

        # Wrap in <p> if not already wrapped in a block element
        if content and not content.startswith('<p') and not content.startswith('<div'):
            content = f'<p>{content}</p>'

        return content

    def _convert_noteref_element(self, elem, new_id, fn_count, soup):
        """Convert an in-text note reference to Hyperlit format."""
        # The element might be a <sup>, <a>, or something else
        # We need to create: <sup fn-count-id="N" id="ID"><a class="footnote-ref" href="#ID">N</a></sup>

        if elem.name == 'sup':
            # Already a sup, just update attributes
            elem['fn-count-id'] = str(fn_count)
            elem['id'] = new_id

            # Find or create the inner <a>
            a_tag = elem.find('a')
            if a_tag:
                a_tag['class'] = 'footnote-ref'
                a_tag['href'] = f'#{new_id}'
                a_tag.string = str(fn_count)
            else:
                # Create new <a> tag
                new_a = soup.new_tag('a')
                new_a['class'] = 'footnote-ref'
                new_a['href'] = f'#{new_id}'
                new_a.string = str(fn_count)
                elem.clear()
                elem.append(new_a)

        elif elem.name == 'a':
            # It's an <a> (possibly containing a <sup>), convert to proper format
            # First, check if it has a <sup> child (Calibre pattern: <a><sup>)
            inner_sup = elem.find('sup')

            if inner_sup:
                # Move the <sup> out and wrap it properly
                # Create new sup with proper attributes
                new_sup = soup.new_tag('sup')
                new_sup['fn-count-id'] = str(fn_count)
                new_sup['id'] = new_id

                # Create new inner <a>
                new_a = soup.new_tag('a')
                new_a['class'] = 'footnote-ref'
                new_a['href'] = f'#{new_id}'
                new_a.string = str(fn_count)
                new_sup.append(new_a)

                # Replace the original <a> with the new structure
                elem.replace_with(new_sup)
            else:
                # Just an <a>, wrap it in <sup>
                new_sup = soup.new_tag('sup')
                new_sup['fn-count-id'] = str(fn_count)
                new_sup['id'] = new_id

                elem['class'] = 'footnote-ref'
                elem['href'] = f'#{new_id}'
                elem.string = str(fn_count)

                elem.replace_with(new_sup)
                new_sup.append(elem)

    def _update_footnote_definition(self, elem, new_id, fn_count):
        """Update the footnote definition element with new ID."""
        # Add/update the ID on the element
        elem['id'] = new_id
        elem['fn-count-id'] = str(fn_count)

    def transform(self, soup, log) -> dict:
        # This method exists for interface compatibility but
        # the actual work is done by convert() which takes more params
        return {'footnotes_json': []}


# =============================================================================
# TRANSFORM PIPELINE CONFIGURATION
# =============================================================================

# Order matters! Structural fixes first, then detection, then normalization
TRANSFORM_PIPELINE = [
    # Phase 1: Structural fixes (fix container abuse, unwrap fake elements)
    CalibreBlockquoteUnwrapper(),      # Unwrap <blockquote class="calibreN">
    CalibreSpanHeadingDetector(),      # Convert <span class="calibre5/8"> to headings
    EmptyElementRemover(),              # Remove empty <div> and <p> spacers
    SpanUnwrapper(),                    # Unwrap remaining styling-only spans
    CalibreClassStripper(),             # Strip calibreN classes from all elements
    DivToSemanticConverter(),           # Convert semantic class divs to proper elements

    # Phase 2: Footnote detection (multiple strategies, results accumulate)
    Epub3SemanticFootnoteDetector(),
    AriaRoleFootnoteDetector(),
    ClassPatternFootnoteDetector(),
    PandocFootnoteDetector(),
    HeuristicFootnoteDetector(),

    # Phase 3: Other content detection
    BibliographyDetector(),

    # Phase 4: Final normalization
    HeadingNormalizer(),
]


# =============================================================================
# MAIN NORMALIZER CLASS
# =============================================================================

class EpubNormalizer:
    """
    Main EPUB normalizer that runs the transform pipeline.

    Handles both:
    - Extracted EPUB directories (epub_original/)
    - Direct .epub files (using EbookLib)
    """

    def __init__(self, input_path, output_dir, book_id=None):
        self.input_path = input_path
        self.output_dir = output_dir
        self.book_id = book_id or f"book_{int(time.time())}"
        self.is_directory = os.path.isdir(input_path)
        self.combined_soup = None
        self.debug_log = None
        self.results = {}  # Accumulated results from all transforms

    def process(self):
        """Run the full normalization pipeline."""
        debug_log_path = os.path.join(self.output_dir, 'epub_normalizer_debug.txt')

        with open(debug_log_path, 'w', encoding='utf-8') as debug_log:
            self.debug_log = debug_log
            self._log("=" * 70)
            self._log("EPUB NORMALIZER - Transform Pipeline")
            self._log("=" * 70)
            self._log(f"Input: {self.input_path}")
            self._log(f"Output: {self.output_dir}")
            self._log(f"Book ID: {self.book_id}")
            self._log(f"Mode: {'Extracted directory' if self.is_directory else '.epub file'}")
            self._log("")

            try:
                # Step 1: Load and combine EPUB content
                self._log("--- Loading EPUB Content ---")
                if self.is_directory:
                    self._load_from_directory()
                else:
                    self._load_from_epub_file()

                # Step 2: Run transform pipeline
                self._log("\n--- Running Transform Pipeline ---")
                self._run_pipeline()

                # Step 3: Convert footnotes to Hyperlit format
                self._log("\n--- Converting Footnotes ---")
                self._convert_footnotes()

                # Step 4: Sanitize for security
                self._log("\n--- Sanitizing HTML ---")
                final_html = str(self.combined_soup)
                sanitized_html = sanitize_html(final_html)
                self._log(f"Sanitized: {len(final_html)} -> {len(sanitized_html)} chars")

                # Step 5: Write output
                self._log("\n--- Writing Output ---")
                output_file = os.path.join(self.output_dir, 'main-text.html')
                with open(output_file, 'w', encoding='utf-8') as f:
                    f.write(sanitized_html)
                self._log(f"Output: {output_file}")

                # Step 6: Write footnotes.json
                self._write_footnotes_json()

                # Summary
                self._log("\n" + "=" * 70)
                self._log("COMPLETE")
                self._log("=" * 70)
                self._log_summary()

            except Exception as e:
                self._log(f"\n--- ERROR ---\n{str(e)}")
                import traceback
                self._log(traceback.format_exc())
                raise

    def _log(self, message):
        """Log to both console and debug file."""
        print(message)
        if self.debug_log:
            self.debug_log.write(message + "\n")

    def _run_pipeline(self):
        """Run all transforms in the pipeline."""
        all_footnotes = []
        all_noterefs = []

        for transform in TRANSFORM_PIPELINE:
            if transform.detect(self.combined_soup):
                self._log(f"\n[{transform.name}]")
                result = transform.transform(self.combined_soup, self._log)

                # Accumulate footnotes from all detectors
                if 'footnotes' in result:
                    # Deduplicate by ID
                    for fn in result['footnotes']:
                        if not any(existing['id'] == fn['id'] for existing in all_footnotes):
                            all_footnotes.append(fn)

                if 'noterefs' in result:
                    all_noterefs.extend(result['noterefs'])

                # Store other results
                self.results[transform.name] = result

        self.results['all_footnotes'] = all_footnotes
        self.results['all_noterefs'] = all_noterefs

    def _convert_footnotes(self):
        """Convert detected footnotes to Hyperlit format."""
        all_footnotes = self.results.get('all_footnotes', [])
        all_noterefs = self.results.get('all_noterefs', [])

        converter = FootnoteConverter()
        result = converter.convert(
            self.combined_soup,
            all_footnotes,
            all_noterefs,
            self.book_id,
            self._log
        )

        self.results['footnotes_json'] = result.get('footnotes_json', [])
        self.results['id_mapping'] = result.get('id_mapping', {})

    def _write_footnotes_json(self):
        """Write footnotes.json file."""
        footnotes_json = self.results.get('footnotes_json', [])

        if not footnotes_json:
            self._log("  No footnotes to write")
            return

        footnotes_file = os.path.join(self.output_dir, 'footnotes.json')
        with open(footnotes_file, 'w', encoding='utf-8') as f:
            json.dump(footnotes_json, f, indent=2, ensure_ascii=False)

        self._log(f"  Wrote {len(footnotes_json)} footnotes to {footnotes_file}")

    def _log_summary(self):
        """Log a summary of what was found/fixed."""
        footnotes = self.results.get('all_footnotes', [])
        noterefs = self.results.get('all_noterefs', [])

        self._log(f"Total footnotes detected: {len(footnotes)}")
        self._log(f"Total note references: {len(noterefs)}")

        # Count by strategy
        if footnotes:
            strategies = {}
            for fn in footnotes:
                s = fn.get('strategy', 'unknown')
                strategies[s] = strategies.get(s, 0) + 1
            self._log("Footnotes by detection strategy:")
            for s, count in sorted(strategies.items()):
                self._log(f"  {s}: {count}")

    def _load_from_directory(self):
        """Load EPUB content from an extracted directory."""
        import xml.etree.ElementTree as ET

        # Find OPF
        container_path = os.path.join(self.input_path, 'META-INF', 'container.xml')
        if not os.path.exists(container_path):
            raise FileNotFoundError("META-INF/container.xml not found")

        tree = ET.parse(container_path)
        root = tree.getroot()
        for elem in root.iter():
            elem.tag = re.sub(r'\{.*?\}', '', elem.tag)

        rootfile = root.find('rootfiles/rootfile')
        if rootfile is None:
            raise ValueError("Could not find <rootfile> in container.xml")

        opf_path = os.path.join(self.input_path, rootfile.get('full-path'))
        opf_dir = os.path.dirname(opf_path)
        self._log(f"OPF: {opf_path}")

        # Parse OPF
        tree = ET.parse(opf_path)
        root = tree.getroot()
        for elem in root.iter():
            elem.tag = re.sub(r'\{.*?\}', '', elem.tag)

        manifest = {item.get('id'): item.get('href') for item in root.findall('.//manifest/item')}
        spine = [item.get('idref') for item in root.findall('.//spine/itemref')]
        self._log(f"Manifest: {len(manifest)} items, Spine: {len(spine)} items")

        # Combine spine items
        self.combined_soup = BeautifulSoup(
            '<html><head><title>Combined EPUB</title></head><body></body></html>',
            'html.parser'
        )
        body = self.combined_soup.body

        for idref in spine:
            if idref not in manifest:
                continue

            file_href = manifest[idref]
            file_path = os.path.normpath(os.path.join(opf_dir, file_href))

            if not os.path.exists(file_path):
                continue

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()

                item_soup = BeautifulSoup(content, 'html.parser')
                item_body = item_soup.body if item_soup.body else item_soup

                if item_body:
                    # Fix internal links
                    for a_tag in item_body.find_all('a', href=True):
                        href = a_tag['href']
                        if '#' in href:
                            a_tag['href'] = '#' + href.split('#', 1)[-1]

                    # Fix image paths
                    for img in item_body.find_all('img', src=True):
                        src = img['src']
                        if not src.startswith(('http', 'data:')):
                            img_path = os.path.normpath(os.path.join(os.path.dirname(file_href), src))
                            final_path = os.path.relpath(os.path.join(opf_dir, img_path), self.output_dir)
                            img['src'] = final_path

                    for child in list(item_body.children):
                        if hasattr(child, 'name') and child.name:
                            body.append(child)

            except Exception as e:
                self._log(f"Error loading {file_path}: {e}")

    def _load_from_epub_file(self):
        """Load EPUB content from a .epub file using EbookLib."""
        book = epub.read_epub(self.input_path)
        self._log(f"Title: {book.get_metadata('DC', 'title')}")

        self.combined_soup = BeautifulSoup(
            '<html><head><title>Combined EPUB</title></head><body></body></html>',
            'html.parser'
        )
        body = self.combined_soup.body

        spine_items = [item for item in book.get_items() if item.get_type() == ITEM_DOCUMENT]
        self._log(f"Spine items: {len(spine_items)}")

        for item in spine_items:
            try:
                content = item.get_content().decode('utf-8')
                item_soup = BeautifulSoup(content, 'html.parser')
                item_body = item_soup.body if item_soup.body else item_soup

                if item_body:
                    for a_tag in item_body.find_all('a', href=True):
                        href = a_tag['href']
                        if '#' in href:
                            a_tag['href'] = '#' + href.split('#', 1)[-1]

                    for img in item_body.find_all('img', src=True):
                        src = img['src']
                        if not src.startswith(('http', 'data:')):
                            item_dir = os.path.dirname(item.get_name())
                            img['src'] = os.path.normpath(os.path.join(item_dir, src))

                    for child in list(item_body.children):
                        if hasattr(child, 'name') and child.name:
                            body.append(child)

            except Exception as e:
                self._log(f"Error loading {item.get_name()}: {e}")


# =============================================================================
# MAIN
# =============================================================================

def main():
    if len(sys.argv) < 2:
        print("EPUB Normalizer - Transform Pipeline")
        print("")
        print("Usage: python epub_normalizer.py <epub_or_dir> [output_dir] [book_id]")
        print("")
        print("Arguments:")
        print("  epub_or_dir  Path to .epub file or extracted EPUB directory")
        print("  output_dir   Output directory (default: parent of input)")
        print("  book_id      Book ID for footnote IDs (default: auto-generated)")
        sys.exit(1)

    input_path = sys.argv[1]

    # Determine output directory
    if os.path.isdir(input_path):
        output_dir = os.path.dirname(input_path)
    else:
        output_dir = os.path.dirname(input_path)

    if len(sys.argv) >= 3:
        output_dir = sys.argv[2]

    book_id = sys.argv[3] if len(sys.argv) >= 4 else None

    # Validate
    if os.path.isdir(input_path):
        container_path = os.path.join(input_path, 'META-INF', 'container.xml')
        if not os.path.exists(container_path):
            print(f"Error: {input_path} is not a valid EPUB directory")
            print("Expected META-INF/container.xml")
            sys.exit(1)

    # Run normalizer
    normalizer = EpubNormalizer(input_path, output_dir, book_id)
    normalizer.process()


if __name__ == '__main__':
    main()

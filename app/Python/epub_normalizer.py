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
- CSSClassHeadingDetector: Converts <p class="h/title/fmtitle"> to proper headings
- ImageProcessor: Copies images to public storage, fixes paths, converts divs to <figure>
- SectionUnwrapper: Unwraps section/div containers so each p/h is a separate node

Phase 2 - Footnote Detection:
- Epub3SemanticFootnoteDetector: Uses epub:type attributes (W3C standard)
- AriaRoleFootnoteDetector: Uses role="doc-footnote" etc.
- ClassPatternFootnoteDetector: Matches common CSS class patterns
- NotesClassFootnoteDetector: Publisher format with <p class="notes"><a id="...">
- TableFootnoteDetector: Table-based footnotes (two-column layout)
- PandocFootnoteDetector: Handles <section class="footnotes"> structure
- EndnoteCharactersFootnoteDetector: Word/Calibre <span class="EndnoteCharacters">
- EnoteFootnoteDetector: Marxists.org enote class format
- HeuristicFootnoteDetector: Fallback based on ID patterns and superscripts

Phase 3 - Other Detection:
- BibliographyDetector: Finds reference/bibliography sections

Phase 4 - Final Normalization:
- HeadingNormalizer: Fixes heading hierarchy gaps (h1 -> h4 becomes h1 -> h2)
- DeadInternalLinkUnwrapper: Removes dead internal links, keeps external URLs

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
from bs4 import BeautifulSoup, NavigableString
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

# Safe URL protocols for href and src attributes
ALLOWED_PROTOCOLS = ['http', 'https', 'mailto', '#']

# Dangerous URL patterns that should be stripped
DANGEROUS_URL_PATTERNS = re.compile(
    r'^(javascript|vbscript|data|file):', re.IGNORECASE
)


def sanitize_url(url):
    """
    Sanitize a URL to prevent XSS.
    Returns None if URL is dangerous, otherwise returns the URL.
    """
    if not url:
        return url

    url = url.strip()

    # Allow fragment-only links (#id)
    if url.startswith('#'):
        return url

    # Block dangerous protocols
    if DANGEROUS_URL_PATTERNS.match(url):
        return None

    return url


def sanitize_html(html_string):
    """Sanitize HTML to prevent XSS from malicious EPUB content."""
    # First pass: bleach sanitization
    cleaned = bleach.clean(
        html_string,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        strip=True
    )

    # Second pass: sanitize URLs in href and src attributes
    soup = BeautifulSoup(cleaned, 'html.parser')

    # Sanitize href attributes
    for elem in soup.find_all(href=True):
        safe_url = sanitize_url(elem['href'])
        if safe_url is None:
            del elem['href']
        else:
            elem['href'] = safe_url

    # Sanitize src attributes (especially important for img)
    for elem in soup.find_all(src=True):
        safe_url = sanitize_url(elem['src'])
        if safe_url is None:
            # For images, remove the element entirely if src is dangerous
            if elem.name == 'img':
                elem.decompose()
            else:
                del elem['src']
        else:
            elem['src'] = safe_url

    return str(soup)


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


class ImageProcessor(EpubTransform):
    """
    Processes images from EPUB:
    1. Copies images from epub_original to public storage location
    2. Updates image src paths to use public URLs
    3. Converts nested div wrappers to proper <figure> elements
    4. Detects and preserves figure captions as <figcaption>

    Image storage: /storage/app/public/books/{bookId}/images/
    Public URL: /storage/books/{bookId}/images/{filename}
    """

    name = "ImageProcessor"
    description = "Process and relocate EPUB images"

    def __init__(self):
        self.book_id = None
        self.input_dir = None
        self.images_copied = 0

    def detect(self, soup) -> bool:
        return bool(soup.find('img'))

    def set_context(self, book_id, input_dir):
        """Set context for image processing (called before transform)."""
        self.book_id = book_id
        self.input_dir = input_dir

    def transform(self, soup, log) -> dict:
        if not self.book_id or not self.input_dir:
            log("  Warning: ImageProcessor context not set, skipping")
            return {'images_processed': 0}

        body = soup.body if soup.body else soup
        images_processed = 0
        figures_created = 0

        # Find the base path for the project (go up from app/Python to project root)
        import pathlib
        project_root = pathlib.Path(__file__).parent.parent.parent

        # Create storage directory for this book's images
        storage_dir = project_root / 'storage' / 'app' / 'public' / 'books' / self.book_id / 'images'
        storage_dir.mkdir(parents=True, exist_ok=True)

        # Define allowed base directories for path traversal protection
        allowed_base = pathlib.Path(self.input_dir).resolve()

        for img in body.find_all('img', src=True):
            src = img['src']

            # Skip external images and data URIs
            if src.startswith(('http://', 'https://', 'data:')):
                continue

            # Security: Reject paths with obvious traversal attempts
            if '..' in src or src.startswith('/'):
                log(f"    Warning: Skipping suspicious image path: {src}")
                continue

            # Find the source image file
            # src might be like "epub_original/images/00001.jpg" or "images/00001.jpg"
            src_path = None
            possible_paths = [
                pathlib.Path(self.input_dir) / src,
                pathlib.Path(self.input_dir) / 'epub_original' / src,
                pathlib.Path(self.input_dir).parent / src,
            ]

            for p in possible_paths:
                if p.exists():
                    # Security: Verify resolved path is within allowed directory
                    resolved = p.resolve()
                    if not str(resolved).startswith(str(allowed_base.parent)):
                        log(f"    Warning: Path traversal attempt blocked: {src}")
                        continue
                    src_path = resolved
                    break

            if not src_path:
                log(f"    Warning: Image not found: {src}")
                continue

            # Copy image to storage
            filename = src_path.name
            dest_path = storage_dir / filename

            if not dest_path.exists():
                import shutil
                shutil.copy2(src_path, dest_path)
                self.images_copied += 1

            # Update src to public URL
            img['src'] = f'/storage/books/{self.book_id}/images/{filename}'
            images_processed += 1

            # Convert div wrappers to figure
            # Pattern: <div><div><img></div></div> or <div><img><p>caption</p></div>
            parent = img.parent
            if parent and parent.name == 'div':
                grandparent = parent.parent

                # Check if parent div contains only the image (and maybe whitespace)
                siblings = [c for c in parent.children if hasattr(c, 'name') and c.name]
                if len(siblings) == 1 and siblings[0] == img:
                    # Parent div only has img, check grandparent
                    if grandparent and grandparent.name == 'div':
                        gp_children = [c for c in grandparent.children if hasattr(c, 'name') and c.name]

                        # Validate grandparent is a minimal wrapper before converting
                        # Don't convert if grandparent contains headings or multiple content elements
                        has_headings = any(c.name in ['h1','h2','h3','h4','h5','h6'] for c in gp_children)
                        p_count = sum(1 for c in gp_children if c.name == 'p')

                        # Grandparent should be minimal: just parent div + maybe 1 caption
                        # If it has headings, multiple paragraphs, or too many children, it's a content section
                        is_minimal_wrapper = not has_headings and p_count <= 1 and len(gp_children) <= 2

                        if is_minimal_wrapper:
                            # Look for caption (usually a <p> with bold text like "Figure 1.1")
                            caption_elem = None
                            for child in gp_children:
                                if child.name == 'p' and child != parent:
                                    text = child.get_text(strip=True)
                                    if text and len(text) < 500:  # Reasonable caption length
                                        caption_elem = child
                                        break

                            # Convert grandparent div to figure
                            grandparent.name = 'figure'
                            grandparent.attrs = {}

                            # Unwrap the intermediate div
                            parent.unwrap()

                            # Convert caption p to figcaption
                            if caption_elem:
                                caption_elem.name = 'figcaption'

                            figures_created += 1
                        else:
                            # Grandparent is a content section, just convert parent div to figure
                            parent.name = 'figure'
                            parent.attrs = {}
                            figures_created += 1

                elif len(siblings) >= 1:
                    # Parent div has img + possibly caption
                    caption_elem = None
                    for child in siblings:
                        if child.name == 'p' and child != img:
                            text = child.get_text(strip=True)
                            if text and len(text) < 500:
                                caption_elem = child
                                break

                    # Convert parent div to figure
                    parent.name = 'figure'
                    parent.attrs = {}

                    if caption_elem:
                        caption_elem.name = 'figcaption'

                    figures_created += 1

        log(f"  Processed {images_processed} images, created {figures_created} figures")
        log(f"  Copied {self.images_copied} images to storage")
        return {'images_processed': images_processed, 'figures_created': figures_created}


class SectionUnwrapper(EpubTransform):
    """
    Unwraps section and div container elements that wrap multiple paragraphs.

    EPUBs often use <section> or <div> to group content by chapter, but these
    container elements prevent proper node chunking (each paragraph should be
    a separate node). This transform unwraps these containers while preserving
    their children.

    Preserves:
    - <figure> elements (needed for images)
    - <nav> elements (table of contents)
    - <aside> elements (semantic sidebars)
    - Elements with epub:type="footnotes" or similar
    - Blockquotes (actual quotes, not Calibre abuse)

    Unwraps:
    - <section> elements (chapter/section wrappers)
    - <div> elements with layout classes (galley-rw, etc.)
    - <nav> elements that are just navigation wrappers
    """

    name = "SectionUnwrapper"
    description = "Unwrap section/div containers for proper node chunking"

    # Elements to preserve (don't unwrap)
    PRESERVE_ELEMENTS = ['figure', 'aside', 'table', 'ul', 'ol', 'blockquote']

    # Classes that indicate the element should be preserved
    PRESERVE_CLASSES = ['footnote', 'footnotes', 'endnote', 'endnotes', 'bibliography', 'references', 'note', 'notes']

    def detect(self, soup) -> bool:
        return bool(soup.find(['section', 'div']))

    def transform(self, soup, log) -> dict:
        unwrapped = 0
        body = soup.body if soup.body else soup

        # Unwrap sections first
        for section in list(body.find_all('section')):
            if self._should_unwrap(section):
                section.unwrap()
                unwrapped += 1

        # Unwrap divs (except figures and other semantic elements)
        for div in list(body.find_all('div')):
            if self._should_unwrap(div):
                div.unwrap()
                unwrapped += 1

        # Also unwrap nav elements that aren't TOC
        for nav in list(body.find_all('nav')):
            epub_type = nav.get('epub:type', '')
            if 'toc' not in epub_type and 'landmarks' not in epub_type:
                nav.unwrap()
                unwrapped += 1

        log(f"  Unwrapped {unwrapped} container elements")
        return {'unwrapped': unwrapped}

    def _should_unwrap(self, elem):
        """Determine if an element should be unwrapped."""
        # Don't unwrap preserved element types
        if elem.name in self.PRESERVE_ELEMENTS:
            return False

        # Don't unwrap elements with semantic epub:type
        epub_type = elem.get('epub:type', '')
        if any(t in epub_type for t in ['footnote', 'endnote', 'bibliography']):
            return False

        # Don't unwrap elements with preserved classes
        classes = elem.get('class', [])
        if isinstance(classes, str):
            classes = classes.split()
        class_str = ' '.join(classes).lower()
        if any(pc in class_str for pc in self.PRESERVE_CLASSES):
            return False

        # Unwrap if it contains block-level children (paragraphs, headings, etc.)
        block_children = elem.find_all(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section'], recursive=False)
        if len(block_children) > 0:
            return True

        # If it only contains inline content, don't unwrap
        return False


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
        # Patterns: 'heading', 'title', or publisher patterns like 'fmhT' (front matter heading)
        for div in body.find_all('div'):
            class_str = ' '.join(div.get('class', [])).lower()
            if 'heading' in class_str or 'title' in class_str or re.search(r'fmh|bmh|chap', class_str):
                level = 2  # Default to h2 for publisher heading classes
                match = re.search(r'[h_s]?(?P<level>\d+)', class_str)
                if match:
                    level = int(match.group('level'))
                    level = max(1, min(6, level))
                elif 'heading' in class_str or 'title' in class_str:
                    level = 1  # Original default for explicit heading/title

                # Special case: VOLUME/PART headings should be h1 (major divisions)
                text = div.get_text(strip=True).upper()
                if re.match(r'^(VOLUME|PART|BOOK)\s', text):
                    level = 1

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


class CSSClassHeadingDetector(EpubTransform):
    """
    Converts paragraphs with heading-like CSS classes to proper headings.

    Common in publisher EPUBs (Pluto Press, Penguin, etc.) where semantic
    headings are replaced with styled paragraphs.

    Auto-detection logic for class="h":
    - If contains <b> (bold): h2 (main section heading)
    - If contains only <i>: h3 (subsection)
    - Otherwise: h2 (default)
    """

    name = "CSSClassHeadingDetector"
    description = "Convert CSS-classed paragraphs to semantic headings"

    # Explicit class mappings (these always map to specific heading levels)
    # Note: Publisher class names like "h1" don't mean HTML h1 - they're relative
    # to the section structure. class="h" is section, class="h1" is subsection, etc.
    EXPLICIT_CLASSES = {
        'h1': 'h3',        # Publisher subsection (under class="h" which is h2)
        'h2': 'h4',        # Publisher sub-subsection
        'h3': 'h5',        # Publisher deeper level
        'h3b': 'h3',       # Subsection variant (Notes chapter headings)
        'fmtitle': 'h1',   # Front matter titles (Figures, Acknowledgements)
        'bmtitle': 'h1',   # Back matter titles (Notes, Index)
        'half': 'h1',      # Half-title page
        'title': 'h1',     # Main book title
        'title1': 'h1',    # Subtitle
        'con': 'h1',       # Contents heading
        'chapnum': 'h1',   # Chapter numbers (CHAPTER 1, CHAPTER 2, etc.)
        'chaptitle': 'h1', # Chapter titles (alternative naming)
    }

    # Classes that need style-based auto-detection
    AUTO_DETECT_CLASSES = {'h'}

    def detect(self, soup) -> bool:
        body = soup.body if soup.body else soup
        # Check for any paragraph with heading-like classes
        all_classes = set(self.EXPLICIT_CLASSES.keys()) | self.AUTO_DETECT_CLASSES
        for p in body.find_all('p'):
            p_classes = set(p.get('class', []))
            if p_classes & all_classes:
                return True
        return False

    def transform(self, soup, log) -> dict:
        changes = 0
        body = soup.body if soup.body else soup
        all_classes = set(self.EXPLICIT_CLASSES.keys()) | self.AUTO_DETECT_CLASSES

        for p in body.find_all('p'):
            p_classes = p.get('class', [])
            if not p_classes:
                continue

            # Find matching class
            matched_class = None
            for cls in p_classes:
                if cls in all_classes:
                    matched_class = cls
                    break

            if not matched_class:
                continue

            # Determine heading level
            if matched_class in self.EXPLICIT_CLASSES:
                heading_level = self.EXPLICIT_CLASSES[matched_class]
            else:
                # Auto-detect based on styling
                heading_level = self._detect_heading_level(p)

            # Convert to heading
            preserved_id = p.get('id')
            p.name = heading_level
            p.attrs = {}
            if preserved_id:
                p['id'] = preserved_id

            changes += 1
            log(f"    {matched_class} -> {heading_level}: {p.get_text(strip=True)[:50]}...")

        if changes > 0:
            log(f"  Converted {changes} paragraphs to headings")

        return {'headings_converted': changes}

    def _detect_heading_level(self, elem):
        """
        Auto-detect heading level based on child element styling.

        - If contains <b> (bold): h2 (main section heading)
        - If contains only <i>: h3 (subsection/italic emphasis)
        - Otherwise: h2 (default)
        """
        has_bold = bool(elem.find('b') or elem.find('strong'))
        has_italic = bool(elem.find('i') or elem.find('em'))

        if has_bold:
            return 'h2'  # Bold content = main section heading
        elif has_italic and not has_bold:
            return 'h3'  # Italic only = subsection
        else:
            return 'h2'  # Default


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
                        'original_marker': elem.get_text(strip=True),
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
                        'original_marker': elem.get_text(strip=True),
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
        r'\bfootnotes?\d*\b', r'\bfoot-notes?\d*\b', r'\bfn\d*\b',
        r'\bendnotes?\d*\b', r'\bend-notes?\d*\b', r'\ben\d*\b',
        r'\bnotes?\d*\b', r'\bannotations?\b'
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
        seen_ids = set()

        for elem in soup.find_all(['aside', 'div', 'section', 'p', 'li']):
            class_str = ' '.join(elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.FOOTNOTE_PATTERNS):
                elem_id = elem.get('id', '')

                # Register element's own ID if present
                if elem_id and elem_id not in seen_ids:
                    seen_ids.add(elem_id)
                    footnotes.append({
                        'id': elem_id,
                        'element': elem,
                        'type': 'footnote',
                        'strategy': 'class_pattern'
                    })
                    log(f"    Found footnote (class): id={elem_id}")

                # ALSO check child anchors - references often point to these
                # (e.g., <p class="endnote" id="cap123"><a id="inen08"/>...)
                for child_a in elem.find_all('a', id=True):
                    child_id = child_a.get('id', '')
                    if child_id and child_id not in seen_ids:
                        seen_ids.add(child_id)
                        footnotes.append({
                            'id': child_id,
                            'element': elem,  # Use parent as the footnote element
                            'type': 'footnote',
                            'strategy': 'class_pattern_child_anchor'
                        })
                        log(f"    Found footnote (class, child anchor): id={child_id}")

        for elem in soup.find_all('a'):
            class_str = ' '.join(elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.NOTEREF_PATTERNS):
                href = elem.get('href', '')
                if href.startswith('#'):
                    noterefs.append({
                        'element': elem,
                        'target_id': href[1:],
                        'original_marker': elem.get_text(strip=True),
                        'strategy': 'class_pattern'
                    })

        return {'footnotes': footnotes, 'noterefs': noterefs}


class NotesClassFootnoteDetector(EpubTransform):
    """
    Detects footnotes in publisher format where:
    - <p class="notes"> contains the footnote definition
    - First <a id="..."> inside has the footnote ID
    - The anchor typically has a backlink to the reference

    Common in academic publishers (Melbourne University Press, etc.)
    where footnotes are in a separate notes section.
    """

    name = "NotesClassFootnoteDetector"
    description = "Detect footnotes in <p class='notes'> with child anchor ID"

    def detect(self, soup) -> bool:
        return bool(soup.find('p', class_='notes'))

    def transform(self, soup, log) -> dict:
        footnotes = []
        seen_ids = set()

        for p in soup.find_all('p', class_='notes'):
            # Look for first anchor with an ID inside this paragraph
            first_a = p.find('a', id=True)
            if first_a:
                fn_id = first_a.get('id', '')
                # Verify it has a backlink (typical footnote pattern)
                has_backlink = bool(first_a.get('href', '').strip())

                if fn_id and fn_id not in seen_ids and has_backlink:
                    seen_ids.add(fn_id)
                    footnotes.append({
                        'id': fn_id,
                        'element': p,
                        'type': 'endnote',
                        'strategy': 'notes_class'
                    })
                    log(f"    Found endnote (notes class): id={fn_id}")

        log(f"    Total: {len(footnotes)} definitions")
        return {'footnotes': footnotes, 'noterefs': []}


class TableFootnoteDetector(EpubTransform):
    """
    Detects footnotes in table-based layouts.

    Common in publisher EPUBs (Pluto Press, Penguin, etc.) where footnotes
    are presented as a two-column table:
    - First <td>: anchor with footnote ID and backlink
    - Second <td>: footnote content

    Example:
    <table class="note">
      <tr>
        <td><a href="#part0008_rintfn1" id="part0018_split_000_intfn1">1</a></td>
        <td><p class="noindent">James Joyce, <i>Ulysses</i>...</p></td>
      </tr>
    </table>
    """

    name = "TableFootnoteDetector"
    description = "Detect footnotes in table-based layouts"

    def detect(self, soup) -> bool:
        # Look for tables that might contain footnotes
        for table in soup.find_all('table'):
            class_str = ' '.join(table.get('class', [])).lower()
            # Common footnote table classes
            if any(x in class_str for x in ['note', 'footnote', 'endnote', 'fn']):
                return True
            # Also check if table contains anchors with backlinks (heuristic)
            first_td = table.find('td')
            if first_td:
                anchor = first_td.find('a', href=True, id=True)
                if anchor:
                    return True
        return False

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []
        seen_ids = set()

        for table in soup.find_all('table'):
            for tr in table.find_all('tr'):
                tds = tr.find_all('td')
                if len(tds) < 2:
                    continue

                # First td should contain anchor with ID
                first_td = tds[0]
                anchor = first_td.find('a', id=True)
                if not anchor:
                    continue

                fn_id = anchor.get('id', '')
                href = anchor.get('href', '')

                # Verify it has a backlink (typical footnote pattern)
                has_backlink = bool(href and href.startswith('#'))

                if fn_id and fn_id not in seen_ids and has_backlink:
                    seen_ids.add(fn_id)

                    # Second td contains the content
                    content_td = tds[1]

                    footnotes.append({
                        'id': fn_id,
                        'element': content_td,  # Use content td as element
                        'anchor_element': anchor,  # Keep reference to anchor
                        'type': 'endnote',
                        'strategy': 'table_footnote'
                    })
                    log(f"    Found footnote (table): id={fn_id}")

        log(f"    Total: {len(footnotes)} definitions")
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
                        'original_marker': a_tag.get_text(strip=True),
                        'strategy': 'pandoc'
                    })

        return {'footnotes': footnotes, 'noterefs': noterefs}


class EndnoteCharactersFootnoteDetector(EpubTransform):
    """
    Detects Microsoft Word/Calibre endnotes using EndnoteCharacters class.

    Pattern for in-text references:
    <a class="pcalibre ..." href="#target_id" id="ref_id">
      <span class="EndnoteCharacters">N</span>
    </a>

    Pattern for endnote definitions (at start of paragraph):
    <p class="MsoNormal">
      <a class="pcalibre ..." href="#ref_id" id="target_id">
        <span class="EndnoteCharacters">N</span>
      </a> Content...
    </p>

    Key distinction:
    - References: anchor is inline within text, href points to definition
    - Definitions: anchor is at START of paragraph, has backlink href to reference
    """

    name = "EndnoteCharactersFootnoteDetector"
    description = "Detect Word/Calibre endnotes via EndnoteCharacters class"

    def detect(self, soup) -> bool:
        return bool(soup.find('span', class_='EndnoteCharacters'))

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []
        seen_fn_ids = set()
        seen_ref_targets = set()

        # Find all anchors containing EndnoteCharacters spans
        for a_tag in soup.find_all('a', href=True):
            span = a_tag.find('span', class_='EndnoteCharacters')
            if not span:
                continue

            a_id = a_tag.get('id', '')
            href = a_tag.get('href', '')

            # Determine if this is a reference or a definition
            # Definitions: at start of paragraph AND have both id and backlink href
            parent = a_tag.parent
            is_at_para_start = self._is_at_paragraph_start(a_tag, parent)

            if is_at_para_start and a_id and href.startswith('#'):
                # This is an endnote DEFINITION
                if a_id not in seen_fn_ids:
                    seen_fn_ids.add(a_id)
                    # The parent paragraph contains the footnote content
                    footnotes.append({
                        'id': a_id,
                        'element': parent,  # The <p> containing the definition
                        'type': 'endnote',
                        'strategy': 'endnote_characters'
                    })
                    log(f"    Found endnote def (EndnoteCharacters): id={a_id}")
            elif href.startswith('#'):
                # This is an in-text REFERENCE
                target_id = href[1:]
                # Track target for definition lookup, but allow multiple refs to same target
                seen_ref_targets.add(target_id)
                # Capture original marker text (e.g., "1", "43a", "*")
                marker_text = span.get_text(strip=True) if span else ''
                noterefs.append({
                    'element': a_tag,
                    'target_id': target_id,
                    'strategy': 'endnote_characters',
                    'original_marker': marker_text
                })

        log(f"    Total: {len(footnotes)} definitions, {len(noterefs)} references")
        return {'footnotes': footnotes, 'noterefs': noterefs}

    def _is_at_paragraph_start(self, a_tag, parent):
        """Check if the anchor is at the start of its parent paragraph."""
        if not parent or parent.name not in ['p', 'div']:
            return False

        # Get all content before this anchor
        for sibling in parent.children:
            if sibling == a_tag:
                return True  # Nothing substantial before it
            if hasattr(sibling, 'name') and sibling.name:
                return False  # Another element before it
            if isinstance(sibling, str) and sibling.strip():
                return False  # Non-whitespace text before it

        return False


class EnoteFootnoteDetector(EpubTransform):
    """
    Detects footnotes using <sup class="enote"> pattern.

    Common in Calibre-converted epubs from Marxists.org:
    - References: <sup class="enote"><a href="#n8">[8]</a></sup>
    - Definitions: <p><a id="n8"><span>8</span></a> Content here...</p>

    The "enote" class indicates endnote references.
    """

    name = "EnoteFootnoteDetector"
    description = "Detect enote class footnotes (Marxists.org format)"

    def detect(self, soup) -> bool:
        """Check if document has enote-class superscripts."""
        return bool(soup.find('sup', class_=lambda c: c and 'enote' in c))

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []
        seen_fn_ids = set()
        seen_ref_targets = set()

        # Pattern 1: <sup class="enote..."><a href="#nX">
        for sup in soup.find_all('sup', class_=lambda c: c and 'enote' in c):
            a_tag = sup.find('a', href=True)
            if not a_tag:
                # Check if sup is inside an anchor (Pattern 2)
                parent_a = sup.find_parent('a', href=True)
                if parent_a:
                    a_tag = parent_a
                else:
                    continue

            href = a_tag.get('href', '')
            if not href.startswith('#'):
                continue

            target_id = href[1:]  # Remove #
            # Track target for definition lookup, but allow multiple refs to same target
            seen_ref_targets.add(target_id)

            # Extract original marker text (e.g., "[8]" or "8")
            marker_text = sup.get_text(strip=True)
            # Strip brackets if present: "[8]" -> "8"
            if marker_text.startswith('[') and marker_text.endswith(']'):
                marker_text = marker_text[1:-1]
            marker_text = marker_text.strip()

            # Use the anchor as element if sup is inside it, otherwise use sup
            element = a_tag if sup.find_parent('a') == a_tag else sup

            noterefs.append({
                'element': element,
                'target_id': target_id,
                'strategy': 'enote_class',
                'original_marker': marker_text
            })

        # Find matching definitions: <a id="nX"> or <a name="nX"> at paragraph start
        # Pattern: <p><a id="n8"><span>8</span></a> Definition content...</p>
        # Also handle inverted pattern: <a href="#nX"> (definition links back to reference)
        for target_id in seen_ref_targets:
            fn_anchor = None
            parent = None

            # Strategy 1: Look for anchor with this id (normal pattern)
            fn_anchor = soup.find('a', id=target_id)
            if not fn_anchor:
                fn_anchor = soup.find('a', attrs={'name': target_id})

            if fn_anchor:
                # Find parent paragraph
                parent = fn_anchor.parent
                while parent and parent.name not in ['p', 'div', 'li', 'blockquote']:
                    parent = parent.parent

                # Verify anchor is at/near start of paragraph
                if parent and not self._is_at_paragraph_start(fn_anchor, parent):
                    parent = None  # Reset if not at start

                # Strategy 1b: Anchor is sibling before paragraph (common pattern)
                # <a id="X"></a><p>Content...</p>
                if not parent and fn_anchor.parent:
                    next_sib = fn_anchor.find_next_sibling()
                    if next_sib and next_sib.name in ['p', 'div', 'blockquote']:
                        parent = next_sib

            # Strategy 2: Inverted pattern - definition has href pointing back to reference
            # Look for <a href="#target_id"> at paragraph start in Notes section
            if not parent:
                # Find anchors with href pointing to this target
                back_link = '#' + target_id
                for a_tag in soup.find_all('a', href=back_link):
                    # Skip if this is the original reference (inside a sup)
                    if a_tag.find_parent('sup'):
                        continue

                    # Find parent paragraph
                    candidate_parent = a_tag.parent
                    while candidate_parent and candidate_parent.name not in ['p', 'div', 'li', 'blockquote']:
                        candidate_parent = candidate_parent.parent

                    if candidate_parent and self._is_at_paragraph_start(a_tag, candidate_parent):
                        fn_anchor = a_tag
                        parent = candidate_parent
                        break

            if not parent:
                continue

            if target_id not in seen_fn_ids:
                seen_fn_ids.add(target_id)
                footnotes.append({
                    'id': target_id,
                    'element': parent,
                    'type': 'endnote',
                    'strategy': 'enote_class'
                })

        log(f"    Total: {len(footnotes)} definitions, {len(noterefs)} references")
        return {'footnotes': footnotes, 'noterefs': noterefs}

    def _is_at_paragraph_start(self, anchor, parent):
        """Check if anchor is at or near the start of its parent element."""
        if not parent:
            return False

        anchor_id = anchor.get('id') or anchor.get('name')

        # Walk through children, allow only whitespace/hr before the anchor
        for child in parent.children:
            if child == anchor:
                return True

            # Allow navigating through wrapper elements
            if hasattr(child, 'name') and child.name:
                if child.name in ['hr', 'br']:
                    continue
                # Check if anchor is inside this child (use attrs dict for find)
                if hasattr(child, 'find'):
                    found = child.find('a', attrs={'id': anchor_id})
                    if found:
                        return True
                    found = child.find('a', attrs={'name': anchor_id})
                    if found:
                        return True
                # Another substantial element before anchor
                if hasattr(child, 'get_text') and child.get_text(strip=True):
                    return False
            elif isinstance(child, str) and child.strip():
                # Non-whitespace text before anchor
                return False

        return False


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
        r'^[a-z]+\d*fn\d+$',  # Chapter-prefixed: chapter01fn1, introductionfn5
        r'^[a-z]+\d*-fn-?\d+$',  # With dashes: chapter01-fn1, chapter-fn-1
        r'^pg\d+fn\d+$',  # Penguin format: pg400fn39 (page+fn+number)
        r'^pg\d+_fn\d+$',  # Penguin reference format: pg202_fn1
        r'.*intfn\d+$',  # Publisher internal: part0018_split_000_intfn1
        r'.*_FTN-\d+$',  # Publisher FTN format: FTN-1, FTN-2 (Haymarket Books) - prefixed after merge
        r'^FTN-\d+$',  # Publisher FTN format without prefix
        r'.*_fn\d+_\d+$',  # Publisher format with suffixes: part0031_fn87_01
        r'.*fn\d+_\d+$',  # Similar without leading underscore
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
                        'original_marker': sup.get_text(strip=True),  # Preserve *, †, etc.
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
                        'original_marker': a_tag.get_text(strip=True),  # Preserve *, †, etc.
                        'strategy': 'heuristic_a_sup'
                    })

        # Pattern 2: ID-based detection for footnote definitions
        # Include 'a' for publisher formats where footnote ID is on anchor (e.g., Haymarket Books)
        for elem in soup.find_all(['p', 'div', 'li', 'aside', 'section', 'blockquote', 'td', 'a']):
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

        # Pattern 4: Cross-file footnote links (href="pg0XXXfn.html#pgXXXfnYY")
        # Common in Penguin Classics and similar publisher formats
        for a_tag in soup.find_all('a', href=re.compile(r'fn\.html#')):
            href = a_tag.get('href', '')
            target_id = self._extract_target_id(href)
            if target_id and target_id not in seen_ref_ids:
                seen_ref_ids.add(target_id)
                noterefs.append({
                    'element': a_tag,
                    'target_id': target_id,
                    'original_marker': a_tag.get_text(strip=True),  # Preserve *, †, etc.
                    'strategy': 'heuristic_cross_file_fn'
                })

        # Pattern 5: Bare <a href="#..."> with short symbol/number content (no <sup>)
        # Matches asterisks (*), daggers (†‡), numbers, letters used as footnote refs
        # Also matches bracketed numbers like [1], [2] (common in Marxists.org, Calibre EPUBs)
        # Examples: <a href="#fn1">*</a>, <a href="#note1">1</a>, <a href="#fn2">†</a>, <a href="#intro1">[1]</a>
        footnote_symbols = re.compile(r'^(?:\[\d+\]|[\d*†‡§¶#a-zA-Z]{1,3}\.?)$')
        for a_tag in soup.find_all('a', href=True):
            # Skip if already in <sup> (handled by Pattern 1a)
            if a_tag.find_parent('sup'):
                continue
            # Skip if contains <sup> (handled by Pattern 1b)
            if a_tag.find('sup'):
                continue

            href = a_tag.get('href', '')
            target_id = self._extract_target_id(href)
            if not target_id or target_id in seen_ref_ids:
                continue

            # Check if link text looks like a footnote reference
            link_text = a_tag.get_text(strip=True)
            if footnote_symbols.match(link_text):
                seen_ref_ids.add(target_id)
                noterefs.append({
                    'element': a_tag,
                    'target_id': target_id,
                    'original_marker': link_text,  # Preserve *, †, etc.
                    'strategy': 'heuristic_bare_symbol_link'
                })

        # Pattern 6: Footnote definitions under a "Footnotes"/"Notes" heading
        # Common in Calibre EPUBs and Marxists.org format:
        #   <h4>Footnotes</h4>
        #   <p><a href="#backlink" id="intro1">[1]</a> Definition content...</p>
        #   <p><span><a href="#backlink" id="b1">[1]</a></span> Definition content...</p>
        # These definitions have non-standard IDs (intro1, b1, d1) that don't match
        # typical footnote ID patterns, but are clearly footnotes by context.
        footnote_heading_texts = {'footnotes', 'footnote', 'notes', 'endnotes'}
        for heading in soup.find_all(['h3', 'h4', 'h5', 'h6']):
            heading_text = heading.get_text(strip=True).lower()
            if heading_text not in footnote_heading_texts:
                continue

            # Collect following siblings until next heading
            for sibling in heading.find_next_siblings():
                if sibling.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                    break

                if sibling.name not in ['p', 'div']:
                    continue

                # Look for an anchor with an id attribute at/near the start
                # Handles both <a id="..."> and <span><a id="..."></span>
                first_a = sibling.find('a', id=True)
                if not first_a:
                    continue

                a_id = first_a.get('id')
                if not a_id or a_id in seen_fn_ids:
                    continue

                # Verify this anchor has a backlink href (points back to the
                # in-text reference) and contains a short marker like [1]
                has_backlink = first_a.get('href', '').startswith('#')
                marker_text = first_a.get_text(strip=True)
                looks_like_marker = bool(re.match(r'^\[?\d+\]?$', marker_text))

                if has_backlink and looks_like_marker:
                    seen_fn_ids.add(a_id)
                    footnotes.append({
                        'id': a_id,
                        'element': sibling,
                        'type': 'footnote',
                        'strategy': 'heuristic_footnotes_heading'
                    })
                    log(f"    Found footnote def (under heading): id={a_id}")

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
        <sup fn-count-id="1" id="Fn{timestamp}_{random}" class="footnote-ref">1</sup>

    Footnote definition (stored in footnotes.json):
        {
            "footnoteId": "Fn{timestamp}_{random}",
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

        log(f"  Converting {len(all_footnotes)} footnotes, {len(all_noterefs)} references (detected)")

        # Build set of all footnote definition IDs (for reverse-mapping references)
        all_footnote_ids = {fn.get('id', '') for fn in all_footnotes if fn.get('id')}

        # Reverse-mapping: Find all <a> links pointing to footnote IDs that weren't
        # detected by the normal reference detectors. This catches publisher-specific
        # patterns like <a class="nounder" href="#footnote_id">
        seen_ref_targets = {ref.get('target_id', '') for ref in all_noterefs}
        additional_refs = []

        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            if not href.startswith('#'):
                continue
            target_id = href[1:]

            # Skip if already detected or not a footnote target
            if target_id in seen_ref_targets or target_id not in all_footnote_ids:
                continue

            # Skip if this is inside a footnote definition (backlink)
            # Check if any ancestor has class matching footnote patterns
            is_backlink = False
            for parent in a_tag.parents:
                parent_class = ' '.join(parent.get('class', []))
                if re.search(r'\b(footnote|endnote|note)\b', parent_class, re.I):
                    is_backlink = True
                    break
            if is_backlink:
                continue

            seen_ref_targets.add(target_id)
            additional_refs.append({
                'element': a_tag,
                'target_id': target_id,
                'original_marker': a_tag.get_text(strip=True),
                'strategy': 'reverse_mapping'
            })

        all_noterefs = all_noterefs + additional_refs
        log(f"  Found {len(additional_refs)} additional refs via reverse-mapping, total: {len(all_noterefs)}")

        # Build mapping from old IDs to new Hyperlit IDs
        # Also extract footnote content
        id_mapping = {}  # old_id -> {new_id, count, content}
        count = 1

        for fn in all_footnotes:
            old_id = fn.get('id', '')
            if not old_id:
                continue

            # Generate new Hyperlit-style ID (short format without bookId prefix)
            timestamp = int(time.time() * 1000)
            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
            new_id = f"Fn{timestamp}_{random_suffix}"

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
        numeric_count = 1  # Counter for numeric footnotes only
        used_ref_ids = set()  # Track which footnote IDs have been assigned to refs

        for noteref in all_noterefs:
            target_id = noteref.get('target_id', '')
            elem = noteref.get('element')
            original_marker = noteref.get('original_marker', '')

            if not target_id or not elem:
                continue

            # Find the mapping for this target
            if target_id in id_mapping:
                mapping = id_mapping[target_id]
                new_id = mapping['new_id']

                # If this footnote ID was already used by another reference,
                # generate a new unique ID and create a duplicate footnote entry
                if new_id in used_ref_ids:
                    timestamp = int(time.time() * 1000)
                    random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
                    new_id = f"Fn{timestamp}_{random_suffix}"
                    # Store duplicate entry to be added to footnotes_json later
                    if '_duplicate_entries' not in mapping:
                        mapping['_duplicate_entries'] = []
                    mapping['_duplicate_entries'].append(new_id)

                used_ref_ids.add(new_id)

                # Determine display marker: preserve non-numeric, use count for numeric
                if original_marker and not original_marker.isdigit():
                    # Non-numeric marker (*, 43a, etc.) - preserve it
                    display_marker = original_marker
                    mapping['original_marker'] = original_marker
                else:
                    # Numeric marker - use sequential count
                    display_marker = numeric_count
                    mapping['original_marker'] = None
                    numeric_count += 1

                mapping['display_marker'] = display_marker

                # Convert the element to Hyperlit format
                self._convert_noteref_element(elem, new_id, display_marker, soup)
                converted_refs += 1

        log(f"  Converted {converted_refs} in-text references")

        # Build footnotes.json data
        for old_id, mapping in id_mapping.items():
            new_id = mapping['new_id']
            display_marker = mapping.get('display_marker', mapping['count'])
            original_marker = mapping.get('original_marker')
            content = mapping['content']

            # Format content with anchor tag
            anchor_html = f'<a fn-count-id="{display_marker}" id="{new_id}"></a>'
            full_content = anchor_html + content

            footnote_entry = {
                'footnoteId': new_id,
                'content': full_content
            }

            # Include original marker for non-numeric footnotes
            if original_marker:
                footnote_entry['originalMarker'] = original_marker

            self.footnotes_json.append(footnote_entry)

            # Add duplicate entries for additional references to the same footnote
            for dup_id in mapping.get('_duplicate_entries', []):
                dup_anchor_html = f'<a fn-count-id="{display_marker}" id="{dup_id}"></a>'
                dup_entry = {
                    'footnoteId': dup_id,
                    'content': dup_anchor_html + content
                }
                if original_marker:
                    dup_entry['originalMarker'] = original_marker
                self.footnotes_json.append(dup_entry)

            # Remove the footnote definition element from main HTML
            # (content has been extracted to footnotes.json)
            elem = mapping.get('element')
            if elem and elem.parent:
                elem.decompose()

        log(f"  Generated {len(self.footnotes_json)} footnote entries for JSON")

        return {'footnotes_json': self.footnotes_json, 'id_mapping': id_mapping}

    def _extract_footnote_content(self, elem, old_id):
        """Extract the content of a footnote definition."""
        # Clone the element to avoid modifying the original during extraction
        from copy import copy

        # Special case: If elem is an <a> tag that's empty or just contains a marker
        # (number, *, †, etc.), the actual content is in the following sibling(s)
        if elem.name == 'a':
            elem_text = elem.get_text(strip=True)
            # Check if anchor is empty, numeric ("1", "1."), or a symbol marker (*, †, ‡, etc.)
            is_empty = not elem_text
            is_numeric = bool(re.match(r'^\d+\.?$', elem_text))
            is_symbol_marker = bool(re.match(r'^[\*†‡§¶#a-zA-Z]{1,3}\.?$', elem_text))

            if is_empty or is_numeric or is_symbol_marker:
                # Look for content in following siblings
                sibling_content = []
                for sibling in elem.next_siblings:
                    if hasattr(sibling, 'name') and sibling.name:
                        # Stop if we hit another anchor with an id (start of next footnote)
                        if sibling.name == 'a' and sibling.get('id'):
                            break
                        sibling_content.append(str(sibling))
                    elif str(sibling).strip():
                        sibling_content.append(str(sibling).strip())
                if sibling_content:
                    return ''.join(sibling_content)

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

        # Strip leading footnote numbers from content
        content = self._strip_leading_footnote_number(content)

        # Wrap in <p> if not already wrapped in a block element
        if content and not content.startswith('<p') and not content.startswith('<div'):
            content = f'<p>{content}</p>'

        return content

    def _strip_leading_footnote_number(self, content):
        """
        Remove leading footnote numbers and symbol markers from content.

        Handles patterns like:
        - "5. Text..." -> "Text..."
        - "[5] Text..." -> "Text..."
        - "<a ...>5</a>. Text..." -> "Text..."
        - "<sup>5</sup>. Text..." -> "Text..."
        - "* Text..." -> "Text..."
        - "† Text..." -> "Text..."
        """
        import re
        from bs4 import BeautifulSoup, NavigableString

        if not content:
            return content

        # Parse the content to handle HTML properly
        soup = BeautifulSoup(content, 'html.parser')

        def strip_marker_element(container):
            """Strip leading marker element (<a> or <sup> with number or symbol) from container."""
            first_elem = None
            for child in container.children:
                if hasattr(child, 'name') and child.name:
                    first_elem = child
                    break
                elif isinstance(child, NavigableString) and str(child).strip():
                    # First non-whitespace is text, not a tag
                    break

            if first_elem and first_elem.name in ['a', 'sup']:
                elem_text = first_elem.get_text().strip()
                # Match numbers (1, 1.) or symbol markers (*, †, ‡, a, b, etc.)
                if re.match(r'^(\d+\.?|[\*†‡§¶#a-zA-Z]{1,3}\.?)$', elem_text):
                    # Get the next sibling to strip trailing ". "
                    next_sib = first_elem.next_sibling
                    first_elem.decompose()
                    # Strip trailing ". " from next text node
                    if next_sib and isinstance(next_sib, NavigableString):
                        text = str(next_sib)
                        next_sib.replace_with(re.sub(r'^[\.\s]+', '', text))
                    return True
            return False

        # Try stripping at top level
        strip_marker_element(soup)

        # Also check inside <p> tags
        for p_tag in soup.find_all('p'):
            strip_marker_element(p_tag)

        content = str(soup)

        # Strip plain text number and symbol patterns
        patterns = [
            r'^\s*\[\d+\]\s*\.?\s*',       # [5] or [5].
            r'^\s*\d+\.\s+',                # 5. (with space after)
            r'^\s*\d+\s*\)\s*',             # 5)
            r'^\s*\(\d+\)\s*',              # (5)
            r'^\s*[\*†‡§¶#]+\s*',           # *, †, ‡, etc.
        ]

        for pattern in patterns:
            content = re.sub(pattern, '', content, count=1)

        return content.strip()

    def _convert_noteref_element(self, elem, new_id, fn_count, soup):
        """Convert an in-text note reference to Hyperlit format."""
        # Canonical format: <sup fn-count-id="N" id="footnoteId" class="footnote-ref">N</sup>
        # No anchor inside - just text content directly in the sup element

        # Check if element is still in the document tree (might have been replaced already)
        if elem.parent is None:
            return  # Skip elements that were already removed/replaced

        # Strip whitespace before footnote marker (looks cleaner)
        prev = elem.previous_sibling
        if prev and isinstance(prev, NavigableString):
            stripped = prev.rstrip()
            if stripped != prev:
                prev.replace_with(NavigableString(stripped))

        if elem.name == 'sup':
            # Already a sup - clear and rebuild with canonical format
            elem.clear()
            elem['fn-count-id'] = str(fn_count)
            elem['id'] = new_id
            elem['class'] = 'footnote-ref'
            elem.string = str(fn_count)

        elif elem.name == 'a':
            # It's an <a>, replace with canonical sup format
            new_sup = soup.new_tag('sup')
            new_sup['fn-count-id'] = str(fn_count)
            new_sup['id'] = new_id
            new_sup['class'] = 'footnote-ref'
            new_sup.string = str(fn_count)
            elem.replace_with(new_sup)

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
    CSSClassHeadingDetector(),          # Convert CSS-classed <p> to headings (publisher formats)
    ImageProcessor(),                   # Copy images to storage, fix paths, convert to <figure>
    SectionUnwrapper(),                 # Unwrap section/div containers for node chunking

    # Phase 2: Footnote detection (multiple strategies, results accumulate)
    Epub3SemanticFootnoteDetector(),
    AriaRoleFootnoteDetector(),
    ClassPatternFootnoteDetector(),
    NotesClassFootnoteDetector(),       # Publisher format: <p class="notes"><a id="...">
    TableFootnoteDetector(),            # Table-based footnotes (Pluto Press, etc.)
    PandocFootnoteDetector(),
    EndnoteCharactersFootnoteDetector(),  # Word/Calibre EndnoteCharacters format
    EnoteFootnoteDetector(),               # Marxists.org enote class format
    HeuristicFootnoteDetector(),

    # Phase 3: Other content detection
    BibliographyDetector(),

    # Phase 4: Final normalization
    HeadingNormalizer(),
    DeadInternalLinkUnwrapper(),        # Remove dead internal links (runs AFTER footnote conversion)
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
            # Set context for transforms that need it
            if isinstance(transform, ImageProcessor):
                transform.set_context(self.book_id, self.output_dir)

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

        # Security: Sanitize footnote content before writing to JSON
        sanitized_footnotes = []
        for fn in footnotes_json:
            sanitized_fn = {
                'footnoteId': fn.get('footnoteId', ''),
                'content': sanitize_html(fn.get('content', ''))
            }
            sanitized_footnotes.append(sanitized_fn)

        footnotes_file = os.path.join(self.output_dir, 'footnotes.json')
        with open(footnotes_file, 'w', encoding='utf-8') as f:
            json.dump(sanitized_footnotes, f, indent=2, ensure_ascii=False)

        self._log(f"  Wrote {len(sanitized_footnotes)} footnotes to {footnotes_file}")

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

        # Build global ID map: original_id -> prefixed_id
        global_id_map = {}

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
                    # Generate prefix from file name to avoid duplicate IDs across chapters
                    file_prefix = os.path.splitext(os.path.basename(file_href))[0] + "_"

                    # Collect all IDs in this chapter (before prefixing)
                    local_ids = set()
                    for elem in item_body.find_all(id=True):
                        local_ids.add(elem['id'])
                    for elem in item_body.find_all(attrs={'name': True}):
                        if elem.name == 'a':
                            local_ids.add(elem['name'])

                    # Prefix all IDs to make them unique, add to global map
                    for elem in item_body.find_all(id=True):
                        orig_id = elem['id']
                        prefixed_id = file_prefix + orig_id
                        global_id_map[orig_id] = prefixed_id
                        elem['id'] = prefixed_id
                    for elem in item_body.find_all(attrs={'name': True}):
                        if elem.name == 'a':
                            orig_name = elem['name']
                            prefixed_name = file_prefix + orig_name
                            global_id_map[orig_name] = prefixed_name
                            elem['name'] = prefixed_name

                    # Fix internal links - same-file references get prefixed now
                    for a_tag in item_body.find_all('a', href=True):
                        href = a_tag['href']
                        if '#' in href:
                            target = href.split('#', 1)[-1]
                            if target in local_ids:
                                # Same-file reference - prefix immediately
                                a_tag['href'] = '#' + file_prefix + target

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

        # Second pass: Fix cross-file hrefs using the global ID map
        # Same-file references were already prefixed in the first pass
        for a_tag in body.find_all('a', href=True):
            href = a_tag['href']
            if '#' in href:
                # Check if this is already a prefixed reference (starts with #prefix_)
                # If so, skip it - it was already handled as a same-file reference
                fragment = href.split('#', 1)[-1]

                # If the fragment contains the original unprefixed ID, look it up
                if fragment in global_id_map:
                    a_tag['href'] = '#' + global_id_map[fragment]
                elif not href.startswith('#'):
                    # Has filename prefix (like "ch02.htm#n1") - strip and use fragment
                    a_tag['href'] = '#' + fragment

    def _load_from_epub_file(self):
        """Load EPUB content from a .epub file using EbookLib."""
        book = epub.read_epub(self.input_path)
        self._log(f"Title: {book.get_metadata('DC', 'title')}")

        self.combined_soup = BeautifulSoup(
            '<html><head><title>Combined EPUB</title></head><body></body></html>',
            'html.parser'
        )
        body = self.combined_soup.body

        # Build global ID map: original_id -> prefixed_id
        global_id_map = {}

        spine_items = [item for item in book.get_items() if item.get_type() == ITEM_DOCUMENT]
        self._log(f"Spine items: {len(spine_items)}")

        for item in spine_items:
            try:
                content = item.get_content().decode('utf-8')
                item_soup = BeautifulSoup(content, 'html.parser')
                item_body = item_soup.body if item_soup.body else item_soup

                if item_body:
                    # Generate prefix from item name to avoid duplicate IDs across chapters
                    item_name = item.get_name()
                    file_prefix = os.path.splitext(os.path.basename(item_name))[0] + "_"

                    # Collect all IDs in this chapter (before prefixing)
                    local_ids = set()
                    for elem in item_body.find_all(id=True):
                        local_ids.add(elem['id'])
                    for elem in item_body.find_all(attrs={'name': True}):
                        if elem.name == 'a':
                            local_ids.add(elem['name'])

                    # Prefix all IDs to make them unique, add to global map
                    for elem in item_body.find_all(id=True):
                        orig_id = elem['id']
                        prefixed_id = file_prefix + orig_id
                        global_id_map[orig_id] = prefixed_id
                        elem['id'] = prefixed_id
                    for elem in item_body.find_all(attrs={'name': True}):
                        if elem.name == 'a':
                            orig_name = elem['name']
                            prefixed_name = file_prefix + orig_name
                            global_id_map[orig_name] = prefixed_name
                            elem['name'] = prefixed_name

                    # Fix internal links - same-file references get prefixed now
                    for a_tag in item_body.find_all('a', href=True):
                        href = a_tag['href']
                        if '#' in href:
                            target = href.split('#', 1)[-1]
                            if target in local_ids:
                                a_tag['href'] = '#' + file_prefix + target

                    for img in item_body.find_all('img', src=True):
                        src = img['src']
                        if not src.startswith(('http', 'data:')):
                            item_dir = os.path.dirname(item_name)
                            img['src'] = os.path.normpath(os.path.join(item_dir, src))

                    for child in list(item_body.children):
                        if hasattr(child, 'name') and child.name:
                            body.append(child)

            except Exception as e:
                self._log(f"Error loading {item.get_name()}: {e}")

        # Second pass: Fix cross-file hrefs using the global ID map
        for a_tag in body.find_all('a', href=True):
            href = a_tag['href']
            if '#' in href:
                fragment = href.split('#', 1)[-1]
                if fragment in global_id_map:
                    a_tag['href'] = '#' + global_id_map[fragment]
                elif not href.startswith('#'):
                    a_tag['href'] = '#' + fragment


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

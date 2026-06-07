"""Phase 1 — structural normalisation. Opens up the publisher's HTML: unwraps Calibre
blockquotes/spans/sections, strips styling-only classes, removes empty spacers,
processes images, and drops dead internal links — so the later detectors see clean markup.
Run FIRST in TRANSFORM_PIPELINE. Each is an EpubTransform (detect()/transform())."""
import os
import re
import time
import random
import string
import json
from bs4 import BeautifulSoup, NavigableString
import bleach
from ingestion.epub.epub_base import EpubTransform


class NavStripper(EpubTransform):
    """Remove EPUB MACHINE-NAVIGATION <nav>s — epub:type 'page-list' (the 'go to page N' index) and
    'landmarks' (cover/bodymatter pointers). These are metadata, NOT reading content. Left in, they get
    unwrapped into the body as a bare <ol> of page numbers, and the footnote detector then matches those
    numbered page-anchors as footnote REFERENCES (rudolph1981finance: a 478-anchor page-list put 66 false
    <sup class="footnote-ref">PAGE</sup> markers at the front). Runs FIRST, before the footnote detectors,
    so the anchors never reach them. The table-of-contents nav (epub:type='toc') is KEPT — it's a reading
    aid and its anchors are TITLES, not numbers, so they don't masquerade as footnotes."""

    name = "NavStripper"
    description = "Remove page-list / landmarks navigation (machine metadata, not reading content)"
    plain = ('Drops EPUB machine-navigation <nav>s (epub:type page-list / landmarks) — the "go to page N" '
             'index and cover/bodymatter pointers. They are not content; left in, their numbered page-anchors '
             'get matched as footnotes. The reading TOC (epub:type=toc) is kept.')

    STRIP_TYPES = ('page-list', 'landmarks')

    def _is_machine_nav(self, nav):
        t = (nav.get('epub:type') or nav.get('role') or '').lower()
        return any(k in t for k in self.STRIP_TYPES)

    def detect(self, soup) -> bool:
        return any(self._is_machine_nav(n) for n in soup.find_all('nav'))

    def transform(self, soup, log) -> dict:
        removed, anchors = 0, 0
        for nav in list(soup.find_all('nav')):
            if self._is_machine_nav(nav):
                anchors += len(nav.find_all('a'))
                nav.decompose()
                removed += 1
        if removed:
            log(f"  Removed {removed} machine-navigation <nav>(s) ({anchors} page/landmark anchors) — not content")
        return {'navs_removed': removed, 'anchors_removed': anchors}


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

        # Find the project root = the dir holding Laravel's `artisan`, by walking UP from this file.
        # (Do NOT hardcode a .parent chain: this file moved from app/Python/ to app/Python/ingestion/epub/
        # in the folder reorg, and the old `.parent.parent.parent` then resolved to app/Python — so images
        # were copied to app/Python/storage/… which the web server never serves → every image 404'd and the
        # reader injected a broken-image-wrapper per image, churning integrity. The sentinel survives reorgs.)
        import pathlib
        here = pathlib.Path(__file__).resolve()
        # HYPERLIT_PROJECT_ROOT is set by the vibe APPLY: its re-conversion runs from a /tmp sandbox that has
        # no `artisan` to walk to, so without this ImageProcessor couldn't find the REAL storage — it bailed,
        # leaving raw epub_original paths (broken images) and never copying the files. The env points it at the
        # real repo so it writes to the live storage + rewrites URLs correctly. Falls back to the artisan walk.
        env_root = os.environ.get('HYPERLIT_PROJECT_ROOT')
        project_root = (pathlib.Path(env_root) if env_root and (pathlib.Path(env_root) / 'artisan').is_file()
                        else next((p for p in here.parents if (p / 'artisan').is_file()), None))

        # The copy needs a reachable storage dir; the URL REWRITE does not (it's the deterministic
        # /storage/books/<id>/images/<file>). So decouple them: when we can't find the project root we still
        # rewrite every <img> to the canonical URL (the original import already placed the files there) — we
        # just skip the physical copy, instead of bailing and leaving a broken raw path.
        storage_dir = None
        if project_root is not None:
            storage_dir = project_root / 'storage' / 'app' / 'public' / 'books' / self.book_id / 'images'
            storage_dir.mkdir(parents=True, exist_ok=True)
        else:
            log("  Warning: project root (artisan) not found; rewriting image URLs to /storage but NOT "
                "copying files (assuming they exist from the original import)")

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

            # Copy image to storage (only when a storage dir is reachable — see the decouple note above).
            filename = src_path.name
            if storage_dir is not None:
                dest_path = storage_dir / filename
                if not dest_path.exists():
                    import shutil
                    shutil.copy2(src_path, dest_path)
                    self.images_copied += 1

            # ALWAYS rewrite src to the canonical public URL (deterministic; the file is there from the
            # copy above OR from the original import).
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
        return bool(soup.find(['section', 'div', 'header', 'footer']))

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

        # Unwrap header and footer elements (structural wrappers in EPUBs)
        # These typically wrap headings but don't add semantic value after extraction
        for header in list(body.find_all('header')):
            header.unwrap()
            unwrapped += 1

        for footer in list(body.find_all('footer')):
            # Preserve footers that contain footnotes
            classes = footer.get('class', [])
            class_str = ' '.join(classes).lower() if classes else ''
            epub_type = footer.get('epub:type', '').lower()
            if not any(x in class_str or x in epub_type for x in ['footnote', 'endnote', 'note']):
                footer.unwrap()
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

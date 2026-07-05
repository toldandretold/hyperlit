"""EPUB ingestion orchestrator — runs TRANSFORM_PIPELINE to turn an .epub into main-text.html.

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
- AriaHiddenOrnamentRemover: Drops decorative aria-hidden scene-break ornaments (stray "—" nodes)
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
- BlindNotesFootnoteDetector: "Blind notes" — reversed back-link only, no in-text marker (PRH/InDesign)
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
from urllib.parse import unquote
from abc import ABC, abstractmethod
from ebooklib import epub, ITEM_DOCUMENT, ITEM_STYLE, ITEM_NAVIGATION
from bs4 import BeautifulSoup, NavigableString
import bleach

from digestion.footnoteLinking.footnote_link_rules import link_epub_footnotes
from ingestion.epub.styleProfiler import StyleProfiler, TocIndex, spine_id_prefix


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

# ===========================================================================
# PHASE MODULES (folders mirror the decision tree)
# The EpubTransform base lives in the epub_base.py leaf (zero internal imports,
# so the runpy-as-__main__ backend path cannot deadlock). The transform/detector
# classes live in phase-named siblings; both are re-exported here so
# TRANSFORM_PIPELINE, the EpubNormalizer orchestrator, and the visual-tree
# generators all see them under `epub_normalizer`.
# ===========================================================================
from ingestion.epub.epub_base import EpubTransform  # noqa: E402,F401
from ingestion.epub.structuralNormalisation import (  # noqa: E402,F401
    NavStripper,
    CalibreBlockquoteUnwrapper,
    EmptyElementRemover,
    AriaHiddenOrnamentRemover,
    SpanUnwrapper,
    ImageProcessor,
    SectionUnwrapper,
    CalibreClassStripper,
)
from ingestion.epub.headingMatching import (  # noqa: E402,F401
    CalibreSpanHeadingDetector,
    SectionNumberHeadingDetector,
    StyledSectionTitleHeadingDetector,
    DivToSemanticConverter,
    CSSClassHeadingDetector,
    StyleHeadingDetector,
)
from ingestion.epub.footnoteMatching import (  # noqa: E402,F401
    Epub3SemanticFootnoteDetector,
    AriaRoleFootnoteDetector,
    ClassPatternFootnoteDetector,
    NotesClassFootnoteDetector,
    BlindNotesFootnoteDetector,
    TableFootnoteDetector,
    PandocFootnoteDetector,
    EndnoteCharactersFootnoteDetector,
    EnoteFootnoteDetector,
    AnchoredFootnoteScheme,                # the declarative id-anchored family (vibe loop can op:register one)
    AnchorHeadingFootnoteDetector,
    InlineAnchorNoteFootnoteDetector,
    StyledSuperscriptFootnoteDetector,
    HeuristicFootnoteDetector,
    FootnoteConverter,
)
from ingestion.epub.bibliographyDetection import (  # noqa: E402,F401
    BibliographyDetector,
)
from ingestion.epub.finalNormalisation import (  # noqa: E402,F401
    HeadingNormalizer,
    DeadInternalLinkUnwrapper,
)




# =============================================================================
# TRANSFORM PIPELINE CONFIGURATION
# =============================================================================

# Order matters! Structural fixes first, then detection, then normalization
TRANSFORM_PIPELINE = [
    # Phase 1: Structural fixes (fix container abuse, unwrap fake elements)
    NavStripper(),                     # Drop page-list/landmarks machine-nav (else page anchors → false footnotes)
    CalibreBlockquoteUnwrapper(),      # Unwrap <blockquote class="calibreN">
    CalibreSpanHeadingDetector(),      # Convert <span class="calibre5/8"> to headings
    SectionNumberHeadingDetector(),    # Bold section-numbered <blockquote>/<div> (1.1. Title) → headings
    StyledSectionTitleHeadingDetector(),  # Bold section titles (BIBLIOGRAPHY/INDEX/NOTES…) → h1 (unblocks bib extraction)
    EmptyElementRemover(),              # Remove empty <div> and <p> spacers
    AriaHiddenOrnamentRemover(),        # Drop decorative aria-hidden scene-break ornaments (stray "—")
    SpanUnwrapper(),                    # Unwrap remaining styling-only spans
    CalibreClassStripper(),             # Strip calibreN classes from all elements
    StyleHeadingDetector(),             # FALLBACK: recover headings from the CSS font hierarchy — MUST run
                                        # before DivToSemanticConverter (which converts <div>→<p> + resets the
                                        # classNN this reads); after CalibreClassStripper (touches only calibreN)
    DivToSemanticConverter(),           # Convert semantic class divs to proper elements
    CSSClassHeadingDetector(),          # Convert CSS-classed <p> to headings (publisher formats)
    ImageProcessor(),                   # Copy images to storage, fix paths, convert to <figure>
    StyledSuperscriptFootnoteDetector(),  # CSS-superscript markers + numbered self-anchored defs — MUST run
                                        # before SectionUnwrapper (which div.unwrap()s the id-bearing def blocks)
    SectionUnwrapper(),                 # Unwrap section/div containers for node chunking

    # Phase 2: Footnote detection (multiple strategies, results accumulate)
    Epub3SemanticFootnoteDetector(),
    AriaRoleFootnoteDetector(),
    ClassPatternFootnoteDetector(),
    NotesClassFootnoteDetector(),       # Publisher format: <p class="notes"><a id="...">
    BlindNotesFootnoteDetector(),        # Blind notes: reversed "GO TO NOTE…" back-link, no in-text marker (PRH)
    TableFootnoteDetector(),            # Table-based footnotes (Pluto Press, etc.)
    PandocFootnoteDetector(),
    EndnoteCharactersFootnoteDetector(),  # Word/Calibre EndnoteCharacters format
    EnoteFootnoteDetector(),               # Marxists.org enote class format
    AnchorHeadingFootnoteDetector(),       # <hN id=X>Note N</hN> + content, linked by <a href=#X>
    InlineAnchorNoteFootnoteDetector(),    # empty <a id=X></a> + following note block, linked by <a href=#X><sup>
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

def _report_detector_error(transform, exc, log):
    """A TRANSFORM_PIPELINE detector raised at runtime. Log it loudly to the debug file AND emit a
    `[detector-error]` line + a short traceback to stderr — the vibe loop captures that and feeds the exact
    exception back to the model so it can fix its detector (instead of seeing a blank all-zeros conversion).
    The caller skips this one detector and continues, so a single bad detector is never fatal."""
    import traceback
    name = getattr(transform, 'name', type(transform).__name__)
    head = f"[detector-error] {name} raised {type(exc).__name__}: {exc}"
    tail = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__)[-3:])
    try:
        log(f"\n⚠ {head}\n{tail}")
    except Exception:
        pass
    print(head, file=sys.stderr)
    print(tail, file=sys.stderr)


def _count_footnote_markers(soup):
    """Count candidate footnote MARKERS (noterefs) in the soup — anchors whose href targets a footnote-ish
    id, plus epub:type=noteref elements. Used by the structural-fidelity check: a big DROP across the
    Phase-1 structural transforms means a cleanup step DETACHED noterefs before detection could use them."""
    seen = set()
    for a in soup.find_all('a', href=True):
        href = a.get('href', '')
        if href.startswith('#') and re.search(r'(?:fn|ftn|foot|note|end|ref)', href, re.I):
            seen.add(id(a))
    for el in soup.find_all(attrs={'epub:type': True}):
        if 'noteref' in str(el.get('epub:type', '')).lower():
            seen.add(id(el))
    return len(seen)


def _document_profile(soup):
    """A STRUCTURAL FINGERPRINT of the RAW combined EPUB — the tags + classes the publisher actually used,
    captured BEFORE the transform pipeline strips/rewrites them. Cheap (one pass). Two uses: (1) a snapshot
    a human (or the diagnostic LLM) can read to see how THIS book fakes structure — e.g. headings as bold
    styled <p>, calibre_NN classes, a toc class; (2) the basis for the 'is this a scheme we handle?' read —
    a high `bold_short_blocks` with near-zero `semantic_headings` means the headings are faked and may be
    unrecognised. The falsifiable structure-vs-OUTPUT contradiction (e.g. reference-shaped paragraphs not
    extracted) is computed downstream in digestion (process_document StructuralCoverageAssessment), which is
    where the produced counts live."""
    from collections import Counter
    body = soup.body if soup.body else soup
    tags, classes = Counter(), Counter()
    bold_short = 0
    for el in body.find_all(True):
        tags[el.name] += 1
        for c in (el.get('class') or []):
            classes[f'{el.name}.{c}'] += 1
        if el.name in ('p', 'blockquote', 'div'):
            if (el.find(['b', 'strong']) or el.find('span', class_='bold')):
                t = el.get_text(strip=True)
                if t and len(t) < 80 and not el.find(['p', 'div', 'blockquote', 'table']):
                    bold_short += 1
    semantic_headings = sum(tags.get(f'h{i}', 0) for i in range(1, 7))
    return {
        'tag_histogram': dict(tags.most_common()),
        'top_classes': dict(classes.most_common(40)),
        'shape_signals': {
            'semantic_headings': semantic_headings,        # real <h1>-<h6> the publisher used (often 0)
            'bold_short_blocks': bold_short,               # heading-LOOKING styled <p>/<blockquote> (faked headings)
            'paragraphs': tags.get('p', 0),
            'blockquotes': tags.get('blockquote', 0),
            'divs': tags.get('div', 0),
        },
    }


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
        # The base images resolve against. Normally output_dir (== the book dir on a normal import, so
        # images resolve). The vibe APPLY writes to a SEPARATE temp out dir, so it sets HYPERLIT_SOURCE_ROOT
        # to the book dir (which holds epub_original/) — otherwise images can't be found and srcs come out as
        # broken ../../../-to-epub_original paths. Env-gated so ONLY the apply changes; normal import +
        # the regression harness are untouched.
        self.source_root = os.environ.get('HYPERLIT_SOURCE_ROOT') or output_dir
        self.book_id = book_id or f"book_{int(time.time())}"
        self.is_directory = os.path.isdir(input_path)
        self.combined_soup = None
        self.debug_log = None
        self.results = {}  # Accumulated results from all transforms
        # The "universal key" for cooked EPUBs — populated by the loaders (CSS + toc.ncx collection),
        # consumed by style-driven detectors via set_style_context(). None/empty ⇒ those detectors no-op.
        self._raw_css = ""
        self._toc_ncx_xml = None
        self.style_profiler = None
        self.toc_index = None

    def _progress(self, pct, stage, detail=""):
        """Emit a machine-readable progress line for the PHP job runner."""
        import json as _json
        print("PROGRESS:" + _json.dumps({"percent": pct, "stage": stage, "detail": detail}), flush=True)

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
                self._progress(5, "epub_load", "Loading EPUB content")
                if self.is_directory:
                    self._load_from_directory()
                else:
                    self._load_from_epub_file()

                # Build the "universal key" from the collected CSS + toc.ncx. Both no-op gracefully when
                # absent (the whole existing corpus has no CSS), so style-driven detectors stay inert there.
                self.style_profiler = StyleProfiler.from_css_text(self._raw_css)
                self.toc_index = TocIndex.from_ncx(self._toc_ncx_xml)
                if self.style_profiler.has_css:
                    self._log(f"StyleProfiler: {len(self.style_profiler._class_rules)} class styles parsed; "
                              f"TocIndex: {self.toc_index.navpoint_count} navPoints")

                # Step 1b: Snapshot the RAW structural fingerprint (tags + classes the publisher used) BEFORE
                # the pipeline strips them — a human/LLM-readable record of how this book fakes structure.
                try:
                    if self.combined_soup is not None:
                        profile = _document_profile(self.combined_soup)
                        with open(os.path.join(self.output_dir, 'document_profile.json'), 'w', encoding='utf-8') as f:
                            json.dump(profile, f, ensure_ascii=False, indent=2)
                        self._log(f"Document profile: {profile['shape_signals']}")
                except Exception as e:
                    self._log(f"Warning: could not write document_profile.json: {e}")

                # Step 2: Run transform pipeline
                self._log("\n--- Running Transform Pipeline ---")
                self._progress(15, "epub_transforms", "Normalizing document structure")
                self._run_pipeline()
                self._progress(30, "epub_transforms", "Transforms complete")

                # Step 3: Convert footnotes to Hyperlit format
                self._log("\n--- Converting Footnotes ---")
                self._progress(35, "epub_footnotes", "Detecting footnotes")
                self._convert_footnotes()
                fn_count = len(self.results.get('footnotes_json', []))
                self._progress(35, "epub_footnotes", f"Detected {fn_count} footnotes")

                # Step 4: Sanitize for security
                self._log("\n--- Sanitizing HTML ---")
                self._progress(40, "epub_sanitize", "Sanitizing HTML")
                final_html = str(self.combined_soup)
                sanitized_html = sanitize_html(final_html)
                self._log(f"Sanitized: {len(final_html)} -> {len(sanitized_html)} chars")

                # Step 5: Write output
                self._log("\n--- Writing Output ---")
                self._progress(43, "epub_write", "Writing output files")
                output_file = os.path.join(self.output_dir, 'main-text.html')
                with open(output_file, 'w', encoding='utf-8') as f:
                    f.write(sanitized_html)
                self._log(f"Output: {output_file}")

                # Step 6: Write footnotes.json
                self._write_footnotes_json()
                self._progress(45, "epub_complete", "EPUB normalization complete")

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
        # Running guards for the footnote accumulation below: dedupe by ID *and* by source
        # element identity. The element guard is the structural invariant — see the comment
        # at the accumulation site.
        seen_fn_ids = set()
        seen_fn_elements = set()
        self._fn_element_dups = 0

        # Track every footnote DETECTOR's detect() verdict (and how many it found) so the
        # assessment can record the "considered but rejected" set — the detectors that ran
        # and matched nothing. detect() is captured at the detector's own position in the
        # pipeline, which is the real decision (the soup mutates as we go).
        fn_detector_results = []

        # Structural-transform FIDELITY: snapshot the footnote-marker count of the RAW combined soup, then
        # again right before the FIRST footnote detector runs (i.e. after the Phase-1 structural transforms).
        # A big drop means a structural cleanup step detached noterefs before detection — recorded as a
        # flagged fork in _write_assessment so the fix-loop is sent to structuralNormalisation.py.
        self._markers_before = _count_footnote_markers(self.combined_soup)
        self._markers_after_structural = None
        self._last_structural = None

        for transform in TRANSFORM_PIPELINE:
            if self._markers_after_structural is None and transform.name.endswith('FootnoteDetector'):
                self._markers_after_structural = _count_footnote_markers(self.combined_soup)
            elif self._markers_after_structural is None:
                self._last_structural = transform.name   # the last Phase-1 transform before detection
            # Set context for transforms that need it. output_dir is where the
            # media/ handoff dir goes (BookImageStore ingests from {output_dir}/media).
            if isinstance(transform, ImageProcessor):
                transform.set_context(self.book_id, self.source_root, self.output_dir)
            # Hand style-driven detectors the parsed CSS + toc.ncx (duck-typed, so any future
            # style-aware transform opts in just by defining set_style_context).
            if hasattr(transform, 'set_style_context'):
                transform.set_style_context(self.style_profiler, self.toc_index)

            detected = False
            found_here = 0
            try:
                detected = transform.detect(self.combined_soup)
                if detected:
                    self._log(f"\n[{transform.name}]")
                    result = transform.transform(self.combined_soup, self._log)

                    # Accumulate footnotes from all detectors
                    if 'footnotes' in result:
                        found_here = len(result['footnotes'])
                        for fn in result['footnotes']:
                            fid = fn.get('id')
                            elem = fn.get('element')
                            # Deduplicate by ID (same note found by two detectors).
                            if fid in seen_fn_ids:
                                continue
                            # STRUCTURAL INVARIANT — one source element = one footnote definition.
                            # A footnote's content is serialized FROM its element, so two footnotes
                            # built from the SAME element produce identical content; the second can
                            # never win an in-text marker and just orphans. This catches the whole
                            # duplicate-definition class UPSTREAM of any single detector — including a
                            # future vibe-registered one that slips — not just the dual-id shape that
                            # bit edward2016orientalism (<p class="footnote" id> + child <a id>, both
                            # registered → 835 defs for 414 notes). Recorded (never silent): the count
                            # rides into the assessment so a real multi-note CONTAINER mis-modelled as
                            # one element shows up as dropped notes rather than passing unnoticed.
                            if elem is not None and id(elem) in seen_fn_elements:
                                self._fn_element_dups += 1
                                self._log(f"    [dedup] dropped footnote id={fid}: shares its source "
                                          f"element with an already-registered note (duplicate definition)")
                                continue
                            seen_fn_ids.add(fid)
                            if elem is not None:
                                seen_fn_elements.add(id(elem))
                            all_footnotes.append(fn)

                    if 'noterefs' in result:
                        # Deduplicate by element identity (same DOM node found by multiple detectors)
                        seen_noteref_elements = {id(nr['element']) for nr in all_noterefs if nr.get('element')}
                        for nr in result['noterefs']:
                            elem = nr.get('element')
                            if elem and id(elem) not in seen_noteref_elements:
                                seen_noteref_elements.add(id(elem))
                                all_noterefs.append(nr)
                            elif not elem:
                                all_noterefs.append(nr)

                    # Store other results
                    self.results[transform.name] = result
            except Exception as e:
                # RESILIENCE: one detector throwing must NOT kill the whole conversion — skip it, keep the
                # rest running. Critical for the vibe loop (a model-ADDED detector that crashes would
                # otherwise wipe the conversion to all-zeros) and for production (a real book that trips one
                # detector's edge case still converts via the others). The [detector-error] line is fed back
                # to the model so it can fix its detector.
                _report_detector_error(transform, e, self._log)
                detected, found_here = False, 0

            if transform.name.endswith('FootnoteDetector'):
                fn_detector_results.append(
                    {'name': transform.name, 'detected': bool(detected), 'found': found_here})

        self.results['all_footnotes'] = all_footnotes
        self.results['all_noterefs'] = all_noterefs
        self.results['fn_detector_results'] = fn_detector_results

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
        self._write_assessment(all_footnotes, all_noterefs, converter._linking_stats)

    # Maps a detected footnote's `strategy` tag back to the responsible detector class,
    # so the decision-trace `code_ref` points an LLM/human straight at the module.
    _STRATEGY_DETECTOR = {
        'epub3_semantic': 'Epub3SemanticFootnoteDetector', 'aria_role': 'AriaRoleFootnoteDetector',
        'class_pattern': 'ClassPatternFootnoteDetector', 'notes_class': 'NotesClassFootnoteDetector',
        'blind_notes': 'BlindNotesFootnoteDetector',
        'table_footnote': 'TableFootnoteDetector', 'pandoc': 'PandocFootnoteDetector',
        'endnote_characters': 'EndnoteCharactersFootnoteDetector', 'enote_class': 'EnoteFootnoteDetector',
        'anchor_heading': 'AnchorHeadingFootnoteDetector', 'reverse_definition': 'FootnoteConverter (reverse-definition)',
    }

    # The markup each footnote detector keys on — the `would_need` for the "considered but
    # rejected" set. For an EPUB that yields NO footnotes, this list IS the diagnostic: it
    # tells the LLM exactly which note-markup shapes were searched for and matched nothing,
    # to compare against what the source actually contains.
    _DETECTOR_NEEDS = {
        'Epub3SemanticFootnoteDetector': 'epub:type="footnote"/"noteref" attributes (EPUB3 W3C semantics)',
        'AriaRoleFootnoteDetector': 'role="doc-footnote"/"doc-noteref" ARIA attributes',
        'ClassPatternFootnoteDetector': 'elements with footnote/endnote/fn CSS class names',
        'NotesClassFootnoteDetector': '<p class="notes"> definitions with a child anchor that has a backlink',
        'BlindNotesFootnoteDetector': 'a back-of-book note (<ol class="blindnotes">) whose only link is a reversed <p class="link_to_text"><a href="#X"> back-link to an empty <span id="X"/> in-text anchor (no forward marker)',
        'TableFootnoteDetector': 'a table whose class or first-cell anchors mark it as footnotes',
        'PandocFootnoteDetector': '<section class="footnotes"> or <div class="footnotes"> (Pandoc/standard HTML)',
        'EndnoteCharactersFootnoteDetector': '<span class="EndnoteCharacters"> (InDesign export)',
        'EnoteFootnoteDetector': '<sup class="enote…"> superscript markers',
        'AnchorHeadingFootnoteDetector': '<hN id=X>Note N</hN> definitions linked by an <a href="#X"> marker',
        'InlineAnchorNoteFootnoteDetector': 'empty <a id=X></a> + following note block, linked by an <a href="#X"><sup> marker',
        'StyledSuperscriptFootnoteDetector': 'CSS-superscript <a href="#X">N</a> markers (vertical-align:super) + numbered self-anchored <div id="X">N. text</div> defs (obfuscated EPUBs)',
        'HeuristicFootnoteDetector': 'numbered-list / superscript heuristics (always-on fallback)',
    }

    # Human-readable notes (the `plain` convention) for the two EPUB tree nodes, used both in the
    # fork-records (node_help) and by the notes generator / LLM failure report.
    _DETECTION_PLAIN = (
        "Find which markup SCHEME marks this EPUB's footnotes — epub3 semantic (epub:type), ARIA role, "
        "CSS class, anchor heading, notes class, table, etc. — then link each marker to its definition "
        "by id. EPUB detects by markup, not physical layout. Classic failure: the source uses a scheme "
        "no specific detector matches, so only the always-on heuristic fires (less reliable).")
    _LINKING_PLAIN = (
        "Detection found the definitions — but did a surviving in-text marker actually link to each? A "
        "large orphaned share means the noteref markers were absent or detached before conversion: route "
        "fixes to FootnoteConverter, NOT the detectors (detection can read 'success' while linking drops "
        "notes).")
    _STRUCTURAL_PLAIN = (
        "Before any footnote detection, 'open up' the publisher's messy HTML: unwrap Calibre fake "
        "blockquotes/spans, strip styling-only classes, relocate images, and unwrap section "
        "containers. This runs FIRST because the detectors match on clean structure — and the soup "
        "keeps mutating, so order matters.")
    _HEADINGS_PLAIN = (
        "Publishers rarely use real <h1>/<h2>/<h3> for titles — they fake them with big fonts, bold "
        "spans, or styled divs. These detectors (Phase 1, before footnotes) recover the real heading "
        "level so the document's outline survives into the markdown/HTML. Each fires if its markup is "
        "present; HeadingNormalizer then fixes any level GAPS (h1 → h4 becomes h1 → h2).")
    _OVERVIEW_PLAIN = (
        "The whole EPUB ingestion job — turn a publisher's .epub into one clean main-text.html for "
        "digestion. It is NOT just footnote detection: ⓪ unzip the .epub + combine its spine documents "
        "into one HTML, ① structurally normalise (unwrap Calibre/publisher cruft), ② recover real "
        "headings (h1/h2/h3) from faked ones, ③ detect the footnote SCHEME (run-all markup detectors), "
        "④ mark the bibliography section, ⑤ final-normalise (heading gaps + dead links). Each phase is "
        "its own file (folders mirror the tree); expand to see them. Footnote/citation LINKING and "
        "bibliography extraction happen later in digestion.")
    _LOAD_PLAIN = (
        "Step 0 — before anything else: an .epub is a ZIP. Unzip it, read META-INF/container.xml to find "
        "the OPF, then read the OPF's manifest + SPINE (the publisher's reading order), and concatenate "
        "the spine's XHTML documents — in spine order — into ONE combined HTML soup. Every later phase "
        "operates on that single combined document. (`_load_from_epub_file` for a .epub; "
        "`_load_from_directory` for an already-extracted folder.) Classic failure: spine order ignored or "
        "a document missing → chapters out of order or dropped.")
    _BIBDETECT_PLAIN = (
        "Phase 3 — find WHERE the references/bibliography section is (via epub:type=\"bibliography\", "
        "ARIA role=\"doc-bibliography\", or a heading like 'References'/'Bibliography'). This only MARKS "
        "the section in the EPUB; pulling out the individual entries and linking (Author Year) citations "
        "to them happens centrally in digestion/, not here. Lives in bibliographyDetection.py.")
    _FINALNORM_PLAIN = (
        "Phase 4 — run LAST, after detection: HeadingNormalizer closes heading-level gaps (h1 → h4 "
        "becomes h1 → h2) and DeadInternalLinkUnwrapper unwraps <a> links whose target no longer exists. "
        "These touch the whole document, so they run once everything else has settled. The two classes "
        "live in headingMatching.py and structuralNormalisation.py respectively.")
    # The heading-detection strategies (Phase 1) — recover real <h1>/<h2>/<h3> from the varied ways
    # publishers fake headings. Keyed by class name → the markup-and-level map each one looks for.
    _HEADING_NEEDS = {
        'CalibreSpanHeadingDetector': 'font-sized <span> classes → calibre5 (1.67em) → h1, '
                                      'calibre8 (1.29em) → h2, bold → h3',
        'SectionNumberHeadingDetector': 'bold section-numbered <blockquote>/<div> (1.→h1, 1.1.→h2, '
                                        '2.3.2.1.→h4; PART/CHAPTER → h1) — the non-<p> wrapper scheme',
        'StyledSectionTitleHeadingDetector': 'bold section-title <p>/<blockquote> (BIBLIOGRAPHY, REFERENCES, '
                                             'NOTES, INDEX, APPENDIX…) → h1 — unblocks bibliography extraction',
        'CSSClassHeadingDetector': 'CSS-classed <p> → title/fmtitle/bmtitle/con → h1, publisher '
                                   'h1 → h3, h2 → h4 (publisher classes are RELATIVE, not HTML levels)',
        'DivToSemanticConverter': 'styled <div> classes (USFM/publisher) → mt/mt1 → h1, mt2 → h2, '
                                  's/s1 → h3, psalmlabel → h2; or a numbered class (heading2 → h2)',
        'StyleHeadingDetector': 'CSS font HIERARCHY (obfuscated EPUBs): rank styles by prominence vs the body '
                                'baseline (size/weight/family/centre/caps) → tiers become h1/h2/h3, anchored '
                                'by toc.ncx; fallback, only on a TOC shortfall',
    }

    def _write_assessment(self, all_footnotes, all_noterefs, linking=None):
        """Emit the EPUB stage's footnote forks to assessment.json: (1) which DETECTOR identified
        the notes + the "considered but rejected" set, and (2) the LINKING outcome — how many
        detected definitions actually received a surviving in-text link vs were orphaned. (2) is
        the signal that was missing: detection can read 'success' while linking silently drops
        notes, mis-routing a fixer to the detectors instead of FootnoteConverter.
        process_document.py seeds from this file so the final trace spans the whole pipeline."""
        from collections import Counter
        fn_results = self.results.get('fn_detector_results', [])
        fired = [r['name'] for r in fn_results if r['detected'] and r['found'] > 0]
        # Roads not taken: footnote detectors that matched nothing (skip the always-on heuristic).
        considered = [
            {'option': f"identify footnotes via {r['name']}",
             'rejected_because': ('detect() matched but it extracted 0 definitions' if r['detected']
                                  else 'its structural signal was absent in this EPUB'),
             'would_need': self._DETECTOR_NEEDS.get(r['name'], 'its target markup')}
            for r in fn_results
            if (not r['detected'] or r['found'] == 0) and r['name'] != 'HeuristicFootnoteDetector'
        ]
        by_strategy = Counter(fn.get('strategy', 'unknown') for fn in all_footnotes)
        records = []
        if not all_footnotes:
            records.append({
                'seq': 0, 'module': 'epub_footnote_detection',
                'code_ref': 'footnoteMatching.py:HeuristicFootnoteDetector',
                'decision': 'no footnotes detected',
                'rationale': f'{len(all_noterefs)} reference(s) seen but 0 definitions resolved by any '
                             f'of {len(fn_results)} footnote detectors',
                'evidence': {'noterefs': len(all_noterefs), 'detectors_run': len(fn_results),
                             'detector_results': fn_results},
                'question': "Which detector identifies this EPUB's footnotes?",
                'considered': considered,
                'node_help': self._DETECTION_PLAIN,
                'confidence': 0.0,
                'margin': 'FALL-THROUGH: 0 definitions from any detector — compare the source note markup '
                          'against each considered detector\'s would_need (the shapes searched for)'})
        else:
            only_heuristic = fired == ['HeuristicFootnoteDetector']
            records.append({
                'seq': 0, 'module': 'epub_footnote_detection',
                'code_ref': f'footnoteMatching.py:{fired[0] if fired else "HeuristicFootnoteDetector"}',
                'decision': f'{len(all_footnotes)} footnote(s) via {", ".join(fired) or "heuristic fallback"}',
                'rationale': 'detector(s) matched the source markup',
                'evidence': {'total_footnotes': len(all_footnotes), 'by_strategy': dict(by_strategy),
                             'duplicate_defs_dropped': getattr(self, '_fn_element_dups', 0),
                             'detector_results': fn_results},
                'question': "Which detector identifies this EPUB's footnotes?",
                'considered': considered,
                'node_help': self._DETECTION_PLAIN,
                'confidence': 0.5 if only_heuristic else 0.85,
                'margin': ('only the always-on Heuristic fallback fired — a specific detector would be '
                           'more reliable; verify against the considered shapes' if only_heuristic
                           else f'{len(fired)} specific detector(s) matched: {", ".join(fired)}')})
            # Granular per-strategy counts (attribution to each responsible detector).
            for strat, n in by_strategy.items():
                det = self._STRATEGY_DETECTOR.get(strat.split('_')[0] if strat.startswith('heuristic') else strat,
                                                  'HeuristicFootnoteDetector' if strat.startswith('heuristic') else strat)
                records.append({'seq': len(records), 'module': 'epub_footnote_detection',
                                'code_ref': f'footnoteMatching.py:{det}',
                                'decision': f'{n} footnote definition(s) via {strat}',
                                'rationale': f'{det} matched the source markup',
                                'evidence': {'count': n, 'strategy': strat}})
        # (2) The LINKING outcome — the signal that was missing. A large orphaned share means
        # detection found the definitions but FootnoteConverter linked no surviving in-text marker
        # to them (their noterefs were absent or detached before conversion) — route fixes HERE.
        if linking and linking.get('detected_footnotes'):
            od, tot = linking['orphaned_defs'], linking['detected_footnotes']
            faulty = od > max(2, 0.05 * tot)
            records.append({
                'seq': len(records), 'module': 'footnote_linking',
                'code_ref': 'footnoteMatching.py:FootnoteConverter.convert',
                'node_help': self._LINKING_PLAIN,
                'decision': (f"{linking['linked']} reference(s) linked; {od} definition(s) ORPHANED"
                             if faulty else f"all {tot} definition(s) linked"),
                'rationale': ('detection found the definitions, but FootnoteConverter linked no '
                              'surviving in-text reference to these — their noteref elements were '
                              'absent or detached (parent=None) before conversion'
                              if faulty else 'every detected definition received a surviving in-text link'),
                'evidence': linking,
                'question': 'Did every detected footnote definition get a surviving in-text link?',
                'considered': ([{
                    'option': 'link these definitions',
                    'rejected_because': 'no surviving noteref resolved to their id at conversion time',
                    'would_need': 'an in-text element pointing to the definition id that SURVIVES to '
                                  'FootnoteConverter — check _convert_noteref_element skips (parent=None) '
                                  'and the transform order that may detach noterefs before linking'}]
                    if faulty else []),
                'confidence': round(max(0.0, 1 - od / max(tot, 1)), 2),
                'margin': (f'{od} of {tot} definitions have NO in-text link — DETECTION succeeded but '
                           f'LINKING dropped them (fix FootnoteConverter, not the detectors)'
                           if faulty else f'all {tot} definitions linked — sound')})
        # (3) STRUCTURAL fidelity — did a Phase-1 cleanup step DETACH footnote markers before detection
        # could use them? (The EPUB analogue of the PDF harvest-fidelity check.) Conservative: only fires
        # on a material drop, so a doc that simply has few/no markers is never flagged.
        mb = getattr(self, '_markers_before', 0) or 0
        ma = getattr(self, '_markers_after_structural', None)
        if ma is not None and mb >= 5 and ma < mb * 0.5:
            records.append({
                'seq': len(records), 'module': 'epub_structural_fidelity',
                'code_ref': 'structuralNormalisation.py',
                'node_help': self._STRUCTURAL_PLAIN,
                'decision': f'{mb - ma} of {mb} footnote marker(s) DETACHED during structural normalisation',
                'rationale': (f'the raw EPUB had {mb} footnote-marker anchors, but only {ma} survived the '
                              f'Phase-1 structural transforms (last: {self._last_structural}) before footnote '
                              f'detection ran. A structural cleanup step unwrapped/removed the noterefs, so '
                              f'detection + linking can never wire them — fix the structural transform, not '
                              f'the detector.'),
                'evidence': {'markers_raw': mb, 'markers_after_structural': ma,
                             'last_structural_transform': self._last_structural},
                'question': 'Did a structural cleanup step detach footnote markers before detection?',
                'confidence': 0.3,
                'margin': f'{mb}->{ma} markers across structural normalisation — a transform dropped noterefs'})
        try:
            with open(os.path.join(self.output_dir, 'assessment.json'), 'w', encoding='utf-8') as f:
                json.dump({'records': records}, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self._log(f"  Could not write assessment.json: {e}")

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

        # Collect the stylesheet(s) + toc.ncx for the StyleProfiler / TocIndex (the "universal key").
        # Best-effort: a missing/broken CSS or ncx must NEVER break the conversion (the style detectors
        # just no-op without it). Resolve hrefs relative to the OPF dir.
        try:
            css_parts = []
            for item in root.findall('.//manifest/item'):
                mtype = (item.get('media-type') or '').strip().lower()
                href = item.get('href')
                if not href:
                    continue
                path = os.path.normpath(os.path.join(opf_dir, unquote(href)))
                if mtype == 'text/css' and os.path.exists(path):
                    with open(path, 'r', encoding='utf-8', errors='replace') as cf:
                        css_parts.append(cf.read())
                elif mtype == 'application/x-dtbncx+xml' and self._toc_ncx_xml is None and os.path.exists(path):
                    with open(path, 'r', encoding='utf-8', errors='replace') as nf:
                        self._toc_ncx_xml = nf.read()
            self._raw_css = "\n".join(css_parts)
        except Exception as e:
            self._log(f"Warning: CSS/toc collection failed: {e}")

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
            # OPF manifest hrefs are percent-encoded URIs (e.g. "Chapter%2001.xhtml" for a file
            # named "Chapter 01.xhtml"). Decode before touching the filesystem, or files with spaces
            # in their names silently fail os.path.exists and get dropped from the spine. NOTE: keep the
            # ENCODED file_href for spine_id_prefix below — TocIndex feeds the equally-encoded ncx src
            # to the same helper, so both sides must derive the prefix from the same (encoded) form.
            file_path = os.path.normpath(os.path.join(opf_dir, unquote(file_href)))

            if not os.path.exists(file_path):
                continue

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()

                item_soup = BeautifulSoup(content, 'html.parser')
                item_body = item_soup.body if item_soup.body else item_soup

                if item_body:
                    # Generate prefix from file name to avoid duplicate IDs across chapters
                    # (SHARED with TocIndex via spine_id_prefix so toc.ncx targets resolve identically).
                    file_prefix = spine_id_prefix(file_href)

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
                            # Relative to the SOURCE root (holds epub_original/), NOT output_dir — so the apply's
                            # temp out dir can't turn this into a ../../../ path ImageProcessor then rejects.
                            final_path = os.path.relpath(os.path.join(opf_dir, img_path), self.source_root)
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

        # Collect stylesheet(s) + toc.ncx for the StyleProfiler / TocIndex. Best-effort (never fatal).
        try:
            css_parts = []
            for item in book.get_items_of_type(ITEM_STYLE):
                try:
                    css_parts.append(item.get_content().decode('utf-8', errors='replace'))
                except Exception:
                    pass
            self._raw_css = "\n".join(css_parts)
            for item in book.get_items_of_type(ITEM_NAVIGATION):
                try:
                    self._toc_ncx_xml = item.get_content().decode('utf-8', errors='replace')
                    break
                except Exception:
                    pass
        except Exception as e:
            self._log(f"Warning: CSS/toc collection failed: {e}")

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
                    file_prefix = spine_id_prefix(item_name)

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

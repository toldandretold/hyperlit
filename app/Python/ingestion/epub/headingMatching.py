r"""Phase 1 — heading matching. Recovers real h1/h2/h3 from publisher-faked headings
(font-sized Calibre spans, CSS-classed <p>, styled <div>s) and then normalises the
heading hierarchy to remove level gaps. Runs BEFORE footnote detection — see
EpubNormalizer._HEADING_NEEDS for the markup -> level rules each detector applies.

═══════════════════════════════════════════════════════════════════════════════════════
HOW EPUBs FAKE HEADINGS — and how to add a detector when a book's scheme isn't captured
═══════════════════════════════════════════════════════════════════════════════════════
EPUBs almost never use semantic <h1>–<h6>. Publishers (and Calibre's HTML export) render
headings as ordinary blocks given a *visual* style — font-size, bold, a CSS class, a
container tag. Each distinct styling is a SCHEME, and each scheme gets its own detector
(an `EpubTransform`) registered in `TRANSFORM_PIPELINE` in epub_normalizer.py. A heading is
"lost" (stays a <p>/<blockquote> in the output, 0 h-nodes) when a book uses a scheme no
detector recognises — the symptom is `_count_headings` == 0 while the TOC (toc.ncx) clearly
lists a hierarchy.

Schemes currently handled (detector → signal → level rule):
  • CalibreSpanHeadingDetector  — <p> whose ONLY child is <span class="calibre5|calibre8|bold">;
                                   font-size class → level (calibre5≈h1, calibre8≈h2, bold→h3).
  • DivToSemanticConverter      — <div class="…heading…|title|mt/mt1/s1/…"> (incl. Bible USFM);
                                   class name → level; VOLUME/PART/BOOK forced to h1.
  • CSSClassHeadingDetector     — <p class="h|fmtitle|title|ch-num+ch-title|…">; publisher class
                                   names are RELATIVE (class="h1" is a SUBSECTION → real h3).

Schemes NOT yet handled (each is a candidate for a new detector — the recipe is below):
  • SECTION-NUMBERED BOLD BLOCKS in a non-<p> wrapper. e.g. Routledge/Calibre exports
    (christian2014digital): the heading is
        <blockquote class="calibre_21"><a><span class="bold">1.1. The Need for …</span></a></blockquote>
    All THREE handled detectors miss it because (a) they scan find_all('p') only — never
    <blockquote>; and (b) CalibreBlockquoteUnwrapper's regex is `^calibre\d*$`, which does NOT
    match the UNDERSCORE variant `calibre_21`, so the wrapper survives as a <blockquote>. The
    level is recoverable WITHOUT any class, from the dotted numbering itself: `1.`→h1, `1.1.`→h2,
    `2.3.2.1.`→h4 (depth = dot-count), and `PART <ROMAN>`/`CHAPTER N`→h1. Discriminate real
    headings from body text that merely starts with a digit ("711 Third Avenue", a cataloguing
    line "1. Knowledge workers…") by requiring BOTH the numbered/PART pattern AND a bold child
    AND a short length — the body false-positives are plain <p> with no bold.

To ADD a new detector (the registry pattern — never edit a scan, add a unit):
  1. Subclass `EpubTransform` here. Implement `detect(self, soup) -> bool` (cheap: is the scheme
     PRESENT?), `transform(self, soup, log) -> dict` (do the conversion; set `el.name = f'h{n}'`,
     reset `el.attrs`, preserve any `id`), and set `name` / `description` / `plain` (the `plain`
     one-liner feeds the vibe-loop prompt + the assessment tree — say what markup → what level).
  2. Register it in `TRANSFORM_PIPELINE` (epub_normalizer.py) at the right ORDER. Ordering bites:
     run BEFORE `SpanUnwrapper`/`CalibreClassStripper` if you need the bold <span>/class as a
     signal (they're gone afterwards); run AFTER structural unwrappers if you need the final tag.
  3. Add the markup→level rule to `EpubNormalizer._HEADING_NEEDS` (the human-readable index).
  4. Keep `detect()` TIGHT so other books' goldens don't move — then `run_regression.py` stays green.
═══════════════════════════════════════════════════════════════════════════════════════
"""
import os
import re
import time
import random
import string
import json
from bs4 import BeautifulSoup, NavigableString
import bleach
from ingestion.epub.epub_base import EpubTransform


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
    plain = ('Calibre exports headings as big-font / bold <span>s, NOT <h1>. This converts them back to '
             'real headings by font-size class: calibre5 (1.67em) → h1, calibre8 (1.29em) → h2, bold → h3.')

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


class DivToSemanticConverter(EpubTransform):
    """
    Converts divs with semantic class names to proper HTML elements.

    Many EPUBs use <div class="heading1"> instead of <h1>.
    This converts them based on class patterns.
    """

    name = "DivToSemanticConverter"
    description = "Convert styled divs to semantic HTML (headings, blockquotes)"
    plain = ('Styled <div>s → semantic headings/blockquotes. Maps publisher (often Bible USFM) classes: '
             'mt/mt1 → h1, mt2 → h2, s/s1 → h3, psalmlabel → h2; or pulls a number out of the class '
             '(heading2 → h2, clamped 1–6).')

    # USFM (Unified Standard Format Markers) classes used in Bible EPUBs
    USFM_HEADING_CLASSES = {
        'mt':         'h1',   # Main Title (e.g., "Genesis")
        'mt1':        'h1',   # Main Title level 1
        'mte':        'h1',   # Main Title at Ending
        'mte1':       'h1',   # Main Title at Ending level 1
        'mt2':        'h2',   # Subtitle
        'mte2':       'h2',   # Subtitle at Ending
        'mt3':        'h3',   # Sub-subtitle (rare)
        'mte3':       'h3',   # Sub-subtitle at Ending (rare)
        's':          'h3',   # Section heading
        's1':         'h3',   # Section heading level 1
        's2':         'h4',   # Subsection heading
        'psalmlabel': 'h2',   # Chapter/psalm number
    }

    def detect(self, soup) -> bool:
        # Always run - it's a cleanup pass
        return True

    def transform(self, soup, log) -> dict:
        changes = {'headings': 0, 'blockquotes': 0, 'paragraphs': 0}
        body = soup.body if soup.body else soup

        # Pass 1: Divs to headings
        # Patterns: 'heading', 'title', or publisher patterns like 'fmhT' (front matter heading)
        for div in body.find_all('div'):
            classes = div.get('class', [])
            class_str = ' '.join(classes).lower()

            # Check for USFM classes (exact match) before general pattern matching
            usfm_tag = None
            for cls in classes:
                if cls.lower() in self.USFM_HEADING_CLASSES:
                    usfm_tag = self.USFM_HEADING_CLASSES[cls.lower()]
                    break
            if usfm_tag:
                div.name = usfm_tag
                preserved_id = div.get('id')
                div.attrs = {}
                if preserved_id:
                    div['id'] = preserved_id
                changes['headings'] += 1
                continue

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

        # Pass 1b: Convert verse number spans to <br> (USFM Bible pattern)
        for span in body.find_all('span', class_='verse'):
            verse_text = span.string or span.get_text()
            br_tag = soup.new_tag('br')
            preserved_id = span.get('id')
            if preserved_id:
                br_tag['id'] = preserved_id
            span.replace_with(br_tag)
            br_tag.insert_after(verse_text)
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
    plain = ('Publisher CSS-classed <p> paragraphs → headings. NOTE the publisher class names are '
             'RELATIVE to the section, not HTML levels — class="h1" is a SUBSECTION (mapped to h3), '
             'while title/fmtitle/bmtitle/con → h1.')

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
        'half-title': 'h1',# Half title page (Verso)
        'title': 'h1',     # Main book title
        'title1': 'h1',    # Subtitle
        'con': 'h1',       # Contents heading
        'chapnum': 'h1',   # Chapter numbers (CHAPTER 1, CHAPTER 2, etc.)
        'chaptitle': 'h1', # Chapter titles (alternative naming)
        'fm-title': 'h1',  # Front matter titles (Contents, Introduction, Index, etc.)
        'note-sec': 'h3',  # Notes section chapter dividers (endnotes)
    }

    # Classes that need style-based auto-detection
    AUTO_DETECT_CLASSES = {'h'}

    # Chapter number/title pair classes (Verso Books pattern)
    # These get merged into a single <h1> before the main transform loop
    CHAPTER_NUM_CLASSES = {'ch-num', 'ch-num1'}
    CHAPTER_TITLE_CLASSES = {'ch-title', 'ch-title1'}

    def detect(self, soup) -> bool:
        body = soup.body if soup.body else soup
        # Check for any paragraph with heading-like classes
        all_classes = (set(self.EXPLICIT_CLASSES.keys()) | self.AUTO_DETECT_CLASSES
                       | self.CHAPTER_NUM_CLASSES | self.CHAPTER_TITLE_CLASSES)
        for p in body.find_all('p'):
            p_classes = set(p.get('class', []))
            if p_classes & all_classes:
                return True
        return False

    def transform(self, soup, log) -> dict:
        changes = 0
        body = soup.body if soup.body else soup

        # First pass: merge ch-num + ch-title pairs into single <h1> elements
        merged = self._merge_chapter_pairs(body, log)
        changes += merged

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

    def _merge_chapter_pairs(self, body, log):
        """
        Merge ch-num + ch-title paragraph pairs into single <h1> elements.

        Verso Books pattern:
          <p class="ch-num"><span id="page_274"></span>9</p>
          <p class="ch-title">The Permanent Arms Economy</p>
        becomes:
          <h1><span id="page_274"></span>9. The Permanent Arms Economy</h1>
        """
        merged = 0

        # Find only ch-num paragraphs (avoids iterating over decomposed ch-title elements)
        ch_num_elements = []
        for cls in self.CHAPTER_NUM_CLASSES:
            ch_num_elements.extend(body.find_all('p', class_=cls))

        for p in ch_num_elements:
            # Collect span anchors (page markers) and the chapter number text
            spans = [s for s in p.find_all('span') if s.get('id')]
            num_text = p.get_text(strip=True)

            # Check if next sibling element is a ch-title
            next_el = p.find_next_sibling()
            if (next_el and next_el.name == 'p'
                    and set(next_el.get('class', [])) & self.CHAPTER_TITLE_CLASSES):
                title_text = next_el.get_text(strip=True)
                combined_text = f"{num_text}. {title_text}" if num_text else title_text

                # Build the new <h1>
                p.name = 'h1'
                p.attrs = {}
                p.clear()
                for span in spans:
                    p.append(span)
                p.append(combined_text)

                # Remove the now-merged title element
                next_el.decompose()
                merged += 1
                log(f"    ch-num + ch-title -> h1: {combined_text[:50]}...")
            else:
                # Unpaired ch-num — convert to <h1> alone
                preserved_id = p.get('id')
                p.name = 'h1'
                p.attrs = {}
                if preserved_id:
                    p['id'] = preserved_id
                merged += 1
                log(f"    ch-num -> h1 (unpaired): {num_text[:50]}...")

        if merged > 0:
            log(f"  Merged {merged} chapter number/title pairs into headings")

        return merged

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


class SectionNumberHeadingDetector(EpubTransform):
    """Headings encoded as a bold, SECTION-NUMBERED block in a non-<p> wrapper (a <blockquote>/<div>,
    commonly <blockquote class="calibre_NN"> in Routledge/Calibre exports) — a scheme the <p>-only
    detectors miss entirely. The level comes from the dotted numbering itself, so it needs NO class map:
    '1.'→h1, '1.1.'→h2, '2.3.2.1.'→h4 (depth = dot-count), and 'PART <ROMAN>' / 'CHAPTER N' → h1.

    Tight by design (see this module's header): only fires on a wrapper that is a single heading LINE
    — bold child + number/PART pattern + short — so body text that merely starts with a digit
    ('711 Third Avenue', the cataloguing line '1. Knowledge workers. 2. …') is left alone."""

    name = "SectionNumberHeadingDetector"
    description = "Convert bold section-numbered blocks (e.g. <blockquote>1.1. Title</blockquote>) to headings"
    plain = ('Bold, section-NUMBERED blocks in a non-<p> wrapper (e.g. <blockquote class="calibre_21">'
             '<span class="bold">1.1. Title</span>) → headings; level from the dotted numbering '
             '(1.→h1, 1.1.→h2, 2.3.2.1.→h4), or PART/CHAPTER → h1. For the scheme the <p>-only detectors miss.')

    _WRAPPERS = ('blockquote', 'div')
    # a dot-separated number group that ENDS in a dot, then whitespace + a non-space (the heading text)
    _NUM = re.compile(r'^(\d+(?:\.\d+)*)\.\s+\S')
    _MAJOR = re.compile(r'^(PART\s+[IVXLCDM]+|CHAPTER\s+\d+|BOOK\s+[IVXLCDM\d]+)\b', re.I)

    def _level_for(self, text):
        text = text.strip()
        if self._MAJOR.match(text):
            return 1
        m = self._NUM.match(text)
        if m:
            return min(m.group(1).count('.') + 1, 6)   # '1'→1, '1.1'→2, '2.3.2.1'→4
        return None

    @staticmethod
    def _is_bold(el):
        return bool(el.find(['b', 'strong']) or el.find('span', class_='bold'))

    def _is_heading_block(self, el):
        # a heading is a single LINE, not a container — reject wrappers holding block-level children
        if el.find(['p', 'div', 'blockquote', 'table', 'ul', 'ol']):
            return False
        txt = el.get_text(strip=True)
        return bool(txt and len(txt) < 200 and self._is_bold(el) and self._level_for(txt))

    def detect(self, soup) -> bool:
        body = soup.body if soup.body else soup
        return any(self._is_heading_block(el) for el in body.find_all(self._WRAPPERS))

    def transform(self, soup, log) -> dict:
        converted = 0
        body = soup.body if soup.body else soup
        for el in list(body.find_all(self._WRAPPERS)):
            if not self._is_heading_block(el):
                continue
            level = self._level_for(el.get_text(strip=True))
            preserved_id = el.get('id')
            el.name = f'h{level}'
            el.attrs = {}
            if preserved_id:
                el['id'] = preserved_id
            for a in el.find_all('a'):   # a heading shouldn't be a TOC back-link — keep its text only
                a.unwrap()
            text = el.get_text(strip=True)
            converted += 1
            log(f"    Section-numbered → h{level}: '{text[:50]}{'...' if len(text) > 50 else ''}'")
        if converted:
            log(f"  Converted {converted} section-numbered blocks to headings")
        return {'converted': converted}


class StyledSectionTitleHeadingDetector(EpubTransform):
    """Front/back-matter SECTION TITLES faked as a bold styled <p>/<blockquote> — 'BIBLIOGRAPHY',
    'REFERENCES', 'NOTES', 'INDEX', 'APPENDIX' … — that the <p>-only and number-based detectors miss
    (no number; the bold sits inside a nested <a><span>, not a bare span).

    These are top-level divisions → h1. Recognising the bibliography/references title in particular
    UNBLOCKS bibliography extraction: `_find_reference_paragraphs`'s PRIMARY scan keys off an <h*>
    'Bibliography'/'References' heading, so while the title stays a <p> the whole reference list is
    invisible (the reverse-scan fallback dies in the trailing Index) and every in-text citation goes
    unlinked. Making INDEX/NOTES headings too gives that scan a clean section boundary to stop at."""

    name = "StyledSectionTitleHeadingDetector"
    description = "Convert bold section-title paragraphs (BIBLIOGRAPHY, INDEX, NOTES…) to headings"
    plain = ('Front/back-matter SECTION TITLES faked as a bold <p>/<blockquote> (BIBLIOGRAPHY, REFERENCES, '
             'NOTES, INDEX, APPENDIX…) → h1. Recognising the bibliography/references title is what lets '
             'bibliography extraction FIND the reference list (its scan keys off an <h*> heading) — without '
             'it, refs stay ~1 and every citation goes unlinked.')

    # Canonical front/back-matter section titles (lowercased, matched against the element's WHOLE text).
    SECTION_TITLES = {
        'bibliography', 'references', 'works cited', 'reference list', 'literature', 'literature cited',
        'notes', 'endnotes', 'index', 'name index', 'subject index', 'appendix', 'appendices',
        'glossary', 'abbreviations', 'acknowledgments', 'acknowledgements',
    }
    _WRAPPERS = ('p', 'blockquote', 'div')

    @staticmethod
    def _is_bold(el):
        return bool(el.find(['b', 'strong']) or el.find('span', class_='bold'))

    @staticmethod
    def _followed_by_content(el):
        """True if a substantial body paragraph follows soon — the discriminator between a REAL section
        heading (followed by the section's content, e.g. the reference list) and a TABLE-OF-CONTENTS entry
        with the same title text (followed by MORE nav links: 'glossary' in a toc points at the glossary
        file, its siblings point at other files). Robust to publisher class names."""
        sib, seen = el.find_next_sibling(), 0
        while sib is not None and seen < 4:
            if getattr(sib, 'name', None) in ('p', 'blockquote', 'div', 'ul', 'ol', 'table'):
                seen += 1
                txt = sib.get_text(' ', strip=True)
                link_only = bool(sib.find('a')) and len(txt) < 60   # a short nav link, not body content
                if txt and len(txt) >= 60 and not link_only:
                    return True
            sib = sib.find_next_sibling()
        return False

    def _is_section_title(self, el):
        # a heading is a single LINE, not a container holding block children
        if el.find(['p', 'div', 'blockquote', 'table', 'ul', 'ol']):
            return False
        txt = el.get_text(strip=True)
        # tight: WHOLE text is a known section word, bold (publisher styling), short — AND it's a real
        # section start (content follows), not a same-named entry sitting in the table of contents.
        return bool(txt and len(txt) <= 40 and txt.lower() in self.SECTION_TITLES
                    and self._is_bold(el) and self._followed_by_content(el))

    def detect(self, soup) -> bool:
        body = soup.body if soup.body else soup
        return any(self._is_section_title(el) for el in body.find_all(self._WRAPPERS))

    def transform(self, soup, log) -> dict:
        converted = 0
        body = soup.body if soup.body else soup
        for el in list(body.find_all(self._WRAPPERS)):
            if not self._is_section_title(el):
                continue
            preserved_id = el.get('id')
            el.name = 'h1'
            el.attrs = {}
            if preserved_id:
                el['id'] = preserved_id
            for a in el.find_all('a'):   # drop the TOC back-link, keep the title text
                a.unwrap()
            converted += 1
            log(f"    Section title → h1: '{el.get_text(strip=True)[:40]}'")
        if converted:
            log(f"  Converted {converted} section-title paragraphs to headings")
        return {'converted': converted}


class StyleHeadingDetector(EpubTransform):
    """The "universal key" for cooked EPUBs — recover headings by reading the CSS and building the book's
    own FONT HIERARCHY, instead of matching hardcoded class names.

    Obfuscated Calibre exports (e.g. `<div class="class33">CHAPTER</div>`) carry no semantic heading markup,
    but the stylesheet defines `.class33` as bold / small-caps / centred / larger. This detector:
      1. finds the body BASELINE (the style covering the most running text),
      2. scores every other style's PROMINENCE relative to it across ALL axes (size, weight, family-switch,
         centring, caps, spacing) — no single axis hardcoded, so whatever a given book uses surfaces,
      3. clusters the above-baseline styles into TIERS → heading levels (most prominent → h1, next → h2…),
      4. corroborates with toc.ncx (authoritative for which blocks are headings + their level).

    It is a LAST-RESORT FALLBACK: it self-gates to engage only when the structural/semantic detectors left a
    big shortfall vs the TOC, so it can never disturb the (vast majority of) books that already recover
    headings. Inert unless real CSS was found. See styleProfiler.StyleProfiler / TocIndex.
    """

    name = "StyleHeadingDetector"
    description = "Recover headings from the CSS font hierarchy (cooked EPUBs)"
    plain = ('Last-resort heading recovery for OBFUSCATED EPUBs whose titles are styled <div>s with '
             'meaningless class names (class33, class57…). Reads the CSS, finds the body baseline, ranks every '
             'other style by how much bigger/bolder/more-centred/caps it is, and the prominence TIERS become '
             'h1/h2/h3 — corroborated by toc.ncx. Only fires when the other heading detectors fell short of '
             'the TOC, so it never disturbs books that already work.')

    _MIN_PROMINENCE = 2.0          # a style must clearly out-rank body to be a heading on style alone
    _MAX_HEADING_LEN = 200        # a heading is a short single line
    _SHORTFALL_RATIO = 0.5        # engage only if recovered headings < this fraction of the TOC's count
    _BLOCK_DESC = ['p', 'div', 'blockquote', 'table', 'ul', 'ol', 'li', 'figure', 'section']
    _HTAGS = ('h1', 'h2', 'h3', 'h4', 'h5', 'h6')

    def __init__(self):
        self.profiler = None
        self.toc = None
        self._plan = []

    def set_style_context(self, profiler, toc_index):
        self.profiler = profiler
        self.toc = toc_index

    def _is_heading_shape(self, el):
        txt = el.get_text(strip=True)
        if not txt or len(txt) > self._MAX_HEADING_LEN:
            return False
        return el.find(self._BLOCK_DESC) is None      # no block-level descendants → a single line

    @staticmethod
    def _categorical(sig, base):
        """Does the style differ from baseline on a CATEGORICAL axis (bold / caps / centred / family-switch)?
        A pure size bump (epigraph, block-quote, first-line) is NOT a heading — requiring a categorical
        signal filters those out, while staying axis-agnostic (any ONE of the four qualifies)."""
        if sig is None:
            return False
        if sig.bold and not (base and base.bold):
            return True
        if sig.caps:
            return True
        if sig.text_align == 'center' and not (base and base.text_align == 'center'):
            return True
        if (sig.serif is not None and base is not None and base.serif is not None
                and sig.serif != base.serif):
            return True
        return False

    @staticmethod
    def _norm(text):
        return re.sub(r'\s+', ' ', (text or '')).strip().lower()

    def _level_for(self, prominence, toc_depth):
        """toc.ncx is authoritative for LEVEL when the block is a nav target; otherwise map prominence to a
        coarse band (more prominent → higher level). HeadingNormalizer later closes any gaps."""
        if toc_depth is not None:
            return min(max(toc_depth, 1), 6)
        if prominence >= 4.0:
            return 1
        if prominence >= 2.8:
            return 2
        return 3

    def _plan_headings(self, soup):
        from collections import defaultdict
        prof = self.profiler
        blocks = soup.find_all(['div', 'p', 'blockquote'])
        if not blocks:
            return []
        # Tally running text per distinct style → the dominant style (most text) is the body baseline.
        text_by_key, sig_by_key = defaultdict(int), {}
        for el in blocks:
            sig = prof.fingerprint(el)
            k = sig.key() if sig else None
            sig_by_key[k] = sig
            text_by_key[k] += len(el.get_text(strip=True))
        baseline = sig_by_key.get(max(text_by_key, key=text_by_key.get))
        # A style is a HEADING style if it is clearly more prominent than body AND differs categorically
        # (not just a size bump). prominence is the axis-agnostic font-hierarchy score.
        prom_by_key = {k: prof.prominence(sig, baseline) for k, sig in sig_by_key.items()}
        heading_styles = {k for k, p in prom_by_key.items()
                          if p >= self._MIN_PROMINENCE and self._categorical(sig_by_key[k], baseline)}
        toc = self.toc

        def block_of(el):
            while el is not None and getattr(el, 'name', None) not in ('div', 'p', 'blockquote') + self._HTAGS:
                el = el.parent
            return el

        plan, seen = [], set()
        # (1) STYLE decides presence — every block in a heading style (one short line).
        for el in blocks:
            if el.name in self._HTAGS or id(el) in seen or not self._is_heading_shape(el):
                continue
            sig = prof.fingerprint(el)
            k = sig.key() if sig else None
            if k not in heading_styles:
                continue
            eid = el.get('id')
            toc_depth = toc.depth_for_id(eid) if (eid and toc) else None
            plan.append((el, self._level_for(prom_by_key.get(k, 0), toc_depth)))
            seen.add(id(el))
        # (2) toc.ncx CATCHES headings whose style is too subtle — but only when the nav anchor genuinely
        # sits on its title (the block's text matches the nav label), so mis-anchored TOCs (anchor on a
        # body paragraph / page number) can't promote non-headings.
        if toc:
            for pid, depth in toc._depth.items():
                target = soup.find(id=pid)
                if target is None:
                    continue
                blk = block_of(target)
                if blk is None or id(blk) in seen or blk.name in self._HTAGS:
                    continue
                if not self._is_heading_shape(blk):
                    continue
                label = toc.label_for_id(pid)
                if label and self._norm(blk.get_text()) == self._norm(label):
                    plan.append((blk, min(max(depth, 1), 6)))
                    seen.add(id(blk))
        return plan

    def detect(self, soup) -> bool:
        self._plan = []
        if not self.profiler or not self.profiler.has_css:
            return False
        existing = len(soup.find_all(list(self._HTAGS)))
        toc_n = self.toc.navpoint_count if self.toc else 0
        # Fallback gate — only engage on a big shortfall vs the TOC (so books that already recover their
        # headings are untouched). With no usable TOC, engage only when nothing else found headings.
        if toc_n > 0 and existing >= toc_n * self._SHORTFALL_RATIO:
            return False
        if toc_n == 0 and existing > 0:
            return False
        self._plan = self._plan_headings(soup)
        return bool(self._plan)

    def transform(self, soup, log) -> dict:
        converted = 0
        for el, level in self._plan:
            if el.name in self._HTAGS:
                continue
            eid = el.get('id')
            el.name = f'h{level}'
            el.attrs = {}
            if eid:
                el['id'] = eid
            for a in el.find_all('a'):     # drop any TOC back-link / inner anchor, keep the title text
                a.unwrap()
            converted += 1
        log(f"    Recovered {converted} headings from the CSS font hierarchy")
        return {'headings_converted': converted}

"""Phase 1 — heading matching. Recovers real h1/h2/h3 from publisher-faked headings
(font-sized Calibre spans, CSS-classed <p>, styled <div>s) and then normalises the
heading hierarchy to remove level gaps. Runs BEFORE footnote detection — see
EpubNormalizer._HEADING_NEEDS for the markup -> level rules each detector applies."""
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

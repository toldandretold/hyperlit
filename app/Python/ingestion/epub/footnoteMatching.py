"""Phase 2 — footnote matching. The run-all detector fan: every detector runs; any whose
markup is present fires and contributes footnotes (deduped by id; multiple can fire;
HeuristicFootnoteDetector is the fallback). FootnoteConverter then renders the detected
notes into Hyperlit's canonical format + links them. See EpubNormalizer._DETECTOR_NEEDS
for the exact markup each looks for."""
import os
import re
import time
import random
import string
import json
from bs4 import BeautifulSoup, NavigableString
import bleach
from ingestion.epub.epub_base import EpubTransform
from digestion.footnoteLinking.footnote_link_rules import link_epub_footnotes


class Epub3SemanticFootnoteDetector(EpubTransform):
    """
    Detects footnotes using EPUB3 epub:type semantic attributes.

    This is the W3C standard way - most reliable when present.
    Looks for epub:type="footnote", epub:type="endnote", epub:type="noteref"

    Reference: https://www.w3.org/TR/epub-ssv-11/
    """

    name = "Epub3SemanticFootnoteDetector"
    description = "Detect footnotes via epub:type attributes (W3C EPUB3 spec)"
    plain = ('EPUB3\'s W3C-standard scheme: elements tagged epub:type="footnote" / "noteref". The '
             'cleanest, most reliable signal — present in well-made modern EPUBs; runs first.')

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
    plain = ('Accessibility-tagged footnotes: role="doc-footnote" / "doc-noteref" ARIA attributes. '
             'Common in EPUBs built for screen-readers; nearly as reliable as the epub:type scheme.')

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
    plain = ('Footnotes identified by CSS class NAMES containing footnote / endnote / fn. The most '
             'common publisher scheme, but broad — so it runs AFTER the precise semantic/ARIA ones to '
             'avoid grabbing the wrong elements.')

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
        for elem in soup.find_all(['aside', 'div', 'section', 'p', 'li', 'a', 'ol', 'ul']):
            class_str = ' '.join(elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.FOOTNOTE_PATTERNS + self.NOTEREF_PATTERNS):
                return True
        return False

    def transform(self, soup, log) -> dict:
        footnotes = []
        noterefs = []
        seen_ids = set()

        # First, handle list containers (<ol class="footnotes">, <ul class="footnotes">)
        # These contain <li> children where the footnote ID is on a child <a> tag
        for list_elem in soup.find_all(['ol', 'ul']):
            class_str = ' '.join(list_elem.get('class', []))
            if any(re.search(p, class_str, re.I) for p in self.FOOTNOTE_PATTERNS):
                log(f"    Found footnotes list container: <{list_elem.name} class=\"{class_str}\">")
                # Process each <li> child as a potential footnote
                for li in list_elem.find_all('li', recursive=False):
                    # The footnote ID is typically on a child <a> tag, not the <li> itself
                    # Pattern: <li><p class="NTX"><a id="front1_fm7-1">1</a>. Content...</p></li>
                    for child_a in li.find_all('a', id=True):
                        child_id = child_a.get('id', '')
                        if child_id and child_id not in seen_ids:
                            seen_ids.add(child_id)
                            footnotes.append({
                                'id': child_id,
                                'element': li,  # Use <li> as the footnote element
                                'type': 'footnote',
                                'strategy': 'class_pattern_list_item'
                            })
                            log(f"    Found footnote (list item): id={child_id}")

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
    plain = ('Publisher format: <p class="notes"> definition paragraphs whose child anchor back-links to '
             'the in-text marker. Matched by the structure (note paragraph + backlink), not a footnote class.')

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
    plain = ('Footnotes laid out as a two-column TABLE — the marker/number in one cell, the note text in '
             'the other (e.g. Pluto Press). Identified by the table\'s class or its first-cell anchors.')

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
    plain = ('The standard Pandoc / HTML <section class="footnotes"> (or <div class="footnotes">) block — '
             'what Word→pandoc and many conversion tools emit. Very common for DOCX-sourced EPUBs.')

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
    plain = ('InDesign / Word export: footnote markers wrapped in <span class="EndnoteCharacters">. A '
             'specific vendor signal — when present it is unambiguous.')

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


# Block-level elements that can hold an endnote definition. Headings are included
# because some Calibre exports render each note as <hN><a id="nX">N.</a> text</hN>.
_ENOTE_DEF_CONTAINERS = ['p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']


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
    plain = ('Marxists.org format: <sup class="enote…"> superscript markers. A site-specific scheme — '
             'the reason this corpus has its own detector.')

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
                # Find parent block. Some Calibre exports (e.g. Marxists.org) render
                # each endnote definition as a heading: <h1><a id="nX">1.</a> text</h1>,
                # so headings must count as definition containers too.
                parent = fn_anchor.parent
                while parent and parent.name not in _ENOTE_DEF_CONTAINERS:
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

                    # Find parent block (headings count — see note above).
                    candidate_parent = a_tag.parent
                    while candidate_parent and candidate_parent.name not in _ENOTE_DEF_CONTAINERS:
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


class AnchorHeadingFootnoteDetector(EpubTransform):
    """
    Detect endnotes encoded as a heading anchor plus following content:

        <a class="..." href="#noteId">Note 33</a>      (in-text reference)
        ...
        <h2 id="noteId">Note 33</h2>                    (definition label)
        <p>Note for accountants: ...</p>                (definition content)

    A common Calibre/InDesign export shape (e.g. some O'Reilly titles). It is
    100% reliable because marker and definition are joined by an explicit id/href
    anchor — no numbering or counting involved. The other detectors miss it: the
    marker text is "Note N" (not a bare number or superscript), the marker carries
    a Calibre class (so HeuristicFootnoteDetector Pattern 5 skips it), and the
    definition is a <hN> heading with an opaque publisher id that matches none of
    the fn/en ID_PATTERNS.

    We consolidate each "<hN id=X>Note N</hN> + following content" into a single
    block <div id="X"> (dropping the redundant "Note N" label) so the standard
    FootnoteConverter can extract the content, reverse-map the references by id,
    and remove the definition — exactly as it handles block-level footnotes.
    """

    name = "AnchorHeadingFootnoteDetector"
    description = "Endnotes as <hN id=X>Note N</hN> + content, linked by <a href=#X>"
    plain = ('Endnotes written as HEADINGS: <hN id=X>Note N</hN> + its content, linked by an in-text '
             '<a href="#X">. Matched by id correspondence (not number), so it survives per-chapter '
             'numbering restarts.')

    _NOTE_HEADING_RE = re.compile(r'^(?:end)?note\s+\d+\.?$', re.I)
    _NOTE_MARKER_RE = re.compile(r'^(?:end)?note\s+(\d+)$', re.I)

    def _linked_ids(self, soup):
        ids = set()
        for a in soup.find_all('a', href=True):
            href = a.get('href', '')
            if href.startswith('#'):
                ids.add(href[1:])
        return ids

    def detect(self, soup) -> bool:
        linked = self._linked_ids(soup)
        if not linked:
            return False
        for h in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
            if h.get('id') in linked and self._NOTE_HEADING_RE.match(h.get_text(strip=True)):
                return True
        return False

    def transform(self, soup, log) -> dict:
        linked = self._linked_ids(soup)
        footnotes = []
        # Collect definition headings up front (document order) before mutating.
        defs = [
            h for h in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
            if h.get('id') in linked and self._NOTE_HEADING_RE.match(h.get_text(strip=True))
        ]
        for h in defs:
            note_id = h.get('id')
            # Definition content = following siblings until the next heading.
            content_sibs = []
            for sib in h.find_next_siblings():
                if getattr(sib, 'name', None) in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
                    break
                content_sibs.append(sib)
            if not content_sibs:
                continue
            # Consolidate into one block element carrying the note id; drop the
            # "Note N" heading label (redundant with the in-text marker).
            wrapper = soup.new_tag('div')
            wrapper['id'] = note_id
            for sib in content_sibs:
                wrapper.append(sib.extract())
            h.replace_with(wrapper)
            footnotes.append({
                'id': note_id,
                'element': wrapper,
                'type': 'endnote',
                'strategy': 'anchor_heading',
            })

        # Normalise in-text marker text "Note 33" -> "33" so the converter renders
        # a clean numeric superscript instead of the verbose "Note 33" label.
        fn_ids = {fn['id'] for fn in footnotes}
        for a in soup.find_all('a', href=True):
            href = a.get('href', '')
            if href.startswith('#') and href[1:] in fn_ids:
                m = self._NOTE_MARKER_RE.match(a.get_text(strip=True))
                if m:
                    a.string = m.group(1)

        log(f"    Total: {len(footnotes)} anchor-heading endnote definitions")
        return {'footnotes': footnotes, 'noterefs': []}


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
    plain = ('The always-on FALLBACK: numbered-list / superscript / id-pattern heuristics, used only when '
             'no specific scheme matched. Least reliable — if this is the ONLY detector that fired, the '
             'EPUB is a prime review candidate (a real scheme may have been missed).')

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
        # Skip when inner <a> has a class attribute — in EPUBs, verse numbers use
        # <sup><a class="StartVersenum"> while footnote refs use plain <a> without class.
        for sup in soup.find_all('sup'):
            a_tag = sup.find('a')
            if a_tag and not a_tag.get('class'):
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
        footnote_symbols = re.compile(r'^(?:\[\d+\]|[*†‡§¶#]{1,3}|[a-zA-Z]{1,3}\.?)$')
        # Bare digits only when the <a> has an id (indicating a back-linkable reference)
        bare_digit = re.compile(r'^\d{1,3}\.?$')
        for a_tag in soup.find_all('a', href=True):
            # Skip if already in <sup> (handled by Pattern 1a)
            if a_tag.find_parent('sup'):
                continue
            # Skip if contains <sup> (handled by Pattern 1b)
            if a_tag.find('sup'):
                continue
            # Skip if has class — verse numbers and navigation links have classes
            if a_tag.get('class'):
                continue

            href = a_tag.get('href', '')
            target_id = self._extract_target_id(href)
            if not target_id or target_id in seen_ref_ids:
                continue

            # Check if link text looks like a footnote reference
            link_text = a_tag.get_text(strip=True)
            is_match = footnote_symbols.match(link_text)
            # For bare digits (no brackets/symbols), require an id attribute —
            # real footnote refs need an id for back-linking, verse cross-refs often don't
            if not is_match and bare_digit.match(link_text) and a_tag.get('id'):
                is_match = True
            if is_match:
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
        self._linking_stats = None  # detected vs linked vs orphaned — recorded into assessment.json

    def detect(self, soup) -> bool:
        # This is run manually after pipeline, not auto-detected
        return False

    def convert(self, soup, all_footnotes, all_noterefs, book_id, log) -> dict:
        """Convert footnotes to Hyperlit format — delegates to the FOOTNOTE_LINK_RULES registry
        (conversion/footnote_link_rules.py), where each linking step is an independently-testable,
        loop-registerable LinkRule (the monolith this replaced is where the aarushi bug lived)."""
        self.book_id = book_id
        result = link_epub_footnotes(soup, all_footnotes, all_noterefs, book_id, log)
        self.footnotes_json = result['footnotes_json']
        self._linking_stats = result['linking_stats']
        return {'footnotes_json': result['footnotes_json'], 'id_mapping': result['id_mapping']}

    def transform(self, soup, log) -> dict:
        # This method exists for interface compatibility but
        # the actual work is done by convert() which takes more params
        return {'footnotes_json': []}

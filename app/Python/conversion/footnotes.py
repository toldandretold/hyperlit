"""Footnote extraction by strategy (whole-document and sequential).

Walks the soup, collects footnote definitions into a map, and inserts the anchor
tags that the linker later wires to in-text markers. Extracted from process_document.py
so each strategy's extraction is an addressable, unit-testable unit. Mutates the soup
(adds anchors) — the regression suite's golden diffs guard the exact output.
"""

import re
import random
import string
import time

from bs4 import NavigableString

from conversion.sanitize import get_element_html_content
from conversion.strategy import _BIBLIOGRAPHY_HEADING_RE

def process_whole_document_footnotes(soup, book_id):
    """Process footnotes when all definitions are at document end.
    Supports multi-paragraph footnotes by collecting all elements until the next footnote marker,
    heading, or horizontal rule.
    """
    # Include tables, headings, hr and other block elements
    all_elements = soup.find_all(['p', 'div', 'li', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'])
    footnote_map = {}
    footnotes_data = []

    print("--- Processing whole-document footnotes ---")

    # First pass: find indices of all footnote start elements. CRUCIALLY, skip any
    # "[N]:" line that sits under a Bibliography / References / Further Reading
    # heading — those are citations, not footnotes. Many books format bibliography
    # entries identically to footnote definitions ("[26]: Miller, William Ian; ...")
    # and number them in the same global sequence, so counting them as footnotes
    # pollutes the numbering and makes body markers resolve to the wrong (often
    # cross-essay) note. Excluding them keeps us honest: correct where determinable,
    # no link where ambiguous.
    footnote_starts = []
    in_bibliography = False
    for i, element in enumerate(all_elements):
        if element.name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            in_bibliography = bool(_BIBLIOGRAPHY_HEADING_RE.search(element.get_text()))
            continue
        if in_bibliography:
            continue
        text = element.get_text().strip()
        # Check if this element starts a footnote definition
        if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
            footnote_starts.append(i)

    # Second pass: process each footnote with its continuation elements
    for j, start_idx in enumerate(footnote_starts):
        # End index is either next footnote start or end of relevant elements
        end_idx = footnote_starts[j + 1] if j + 1 < len(footnote_starts) else len(all_elements)

        # Get the first element (contains the marker)
        first_element = all_elements[start_idx]
        first_text = first_element.get_text().strip()

        # Extract footnote number from first element
        number_match = re.search(r'^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*)', first_text, re.DOTALL)
        if not number_match:
            continue

        # Extract the digit from either group 2 or group 3
        identifier = number_match.group(2) or number_match.group(3)

        # Extract content from inner HTML to preserve <a>, <em> etc.
        first_inner_html = ''.join(str(c) for c in first_element.children)
        html_match = re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*(.*)', first_inner_html, re.DOTALL)
        first_content = html_match.group(2).strip() if html_match else number_match.group(4).strip()

        # Collect content from all elements for this footnote
        content_parts = [first_content] if first_content else []

        # Add continuation elements (elements between this footnote and the next)
        # Stop at headings or horizontal rules
        for elem in all_elements[start_idx + 1:end_idx]:
            # Stop if we hit a heading or hr (section boundary)
            if elem.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']:
                break
            elem_content = get_element_html_content(elem)
            if elem_content and elem_content.strip():
                content_parts.append(elem_content.strip())

        # Combine all content with HTML line breaks for multi-paragraph support
        full_content = '<br><br>'.join(content_parts) if len(content_parts) > 1 else (content_parts[0] if content_parts else '')

        print(f"Processing whole-doc footnote {identifier}: {full_content[:50]}... ({len(content_parts)} parts)")

        # Generate unique footnote ID (shorter format without book prefix)
        random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
        unique_fn_id = f"Fn{int(time.time() * 1000)}_{random_suffix}"

        # Add anchor with unique ID to the first element
        anchor_tag = soup.new_tag('a', id=unique_fn_id)
        anchor_tag['fn-count-id'] = identifier
        first_element.insert(0, anchor_tag)

        footnote_map[identifier] = {
            'unique_fn_id': unique_fn_id,
            'content': full_content,
            'element': first_element
        }

        footnotes_data.append({"footnoteId": unique_fn_id, "content": full_content})

    print(f"Found {len(footnote_map)} footnote definitions in whole-document mode")
    return footnote_map, footnotes_data


def process_sequential_footnotes(soup, book_id):
    """Process footnotes when ref/def sections restart numbering (sequential strategy).
    Uses markers emitted by simple_md_to_html: footnoteSectionStart and footnoteDefinitionsStart.
    """
    # Find all definition section markers
    def_markers = soup.find_all('a', class_='footnoteDefinitionsStart')
    all_elements = soup.find_all(['p', 'div', 'li', 'table', 'blockquote', 'pre',
                                  'ul', 'ol', 'figure', 'img', 'h1', 'h2', 'h3',
                                  'h4', 'h5', 'h6', 'hr', 'a'])

    # Build an index of element positions for fast lookup
    element_positions = {id(elem): i for i, elem in enumerate(all_elements)}

    # Group definitions by section: for each def marker, collect all [^N]: defs
    # until the next def marker or end of document
    sequential_footnote_map = {}  # section_number -> {identifier -> footnote_data}
    all_footnotes_data = []

    for marker_idx, marker in enumerate(def_markers):
        section_number = marker.get('id', '').replace('fnDefSection_', '')
        marker_pos = element_positions.get(id(marker), 0)

        # End boundary: next def marker or end of document
        if marker_idx + 1 < len(def_markers):
            next_marker_pos = element_positions.get(id(def_markers[marker_idx + 1]), len(all_elements))
        else:
            next_marker_pos = len(all_elements)

        # Scan elements in this range for footnote definitions
        section_map = {}
        footnote_starts = []

        range_elements = all_elements[marker_pos + 1:next_marker_pos]
        for i, element in enumerate(range_elements):
            if element.name == 'a':
                continue  # Skip anchor markers
            text = element.get_text().strip()
            if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                footnote_starts.append(i)

        for j, start_idx in enumerate(footnote_starts):
            end_idx = footnote_starts[j + 1] if j + 1 < len(footnote_starts) else len(range_elements)
            first_element = range_elements[start_idx]
            first_text = first_element.get_text().strip()

            number_match = re.search(r'^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*)', first_text, re.DOTALL)
            if not number_match:
                continue

            identifier = number_match.group(2) or number_match.group(3)

            # Extract content from inner HTML to preserve <a>, <em> etc.
            first_inner_html = ''.join(str(c) for c in first_element.children)
            html_match = re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*(.*)', first_inner_html, re.DOTALL)
            first_content = html_match.group(2).strip() if html_match else number_match.group(4).strip()

            content_parts = [first_content] if first_content else []
            for elem in range_elements[start_idx + 1:end_idx]:
                if elem.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']:
                    break
                if elem.name == 'a':
                    continue
                elem_content = get_element_html_content(elem)
                if elem_content and elem_content.strip():
                    content_parts.append(elem_content.strip())

            full_content = '<br><br>'.join(content_parts) if len(content_parts) > 1 else (content_parts[0] if content_parts else '')

            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
            unique_fn_id = f"seq{section_number}_Fn{int(time.time() * 1000)}_{random_suffix}"

            anchor_tag = soup.new_tag('a', id=unique_fn_id)
            anchor_tag['fn-count-id'] = identifier
            anchor_tag['fn-section-id'] = section_number
            first_element.insert(0, anchor_tag)

            section_map[identifier] = {
                'unique_fn_id': unique_fn_id,
                'content': full_content,
                'section_id': section_number
            }
            all_footnotes_data.append({"footnoteId": unique_fn_id, "content": full_content})

            print(f"Sequential fn [{section_number}][{identifier}]: {full_content[:50]}...")

        sequential_footnote_map[section_number] = section_map
        print(f"Section {section_number}: {len(section_map)} definitions")

    total = sum(len(s) for s in sequential_footnote_map.values())
    print(f"Found {total} footnote definitions in sequential mode across {len(sequential_footnote_map)} sections")
    return sequential_footnote_map, all_footnotes_data


def link_footnotes(soup, all_elements, strategy, global_footnote_map,
                   sequential_footnote_map, sectioned_footnote_map, footnote_sections):
    """Wire in-text markers (<a href="#fnN">, <sup>N</sup>, [^id]) to footnote
    definitions using the strategy-appropriate lookup. Mutates the soup. A suppressed
    (empty) map yields no links — the modus operandi: never a confident wrong link."""
    # --- 2B: Link Footnotes (STRATEGY-AWARE) ---

    # Pre-build element position index for O(1) lookups instead of O(n) .index() calls
    _element_pos = {id(elem): i for i, elem in enumerate(all_elements)}

    def _elem_position(element):
        """O(1) position lookup, walking up to parent if element isn't in the index."""
        pos = _element_pos.get(id(element))
        if pos is not None:
            return pos
        parent = element.parent
        while parent:
            pos = _element_pos.get(id(parent))
            if pos is not None:
                return pos
            parent = parent.parent
        return 0

    # Pre-build ref section positions for sequential strategy
    if strategy == 'sequential':
        ref_markers = soup.find_all('a', class_='footnoteSectionStart')
        ref_section_positions = []
        for marker in ref_markers:
            section_num = marker.get('id', '').replace('fnRefSection_', '')
            ref_section_positions.append((_elem_position(marker), section_num))
        # Sort by position ascending
        ref_section_positions.sort(key=lambda x: x[0])

    def find_footnote_data(identifier, current_element=None):
        """Find footnote data using the appropriate strategy"""
        if strategy == 'whole_document':
            # Simple lookup in whole-document map
            if identifier in global_footnote_map:
                print(f"Found footnote {identifier} in whole-document mode")
                return global_footnote_map[identifier]
            print(f"Could not find footnote {identifier} in whole-document mode (available: {list(global_footnote_map.keys())[:10]}...)")
            return None
        elif strategy == 'sequential':
            return find_footnote_in_sequential(identifier, current_element)
        else:
            # Section-aware lookup (original logic)
            return find_footnote_in_sections(identifier, current_element)

    def find_footnote_in_sequential(identifier, current_element):
        """Find footnote data by determining which ref section the element falls in,
        then looking up the matching definition section."""
        current_pos = _elem_position(current_element)

        # Find which ref section this element falls in (last marker before current_pos)
        section_num = None
        for pos, num in ref_section_positions:
            if pos <= current_pos:
                section_num = num
            else:
                break

        if section_num and section_num in sequential_footnote_map:
            if identifier in sequential_footnote_map[section_num]:
                print(f"Found footnote {identifier} in sequential section {section_num} (pos {current_pos})")
                return sequential_footnote_map[section_num][identifier]

        # Fallback: try all sections for this identifier
        for sec_id, sec_map in sequential_footnote_map.items():
            if identifier in sec_map:
                print(f"Fallback: found footnote {identifier} in section {sec_id}")
                return sec_map[identifier]

        print(f"Could not find footnote {identifier} in sequential mode (section {section_num})")
        return None

    def find_footnote_in_sections(identifier, current_element):
        """Find footnote data by determining which section's text area this element is in"""
        current_pos = _elem_position(current_element)

        # Find which section this element belongs to by checking explicit text ranges
        for section in footnote_sections:
            if (current_pos >= section.get('text_start_idx', 0) and
                current_pos < section.get('text_end_idx', len(all_elements))):
                if identifier in sectioned_footnote_map.get(section['id'], {}):
                    return sectioned_footnote_map[section['id']][identifier]

        # Try traditional footnotes as final fallback
        if 'traditional' in sectioned_footnote_map and identifier in sectioned_footnote_map['traditional']:
            return sectioned_footnote_map['traditional'][identifier]

        return None

    # Handle existing <a> tags with #fn pattern
    for a_tag in soup.find_all('a', href=re.compile(r'^#fn\d+')):
        identifier_match = re.search(r'(\d+)', a_tag.get('href', ''))
        if not identifier_match: continue
        identifier = identifier_match.group(1)
        text_content = a_tag.get_text(strip=True)

        footnote_data = find_footnote_data(identifier, a_tag)
        if footnote_data and text_content == identifier:
            # New format: sup with class, no anchor inside
            new_sup = soup.new_tag('sup', id=footnote_data['unique_fn_id'])
            new_sup['fn-count-id'] = identifier
            new_sup['class'] = 'footnote-ref'
            if 'section_id' in footnote_data:
                new_sup['fn-section-id'] = footnote_data['section_id']
            new_sup.string = text_content
            a_tag.replace_with(new_sup)

    # Handle existing <sup> tags
    for sup_tag in soup.find_all('sup'):
        # Skip if already has new format (class on sup) or old format (anchor inside)
        if 'footnote-ref' in sup_tag.get('class', []) or sup_tag.find('a', class_='footnote-ref'):
            continue
        identifier = sup_tag.get_text(strip=True)
        footnote_data = find_footnote_data(identifier, sup_tag)
        if footnote_data:
            # New format: add attributes to sup, no anchor
            sup_tag['id'] = footnote_data['unique_fn_id']
            sup_tag['fn-count-id'] = identifier
            sup_tag['class'] = sup_tag.get('class', []) + ['footnote-ref']
            if 'section_id' in footnote_data:
                sup_tag['fn-section-id'] = footnote_data['section_id']
            # Keep text content as-is (already identifier)

    # Handle [^identifier] patterns in text (but NOT footnote definitions)
    # Quick pre-check: skip expensive text node walk if no [^...] or [...] patterns exist
    _fn_full_text = soup.get_text()
    _has_bracket_fn = re.search(r'\[\^?\w+\]', _fn_full_text)
    del _fn_full_text
    if not _has_bracket_fn:
        print("  ⏭️ No [^identifier] patterns found — skipping text node scan for footnotes")

    for text_node in (soup.find_all(string=True) if _has_bracket_fn else []):
        if not text_node.parent.name in ['style', 'script', 'a']:
            text = str(text_node)
            matches = list(re.finditer(r'\[\^?(\w+)\]', text))
            if matches:
                new_content = []
                last_index = 0
                for match in matches:
                    identifier = match.group(1)

                    # Check if this is a footnote definition (followed by colon)
                    # Skip processing if this looks like a definition
                    match_end = match.end()
                    following_text = text[match_end:match_end+5].strip()  # Look at next 5 chars
                    if following_text.startswith(':'):
                        # This is a footnote definition, skip it
                        print(f"Skipping footnote definition pattern: {match.group(0)}:")
                        continue

                    footnote_data = find_footnote_data(identifier, text_node.parent)
                    if footnote_data:
                        new_content.append(NavigableString(text[last_index:match.start()]))
                        # New format: sup with class, no anchor inside
                        new_sup = soup.new_tag('sup', id=footnote_data['unique_fn_id'])
                        new_sup['fn-count-id'] = identifier
                        new_sup['class'] = 'footnote-ref'
                        if 'section_id' in footnote_data:
                            new_sup['fn-section-id'] = footnote_data['section_id']
                        new_sup.string = identifier
                        new_content.append(new_sup)
                        last_index = match.end()
                    else:
                        # If no footnote found, leave the text as-is
                        continue
                if new_content:  # Only replace if we found matches
                    new_content.append(NavigableString(text[last_index:]))
                    text_node.replace_with(*new_content)

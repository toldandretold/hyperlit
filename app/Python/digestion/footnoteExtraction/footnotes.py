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

from shared.sanitize import get_element_html_content
from digestion.strategySelection.strategy import _BIBLIOGRAPHY_HEADING_RE
from digestion.footnoteLinking.footnote_link_rules import link_marker_footnotes

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
    """Wire in-text markers (<a href="#fnN">, <sup>N</sup>, [^id]) to footnote definitions using the
    strategy-appropriate lookup. Mutates the soup. Delegates to the MARKER_LINK_RULES registry in
    footnote_link_rules.py — each marker shape is an independently-testable, loop-registerable rule.
    A suppressed (empty) map yields no links — the modus operandi: never a confident wrong link."""
    link_marker_footnotes(soup, all_elements, strategy, global_footnote_map,
                          sequential_footnote_map, sectioned_footnote_map, footnote_sections)

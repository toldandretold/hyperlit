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
from shared.assessment import ASSESSMENT
from digestion.strategySelection.strategy import _BIBLIOGRAPHY_HEADING_RE
from digestion.footnoteLinking.footnote_link_rules import link_marker_footnotes


# Human-readable `plain` note for the footnote-extraction tree node (single source — node_help +
# generator + LLM failure prompt + the visual tree).
_FOOTNOTE_EXTRACTION_PLAIN = (
    "Decides which lines ARE footnote definitions: a line starting with [N]: / [^N]: / ^N: (a number "
    "marker then a colon/period and text). Lines under a Bibliography/References heading are deliberately "
    "excluded (those are citations, not footnotes). Collects each definition (plus its continuation "
    "paragraphs) into the map the linker later wires to in-text markers."
)

# A footnote DEFINITION opener: "[1]:", "[^1].", "^1:" (a number marker + colon/period + text), or the
# colon-less "[1] Capitalised…" form. This is the single detection predicate for what COUNTS as a
# footnote definition — kept in one place so it is testable and both strategies agree.
_FOOTNOTE_DEFINITION_RE = re.compile(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]')


def _is_footnote_definition(text):
    """Does this element's text OPEN a footnote definition? True for "[1]: note", "[^1]. note",
    "^1: note", and the colon-less "[1] Note"; False for ordinary prose, a bare "[1]" with no body,
    and bibliography entries that aren't number-marker shaped. The one place "what is a footnote
    definition" is decided (both extraction strategies call it)."""
    return bool(_FOOTNOTE_DEFINITION_RE.search((text or '').strip()))


def _record_extraction_fork(strategy, code_ref, def_candidates, defs_extracted, excluded_in_bib):
    """Emit the footnote-extraction decision-trace fork (a SUSPICION signal, never a verdict — see
    README §0). Counts every line that LOOKED like a footnote definition (`def_candidates`), how many
    became definitions, and how many were deliberately excluded under a Bibliography heading. The
    falsifiable contradiction is `dropped` > 0: candidates that were NOT bibliography-excluded yet still
    didn't extract — usually the colon-less "[5] Smith" form (detected, but the number+content parse
    requires a colon/period), or a genuine bug. That's the only case we flag."""
    dropped = max(0, def_candidates - excluded_in_bib - defs_extracted)
    if dropped > 0:
        confidence = 0.4
        margin = (f'{dropped} line(s) looked like footnote definitions but were NOT extracted (and were '
                  f'not under a Bibliography heading) — MIGHT be the colon-less "[5] Note" form or a parse '
                  f'gap; please check the source text near those markers.')
    else:
        confidence = 0.9
        margin = (f'every non-bibliography definition-shaped line ({defs_extracted}) was extracted; '
                  f'{excluded_in_bib} bibliography-style "[N]:" line(s) deliberately excluded as citations'
                  if excluded_in_bib else f'all {defs_extracted} definition-shaped line(s) extracted')
    ASSESSMENT.record(
        module='footnote_extraction', code_ref=code_ref,
        node_help=_FOOTNOTE_EXTRACTION_PLAIN,
        decision=f'extracted {defs_extracted} footnote definition(s) via {strategy}',
        rationale='a line is a footnote definition when it opens with a [N]: / [^N]. / ^N: number marker '
                  '(or the colon-less "[N] Capital" form); lines under a Bibliography/References heading '
                  'are excluded as citations, not footnotes',
        evidence={'strategy': strategy, 'def_candidates': def_candidates,
                  'defs_extracted': defs_extracted, 'excluded_under_bibliography': excluded_in_bib,
                  'dropped': dropped},
        question='Which lines are footnote definitions (vs prose / bibliography entries)?',
        considered=([{'option': 'treat the dropped definition-shaped lines as footnotes',
                      'rejected_because': 'they matched the definition opener but not the number+content '
                                          'parse (which requires a colon/period after the marker)',
                      'would_need': 'a colon/period after the "[N]" marker, or a parser that accepts '
                                    'the colon-less "[N] Text" form'}] if dropped > 0 else []),
        confidence=confidence, margin=margin)


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
    def_candidates = 0      # elements whose text OPENS a footnote definition (before bibliography exclusion)
    excluded_in_bib = 0     # of those, deliberately skipped because under a Bibliography/References heading
    in_bibliography = False
    for i, element in enumerate(all_elements):
        if element.name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            in_bibliography = bool(_BIBLIOGRAPHY_HEADING_RE.search(element.get_text()))
            continue
        # Check if this element starts a footnote definition
        if _is_footnote_definition(element.get_text()):
            def_candidates += 1
            if in_bibliography:
                excluded_in_bib += 1   # a citation under a References heading — deliberately NOT a footnote
                continue
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
    _record_extraction_fork('whole_document', 'footnotes.py:process_whole_document_footnotes',
                            def_candidates, len(footnote_map), excluded_in_bib)
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
    def_candidates = 0  # elements opening a footnote definition across all sections (for the fork)

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
            if _is_footnote_definition(element.get_text()):
                def_candidates += 1
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
    _record_extraction_fork('sequential', 'footnotes.py:process_sequential_footnotes',
                            def_candidates, total, 0)
    return sequential_footnote_map, all_footnotes_data


def link_footnotes(soup, all_elements, strategy, global_footnote_map,
                   sequential_footnote_map, sectioned_footnote_map, footnote_sections):
    """Wire in-text markers (<a href="#fnN">, <sup>N</sup>, [^id]) to footnote definitions using the
    strategy-appropriate lookup. Mutates the soup. Delegates to the MARKER_LINK_RULES registry in
    footnote_link_rules.py — each marker shape is an independently-testable, loop-registerable rule.
    A suppressed (empty) map yields no links — the modus operandi: never a confident wrong link."""
    link_marker_footnotes(soup, all_elements, strategy, global_footnote_map,
                          sequential_footnote_map, sectioned_footnote_map, footnote_sections)

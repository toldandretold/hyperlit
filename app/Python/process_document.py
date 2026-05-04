import sys
import re
import json
import time
import os
import argparse
import random
import string
from collections import Counter
from bs4 import BeautifulSoup, NavigableString
from PIL import Image as PILImage
import bleach

# --- SECURITY: HTML Sanitization ---

ALLOWED_TAGS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'a', 'em', 'strong', 'i', 'b', 'u', 'sub', 'sup', 'span', 'aside',
    'ul', 'ol', 'li', 'br', 'hr', 'img', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'figure', 'figcaption', 'cite', 'q', 'abbr', 'mark',
    'section', 'nav', 'article', 'header', 'footer', 'div',
    'latex', 'latex-block'
]

ALLOWED_ATTRS = {
    'a': ['href', 'title', 'target', 'id', 'class', 'fn-count-id', 'data-refs', 'data-page'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan'],
    'sup': ['id', 'class', 'fn-count-id'],
    '*': ['id', 'class', 'fn-count-id', 'data-node-id', 'data-math', 'data-chart']
}

# Dangerous URL patterns
DANGEROUS_URL_PATTERN = re.compile(r'^(javascript|vbscript|data|file):', re.IGNORECASE)

# Fast pre-check: skip expensive bleach parse when content is already clean
_ALLOWED_TAGS_SET = set(ALLOWED_TAGS)
_TAG_NAME_RE = re.compile(r'</?([a-zA-Z][a-zA-Z0-9-]*)')
_DANGEROUS_ATTR_RE = re.compile(r'\bon[a-z]+\s*=|javascript:|vbscript:|data:', re.IGNORECASE)


def _needs_sanitization(html_string):
    """Quick check: does this HTML contain anything bleach would change?"""
    # Check for dangerous attributes/URLs
    if _DANGEROUS_ATTR_RE.search(html_string):
        return True
    # Check for disallowed tags
    for m in _TAG_NAME_RE.finditer(html_string):
        if m.group(1).lower() not in _ALLOWED_TAGS_SET:
            return True
    return False


def emit_progress(pct, stage, detail=""):
    """Emit a machine-readable progress line for the PHP job runner."""
    print("PROGRESS:" + json.dumps({"percent": pct, "stage": stage, "detail": detail}), flush=True)


def sanitize_url(url):
    """Sanitize a URL to prevent XSS."""
    if not url:
        return url
    url = url.strip()
    if url.startswith('#'):
        return url
    if DANGEROUS_URL_PATTERN.match(url):
        return None
    return url


def sanitize_html(html_string):
    """Sanitize HTML to prevent XSS."""
    # Fast path: skip expensive bleach parse when content only has allowed tags
    # and no dangerous patterns. Covers 99%+ of Pandoc output.
    if not _needs_sanitization(html_string):
        # Still need to check URLs if present
        if 'href=' not in html_string and 'src=' not in html_string:
            return html_string
    cleaned = bleach.clean(
        html_string,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        strip=True
    )
    # Only parse with BeautifulSoup if there are URLs to sanitize
    if 'href=' not in cleaned and 'src=' not in cleaned:
        return cleaned
    soup = BeautifulSoup(cleaned, 'html.parser')
    for elem in soup.find_all(href=True):
        safe_url = sanitize_url(elem['href'])
        if safe_url is None:
            del elem['href']
        else:
            elem['href'] = safe_url
    for elem in soup.find_all(src=True):
        safe_url = sanitize_url(elem['src'])
        if safe_url is None:
            if elem.name == 'img':
                elem.decompose()
            else:
                del elem['src']
        else:
            elem['src'] = safe_url
    return str(soup)


def get_element_html_content(element):
    """
    Extract HTML content from an element, preserving structure for tables etc.
    For block elements like tables, returns the full HTML.
    For text elements, returns inner HTML preserving inline formatting.
    """
    if element.name in ['table', 'pre', 'blockquote', 'ul', 'ol', 'figure', 'img']:
        # Preserve full HTML structure for block elements and images
        return str(element)
    else:
        # For p, div, li, etc. - get inner HTML (children)
        return ''.join(str(c) for c in element.children)


# --- UTILITY FUNCTIONS ---

def analyze_document_structure(soup):
    """Analyze document to determine if footnotes are sectioned or all at end"""

    # Check for explicit section markers from simple_md_to_html (sequential strategy)
    ref_markers = soup.find_all('a', class_='footnoteSectionStart')
    def_markers = soup.find_all('a', class_='footnoteDefinitionsStart')

    if ref_markers and def_markers:
        print(f"🔍 STRATEGY: SEQUENTIAL - Found {len(ref_markers)} ref section markers and {len(def_markers)} def section markers")
        return 'sequential', {
            'ref_section_count': len(ref_markers),
            'def_section_count': len(def_markers),
        }

    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr'])
    
    # Find all footnote definitions
    footnote_definitions = []
    footnote_references = []
    
    for i, element in enumerate(all_elements):
        text = element.get_text().strip()
        
        # Check for footnote definitions
        if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
            footnote_definitions.append({
                'element': element,
                'index': i,
                'text': text,
                'number': re.search(r'(\d+)', text).group(1) if re.search(r'(\d+)', text) else None
            })
        
        # Check for footnote references (not at start of paragraph)
        elif re.search(r'\[\^?\d+\]', text) and not re.search(r'^\s*\[\^?\d+\]\s*[:.]\s*', text):
            footnote_references.append({
                'element': element,
                'index': i,
                'text': text
            })
    
    print(f"Found {len(footnote_definitions)} footnote definitions and {len(footnote_references)} potential references")
    
    if not footnote_definitions:
        return 'no_footnotes', {}
    
    # Calculate where footnote definitions are located relative to document length
    total_elements = len(all_elements)
    definition_positions = [fd['index'] for fd in footnote_definitions]
    avg_definition_position = sum(definition_positions) / len(definition_positions) if definition_positions else 0
    position_ratio = avg_definition_position / total_elements if total_elements > 0 else 0
    
    # Check if footnotes are clustered at the end (last 20% of document)
    footnotes_at_end = position_ratio > 0.8
    
    # Check for section headers followed by footnotes
    has_section_pattern = False
    headers = [elem for elem in all_elements if elem.name and elem.name.startswith('h')]
    
    for header in headers:
        if 'notes' in header.get_text().lower():
            has_section_pattern = True
            break
    
    # Check for header + footnotes + hr separator patterns
    has_structured_sections = False
    for i, element in enumerate(all_elements):
        if element.name and element.name.startswith('h'):
            # Look ahead for footnotes followed by hr
            footnote_count = 0
            hr_found = False
            for j in range(i + 1, min(i + 50, len(all_elements))):  # Look ahead 50 elements max
                next_elem = all_elements[j]
                next_text = next_elem.get_text().strip()
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', next_text):
                    footnote_count += 1
                elif next_elem.name == 'hr' and footnote_count > 0:
                    has_structured_sections = True
                    break
                elif next_elem.name and next_elem.name.startswith('h'):
                    break
    
    # NEW: Check for footnote numbering resets (key pattern for sectioned docs)
    has_footnote_resets = False
    footnote_numbers_seen = set()
    duplicate_numbers = set()
    
    for fd in footnote_definitions:
        if fd['number']:
            num = fd['number']
            if num in footnote_numbers_seen:
                duplicate_numbers.add(num)
                has_footnote_resets = True
            footnote_numbers_seen.add(num)
    
    print(f"🔍 Footnote reset analysis: duplicate numbers found: {duplicate_numbers}")
    
    # NEW: Check for HR separators distributed throughout document (not just at end)
    hr_elements = [elem for elem in all_elements if elem.name == 'hr']
    has_distributed_hrs = False
    if len(hr_elements) >= 2:
        hr_positions = [all_elements.index(hr) for hr in hr_elements]
        # If HRs are spread throughout (not all in last 20% of document)
        early_hrs = [pos for pos in hr_positions if pos < total_elements * 0.8]
        if len(early_hrs) >= 2:
            has_distributed_hrs = True
    
    print(f"🔍 HR distribution analysis: {len(hr_elements)} HRs found, {len(hr_elements) if has_distributed_hrs else 0} distributed throughout")
    
    # Check if this is a "references throughout + definitions at end" pattern
    references_throughout_definitions_at_end = False
    if footnotes_at_end and len(footnote_references) > 0 and len(footnote_definitions) > 10:
        # Check if references are spread throughout (not just at end)
        ref_positions = [fr['index'] for fr in footnote_references]
        avg_ref_position = sum(ref_positions) / len(ref_positions) if ref_positions else 0
        ref_position_ratio = avg_ref_position / total_elements if total_elements > 0 else 0
        
        # If references average position is much earlier than definitions (< 0.6 vs > 0.8)
        if ref_position_ratio < 0.6 and position_ratio > 0.8:
            references_throughout_definitions_at_end = True
    
    # Decision logic
    strategy_info = {
        'total_elements': total_elements,
        'footnote_count': len(footnote_definitions),
        'reference_count': len(footnote_references),
        'position_ratio': position_ratio,
        'footnotes_at_end': footnotes_at_end,
        'has_section_pattern': has_section_pattern,
        'has_structured_sections': has_structured_sections,
        'references_throughout_definitions_at_end': references_throughout_definitions_at_end,
        'has_footnote_resets': has_footnote_resets,
        'has_distributed_hrs': has_distributed_hrs,
        'duplicate_numbers': list(duplicate_numbers)
    }
    
    # Updated decision logic with footnote reset detection as primary indicator
    if has_footnote_resets and has_distributed_hrs:
        strategy = 'sectioned'
        print("🔍 STRATEGY: SECTIONED - Footnote numbering resets detected with HR separators")
    elif has_footnote_resets and len(hr_elements) > 0:
        strategy = 'sectioned'
        print("🔍 STRATEGY: SECTIONED - Footnote numbering resets detected")
    elif references_throughout_definitions_at_end:
        strategy = 'whole_document'
        print("🔍 STRATEGY: WHOLE DOCUMENT - References throughout text, definitions at end")
    elif has_structured_sections:
        strategy = 'sectioned'
        print("🔍 STRATEGY: SECTIONED - Found header + footnotes + hr patterns")
    elif footnotes_at_end and not has_section_pattern and not has_footnote_resets:
        strategy = 'whole_document'
        print("🔍 STRATEGY: WHOLE DOCUMENT - Footnotes clustered at end")
    elif has_section_pattern and not references_throughout_definitions_at_end:
        strategy = 'sectioned'
        print("🔍 STRATEGY: SECTIONED - Found 'Notes' headers")
    else:
        strategy = 'whole_document'
        print("🔍 STRATEGY: WHOLE DOCUMENT - Default fallback")
    
    print(f"📊 Document analysis: {strategy_info}")
    return strategy, strategy_info

def detect_footnote_sections(soup):
    """Detect footnote sections by scanning forward and identifying text ranges"""
    # Include tables and other block elements that might be part of multi-paragraph footnotes
    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
    print("--- DEBUG: Section Detection ---")
    print(f"Total elements found: {len(all_elements)}")
    
    # Find all headers and hr separators first
    headers = []
    hrs = []
    
    for i, element in enumerate(all_elements):
        text = element.get_text().strip()
        if element.name and element.name.startswith('h'):
            headers.append({
                'element': element,
                'index': i,
                'text': text
            })
            print(f"Found header at index {i}: {text}")
        elif element.name == 'hr':
            hrs.append({
                'element': element,
                'index': i,
                'text': '---'
            })
            print(f"Found HR separator at index {i}")
    
    # Look for header + footnotes + hr patterns
    section_boundaries = []
    
    for header in headers:
        header_idx = header['index']
        
        # Find the next HR after this header
        next_hr = None
        for hr in hrs:
            if hr['index'] > header_idx:
                next_hr = hr
                break
        
        if next_hr:
            # Check if there are footnotes between this header and the HR
            footnote_count = 0
            for i in range(header_idx + 1, next_hr['index']):
                if i >= len(all_elements):
                    break
                element = all_elements[i]
                text = element.get_text().strip()
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                    footnote_count += 1
            
            if footnote_count > 0:
                section_boundaries.append({
                    'type': 'header_with_footnotes',
                    'header': header,
                    'hr': next_hr,
                    'footnote_count': footnote_count
                })
                print(f"Found section: {header['text']} -> {footnote_count} footnotes -> HR at {next_hr['index']}")
    
    # Also add standalone notes headers (original behavior as fallback)
    for header in headers:
        if 'notes' in header['text'].lower():
            # Check if this header isn't already part of a header+hr pattern
            already_included = any(boundary['header']['index'] == header['index'] 
                                 for boundary in section_boundaries 
                                 if boundary['type'] == 'header_with_footnotes')
            if not already_included:
                section_boundaries.append({
                    'type': 'notes_header',
                    'header': header,
                    'hr': None,
                    'footnote_count': 0  # Will be calculated later
                })
                print(f"Found standalone notes header: {header['text']}")
    
    # For each boundary, create sections
    sections = []
    section_counter = 0
    
    for boundary_idx, boundary in enumerate(section_boundaries):
        footnotes = []
        
        if boundary['type'] == 'header_with_footnotes':
            # Text is before the header, footnotes are between header and HR
            header_idx = boundary['header']['index']
            hr_idx = boundary['hr']['index']
            
            # Collect footnotes between header and HR
            for i in range(header_idx + 1, hr_idx):
                if i >= len(all_elements):
                    break
                element = all_elements[i]
                text = element.get_text().strip()
                
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                    footnotes.append(element)
                    print(f"  Found footnote in section: {text[:50]}...")
            
            if footnotes:
                section_counter += 1
                
                # Text range: from start of document (or end of previous section) to this header
                text_start_idx = 0
                if boundary_idx > 0:
                    prev_boundary = section_boundaries[boundary_idx - 1]
                    if prev_boundary['type'] == 'header_with_footnotes':
                        text_start_idx = prev_boundary['hr']['index'] + 1
                    else:
                        # Handle notes_header type
                        text_start_idx = prev_boundary['header']['index'] + 1
                        # Skip previous footnotes
                        for j in range(text_start_idx, header_idx):
                            if j >= len(all_elements):
                                break
                            elem_text = all_elements[j].get_text().strip()
                            if not re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', elem_text):
                                text_start_idx = j
                                break
                
                section_data = {
                    'id': f'section_{section_counter}',
                    'header': boundary['header']['element'],
                    'footnotes': footnotes,
                    'text_start_idx': text_start_idx,
                    'text_end_idx': header_idx,  # Text ends at the header
                    'footnotes_start_idx': header_idx + 1,
                    'footnotes_end_idx': hr_idx
                }
                sections.append(section_data)
                print(f"Created section {section_counter} with {len(footnotes)} footnotes")
                print(f"  Header: {boundary['header']['text']}")
                print(f"  Text range: {section_data['text_start_idx']} to {section_data['text_end_idx']}")
                print(f"  Footnotes range: {section_data['footnotes_start_idx']} to {section_data['footnotes_end_idx']}")
        
        elif boundary['type'] == 'notes_header':
            # Traditional notes header - footnotes come after
            header_idx = boundary['header']['index']
            
            # Find where footnotes end (next header or end of document)
            end_idx = len(all_elements)
            for other_boundary in section_boundaries:
                if (other_boundary != boundary and 
                    other_boundary['header']['index'] > header_idx):
                    end_idx = other_boundary['header']['index']
                    break
            
            # Collect footnotes after header
            for i in range(header_idx + 1, end_idx):
                if i >= len(all_elements):
                    break
                element = all_elements[i]
                text = element.get_text().strip()
                
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                    footnotes.append(element)
                    print(f"  Found footnote in notes section: {text[:50]}...")
            
            if footnotes:
                section_counter += 1
                
                # Text range: from start of document (or end of previous section) to this header
                text_start_idx = 0
                if boundary_idx > 0:
                    prev_boundary = section_boundaries[boundary_idx - 1]
                    if prev_boundary['type'] == 'header_with_footnotes':
                        text_start_idx = prev_boundary['hr']['index'] + 1
                    else:
                        text_start_idx = prev_boundary['header']['index'] + 1
                
                section_data = {
                    'id': f'section_{section_counter}',
                    'header': boundary['header']['element'],
                    'footnotes': footnotes,
                    'text_start_idx': text_start_idx,
                    'text_end_idx': header_idx,  # Text ends at the notes header
                    'footnotes_start_idx': header_idx + 1,
                    'footnotes_end_idx': end_idx
                }
                sections.append(section_data)
                print(f"Created notes section {section_counter} with {len(footnotes)} footnotes")
                print(f"  Text range: {section_data['text_start_idx']} to {section_data['text_end_idx']}")
                print(f"  Footnotes range: {section_data['footnotes_start_idx']} to {section_data['footnotes_end_idx']}")
    
    # Handle case where there are footnotes but no section headers
    if not sections:
        # NEW: Try to detect HR-separated footnote groups
        hr_positions = [i for i, elem in enumerate(all_elements) if elem.name == 'hr']
        
        if len(hr_positions) >= 2:
            print(f"Attempting HR-based section detection with {len(hr_positions)} separators")
            sections = []
            section_counter = 0
            
            # Create sections between HR separators
            section_starts = [0] + [pos + 1 for pos in hr_positions[:-1]]  # Start after each HR except last
            section_ends = hr_positions  # End at each HR
            
            for i, (start_idx, end_idx) in enumerate(zip(section_starts, section_ends)):
                footnotes = []
                
                # Collect footnotes in this range
                for j in range(start_idx, end_idx):
                    if j >= len(all_elements):
                        break
                    element = all_elements[j]
                    text = element.get_text().strip()
                    
                    if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                        footnotes.append(element)
                        print(f"  Found footnote in HR section {i+1}: {text[:30]}...")
                
                if footnotes:
                    section_counter += 1
                    section_data = {
                        'id': f'hr_section_{section_counter}',
                        'header': None,
                        'footnotes': footnotes,
                        'text_start_idx': start_idx,
                        'text_end_idx': end_idx,
                        'footnotes_start_idx': start_idx,
                        'footnotes_end_idx': end_idx
                    }
                    sections.append(section_data)
                    print(f"Created HR-based section {section_counter} with {len(footnotes)} footnotes (range {start_idx}-{end_idx})")
        
        # Fallback to default section if HR-based detection didn't work
        if not sections:
            footnotes = []
            for element in all_elements:
                text = element.get_text().strip()
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                    footnotes.append(element)
            
            if footnotes:
                sections = [{
                    'id': 'default_section',
                    'header': None,
                    'footnotes': footnotes,
                    'text_start_idx': 0,
                    'text_end_idx': len(all_elements),
                    'footnotes_start_idx': 0,
                    'footnotes_end_idx': len(all_elements)
                }]
                print(f"Created fallback default section with {len(footnotes)} footnotes")
    
    print(f"Total sections detected: {len(sections)}")
    # Also return the elements list for position-based matching
    return sections, all_elements

def normalize_unicode_name(name):
    """Normalize unicode characters in names for key matching.
    Converts ß→ss, ü→u, é→e, etc. Also handles hyphenated names."""
    import unicodedata
    # First handle German ß explicitly (it normalizes to 'ss')
    name = name.replace('ß', 'ss').replace('ẞ', 'SS')
    # Normalize to NFD (decomposed form), then remove combining marks
    normalized = unicodedata.normalize('NFD', name)
    # Keep only ASCII letters, removing diacritics
    ascii_name = ''.join(c for c in normalized if unicodedata.category(c) != 'Mn')
    # Remove hyphens for key generation (von Ingersleben-Seip → von IngerslebenSeip)
    ascii_name = ascii_name.replace('-', '').replace("'", '')
    return ascii_name

def generate_ref_keys(text, context_text=""):
    # Normalize curly apostrophes to straight for consistent matching
    text = text.replace('\u2019', "'").replace('\u2018', "'").replace('\u02BC', "'")
    context_text = context_text.replace('\u2019', "'").replace('\u2018', "'").replace('\u02BC', "'")
    processed_text = re.sub(r'\[\d{4}\]\s*', '', text)
    # Prefer parenthesized year (common in bibliography: "Author (2022). Title...")
    paren_year = re.search(r'\((\d{4}[a-z]?)\)', processed_text)
    if paren_year:
        year_match = paren_year
    else:
        # For entries without parenthesized year, find the LAST plausible year (1900-2099)
        # to avoid picking up title numbers like "Scopus 1900–2020" or arXiv IDs like "2601"
        plausible_years = list(re.finditer(r'(?<!\d)(\d{4}[a-z]?)(?!\d)', processed_text))
        plausible_years = [m for m in plausible_years if 1900 <= int(re.match(r'\d{4}', m.group(1)).group()) <= 2099]
        year_match = plausible_years[-1] if plausible_years else None
    if not year_match: return []
    year = year_match.group(1)
    authors_part = text.split(year)[0]
    # For bare-year entries (no parens), the year is near the end so authors_part
    # includes the title. Limit to the initial author block (before first ". " + uppercase).
    # Use lookbehind to avoid matching single-letter initials like "G. Otis" or "D. Lawrence".
    if not paren_year and '. ' in authors_part:
        author_block_end = re.search(r'(?<=[a-z]{2})\.\s+[A-Z]', authors_part)
        if author_block_end:
            authors_part = authors_part[:author_block_end.start()]
    keys = set()
    # Check for any letter (including Unicode) in authors_part
    has_author = re.search(r'[a-zA-ZÀ-ÿßẞ]', authors_part)
    author_source = authors_part if has_author else context_text

    if author_source:
        if not has_author:
            # Try to extract full author group at end of context: "Name", "Name and Name", "Name, Name, and Name"
            group_match = re.search(
                r"([A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zA-ZÀ-ÿßẞ'-]+(?:(?:\s+and\s+|\s*,\s*(?:and\s+)?)[A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zA-ZÀ-ÿßẞ'-]+)*)\s*$",
                author_source
            )
            if group_match:
                author_source = group_match.group(1)
            else:
                # Fallback: last capitalized word
                candidates = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
                if candidates: author_source = candidates[-1]

        # Match capitalized words including Unicode letters and hyphens
        # This pattern matches: Capital letter (including accented) followed by letters/hyphens/apostrophes
        surnames = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
        excluded = {'And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'}
        # Normalize Unicode and remove apostrophe-s for key generation
        surnames = [normalize_unicode_name(s.replace("'s", "")).lower() for s in surnames if s not in excluded and len(s) > 1]
        if surnames:
            keys.add(surnames[0] + year)
            surnames.sort()
            keys.add("".join(surnames) + year)
            # Also generate keys using last-word-of-each-author-group as surnames
            # (handles "FirstName LastName and FirstName LastName" bibliography patterns)
            groups = re.split(r'\s+and\s+|,\s*and\s+|,\s+(?=[A-Z])', author_source)
            group_surnames = []
            for group in groups:
                words = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", group)
                words = [w for w in words if w not in excluded and len(w) > 1]
                if words:
                    group_surnames.append(normalize_unicode_name(words[-1].replace("'s", "")).lower())
            if group_surnames and set(group_surnames) != set(surnames):
                keys.add(group_surnames[0] + year)
                group_surnames.sort()
                keys.add("".join(group_surnames) + year)

    acronyms = re.findall(r'\b[A-Z]{2,}\b', author_source)
    for acronym in acronyms: keys.add(acronym.lower() + year)
    if "United Nations General Assembly" in text: keys.add("un" + year)
    return list(keys)

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

    # First pass: find indices of all footnote start elements
    footnote_starts = []
    for i, element in enumerate(all_elements):
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


def is_likely_reference(p_tag):
    """
    Detect if a paragraph looks like a bibliography reference entry.
    Handles multiple formats:
    - Standard: "Author, A. (2023). Title..."
    - Numbered: "[1] Author, A. (2023). Title..."
    - Bracketed year: "[2023] Author. Title..."
    - Noble particles: "von Name, A. (2023). Title..."
    """
    if not p_tag: return False
    text = p_tag.get_text(" ", strip=True)

    # Must contain a 4-digit year
    if not re.search(r'\d{4}', text):
        return False

    # Check various reference formats:
    # 1. Numbered format: [1] Author... (year)
    if re.match(r'^\s*\[\d+\]', text):
        return True

    # 2. Bracketed year format: [2023] Author...
    if re.match(r'^\s*\[\d{4}\]', text):
        return True

    # 3. Noble particle format: starts with common particles like "von", "van", "de", "du", "da", "del", "della"
    # followed by a capitalized surname
    if re.match(r'^\s*(von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-ZÀ-ÖØ-Þ]', text, re.IGNORECASE):
        return True

    # 4. Em-dash repeat-author format: —. Year. Title...
    if re.match(r'^\s*[\u2014\u2013\u2012\u2015\u2E3A\u2E3B—–-]{1,3}[\.\,\s]', text):
        return True

    # 5. Standard author-first format: starts with capital letter (including Unicode like Ö, É, etc.)
    # Use Unicode property \p{Lu} for uppercase letters, or check first non-space char
    first_char = text.lstrip()[:1] if text.strip() else ''
    if first_char and first_char.isupper():
        return True

    return False

# --- MAIN PROCESSING LOGIC ---

def main(html_file_path, output_dir, book_id):
    emit_progress(48, "doc_parse", "Parsing HTML document")
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    # Check if this is a STEM bibliography-style document
    footnote_meta_path = os.path.join(output_dir, 'footnote_meta.json')
    is_stem = False
    if os.path.exists(footnote_meta_path):
        with open(footnote_meta_path, 'r') as f:
            is_stem = json.load(f).get('classification') == 'wackSTEMbibliographyNotes'
    if is_stem:
        print("📐 STEM bibliography mode detected — using wackSTEM marker conversion")

    # ========================================================================
    # SAFARI FIX: Remove RTL spans that cause findTextSamplesByVisualExamination lag
    # Pandoc generates <span dir="rtl">'</span> for smart quotes from DOCX
    # These trigger Safari's bidirectional text analysis and freeze the browser
    # ========================================================================
    rtl_spans = soup.find_all('span', attrs={'dir': 'rtl'})
    for span in rtl_spans:
        # Replace the span with just its text content (the quote character)
        span.replace_with(span.get_text())
    if rtl_spans:
        print(f"🔧 SAFARI FIX: Removed {len(rtl_spans)} RTL spans from document")

    # ========================================================================
    # PRE-PROCESS: Split multi-entry bibliography paragraphs
    # ========================================================================
    # PDF conversion sometimes crams many reference entries into a single <p>,
    # separated by newlines. Split these so each entry gets its own <p>.
    split_count = 0
    for p in list(soup.find_all('p')):
        inner = p.decode_contents()
        if '\n' not in inner:
            continue
        lines = [l.strip() for l in inner.split('\n') if l.strip()]
        if len(lines) < 2:
            continue
        # Count lines that look like reference entries (start with uppercase + contain a year)
        ref_lines = 0
        for l in lines:
            line_text = BeautifulSoup(l, 'html.parser').get_text()
            if line_text and line_text[0].isupper() and re.search(r'\d{4}', line_text):
                ref_lines += 1
        if ref_lines >= 2:
            new_elements = []
            for line in lines:
                new_p = soup.new_tag('p')
                new_p.append(BeautifulSoup(line, 'html.parser'))
                new_elements.append(new_p)
            # Insert after original in reverse, then remove original
            for new_p in reversed(new_elements):
                p.insert_after(new_p)
            p.decompose()
            split_count += 1
            print(f"  Split multi-entry <p> into {len(new_elements)} individual entries")
    if split_count:
        print(f"Pre-processed {split_count} multi-entry bibliography paragraphs")


    # ========================================================================
    # STEM BIBLIOGRAPHY PROCESSING (wackSTEMbibliographyNotes)
    # ========================================================================
    if is_stem:
        references_data = []
        footnotes_data = []
        all_footnotes_data = []

        # Convert wackSTEMdef → bib-entry and collect references
        for a_tag in soup.find_all('a', class_='wackSTEMdef'):
            ref_id = a_tag.get('id', '')
            a_tag['class'] = 'bib-entry'
            # Store just the text for popup display (not the <a>/<p> wrapper)
            ref_text = a_tag.get_text()
            if ref_text:
                references_data.append({"referenceId": ref_id, "content": ref_text})

        # Convert wackSTEMcite → in-text-citation with href
        for a_tag in soup.find_all('a', class_='wackSTEMcite'):
            cite_text = a_tag.get_text()
            data_refs = a_tag.get('data-refs')
            if data_refs:
                # Range citation: href points to first ref, data-refs preserved
                first_ref = data_refs.split(',')[0]
                a_tag['href'] = f'#{first_ref}'
            else:
                num_match = re.search(r'\d+', cite_text)
                if num_match:
                    a_tag['href'] = f'#stemref_{num_match.group()}'
            a_tag['class'] = 'in-text-citation'

        stem_cites = len(soup.find_all('a', class_='in-text-citation'))
        print(f"Converted {len(references_data)} STEM bibliography entries")
        print(f"Converted {stem_cites} STEM in-text citations")

        # Write audit.json
        os.makedirs(output_dir, exist_ok=True)
        audit_data = {
            'stem_mode': True,
            'total_refs': stem_cites,
            'total_defs': len(references_data),
            'gaps': [], 'duplicates': [],
            'unmatched_refs': [], 'unmatched_defs': []
        }
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (STEM path)
        conversion_stats = {
            'references_found': len(references_data),
            'citations_total': stem_cites,
            'citations_linked': stem_cites,
            'footnotes_matched': 0,
            'footnote_strategy': 'stem_bibliography',
            'citation_style': 'numbered-bracket',
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

    # ========================================================================
    # STANDARD PROCESSING: PASS 1 + PASS 2 + AUDIT (skipped for STEM)
    # ========================================================================
    if not is_stem:

        # ========================================================================
        # PASS 1: EXTRACT ALL DEFINITIONS
        # ========================================================================
        emit_progress(52, "doc_bibliography", "Scanning for bibliography")
        print("--- PASS 1: Extracting All Definitions ---")

        # --- 1A: Process Bibliography / References ---
        bibliography_map = {}
        references_data = []
        all_paragraphs = soup.find_all('p')
        reference_p_tags = []

        print(f"📚 Scanning {len(all_paragraphs)} paragraphs for reference section...")

        # Common reference section headers
        REFERENCE_HEADERS = ["references", "bibliography", "works cited", "sources", "literature cited", "reference list"]

        # PRIMARY: Find reference section by heading (more reliable for academic papers)
        all_headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
        for heading in all_headings:  # Forward scan to find first matching heading
            header_text = heading.get_text(strip=True).lower()
            if header_text in REFERENCE_HEADERS:
                print(f"  📖 Found references heading: '{header_text}'")
                bib_heading_level = int(heading.name[1])  # e.g. h2 → 2
                # Collect ALL paragraphs until the next same-or-higher-level heading
                next_sibling = heading.find_next_sibling()
                while next_sibling:
                    if next_sibling.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                        sibling_level = int(next_sibling.name[1])
                        if sibling_level <= bib_heading_level:
                            # Peek ahead: are subsequent paragraphs reference-like?
                            # Use strict check: year must appear near start of text (first 80 chars).
                            # Body text has years scattered in citations far from the start;
                            # bibliography entries always have Author. Year. near the beginning.
                            peek = next_sibling.find_next_sibling()
                            peek_refs = 0
                            peek_total = 0
                            while peek and peek_total < 3:
                                if peek.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                                    peek = peek.find_next_sibling()
                                    continue
                                if peek.name == 'p':
                                    peek_total += 1
                                    peek_text = peek.get_text(" ", strip=True)
                                    # Strict: reference-like AND year within first 80 chars
                                    if is_likely_reference(peek) and re.search(r'\d{4}', peek_text[:80]):
                                        peek_refs += 1
                                peek = peek.find_next_sibling()
                            if peek_total >= 2 and peek_refs >= 2:
                                # Multiple reference-like paragraphs follow — heading is OCR artifact
                                print(f"  ⚠️ Skipping embedded heading (OCR artifact): '{next_sibling.get_text(strip=True)[:60]}'")
                                next_sibling = next_sibling.find_next_sibling()
                                continue
                            break  # Real section boundary
                        # Lower level → alphabetical marker or sub-section within bibliography, skip it
                    if next_sibling.name == 'p' and is_likely_reference(next_sibling):
                        reference_p_tags.append(next_sibling)
                        text_preview = next_sibling.get_text(" ", strip=True)[:80]
                        print(f"  ✓ Detected reference: {text_preview}...")
                    next_sibling = next_sibling.find_next_sibling()
                # Don't break — continue scanning for more reference sections (multi-chapter books)

        # FALLBACK: If no heading found, use reverse paragraph scan
        if not reference_p_tags:
            print("  ⚠️ No references heading found, scanning paragraphs...")
            for p in reversed(all_paragraphs):
                text_preview = p.get_text(" ", strip=True)[:80]
                if is_likely_reference(p):
                    reference_p_tags.insert(0, p)
                    print(f"  ✓ Detected reference: {text_preview}...")
                elif reference_p_tags:
                    header_text = p.get_text(strip=True).lower()
                    if header_text in REFERENCE_HEADERS:
                        reference_p_tags.insert(0, p)
                        print(f"  📖 Found references header: '{header_text}'")
                    break

        print(f"📚 Found {len(reference_p_tags)} reference paragraphs")

        # Detect markdown list markers (- or *) used consistently across entries
        list_marker_count = sum(
            1 for p in reference_p_tags
            if re.match(r'^\s*[-*]\s', p.get_text(" ", strip=True))
        )
        strip_list_marker = list_marker_count > len(reference_p_tags) * 0.5
        if strip_list_marker:
            print(f"  📋 Detected list-marker format ({list_marker_count}/{len(reference_p_tags)} entries) — stripping '- ' prefixes")

        seen_references = {}  # base_entry_id → {"text": str, "suffix_count": int}
        used_ids = set()      # all entry_ids actually assigned (including suffixed)
        last_bib_author = ""  # Track last author for em-dash (—) repeat-author entries

        for p in reference_p_tags:
            text = p.get_text(" ", strip=True)
            if strip_list_marker:
                text = re.sub(r'^\s*[-*]\s+', '', text)

            # Handle em-dash repeat-author entries (e.g. "—. 2014. Title...")
            # Common academic convention: — means "same author as previous entry"
            dash_match = re.match(r'^[\u2014\u2013\u2012\u2015—–-]{1,3}[\.\,\s]', text)
            if dash_match and last_bib_author:
                # Replace the dash with the previous author name
                text_with_author = last_bib_author + text[dash_match.end()-1:]
                print(f"  ↩️ Dash-author entry, substituting '{last_bib_author}': {text[:60]}...")
                keys = generate_ref_keys(text_with_author)
            else:
                keys = generate_ref_keys(text)
                # Update last_bib_author from this entry (text before the year)
                if keys and not dash_match:
                    year_match = re.search(r'\d{4}', text)
                    if year_match:
                        last_bib_author = text[:year_match.start()].rstrip(' .,;:(')
                # For entries with prefix year (Author (YEAR1)) that also have a different
                # publication year in the body (YEAR2), generate keys for both years
                # to handle OCR errors in the prefix year
                if keys:
                    paren_yr = re.search(r'\((\d{4}[a-z]?)\)', text)
                    if paren_yr:
                        prefix_yr = paren_yr.group(1)
                        body_text = text[paren_yr.end():]
                        body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', body_text))
                        body_years = [m for m in body_years if 1900 <= int(m.group(1)) <= 2099 and m.group(1) != prefix_yr]
                        if body_years:
                            alt_yr = body_years[-1].group(1)
                            alt_keys = [k.replace(prefix_yr, alt_yr) for k in keys if prefix_yr in k]
                            keys = list(set(keys + alt_keys))

            if not keys:
                # Fallback: for entries with garbled prefix initials like "K. E. (2005) Daniel Kennefick..."
                # extract author names from the text AFTER the parenthesized year prefix
                paren_year_match = re.search(r'\((\d{4}[a-z]?)\)', text)
                if paren_year_match:
                    remainder = text[paren_year_match.end():].strip()
                    prefix_year = paren_year_match.group(1)
                    # Extract author block from remainder (before title start: ". " after 2+ lowercase chars + uppercase)
                    # Avoids matching initials like "H. G" or "D. L"
                    author_block_match = re.search(r'(?<=[a-z]{2})\.\s+[A-Z]', remainder)
                    if author_block_match:
                        author_text = remainder[:author_block_match.start()] + " " + prefix_year
                    else:
                        author_text = remainder.split('.')[0] + " " + prefix_year
                    keys = generate_ref_keys(author_text)
                    # Also generate keys with alternative years from body text
                    body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', remainder))
                    body_years = [m for m in body_years if 1900 <= int(m.group(1)) <= 2099 and m.group(1) != prefix_year]
                    if body_years:
                        alt_year = body_years[-1].group(1)
                        alt_keys = generate_ref_keys(author_text.replace(prefix_year, alt_year))
                        keys = list(set(keys + alt_keys))
                    if keys:
                        print(f"  🔄 Fallback keys from post-prefix text: {keys}")

            if not keys:
                print(f"  ⚠️ No keys generated for: {text[:60]}...")
                continue

            base_entry_id = keys[0]

            if base_entry_id not in seen_references:
                # First time seeing this base key
                if base_entry_id not in used_ids:
                    # ID is free — add normally
                    seen_references[base_entry_id] = {"text": text, "suffix_count": 0}
                    entry_id = base_entry_id
                else:
                    # ID was already taken by a collision suffix from a different base key
                    # Treat this as a new base that needs an immediate suffix
                    seen_references[base_entry_id] = {"text": text, "suffix_count": 0}
                    suffix_num = 1
                    while base_entry_id + chr(ord('a') + suffix_num) in used_ids:
                        suffix_num += 1
                    entry_id = base_entry_id + chr(ord('a') + suffix_num)
                    seen_references[base_entry_id]["suffix_count"] = suffix_num
                    print(f"  🔀 ID '{base_entry_id}' already taken by suffix — using {entry_id}")
            else:
                prev = seen_references[base_entry_id]
                # Compare content (first 60 alphanum chars, normalized) to detect true dupes vs collisions
                normalize = lambda t: re.sub(r'[^a-z0-9]', '', t.lower())[:60]
                if normalize(prev["text"]) == normalize(text):
                    # True duplicate — skip DOM/data, but still add keys
                    for key in keys:
                        bibliography_map[key] = base_entry_id if prev["suffix_count"] == 0 else base_entry_id + "a"
                    print(f"  ⏭️ Duplicate reference skipped (keys still added): {base_entry_id}")
                    continue
                else:
                    # Collision — different paper, same author+year
                    # Retroactively suffix the first entry if this is the first collision
                    if prev["suffix_count"] == 0:
                        old_id = base_entry_id
                        # Find a free suffix for the first entry
                        first_suffix = 0  # 'a'
                        while base_entry_id + chr(ord('a') + first_suffix) in used_ids:
                            first_suffix += 1
                        new_first_id = base_entry_id + chr(ord('a') + first_suffix)
                        # Update the first entry's anchor and references_data
                        first_anchor = soup.find("a", {"id": old_id, "class": "bib-entry"})
                        if first_anchor:
                            first_anchor["id"] = new_first_id
                            parent_p = first_anchor.find_parent('p')
                        else:
                            parent_p = None
                        for rd in references_data:
                            if rd["referenceId"] == old_id:
                                rd["referenceId"] = new_first_id
                                if first_anchor and parent_p:
                                    rd["content"] = str(parent_p)
                                break
                        # Remap bibliography_map entries pointing to old_id
                        for k, v in list(bibliography_map.items()):
                            if v == old_id:
                                bibliography_map[k] = new_first_id
                        used_ids.discard(old_id)
                        used_ids.add(new_first_id)
                        seen_references[base_entry_id]["suffix_count"] = first_suffix
                        print(f"  🔀 Collision detected! Retroactively suffixed first entry: {old_id} → {new_first_id}")

                    prev["suffix_count"] += 1
                    suffix = chr(ord('a') + prev["suffix_count"])
                    # Skip past any suffixes already taken
                    while base_entry_id + suffix in used_ids:
                        prev["suffix_count"] += 1
                        suffix = chr(ord('a') + prev["suffix_count"])
                    entry_id = base_entry_id + suffix
                    print(f"  🔀 Collision: assigned suffix → {entry_id}")

            used_ids.add(entry_id)

            # Add keys to bibliography_map
            for key in keys:
                bibliography_map[key] = entry_id
            # Add DOM anchor + references_data entry
            anchor_tag = soup.new_tag("a", attrs={"class": "bib-entry", "id": entry_id})
            p.insert(0, anchor_tag)
            references_data.append({"referenceId": entry_id, "content": str(p)})
            print(f"  🔑 Generated keys for reference: {keys} → {entry_id}")

        print(f"📚 Bibliography map has {len(bibliography_map)} entries: {list(bibliography_map.keys())[:10]}{'...' if len(bibliography_map) > 10 else ''}")
        print(f"Found and processed {len(references_data)} reference entries (kept in DOM).")

        # --- 1B: Process Footnotes (ROUTER-BASED) ---
        # Check if footnotes.json already exists (e.g., from epub_normalizer.py)
        # If so, use that instead of detecting footnotes ourselves
        existing_footnotes_path = os.path.join(output_dir, 'footnotes.json')
        if os.path.exists(existing_footnotes_path):
            try:
                with open(existing_footnotes_path, 'r', encoding='utf-8') as f:
                    existing_footnotes = json.load(f)
                if existing_footnotes and len(existing_footnotes) > 0:
                    print(f"--- Using existing footnotes.json ({len(existing_footnotes)} footnotes) ---")
                    all_footnotes_data = existing_footnotes
                    footnote_sections = []
                    sectioned_footnote_map = {}
                    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
                    # Skip to node chunking
                    strategy = 'pre_processed'
                else:
                    strategy, strategy_info = analyze_document_structure(soup)
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Could not read existing footnotes.json: {e}")
                strategy, strategy_info = analyze_document_structure(soup)
        else:
            strategy, strategy_info = analyze_document_structure(soup)

        if strategy == 'sequential':
            # Use sequential footnote processing (ref/def sections restart numbering)
            sequential_footnote_map, all_footnotes_data = process_sequential_footnotes(soup, book_id)
            sectioned_footnote_map = sequential_footnote_map
            footnotes_data = all_footnotes_data
            footnote_sections = []
            all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img', 'a'])
        elif strategy == 'whole_document':
            # Use simple whole-document footnote processing
            global_footnote_map, footnotes_data = process_whole_document_footnotes(soup, book_id)
            sectioned_footnote_map = {'whole_document': global_footnote_map}
            all_footnotes_data = footnotes_data
            footnote_sections = []
            all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
        elif strategy != 'pre_processed':
            # Use section-aware footnote processing
            footnote_sections, all_elements = detect_footnote_sections(soup)
            sectioned_footnote_map = {}
            all_footnotes_data = []
    
        # Process traditional footnotes container first (skip if pre-processed)
        fn_container = soup.find('section', class_='footnotes')
        if fn_container and strategy != 'pre_processed':
            list_items = fn_container.find_all('li')
        
            for li in list_items:
                back_link = li.find('a', class_='footnote-back')
                if not back_link: continue

                href = back_link.get('href', '')
                id_match = re.search(r'#fnref(\d+)', href)
                if not id_match: continue
            
                identifier = id_match.group(1)

                # Generate unique footnote ID for traditional footnotes (shorter format without book prefix)
                random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
                unique_fn_id = f"Fn{int(time.time() * 1000)}_{random_suffix}"

                # Add anchor with unique ID and count attribute
                anchor_tag = soup.new_tag('a', id=unique_fn_id)
                anchor_tag['fn-count-id'] = identifier
                li.insert(0, anchor_tag)

                # Update the back-link to point to the unique in-text reference (same ID)
                back_link['href'] = f"#{unique_fn_id}"

                # Extract content for JSON
                temp_li = BeautifulSoup(str(li), 'html.parser')
                temp_back_link = temp_li.find('a', class_='footnote-back')
                if temp_back_link:
                    temp_back_link.decompose()
                content = temp_li.li.decode_contents().strip()

                # Store in global section for traditional footnotes
                if 'traditional' not in sectioned_footnote_map:
                    sectioned_footnote_map['traditional'] = {}
            
                sectioned_footnote_map['traditional'][identifier] = {
                    'unique_fn_id': unique_fn_id,
                    'content': content,
                    'section_id': 'traditional'
                }
            
                all_footnotes_data.append({"footnoteId": unique_fn_id, "content": content})
        
            print(f"Unwrapping {len(list_items)} traditional footnote items to be processed as individual nodes.")
            fn_container.replace_with(*list_items)
    
        # Process sectioned footnotes with multi-paragraph support
        for section in footnote_sections:
            section_id = section['id']
            sectioned_footnote_map[section_id] = {}

            # Get the range of elements in this section's footnotes area
            fn_start_idx = section.get('footnotes_start_idx', 0)
            fn_end_idx = section.get('footnotes_end_idx', len(all_elements))

            # Get elements in the footnotes range
            section_elements = all_elements[fn_start_idx:fn_end_idx]

            # Find indices of footnote starts within this range
            footnote_starts = []
            for i, element in enumerate(section_elements):
                text = element.get_text().strip()
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                    footnote_starts.append(i)

            # Process each footnote with its continuation elements
            for j, start_idx in enumerate(footnote_starts):
                # End index is either next footnote start or end of section
                end_idx = footnote_starts[j + 1] if j + 1 < len(footnote_starts) else len(section_elements)

                # Get the first element (contains the marker)
                first_element = section_elements[start_idx]
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
                # Stop at headings or horizontal rules (section boundaries)
                for elem in section_elements[start_idx + 1:end_idx]:
                    # Stop if we hit a heading or hr (section boundary)
                    if elem.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']:
                        break
                    elem_content = get_element_html_content(elem)
                    if elem_content and elem_content.strip():
                        content_parts.append(elem_content.strip())

                # Combine all content with HTML line breaks for multi-paragraph support
                full_content = '<br><br>'.join(content_parts) if len(content_parts) > 1 else (content_parts[0] if content_parts else '')

                print(f"Processing footnote {identifier} in section {section_id}: {full_content[:30]}... ({len(content_parts)} parts)")

                # Generate unique footnote ID with section prefix (shorter format without book prefix)
                random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
                unique_fn_id = f"s{section_id}_Fn{int(time.time() * 1000)}_{random_suffix}"

                # Add anchor with unique ID and section info to the first element
                anchor_tag = soup.new_tag('a', id=unique_fn_id)
                anchor_tag['fn-count-id'] = identifier
                anchor_tag['fn-section-id'] = section_id
                first_element.insert(0, anchor_tag)

                sectioned_footnote_map[section_id][identifier] = {
                    'unique_fn_id': unique_fn_id,
                    'content': full_content,
                    'section_id': section_id,
                    'element': first_element
                }

                all_footnotes_data.append({"footnoteId": unique_fn_id, "content": full_content})
    
        # Create flattened map for backward compatibility
        footnote_map = {}
        for section_id, section_footnotes in sectioned_footnote_map.items():
            for identifier, footnote_data in section_footnotes.items():
                # Use section-prefixed key to avoid conflicts
                map_key = f"{section_id}_{identifier}" if section_id != 'traditional' else identifier
                footnote_map[map_key] = footnote_data
    
        footnotes_data = all_footnotes_data
        total_footnotes = sum(len(section_footnotes) for section_footnotes in sectioned_footnote_map.values())
        print(f"Found and extracted {total_footnotes} footnote definitions across {len(footnote_sections)} sections.")
        emit_progress(62, "doc_footnotes", f"Found {total_footnotes} footnotes across {len(footnote_sections)} sections")

        # ========================================================================
        # PASS 2: LINK ALL IN-TEXT MARKERS
        # ========================================================================
        emit_progress(68, "doc_linking", "Linking in-text citations")
        print("\n--- PASS 2: Linking All In-Text Markers ---")

        # --- 2A: Link References ---
        citations_found = 0
        citations_linked = 0
        citations_unlinked = []

        # --- 2A-pre: Convert existing <a href="#id"> links to in-text citations ---
        anchor_converted = 0
        anchor_unmatched = 0
        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            # Skip if already a citation, bib-entry, footnote, or external link
            if not href.startswith('#'):
                continue
            if 'in-text-citation' in a_tag.get('class', []):
                continue
            if 'bib-entry' in a_tag.get('class', []):
                continue
            if 'footnote-ref' in a_tag.get('class', []):
                continue
            # Skip anchors inside bibliography/reference section paragraphs
            parent_p = a_tag.find_parent('p')
            if parent_p and parent_p.find('a', class_='bib-entry'):
                continue

            anchor_id = href.lstrip('#')
            if anchor_id in bibliography_map:
                primary_id = bibliography_map[anchor_id]
                a_tag['href'] = f'#{primary_id}'
                a_tag['class'] = a_tag.get('class', []) + ['in-text-citation']
                anchor_converted += 1
            else:
                anchor_unmatched += 1

        print(f"  - Pre-linked anchors converted: {anchor_converted}")
        print(f"  - Pre-linked anchors unmatched: {anchor_unmatched}")

        # Guard: skip expensive per-node scan if there's nothing to link against
        _skip_citation_scan = False
        if not bibliography_map:
            print("  ⏭️ No bibliography entries — skipping in-text citation scan")
            _skip_citation_scan = True
        else:
            # Quick pre-check on full text before walking every DOM node
            _full_text = soup.get_text()
            _has_citation_patterns = bool(re.search(r"\([^)]*?\d{4}[^)]*?\)", _full_text))
            del _full_text  # free memory
            if not _has_citation_patterns:
                print("  ⏭️ No parenthesized citation patterns found — skipping text node scan")
                _skip_citation_scan = True
            else:
                print(f"  📝 Found citation patterns, scanning text nodes against {len(bibliography_map)} bibliography keys...")

        if not _skip_citation_scan:
          _all_text_nodes = soup.find_all(string=True)
          _total_text_nodes = len(_all_text_nodes)
          _last_progress_pct = 68
          for _tn_idx, text_node in enumerate(_all_text_nodes):
            # Emit progress every ~1% of text nodes scanned
            if _total_text_nodes > 100:
                _pct = 68 + int((_tn_idx / _total_text_nodes) * 7)  # 68% → 75%
                if _pct > _last_progress_pct:
                    _last_progress_pct = _pct
                    emit_progress(_pct, "doc_linking", f"Scanning text nodes ({_tn_idx}/{_total_text_nodes})")
            if not text_node.find_parent("p") or not text_node.find_parent("p").find("a", class_="bib-entry"):
                text = str(text_node)
                matches = list(re.finditer(r"\(([^)]*?\d{4}[^)]*?)\)", text))
                if matches:
                    new_content = []
                    last_index = 0
                    for match in matches:
                        preceding_text = text[last_index : match.start()]
                        new_content.append(NavigableString(preceding_text))
                        citation_block = match.group(1)
                        new_content.append(NavigableString("("))
                        sub_citations = re.split(r";\s*", citation_block)
                        # Further split comma-separated citations: "Author1, 2020, Author2, 2021"
                        refined = []
                        for _sub in sub_citations:
                            _years = list(re.finditer(r'\d{4}[a-z]?', _sub))
                            if len(_years) > 1:
                                parts = re.split(r',\s*(?=[A-Z])', _sub)
                                for part in parts:
                                    if re.search(r'\d{4}', part):
                                        refined.append(part.strip())
                                    elif refined:
                                        refined[-1] += ', ' + part.strip()
                            else:
                                refined.append(_sub.strip())
                        sub_citations = refined
                        for i, sub_cite_raw in enumerate(sub_citations):
                            sub_cite = sub_cite_raw.strip()
                            if not sub_cite: continue
                            citations_found += 1
                            context_for_keys = preceding_text
                            if not re.search(r'[A-Z]', preceding_text):
                                # Author name may be in a preceding sibling element (e.g. <em>Author</em> (Year))
                                sibling_texts = []
                                for sibling in text_node.previous_siblings:
                                    if hasattr(sibling, 'get_text'):
                                        sibling_texts.append(sibling.get_text())
                                    elif isinstance(sibling, str):
                                        sibling_texts.append(str(sibling))
                                if sibling_texts:
                                    context_for_keys = ''.join(reversed(sibling_texts)) + preceding_text
                            keys = generate_ref_keys(sub_cite, context_text=context_for_keys)
                            linked = False
                            for key in keys:
                                if key in bibliography_map:
                                    year_match = re.search(r'(\d{4}[a-z]?)', sub_cite)
                                    if year_match:
                                        author_part = sub_cite[:year_match.start(0)]
                                        year_part = year_match.group(0)
                                        trailing_part = sub_cite[year_match.end(0):]
                                        if author_part:
                                            new_content.append(NavigableString(author_part))
                                        a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                        a_tag['class'] = 'in-text-citation'
                                        a_tag.string = year_part
                                        new_content.append(a_tag)
                                        if trailing_part:
                                            # Check for comma-separated additional years e.g. "2010a, 2010b"
                                            remaining = trailing_part
                                            while remaining:
                                                extra_year = re.match(r'([\s,]+)(\d{4}[a-z]?)', remaining)
                                                if extra_year:
                                                    separator = extra_year.group(1)
                                                    extra_year_str = extra_year.group(2)
                                                    extra_keys = generate_ref_keys(author_part + extra_year_str, context_text=preceding_text)
                                                    extra_linked = False
                                                    for ek in extra_keys:
                                                        if ek in bibliography_map:
                                                            new_content.append(NavigableString(separator))
                                                            ea_tag = soup.new_tag("a", href=f"#{bibliography_map[ek]}")
                                                            ea_tag['class'] = 'in-text-citation'
                                                            ea_tag.string = extra_year_str
                                                            new_content.append(ea_tag)
                                                            extra_linked = True
                                                            citations_found += 1
                                                            citations_linked += 1
                                                            break
                                                    if not extra_linked:
                                                        new_content.append(NavigableString(separator + extra_year_str))
                                                    remaining = remaining[extra_year.end(0):]
                                                else:
                                                    new_content.append(NavigableString(remaining))
                                                    break
                                    else:
                                        a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                        a_tag['class'] = 'in-text-citation'
                                        a_tag.string = sub_cite
                                        new_content.append(a_tag)

                                    linked = True
                                    citations_linked += 1
                                    break
                            # Fuzzy year fallback: try ±1, ±2, ±3 year variants for OCR year errors
                            if not linked and keys:
                                year_in_cite = re.search(r'(\d{4})', sub_cite)
                                if year_in_cite:
                                    orig_year = year_in_cite.group(1)
                                    for offset in [1, -1, 2, -2, 3, -3]:
                                        if linked: break
                                        alt_year = str(int(orig_year) + offset)
                                        for key in keys:
                                            alt_key = key.replace(orig_year, alt_year)
                                            if alt_key in bibliography_map:
                                                author_part = sub_cite[:year_in_cite.start(0)]
                                                year_part = year_in_cite.group(0)
                                                trailing_part = sub_cite[year_in_cite.end(0):]
                                                if author_part:
                                                    new_content.append(NavigableString(author_part))
                                                a_tag = soup.new_tag("a", href=f"#{bibliography_map[alt_key]}")
                                                a_tag['class'] = 'in-text-citation'
                                                a_tag.string = year_part
                                                new_content.append(a_tag)
                                                if trailing_part:
                                                    new_content.append(NavigableString(trailing_part))
                                                linked = True
                                                citations_linked += 1
                                                break
                            if not linked:
                                new_content.append(NavigableString(sub_cite))
                                citations_unlinked.append({"citation": sub_cite, "generated_keys": keys})
                            if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                        new_content.append(NavigableString(")"))
                        last_index = match.end()
                    new_content.append(NavigableString(text[last_index:]))
                    text_node.replace_with(*new_content)

          # --- 2A-bracket: Link [Author Year] square-bracket citations ---
          for text_node in soup.find_all(string=True):
            if not text_node.find_parent("p") or not text_node.find_parent("p").find("a", class_="bib-entry"):
                text = str(text_node)
                matches = list(re.finditer(r"\[([^\]]*?\d{4}[^\]]*?)\]", text))
                if matches:
                    new_content = []
                    last_index = 0
                    for match in matches:
                        preceding_text = text[last_index : match.start()]
                        new_content.append(NavigableString(preceding_text))
                        citation_block = match.group(1)
                        new_content.append(NavigableString("["))
                        sub_citations = re.split(r";\s*", citation_block)
                        # Further split comma-separated citations: "Author1, 2020, Author2, 2021"
                        refined = []
                        for _sub in sub_citations:
                            _years = list(re.finditer(r'\d{4}[a-z]?', _sub))
                            if len(_years) > 1:
                                parts = re.split(r',\s*(?=[A-Z])', _sub)
                                for part in parts:
                                    if re.search(r'\d{4}', part):
                                        refined.append(part.strip())
                                    elif refined:
                                        refined[-1] += ', ' + part.strip()
                            else:
                                refined.append(_sub.strip())
                        sub_citations = refined
                        for i, sub_cite_raw in enumerate(sub_citations):
                            sub_cite = sub_cite_raw.strip()
                            if not sub_cite: continue
                            citations_found += 1
                            context_for_keys = preceding_text
                            if not re.search(r'[A-Z]', preceding_text):
                                sibling_texts = []
                                for sibling in text_node.previous_siblings:
                                    if hasattr(sibling, 'get_text'):
                                        sibling_texts.append(sibling.get_text())
                                    elif isinstance(sibling, str):
                                        sibling_texts.append(str(sibling))
                                if sibling_texts:
                                    context_for_keys = ''.join(reversed(sibling_texts)) + preceding_text
                            keys = generate_ref_keys(sub_cite, context_text=context_for_keys)
                            linked = False
                            for key in keys:
                                if key in bibliography_map:
                                    year_match = re.search(r'(\d{4}[a-z]?)', sub_cite)
                                    if year_match:
                                        author_part = sub_cite[:year_match.start(0)]
                                        year_part = year_match.group(0)
                                        trailing_part = sub_cite[year_match.end(0):]
                                        if author_part:
                                            new_content.append(NavigableString(author_part))
                                        a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                        a_tag['class'] = 'in-text-citation'
                                        a_tag.string = year_part
                                        new_content.append(a_tag)
                                        if trailing_part:
                                            remaining = trailing_part
                                            while remaining:
                                                extra_year = re.match(r'([\s,]+)(\d{4}[a-z]?)', remaining)
                                                if extra_year:
                                                    separator = extra_year.group(1)
                                                    extra_year_str = extra_year.group(2)
                                                    extra_keys = generate_ref_keys(author_part + extra_year_str, context_text=preceding_text)
                                                    extra_linked = False
                                                    for ek in extra_keys:
                                                        if ek in bibliography_map:
                                                            new_content.append(NavigableString(separator))
                                                            ea_tag = soup.new_tag("a", href=f"#{bibliography_map[ek]}")
                                                            ea_tag['class'] = 'in-text-citation'
                                                            ea_tag.string = extra_year_str
                                                            new_content.append(ea_tag)
                                                            extra_linked = True
                                                            citations_found += 1
                                                            citations_linked += 1
                                                            break
                                                    if not extra_linked:
                                                        new_content.append(NavigableString(separator + extra_year_str))
                                                    remaining = remaining[extra_year.end(0):]
                                                else:
                                                    new_content.append(NavigableString(remaining))
                                                    break
                                    else:
                                        a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                        a_tag['class'] = 'in-text-citation'
                                        a_tag.string = sub_cite
                                        new_content.append(a_tag)

                                    linked = True
                                    citations_linked += 1
                                    break
                            # Fuzzy year fallback: try ±1, ±2, ±3 year variants for OCR year errors
                            if not linked and keys:
                                year_in_cite = re.search(r'(\d{4})', sub_cite)
                                if year_in_cite:
                                    orig_year = year_in_cite.group(1)
                                    for offset in [1, -1, 2, -2, 3, -3]:
                                        if linked: break
                                        alt_year = str(int(orig_year) + offset)
                                        for key in keys:
                                            alt_key = key.replace(orig_year, alt_year)
                                            if alt_key in bibliography_map:
                                                author_part = sub_cite[:year_in_cite.start(0)]
                                                year_part = year_in_cite.group(0)
                                                trailing_part = sub_cite[year_in_cite.end(0):]
                                                if author_part:
                                                    new_content.append(NavigableString(author_part))
                                                a_tag = soup.new_tag("a", href=f"#{bibliography_map[alt_key]}")
                                                a_tag['class'] = 'in-text-citation'
                                                a_tag.string = year_part
                                                new_content.append(a_tag)
                                                if trailing_part:
                                                    new_content.append(NavigableString(trailing_part))
                                                linked = True
                                                citations_linked += 1
                                                break
                            if not linked:
                                new_content.append(NavigableString(sub_cite))
                                citations_unlinked.append({"citation": sub_cite, "generated_keys": keys})
                            if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                        new_content.append(NavigableString("]"))
                        last_index = match.end()
                    new_content.append(NavigableString(text[last_index:]))
                    text_node.replace_with(*new_content)

        # Citation linking summary
        emit_progress(75, "doc_linking", f"Linked {citations_linked} of {citations_found} citations")
        print(f"\n📖 Citation linking summary:")
        print(f"  - Total in-text citations found: {citations_found}")
        print(f"  - Successfully linked: {citations_linked}")
        print(f"  - Unlinked: {citations_found - citations_linked}")
        if citations_unlinked:
            print(f"  - All unlinked citations ({len(citations_unlinked)}):")
            for item in citations_unlinked:
                print(f"    • '{item['citation']}' → keys tried: {item['generated_keys']}")
        print(f"  - Bibliography map keys ({len(bibliography_map)}): {sorted(bibliography_map.keys())}")

        emit_progress(76, "doc_footnote_linking", "Linking footnote references")
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

        # ========================================================================
        # AUDIT PASS: Validate footnote linking
        # ========================================================================
        emit_progress(77, "doc_audit", "Validating footnote linking")
        print("\n--- AUDIT: Validating footnote linking ---")
        audit_data = {
            'total_refs': 0,
            'total_defs': len(footnotes_data) if 'footnotes_data' in dir() else len(all_footnotes_data),
            'gaps': [],
            'duplicates': [],
            'unmatched_refs': [],
            'unmatched_defs': []
        }

        # Walk all footnote-ref sup elements in document order
        all_ref_sups = soup.find_all('sup', class_='footnote-ref')
        audit_data['total_refs'] = len(all_ref_sups)
        emit_progress(77, "doc_audit", f"Validating {len(all_ref_sups)} footnote refs")

        # Group into sequences (restart when fn-count-id goes back to lower number)
        # Only store lightweight data per ref; gather expensive context on demand.
        sequences = []  # list of lists of (num, sup_element) tuples
        current_sequence = []
        last_num = 0

        for sup in all_ref_sups:
            fn_count = sup.get('fn-count-id', '0')
            try:
                num = int(fn_count)
            except ValueError:
                continue
            if num <= last_num and current_sequence:
                sequences.append(current_sequence)
                current_sequence = []
            current_sequence.append((num, sup))
            last_num = num

        if current_sequence:
            sequences.append(current_sequence)

        def _audit_context(sup_elem):
            """Extract heading/context for a ref — only called for gaps/duplicates."""
            section_id = sup_elem.get('fn-section-id', '')
            prev_heading = sup_elem.find_previous(['h1','h2','h3','h4','h5','h6'])
            heading_text = prev_heading.get_text()[:60].strip() if prev_heading else ''
            context_text = sup_elem.parent.get_text()[:120].strip() if sup_elem.parent else ''
            return section_id, heading_text, context_text

        # Check for gaps and duplicates within each sequence
        for seq_idx, sequence in enumerate(sequences):
            numbers_in_seq = [item[0] for item in sequence]

            # Check for gaps (cap per-gap expansion to avoid millions of entries
            # when lettered footnotes cause sparse numeric sequences)
            MAX_GAP_EXPANSION = 50
            if numbers_in_seq:
                for i in range(len(numbers_in_seq) - 1):
                    current = numbers_in_seq[i]
                    next_num = numbers_in_seq[i + 1]
                    gap_size = next_num - current - 1
                    if gap_size > 0:
                        after_sid, after_heading, after_ctx = _audit_context(sequence[i][1])
                        before_sid, before_heading, before_ctx = _audit_context(sequence[i + 1][1])
                        if gap_size > MAX_GAP_EXPANSION:
                            # Record as a single summary entry instead of expanding
                            audit_data['gaps'].append({
                                'missing': f"{current + 1}-{next_num - 1}",
                                'after_ref': current,
                                'before_ref': next_num,
                                'section': seq_idx + 1,
                                'gap_size': gap_size,
                                'after_ref_context': after_ctx,
                                'after_ref_section_id': after_sid,
                                'after_ref_heading': after_heading,
                                'before_ref_context': before_ctx,
                                'before_ref_section_id': before_sid,
                                'before_ref_heading': before_heading,
                            })
                        else:
                            for missing in range(current + 1, next_num):
                                audit_data['gaps'].append({
                                    'missing': missing,
                                    'after_ref': current,
                                    'before_ref': next_num,
                                    'section': seq_idx + 1,
                                    'after_ref_context': after_ctx,
                                    'after_ref_section_id': after_sid,
                                    'after_ref_heading': after_heading,
                                    'before_ref_context': before_ctx,
                                    'before_ref_section_id': before_sid,
                                    'before_ref_heading': before_heading,
                                })

            # Check for duplicates
            num_counts = Counter(numbers_in_seq)
            for num, count in num_counts.items():
                if count > 1:
                    dup_item = next((item for item in sequence if item[0] == num), None)
                    if dup_item:
                        dup_sid, dup_heading, dup_ctx = _audit_context(dup_item[1])
                    else:
                        dup_sid, dup_heading, dup_ctx = '', '', ''
                    audit_data['duplicates'].append({
                        'number': num,
                        'section': seq_idx + 1,
                        'count': count,
                        'context': dup_ctx,
                        'heading': dup_heading,
                    })

        # Check for unmatched refs (ref exists but no definition linked)
        linked_fn_ids = set()
        for sup in all_ref_sups:
            fn_id = sup.get('id', '')
            if fn_id:
                linked_fn_ids.add(fn_id)

        defined_fn_ids = set()
        for fn in (footnotes_data if 'footnotes_data' in dir() else all_footnotes_data):
            defined_fn_ids.add(fn.get('footnoteId', ''))

        # Refs whose IDs don't appear in definitions
        for sup in all_ref_sups:
            fn_id = sup.get('id', '')
            if fn_id and fn_id not in defined_fn_ids:
                audit_data['unmatched_refs'].append({
                    'number': sup.get('fn-count-id', ''),
                    'ref_id': fn_id,
                    'context': sup.parent.get_text()[:80] if sup.parent else ''
                })

        # Build lookup from definition anchors for number + section metadata
        fn_id_to_metadata = {}
        for a_tag in soup.find_all('a', attrs={'fn-count-id': True}):
            fid = a_tag.get('id', '')
            if fid:
                fn_id_to_metadata[fid] = {
                    'number': a_tag.get('fn-count-id', ''),
                    'section_id': a_tag.get('fn-section-id', ''),
                }

        # Defs whose IDs don't appear in any ref
        for fn in (footnotes_data if 'footnotes_data' in dir() else all_footnotes_data):
            fn_id = fn.get('footnoteId', '')
            if fn_id and fn_id not in linked_fn_ids:
                meta = fn_id_to_metadata.get(fn_id, {})
                audit_data['unmatched_defs'].append({
                    'footnote_id': fn_id,
                    'number': meta.get('number', ''),
                    'section': meta.get('section_id', ''),
                    'definition_preview': fn.get('content', '')[:200]
                })

        print(f"📊 Audit: {audit_data['total_refs']} refs, {audit_data['total_defs']} defs, "
              f"{len(audit_data['gaps'])} gaps, {len(audit_data['duplicates'])} duplicates, "
              f"{len(audit_data['unmatched_refs'])} unmatched refs, {len(audit_data['unmatched_defs'])} unmatched defs")

        # Write audit.json
        os.makedirs(output_dir, exist_ok=True)
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (standard path)
        # Determine citation style from what was detected
        if len(references_data) > 0 and citations_found > 0:
            citation_style = 'author-year-bracket'
        elif len(references_data) > 0:
            citation_style = 'bibliography-only'
        else:
            citation_style = 'none'

        conversion_stats = {
            'references_found': len(references_data),
            'citations_total': citations_found,
            'citations_linked': citations_linked,
            'footnotes_matched': len(all_footnotes_data),
            'footnote_strategy': strategy,
            'citation_style': citation_style,
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

    # ========================================================================
    # PASS 3: GENERATE FINAL JSON OUTPUT
    # ========================================================================
    emit_progress(78, "doc_json_gen", "Building node chunks")
    print("\n--- PASS 3: Generating Final JSON Output ---")
    # Use the passed book_id parameter instead of generating a new one
    node_chunks_data = []
    start_line_counter = 0
    CHUNK_SIZE = 50
    content_root = soup.body if soup.body else soup

    # Rewrite bare image src to servable route path: img-1.jpeg → /{book_id}/media/img-1.jpeg
    # Also inject width/height from file on disk to prevent layout shift
    for img_tag in content_root.find_all('img'):
        src = img_tag.get('src', '')
        if src and not src.startswith('/') and not src.startswith('http'):
            # Inject dimensions from file on disk before rewriting src
            img_path = os.path.join(output_dir, 'media', src)
            try:
                with PILImage.open(img_path) as pil_img:
                    w, h = pil_img.size
                    img_tag['width'] = str(w)
                    img_tag['height'] = str(h)
            except Exception:
                pass  # image missing or unreadable — skip silently
            img_tag['src'] = f'/{book_id}/media/{src}'

    for node in content_root.find_all(recursive=False):
        if isinstance(node, NavigableString) and not node.strip(): continue
        start_line_counter += 1
        chunk_id = (start_line_counter - 1) // CHUNK_SIZE
        node_key = f"{book_id}_{start_line_counter}"
        
        # Store original ID if it exists (for anchor preservation)
        original_id = node.get('id') if node.has_attr('id') else None
        
        # Remove ALL class attributes from the node and its children to clean up EPUB styling
        if node.has_attr('class'):
            del node['class']
        
        # Also remove class attributes from all nested elements EXCEPT functional classes
        preserved_classes = {'in-text-citation', 'footnote-ref', 'bib-entry', 'pageNumber'}
        for nested_element in node.find_all():
            if nested_element.has_attr('class'):
                # Keep only functional classes, remove styling classes
                element_classes = nested_element.get('class', [])
                if isinstance(element_classes, str):
                    element_classes = element_classes.split()
                functional_classes = [c for c in element_classes if c in preserved_classes]
                if functional_classes:
                    nested_element['class'] = functional_classes
                else:
                    del nested_element['class']
        
        # FORCE all elements to get numerical IDs (overwrite any existing non-numerical IDs)

        node['id'] = start_line_counter

        
        # For specific element types, preserve the original ID as an anchor for backwards compatibility
        if original_id and (
            (node.name == 'li' and node.find('a', attrs={'fn-count-id': True})) or
            (node.name == 'p' and node.find('a', class_='bib-entry')) or
            (node.name and node.name.startswith('h'))
        ):
            # Only add anchor if original_id was not already numerical
            if not original_id.isdigit():
                original_anchor = soup.new_tag('a', id=original_id)
                node.insert(0, original_anchor)
        
        references_in_node = []
        for a in node.find_all('a', class_='in-text-citation'):
            data_refs = a.get('data-refs')
            if data_refs:
                references_in_node.extend(data_refs.split(','))
            else:
                references_in_node.append(a['href'].lstrip('#'))
        # Extract footnote IDs and markers from sup elements
        # Store as objects {id, marker} to support non-numeric markers (*, 23a, etc.)
        # This enables dynamic renumbering for numeric footnotes while preserving symbolic markers
        footnotes_in_node = []
        for sup in node.find_all('sup'):
            # Get marker from fn-count-id attribute
            marker = sup.get('fn-count-id', '')
            # New format: sup has id directly and class="footnote-ref"
            if sup.get('class') and 'footnote-ref' in sup.get('class', []):
                footnote_id = sup.get('id', '')
                if footnote_id:
                    footnotes_in_node.append({'id': footnote_id, 'marker': marker})
            else:
                # Old format: anchor inside sup with class="footnote-ref"
                fn_link = sup.find('a', class_='footnote-ref')
                if fn_link and fn_link.get('href'):
                    footnote_id = fn_link['href'].lstrip('#')
                    if footnote_id:
                        footnotes_in_node.append({'id': footnote_id, 'marker': marker})
        node_object = {
            "id": node_key, "book": book_id, "chunk_id": chunk_id, 
            "startLine": start_line_counter, "content": str(node), 
            "references": references_in_node, "footnotes": footnotes_in_node, 
            "hypercites": [], "hyperlights": [],
            "plainText": node.get_text(strip=True),
            "type": node.name if hasattr(node, 'name') else 'p'
        }
        node_chunks_data.append(node_object)

    emit_progress(80, "doc_sanitize", "Sanitizing output")
    print("\n--- Sanitizing and writing JSON output files ---")
    os.makedirs(output_dir, exist_ok=True)

    # Security: Sanitize all HTML content before writing to JSON
    sanitized_references = [
        {"referenceId": r.get("referenceId", ""), "content": sanitize_html(r.get("content", ""))}
        for r in references_data
    ]
    sanitized_footnotes = [
        {"footnoteId": f.get("footnoteId", ""), "content": sanitize_html(f.get("content", ""))}
        for f in footnotes_data
    ]
    total_nodes = len(node_chunks_data)
    sanitized_nodes = []
    for i, node in enumerate(node_chunks_data):
        sanitized_node = node.copy()
        sanitized_node["content"] = sanitize_html(node.get("content", ""))
        sanitized_nodes.append(sanitized_node)
        if (i + 1) % 5000 == 0:
            emit_progress(80 + int((i / total_nodes) * 4), "doc_sanitize", f"Sanitized {i + 1} / {total_nodes} nodes")

    emit_progress(84, "doc_json_write", "Writing output files")

    with open(os.path.join(output_dir, 'references.json'), 'w', encoding='utf-8') as f:
        json.dump(sanitized_references, f, ensure_ascii=False)
    print(f"Successfully created {os.path.join(output_dir, 'references.json')}")

    # Write footnotes as JSONL for memory-efficient PHP streaming
    footnotes_path = os.path.join(output_dir, 'footnotes.jsonl')
    with open(footnotes_path, 'w', encoding='utf-8') as f:
        for fn in sanitized_footnotes:
            f.write(json.dumps(fn, ensure_ascii=False) + '\n')
    print(f"Successfully created {footnotes_path}")

    # Write nodes as JSONL (one JSON object per line) for memory-efficient PHP streaming
    nodes_path = os.path.join(output_dir, 'nodes.jsonl')
    with open(nodes_path, 'w', encoding='utf-8') as f:
        for node in sanitized_nodes:
            f.write(json.dumps(node, ensure_ascii=False) + '\n')
    print(f"Successfully created {nodes_path}")
    emit_progress(85, "doc_json_written", f"Written {len(sanitized_nodes)} nodes, {len(sanitized_footnotes)} footnotes, {len(sanitized_references)} references")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process a document to extract references, footnotes, and content chunks.")
    parser.add_argument("html_file", help="Path to the input HTML file.")
    parser.add_argument("output_dir", help="Directory to save the output JSON files.")
    parser.add_argument("book_id", help="Book ID to use for generating unique footnote IDs.")
    args = parser.parse_args()

    if not os.path.isfile(args.html_file):
        print(f"Error: Input file not found at {args.html_file}")
        sys.exit(1)

    main(args.html_file, args.output_dir, args.book_id)
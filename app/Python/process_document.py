import sys
import re
import json
import time
import os
import argparse
import random
import string
from bs4 import BeautifulSoup, NavigableString
import bleach

# --- SECURITY: HTML Sanitization ---

ALLOWED_TAGS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'a', 'em', 'strong', 'i', 'b', 'u', 'sub', 'sup', 'span', 'aside',
    'ul', 'ol', 'li', 'br', 'hr', 'img', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'figure', 'figcaption', 'cite', 'q', 'abbr', 'mark',
    'section', 'nav', 'article', 'header', 'footer', 'div'
]

ALLOWED_ATTRS = {
    'a': ['href', 'title', 'id', 'class', 'fn-count-id'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan'],
    'sup': ['id', 'class', 'fn-count-id'],
    '*': ['id', 'class', 'fn-count-id', 'data-node-id']
}

# Dangerous URL patterns
DANGEROUS_URL_PATTERN = re.compile(r'^(javascript|vbscript|data|file):', re.IGNORECASE)


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
    cleaned = bleach.clean(
        html_string,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        strip=True
    )
    # Sanitize URLs
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


# --- UTILITY FUNCTIONS ---

def analyze_document_structure(soup):
    """Analyze document to determine if footnotes are sectioned or all at end"""
    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr'])
    
    # Find all footnote definitions
    footnote_definitions = []
    footnote_references = []
    
    for i, element in enumerate(all_elements):
        text = element.get_text().strip()
        
        # Check for footnote definitions
        if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', text):
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
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', next_text):
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
    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr'])
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
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', text):
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
                
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', text):
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
                            if not re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', elem_text):
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
                
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', text):
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
                    
                    if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', text):
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
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S', text):
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
    ascii_name = ascii_name.replace('-', '')
    return ascii_name

def generate_ref_keys(text, context_text=""):
    processed_text = re.sub(r'\[\d{4}\]\s*', '', text)
    year_match = re.search(r'(\d{4}[a-z]?)', processed_text)
    if not year_match: return []
    year = year_match.group(1)
    authors_part = text.split(year)[0]
    keys = set()
    # Check for any letter (including Unicode) in authors_part
    has_author = re.search(r'[a-zA-ZÀ-ÿßẞ]', authors_part)
    author_source = authors_part if has_author else context_text

    if author_source:
        if not has_author:
            # Match capitalized words including Unicode letters and hyphens
            candidates = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
            if candidates: author_source = candidates[-1]

        # Match capitalized words including Unicode letters and hyphens
        # This pattern matches: Capital letter (including accented) followed by letters/hyphens/apostrophes
        surnames = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
        excluded = {'And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'}
        # Normalize Unicode and remove apostrophe-s for key generation
        surnames = [normalize_unicode_name(s).lower().replace("'s", "") for s in surnames if s not in excluded]
        if surnames:
            keys.add(surnames[0] + year)
            surnames.sort()
            keys.add("".join(surnames) + year)

    acronyms = re.findall(r'\b[A-Z]{2,}\b', author_source)
    for acronym in acronyms: keys.add(acronym.lower() + year)
    if "United Nations General Assembly" in text: keys.add("un" + year)
    return list(keys)

def process_whole_document_footnotes(soup, book_id):
    """Process footnotes when all definitions are at document end"""
    all_elements = soup.find_all(['p', 'div', 'li'])
    footnote_map = {}
    footnotes_data = []
    
    print("--- Processing whole-document footnotes ---")
    
    # Find all footnote definitions
    for element in all_elements:
        text = element.get_text().strip()
        # Extract footnote number from various patterns including [^1]:
        number_match = re.search(r'^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*)', text, re.DOTALL)
        if number_match:
            # Extract the digit from either group 2 or group 3
            identifier = number_match.group(2) or number_match.group(3)
            content = number_match.group(4).strip()
            
            print(f"Processing whole-doc footnote {identifier}: {content[:50]}...")
            
            # Generate unique footnote ID (same ID used for both sup and anchor)
            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
            unique_fn_id = f"{book_id}_Fn{int(time.time() * 1000)}_{random_suffix}"
            
            # Add anchor with unique ID
            anchor_tag = soup.new_tag('a', id=unique_fn_id)
            anchor_tag['fn-count-id'] = identifier
            element.insert(0, anchor_tag)
            
            footnote_map[identifier] = {
                'unique_fn_id': unique_fn_id,
                'content': content,
                'element': element
            }
            
            footnotes_data.append({"footnoteId": unique_fn_id, "content": content})
    
    print(f"Found {len(footnote_map)} footnote definitions in whole-document mode")
    return footnote_map, footnotes_data

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

    # 4. Standard author-first format: starts with capital letter (including Unicode like Ö, É, etc.)
    # Use Unicode property \p{Lu} for uppercase letters, or check first non-space char
    first_char = text.lstrip()[:1] if text.strip() else ''
    if first_char and first_char.isupper():
        return True

    return False

# --- MAIN PROCESSING LOGIC ---

def main(html_file_path, output_dir, book_id):
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

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
    # PASS 1: EXTRACT ALL DEFINITIONS
    # ========================================================================
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
            # Collect ALL paragraphs until the next heading
            next_sibling = heading.find_next_sibling()
            while next_sibling:
                if next_sibling.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                    # Stop at next major section
                    break
                if next_sibling.name == 'p' and is_likely_reference(next_sibling):
                    reference_p_tags.append(next_sibling)
                    text_preview = next_sibling.get_text(" ", strip=True)[:80]
                    print(f"  ✓ Detected reference: {text_preview}...")
                next_sibling = next_sibling.find_next_sibling()
            if reference_p_tags:
                break  # Found references, done

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

    for p in reference_p_tags:
        text = p.get_text(" ", strip=True)
        keys = generate_ref_keys(text)
        if keys:
            entry_id = keys[0]
            # Create an anchor tag with the bib-entry class and reference ID
            anchor_tag = soup.new_tag("a", attrs={"class": "bib-entry", "id": entry_id})
            # Insert the anchor at the beginning of the paragraph
            p.insert(0, anchor_tag)
            references_data.append({"referenceId": entry_id, "content": str(p)})
            for key in keys: bibliography_map[key] = entry_id
            print(f"  🔑 Generated keys for reference: {keys}")
        else:
            print(f"  ⚠️ No keys generated for: {text[:60]}...")

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
                all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr'])
                # Skip to node chunking
                strategy = 'pre_processed'
            else:
                strategy, strategy_info = analyze_document_structure(soup)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Could not read existing footnotes.json: {e}")
            strategy, strategy_info = analyze_document_structure(soup)
    else:
        strategy, strategy_info = analyze_document_structure(soup)

    if strategy == 'whole_document':
        # Use simple whole-document footnote processing
        global_footnote_map, footnotes_data = process_whole_document_footnotes(soup, book_id)
        sectioned_footnote_map = {'whole_document': global_footnote_map}
        all_footnotes_data = footnotes_data
        footnote_sections = []
        all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr'])
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

            # Generate unique footnote ID for traditional footnotes (same ID for sup and anchor)
            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
            unique_fn_id = f"{book_id}_Fn{int(time.time() * 1000)}_{random_suffix}"

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
    
    # Process sectioned footnotes
    for section in footnote_sections:
        section_id = section['id']
        sectioned_footnote_map[section_id] = {}
        
        for footnote_element in section['footnotes']:
            text = footnote_element.get_text()
            # Extract footnote number from various patterns including [^1]:
            # Must have brackets OR caret to avoid matching numbered lists
            number_match = re.search(r'^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*)', text, re.DOTALL)
            if not number_match:
                continue
                
            # Extract the digit from either group 2 or group 3
            identifier = number_match.group(2) or number_match.group(3)
            content = number_match.group(4).strip()
            print(f"Processing footnote {identifier} in section {section_id}: {content[:30]}...")
            
            # Generate unique footnote ID with section prefix (same ID for sup and anchor)
            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
            unique_fn_id = f"{book_id}_{section_id}_Fn{int(time.time() * 1000)}_{random_suffix}"
            
            # Add anchor with unique ID and section info
            anchor_tag = soup.new_tag('a', id=unique_fn_id)
            anchor_tag['fn-count-id'] = identifier
            anchor_tag['fn-section-id'] = section_id
            footnote_element.insert(0, anchor_tag)
            
            sectioned_footnote_map[section_id][identifier] = {
                'unique_fn_id': unique_fn_id,
                'content': content,
                'section_id': section_id,
                'element': footnote_element
            }
            
            all_footnotes_data.append({"footnoteId": unique_fn_id, "content": content})
    
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

    # ========================================================================
    # PASS 2: LINK ALL IN-TEXT MARKERS
    # ========================================================================
    print("\n--- PASS 2: Linking All In-Text Markers ---")

    # --- 2A: Link References ---
    citations_found = 0
    citations_linked = 0
    citations_unlinked = []

    for text_node in soup.find_all(string=True):
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
                    for i, sub_cite_raw in enumerate(sub_citations):
                        sub_cite = sub_cite_raw.strip()
                        if not sub_cite: continue
                        citations_found += 1
                        keys = generate_ref_keys(sub_cite, context_text=preceding_text)
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
                                        new_content.append(NavigableString(trailing_part))
                                else:
                                    a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                    a_tag['class'] = 'in-text-citation'
                                    a_tag.string = sub_cite
                                    new_content.append(a_tag)

                                linked = True
                                citations_linked += 1
                                break
                        if not linked:
                            new_content.append(NavigableString(sub_cite))
                            if len(citations_unlinked) < 10:  # Limit to first 10 for logging
                                citations_unlinked.append({"citation": sub_cite, "generated_keys": keys})
                        if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                    new_content.append(NavigableString(")"))
                    last_index = match.end()
                new_content.append(NavigableString(text[last_index:]))
                text_node.replace_with(*new_content)

    # Citation linking summary
    print(f"\n📖 Citation linking summary:")
    print(f"  - Total in-text citations found: {citations_found}")
    print(f"  - Successfully linked: {citations_linked}")
    print(f"  - Unlinked: {citations_found - citations_linked}")
    if citations_unlinked:
        print(f"  - First unlinked citations (up to 10):")
        for item in citations_unlinked:
            print(f"    • '{item['citation']}' → keys tried: {item['generated_keys']}")

    # --- 2B: Link Footnotes (STRATEGY-AWARE) ---
    def find_footnote_data(identifier, current_element=None):
        """Find footnote data using the appropriate strategy"""
        if strategy == 'whole_document':
            # Simple lookup in whole-document map
            if identifier in global_footnote_map:
                print(f"Found footnote {identifier} in whole-document mode")
                return global_footnote_map[identifier]
            print(f"Could not find footnote {identifier} in whole-document mode (available: {list(global_footnote_map.keys())[:10]}...)")
            return None
        else:
            # Section-aware lookup (original logic)
            return find_footnote_in_sections(identifier, current_element)
    
    def find_footnote_in_sections(identifier, current_element):
        """Find footnote data by determining which section's text area this element is in"""
        # Get position of current element in document
        try:
            current_pos = all_elements.index(current_element)
        except ValueError:
            # If element not found, find closest parent that is
            parent = current_element.parent
            while parent:
                try:
                    current_pos = all_elements.index(parent)
                    break
                except ValueError:
                    parent = parent.parent
            else:
                current_pos = 0
        
        # Find which section this element belongs to by checking explicit text ranges
        for section in footnote_sections:
            # Check if current element is in this section's text range
            if (current_pos >= section.get('text_start_idx', 0) and 
                current_pos < section.get('text_end_idx', len(all_elements))):
                
                if identifier in sectioned_footnote_map[section['id']]:
                    print(f"Found footnote {identifier} in section {section['id']} (element at pos {current_pos})")
                    return sectioned_footnote_map[section['id']][identifier]
        
        # Try traditional footnotes as final fallback
        if 'traditional' in sectioned_footnote_map and identifier in sectioned_footnote_map['traditional']:
            return sectioned_footnote_map['traditional'][identifier]
            
        print(f"Could not find footnote {identifier} in any section (element at pos {current_pos})")
        return None
    
    # Handle existing <a> tags with #fn pattern
    for a_tag in soup.find_all('a', href=re.compile(r'^#fn\d+')):
        identifier_match = re.search(r'(\d+)', a_tag.get('href', ''))
        if not identifier_match: continue
        identifier = identifier_match.group(1)
        text_content = a_tag.get_text(strip=True)

        footnote_data = find_footnote_data(identifier, a_tag)
        if footnote_data and text_content == identifier:
            new_sup = soup.new_tag('sup', id=footnote_data['unique_fn_id'])
            new_sup['fn-count-id'] = identifier
            if 'section_id' in footnote_data:
                new_sup['fn-section-id'] = footnote_data['section_id']
            new_a = soup.new_tag('a', href=f"#{footnote_data['unique_fn_id']}", attrs={'class': 'footnote-ref'})
            new_a.string = text_content
            new_sup.append(new_a)
            a_tag.replace_with(new_sup)

    # Handle existing <sup> tags
    for sup_tag in soup.find_all('sup'):
        if sup_tag.find('a', class_='footnote-ref'): continue
        identifier = sup_tag.get_text(strip=True)
        footnote_data = find_footnote_data(identifier, sup_tag)
        if footnote_data:
            sup_tag['id'] = footnote_data['unique_fn_id']
            sup_tag['fn-count-id'] = identifier
            if 'section_id' in footnote_data:
                sup_tag['fn-section-id'] = footnote_data['section_id']
            a_tag = soup.new_tag('a', href=f"#{footnote_data['unique_fn_id']}", attrs={'class': 'footnote-ref'})
            a_tag.string = identifier
            sup_tag.string = '' 
            sup_tag.append(a_tag)

    # Handle [^identifier] patterns in text (but NOT footnote definitions)
    for text_node in soup.find_all(string=True):
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
                        new_sup = soup.new_tag('sup', id=footnote_data['unique_fn_id'])
                        new_sup['fn-count-id'] = identifier
                        if 'section_id' in footnote_data:
                            new_sup['fn-section-id'] = footnote_data['section_id']
                        new_a = soup.new_tag('a', href=f"#{footnote_data['unique_fn_id']}", attrs={'class': 'footnote-ref'})
                        new_a.string = identifier
                        new_sup.append(new_a)
                        new_content.append(new_sup)
                        last_index = match.end()
                    else:
                        # If no footnote found, leave the text as-is
                        continue
                if new_content:  # Only replace if we found matches
                    new_content.append(NavigableString(text[last_index:]))
                    text_node.replace_with(*new_content)

    # ========================================================================
    # PASS 3: GENERATE FINAL JSON OUTPUT
    # ========================================================================
    print("\n--- PASS 3: Generating Final JSON Output ---")
    # Use the passed book_id parameter instead of generating a new one
    node_chunks_data = []
    start_line_counter = 0
    CHUNK_SIZE = 50
    content_root = soup.body if soup.body else soup

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
        preserved_classes = {'in-text-citation', 'footnote-ref', 'bib-entry'}
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
        
        references_in_node = [a['href'].lstrip('#') for a in node.find_all('a', class_='in-text-citation')]
        # Extract footnote IDs from href (new format) instead of display numbers (old format)
        # This enables dynamic renumbering when footnotes are added/deleted
        footnotes_in_node = []
        for sup in node.find_all('sup'):
            fn_link = sup.find('a', class_='footnote-ref')
            if fn_link and fn_link.get('href'):
                footnote_id = fn_link['href'].lstrip('#')
                if footnote_id:
                    footnotes_in_node.append(footnote_id)
        node_object = {
            "id": node_key, "book": book_id, "chunk_id": chunk_id, 
            "startLine": start_line_counter, "content": str(node), 
            "references": references_in_node, "footnotes": footnotes_in_node, 
            "hypercites": [], "hyperlights": [],
            "plainText": node.get_text(strip=True),
            "type": node.name if hasattr(node, 'name') else 'p'
        }
        node_chunks_data.append(node_object)

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
    sanitized_nodes = []
    for node in node_chunks_data:
        sanitized_node = node.copy()
        sanitized_node["content"] = sanitize_html(node.get("content", ""))
        # plainText doesn't need sanitization as it's text-only
        sanitized_nodes.append(sanitized_node)

    with open(os.path.join(output_dir, 'references.json'), 'w', encoding='utf-8') as f:
        json.dump(sanitized_references, f, ensure_ascii=False, indent=4)
    print(f"Successfully created {os.path.join(output_dir, 'references.json')}")

    with open(os.path.join(output_dir, 'footnotes.json'), 'w', encoding='utf-8') as f:
        json.dump(sanitized_footnotes, f, ensure_ascii=False, indent=4)
    print(f"Successfully created {os.path.join(output_dir, 'footnotes.json')}")

    with open(os.path.join(output_dir, 'nodes.json'), 'w', encoding='utf-8') as f:
        json.dump(sanitized_nodes, f, ensure_ascii=False, indent=4)
    print(f"Successfully created {os.path.join(output_dir, 'nodes.json')}")

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
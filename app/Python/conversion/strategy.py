"""Footnote-strategy selection + the numbering-linkability guard + bibliography-heading
detection. Pure decision logic (inspect-only on the soup) extracted from process_document.py
so it is independently unit-testable: given a soup, assert the chosen strategy + the assessment
record it emits; given a footnote map, assert linkability. Records its decisions to the shared
ASSESSMENT trace.
"""

import re

from conversion.assessment import ASSESSMENT

_BIBLIOGRAPHY_HEADING_RE = re.compile(
    r'\b(?:bibliograph(?:y|ies|ic)?|references?|works\s+cited|further\s+reading|reading\s+list)\b',
    re.IGNORECASE,
)


def _summarize_footnote_numbers(footnote_map):
    nums = sorted(int(k) for k in footnote_map if str(k).isdigit())
    if not nums:
        return "none"
    return f"{nums[0]}-{nums[-1]} ({len(nums)} defs)"


def _footnote_numbering_is_linkable(footnote_map, soup):
    """Trust check for whole-document NUMBER-based footnote linking.

    whole-document linking pairs an in-text marker with a definition purely by
    NUMBER, which is only safe when the two numbering schemes correspond. Return
    False when they don't — the signature of a source whose notes were renumbered
    independently of their references (per-essay endnotes flattened into one
    stream, interleaved bibliography entries we stripped, OCR/export drift). In
    that state matching by number silently drifts and mislinks (a body marker
    resolving to an unrelated note), so the caller extracts the note content but
    refuses to emit links. A missing link is honest; a confident wrong link is not.
    """
    def_nums = sorted(int(k) for k in footnote_map if str(k).isdigit())
    if len(def_nums) < 2:
        return True
    # (a) Internal gaps in the definition sequence — numbers were removed/renumbered.
    if def_nums[-1] - def_nums[0] + 1 != len(def_nums):
        return False
    # (b) In-text markers that have no same-numbered definition — the marker stream
    #     and the definition stream don't line up.
    def_set = set(def_nums)
    ref_nums = {
        int(s.get_text(strip=True))
        for s in soup.find_all('sup')
        if s.get_text(strip=True).isdigit()
    }
    if ref_nums and not ref_nums.issubset(def_set):
        return False
    return True


def analyze_document_structure(soup):
    """Analyze document to determine if footnotes are sectioned or all at end"""

    # Check for explicit section markers from simple_md_to_html (sequential strategy)
    ref_markers = soup.find_all('a', class_='footnoteSectionStart')
    def_markers = soup.find_all('a', class_='footnoteDefinitionsStart')

    if ref_markers and def_markers:
        print(f"🔍 STRATEGY: SEQUENTIAL - Found {len(ref_markers)} ref section markers and {len(def_markers)} def section markers")
        info = {'ref_section_count': len(ref_markers), 'def_section_count': len(def_markers)}
        ASSESSMENT.record(
            module='strategy_selection',
            code_ref='process_document.py:analyze_document_structure',
            decision='footnote_strategy=sequential',
            rationale='explicit footnoteSectionStart/footnoteDefinitionsStart markers from simple_md_to_html',
            evidence=info,
        )
        return 'sequential', info

    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr'])
    
    # Find all footnote definitions
    footnote_definitions = []
    footnote_references = []
    
    in_bibliography = False
    for i, element in enumerate(all_elements):
        # Track whether we're inside a Bibliography/References section so its
        # "[N]:" citation lines aren't miscounted as footnote definitions (which
        # would skew strategy selection and the def/ref balance).
        if element.name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            in_bibliography = bool(_BIBLIOGRAPHY_HEADING_RE.search(element.get_text()))
            continue

        text = element.get_text().strip()

        # Check for footnote definitions (skip citation lines in bibliography sections)
        if not in_bibliography and re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
            footnote_definitions.append({
                'element': element,
                'index': i,
                'text': text,
                'number': re.search(r'(\d+)', text).group(1) if re.search(r'(\d+)', text) else None
            })
        
        # Check for footnote references (not at start of paragraph). A reference
        # can be bracketed [N] text OR a bare <sup>N</sup> superscript. The latter
        # is invisible to the text regex because get_text() folds the digit into
        # the surrounding prose without brackets (e.g. "...reward.26 These..."), so
        # we must inspect <sup> children directly — otherwise end-notes books that
        # use superscript markers register zero references and get misclassified.
        elif (
            (re.search(r'\[\^?\d+\]', text) and not re.search(r'^\s*\[\^?\d+\]\s*[:.]\s*', text))
            or any(s.get_text(strip=True).isdigit() for s in element.find_all('sup'))
        ):
            footnote_references.append({
                'element': element,
                'index': i,
                'text': text
            })
    
    print(f"Found {len(footnote_definitions)} footnote definitions and {len(footnote_references)} potential references")
    
    if not footnote_definitions:
        ASSESSMENT.record(
            module='strategy_selection',
            code_ref='process_document.py:analyze_document_structure',
            decision='footnote_strategy=no_footnotes',
            rationale='no "[N]:" footnote definitions found (after bibliography exclusion)',
            evidence={'reference_count': len(footnote_references)},
        )
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
    
    # Check if this is a "references throughout + definitions at end" pattern.
    # This is the signature of an end-notes book: every footnote definition lives
    # in a trailing "Notes" section while the references are scattered through the
    # body. We deliberately do NOT gate this on the strict footnotes_at_end
    # (position_ratio > 0.8) cutoff — a book whose notes begin at, say, 76% of the
    # document still has all its definitions behind all its references, and the
    # mere presence of a "Notes" header would otherwise force it down the SECTIONED
    # path (whose positional section-ranges can't connect early body refs to
    # end-of-book notes). The robust discriminator is "definitions cluster in the
    # back portion AND references average clearly earlier", excluding books whose
    # numbering resets per chapter (those are genuinely sectioned, handled above).
    references_throughout_definitions_at_end = False
    if len(footnote_references) > 0 and len(footnote_definitions) > 10 and not has_footnote_resets:
        ref_positions = [fr['index'] for fr in footnote_references]
        avg_ref_position = sum(ref_positions) / len(ref_positions) if ref_positions else 0
        ref_position_ratio = avg_ref_position / total_elements if total_elements > 0 else 0

        # Definitions sit in the back third, references average clearly ahead of them.
        if position_ratio > 0.65 and ref_position_ratio < position_ratio - 0.15:
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
        strategy, reason = 'sectioned', 'footnote numbering resets detected with HR separators'
    elif has_footnote_resets and len(hr_elements) > 0:
        strategy, reason = 'sectioned', 'footnote numbering resets detected'
    elif references_throughout_definitions_at_end:
        strategy, reason = 'whole_document', 'references throughout text, definitions clustered at end'
    elif has_structured_sections:
        strategy, reason = 'sectioned', 'header + footnotes + hr patterns'
    elif footnotes_at_end and not has_section_pattern and not has_footnote_resets:
        strategy, reason = 'whole_document', 'footnotes clustered at end (no section pattern)'
    elif has_section_pattern and not references_throughout_definitions_at_end:
        strategy, reason = 'sectioned', "'Notes' headers present"
    else:
        strategy, reason = 'whole_document', 'default fallback'

    print(f"🔍 STRATEGY: {strategy.upper()} - {reason}")
    print(f"📊 Document analysis: {strategy_info}")
    ASSESSMENT.record(
        module='strategy_selection',
        code_ref='process_document.py:analyze_document_structure',
        decision=f'footnote_strategy={strategy}',
        rationale=reason,
        evidence=strategy_info,
    )
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

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


_ALL_STRATEGIES = ('sequential', 'no_footnotes', 'sectioned', 'whole_document')


def _strategy_considered(chosen, info):
    """The roads NOT taken at the footnote-strategy fork: for each strategy other than
    `chosen`, why it lost and what evidence WOULD have selected it. This is what lets the
    diagnostic LLM re-litigate the fork — e.g. check whether `would_need` is genuinely
    absent or was simply missed by the detector upstream."""
    resets = info.get('has_footnote_resets', False)
    structured = info.get('has_structured_sections', False)
    section_hdr = info.get('has_section_pattern', False)
    fn = info.get('footnote_count', 0)
    why = {
        'sequential': (
            'no explicit footnoteSectionStart/footnoteDefinitionsStart markers '
            '(emitted only by simple_md_to_html for per-section restart sources)',
            'restart anchors in the HTML (sequential md/Word export)'),
        'no_footnotes': (
            f'{fn} footnote definition(s) were found' if fn else 'no definitions found',
            'zero "[N]:" definitions after bibliography exclusion'),
        'sectioned': (
            'no per-chapter numbering resets and no "Notes"/HR section structure'
            if not (resets or structured or section_hdr)
            else 'section/reset signals present but a stronger whole-document signal won',
            'duplicate footnote numbers across sections (resets) + HR or "Notes" separators'),
        'whole_document': (
            'per-section numbering resets / "Notes" sections indicate the notes are '
            'partitioned rather than one continuous end-stream',
            'definitions clustered at the end under one continuous numbering, '
            'with references scattered earlier'),
    }
    return [
        {'option': s, 'rejected_because': why[s][0], 'would_need': why[s][1]}
        for s in _ALL_STRATEGIES if s != chosen
    ]


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
    def_set = set(def_nums)
    ref_nums = {
        int(s.get_text(strip=True))
        for s in soup.find_all('sup')
        if s.get_text(strip=True).isdigit()
    }

    # Decide WHY, with evidence, then record the link-vs-suppress fork once. The modus
    # operandi: when the numbering can't be trusted, suppress — a missing link is honest,
    # a confident wrong link is not.
    if len(def_nums) < 2:
        linkable, guard = True, 'too few definitions to misalign'
        reason = f'{len(def_nums)} definition number(s) (<2) — nothing to misalign, safe to link'
        evidence = {'definition_count': len(def_nums)}
        confidence, margin = 0.9, f'only {len(def_nums)} definition(s) — no drift possible'
    elif def_nums[-1] - def_nums[0] + 1 != len(def_nums):
        # (a) Internal gaps in the definition sequence — numbers were removed/renumbered.
        missing = (def_nums[-1] - def_nums[0] + 1) - len(def_nums)
        linkable, guard = False, 'definition-sequence gap'
        reason = (f'definition numbers span {def_nums[0]}-{def_nums[-1]} but only {len(def_nums)} '
                  f'defs exist ({missing} missing) — renumbered/stripped; matching by number would drift')
        evidence = {'definition_range': f'{def_nums[0]}-{def_nums[-1]}',
                    'definition_count': len(def_nums), 'missing_in_sequence': missing}
        confidence, margin = 0.85, f'{missing} number(s) missing from an otherwise contiguous sequence'
    elif ref_nums and not ref_nums.issubset(def_set):
        # (b) In-text markers with no same-numbered definition — the streams don't line up.
        orphans = sorted(ref_nums - def_set)
        linkable, guard = False, 'orphaned in-text markers'
        reason = (f'{len(orphans)} in-text marker number(s) {orphans[:8]} have no same-numbered '
                  f'definition — the marker and definition streams do not line up')
        evidence = {'orphan_markers': orphans[:20], 'definition_range': f'{def_nums[0]}-{def_nums[-1]}',
                    'marker_count': len(ref_nums)}
        confidence, margin = 0.8, f'{len(orphans)} in-text marker(s) with no matching definition'
    else:
        linkable, guard = True, 'contiguous + every marker matched'
        reason = (f'definitions contiguous {def_nums[0]}-{def_nums[-1]} and all {len(ref_nums)} '
                  f'in-text marker number(s) have a definition — safe to link by number')
        evidence = {'definition_range': f'{def_nums[0]}-{def_nums[-1]}', 'matched_markers': len(ref_nums)}
        confidence, margin = 0.85, f'contiguous {def_nums[0]}-{def_nums[-1]}, all markers matched'

    if linkable:
        decision = 'link whole-document footnotes by number'
        considered = [{'option': 'suppress whole-document footnote links',
                       'rejected_because': 'numbering is contiguous and every marker is matched — '
                                           'suppressing would needlessly drop valid links',
                       'would_need': 'a gap in the definition sequence OR a marker with no matching definition'}]
    else:
        decision = 'suppress whole-document footnote links (extract notes, emit NO links)'
        considered = [{'option': 'link whole-document footnotes by number',
                       'rejected_because': reason,
                       'would_need': 'a contiguous definition sequence AND every marker number having a definition'}]

    ASSESSMENT.record(
        module='footnote_linking_guard',
        code_ref='strategy.py:_footnote_numbering_is_linkable',
        decision=decision,
        rationale=reason,
        evidence=evidence,
        question='Is whole-document footnote numbering safe to link by number?',
        considered=considered,
        confidence=confidence,
        margin=margin,
    )
    return linkable


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
            code_ref='strategy.py:analyze_document_structure',
            decision='footnote_strategy=sequential',
            rationale='explicit footnoteSectionStart/footnoteDefinitionsStart markers from simple_md_to_html',
            evidence=info,
            question='Which footnote strategy for this document?',
            considered=_strategy_considered('sequential', info),
            confidence=0.95,
            margin=f"{len(ref_markers)} ref + {len(def_markers)} def restart markers present "
                   f"(explicit signal — unambiguous)",
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
        ref_n = len(footnote_references)
        info = {'reference_count': ref_n, 'definition_count': 0}
        # Near-miss flag: in-text markers WITHOUT any definitions is the signature of
        # definitions that were missed or wrongly excluded (e.g. swallowed under a
        # bibliography heading) — exactly where the LLM should look, not a clean "no notes".
        confidence = 0.9 if ref_n == 0 else 0.4
        margin = (None if ref_n == 0 else
                  f'{ref_n} in-text reference marker(s) found but 0 definitions — '
                  f'definitions may have been missed or excluded as bibliography')
        ASSESSMENT.record(
            module='strategy_selection',
            code_ref='strategy.py:analyze_document_structure',
            decision='footnote_strategy=no_footnotes',
            rationale='no "[N]:" footnote definitions found (after bibliography exclusion)',
            evidence=info,
            question='Which footnote strategy for this document?',
            considered=_strategy_considered('no_footnotes', info),
            confidence=confidence,
            margin=margin,
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
    ref_position_ratio = None
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
        'duplicate_numbers': list(duplicate_numbers),
        'ref_position_ratio': round(ref_position_ratio, 4) if ref_position_ratio is not None else None,
    }

    # Updated decision logic with footnote reset detection as primary indicator.
    # Each branch also records a CONFIDENCE and a near-miss MARGIN: how decisively the
    # winning condition was met, so the diagnostic LLM can spot a shaky fork at a glance.
    pr = position_ratio
    if has_footnote_resets and has_distributed_hrs:
        strategy, reason = 'sectioned', 'footnote numbering resets detected with HR separators'
        confidence = 0.85
        margin = (f"{len(duplicate_numbers)} duplicate fn-number(s) + distributed HRs — "
                  f"strong sectioned signal")
    elif has_footnote_resets and len(hr_elements) > 0:
        strategy, reason = 'sectioned', 'footnote numbering resets detected'
        confidence = 0.7
        margin = (f"{len(duplicate_numbers)} duplicate fn-number(s) + {len(hr_elements)} HR(s), "
                  f"but HRs not distributed throughout")
    elif references_throughout_definitions_at_end:
        strategy, reason = 'whole_document', 'references throughout text, definitions clustered at end'
        gap = (pr - ref_position_ratio) if ref_position_ratio is not None else 0.0
        confidence = round(min(0.9, 0.6 + gap), 2)
        margin = (f"def position_ratio {pr:.2f} vs 0.65 gate; refs avg "
                  f"{ref_position_ratio:.2f} (gap {gap:.2f} vs 0.15 min)")
    elif has_structured_sections:
        strategy, reason = 'sectioned', 'header + footnotes + hr patterns'
        confidence = 0.65
        margin = "header→footnotes→HR pattern found; no numbering resets to corroborate"
    elif footnotes_at_end and not has_section_pattern and not has_footnote_resets:
        strategy, reason = 'whole_document', 'footnotes clustered at end (no section pattern)'
        confidence = round(min(0.85, 0.5 + (pr - 0.8) * 2), 2) if pr > 0.8 else 0.6
        margin = f"def position_ratio {pr:.2f} vs 0.80 gate (footnotes_at_end)"
    elif has_section_pattern and not references_throughout_definitions_at_end:
        strategy, reason = 'sectioned', "'Notes' headers present"
        confidence = 0.6
        margin = "a 'Notes' header is present but no resets/HR structure to confirm sectioning"
    else:
        strategy, reason = 'whole_document', 'default fallback'
        confidence = 0.3
        margin = ("FALL-THROUGH: no positive signal matched — defaulted to whole_document. "
                  "LOW confidence; a prime candidate for review.")

    print(f"🔍 STRATEGY: {strategy.upper()} - {reason}")
    print(f"📊 Document analysis: {strategy_info}")
    ASSESSMENT.record(
        module='strategy_selection',
        code_ref='strategy.py:analyze_document_structure',
        decision=f'footnote_strategy={strategy}',
        rationale=reason,
        evidence=strategy_info,
        question='Which footnote strategy for this document?',
        considered=_strategy_considered(strategy, strategy_info),
        confidence=confidence,
        margin=margin,
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

import sys
import re
import json
import time
import os
import argparse
from bs4 import BeautifulSoup, NavigableString

# --- UTILITY FUNCTIONS ---

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
            print(f"Created default section with {len(footnotes)} footnotes")
    
    print(f"Total sections detected: {len(sections)}")
    # Also return the elements list for position-based matching
    return sections, all_elements

def generate_ref_keys(text, context_text=""):
    processed_text = re.sub(r'\[\d{4}\]\s*', '', text)
    year_match = re.search(r'(\d{4}[a-z]?)', processed_text)
    if not year_match: return []
    year = year_match.group(1)
    authors_part = text.split(year)[0]
    keys = set()
    has_author = re.search(r'[a-zA-Z]', authors_part)
    author_source = authors_part if has_author else context_text
    
    if author_source:
        if not has_author:
            candidates = re.findall(r"\b[A-Z][a-zA-Z']+\b", author_source)
            if candidates: author_source = candidates[-1]

        surnames = re.findall(r"\b[A-Z][a-zA-Z']+\b", author_source)
        excluded = {'And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'}
        surnames = [s.lower().replace("'s", "") for s in surnames if s not in excluded]
        if surnames:
            keys.add(surnames[0] + year)
            surnames.sort()
            keys.add("".join(surnames) + year)

    acronyms = re.findall(r'\b[A-Z]{2,}\b', author_source)
    for acronym in acronyms: keys.add(acronym.lower() + year)
    if "United Nations General Assembly" in text: keys.add("un" + year)
    return list(keys)

def is_likely_reference(p_tag):
    if not p_tag: return False
    text = p_tag.get_text(" ", strip=True)
    return re.match(r'^\s*[A-Z]', text) and re.search(r'\d{4}', text)

# --- MAIN PROCESSING LOGIC ---

def main(html_file_path, output_dir, book_id):
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    # ========================================================================
    # PASS 1: EXTRACT ALL DEFINITIONS
    # ========================================================================
    print("--- PASS 1: Extracting All Definitions ---")
    
    # --- 1A: Process Bibliography / References (No changes here) ---
    bibliography_map = {}
    references_data = []
    all_paragraphs = soup.find_all('p')
    reference_p_tags = []
    
    for p in reversed(all_paragraphs):
        if is_likely_reference(p):
            reference_p_tags.insert(0, p)
        elif reference_p_tags:
            if p.get_text(strip=True).lower() in ["references", "bibliography", "works cited"]:
                reference_p_tags.insert(0, p)
            break
    
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
    
    print(f"Found and processed {len(references_data)} reference entries (kept in DOM).")

    # --- 1B: Process Footnotes (SECTION-AWARE) ---
    footnote_sections, all_elements = detect_footnote_sections(soup)
    sectioned_footnote_map = {}
    all_footnotes_data = []
    
    # Process traditional footnotes container first
    fn_container = soup.find('section', class_='footnotes')
    if fn_container:
        list_items = fn_container.find_all('li')
        
        for li in list_items:
            back_link = li.find('a', class_='footnote-back')
            if not back_link: continue

            href = back_link.get('href', '')
            id_match = re.search(r'#fnref(\d+)', href)
            if not id_match: continue
            
            identifier = id_match.group(1)

            # Generate unique IDs for traditional footnotes
            unique_fn_id = f"{book_id}Fn{int(time.time() * 1000)}{identifier}"
            unique_fnref_id = f"{book_id}Fnref{int(time.time() * 1000)}{identifier}"

            # Add anchor with unique ID and count attribute
            anchor_tag = soup.new_tag('a', id=unique_fn_id)
            anchor_tag['fn-count-id'] = identifier
            li.insert(0, anchor_tag)

            # Update the back-link to point to the unique in-text reference
            back_link['href'] = f"#{unique_fnref_id}"

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
                'unique_fnref_id': unique_fnref_id,
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
            
            # Generate unique IDs with section prefix
            unique_fn_id = f"{book_id}_{section_id}_Fn{int(time.time() * 1000)}{identifier}"
            unique_fnref_id = f"{book_id}_{section_id}_Fnref{int(time.time() * 1000)}{identifier}"
            
            # Add anchor with unique ID and section info
            anchor_tag = soup.new_tag('a', id=unique_fn_id)
            anchor_tag['fn-count-id'] = identifier
            anchor_tag['fn-section-id'] = section_id
            footnote_element.insert(0, anchor_tag)
            
            sectioned_footnote_map[section_id][identifier] = {
                'unique_fn_id': unique_fn_id,
                'unique_fnref_id': unique_fnref_id,
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

    # --- 2A: Link References (No changes here) ---
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
                                    a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}", attrs={'class': 'in-text-citation'})
                                    a_tag.string = year_part
                                    new_content.append(a_tag)
                                    if trailing_part:
                                        new_content.append(NavigableString(trailing_part))
                                else:
                                    a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}", attrs={'class': 'in-text-citation'})
                                    a_tag.string = sub_cite
                                    new_content.append(a_tag)
                                
                                linked = True
                                break
                        if not linked: new_content.append(NavigableString(sub_cite))
                        if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                    new_content.append(NavigableString(")"))
                    last_index = match.end()
                new_content.append(NavigableString(text[last_index:]))
                text_node.replace_with(*new_content)

    # --- 2B: Link Footnotes (SECTION-AWARE) ---
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

        footnote_data = find_footnote_in_sections(identifier, a_tag)
        if footnote_data and text_content == identifier:
            new_sup = soup.new_tag('sup', id=footnote_data['unique_fnref_id'])
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
        footnote_data = find_footnote_in_sections(identifier, sup_tag)
        if footnote_data:
            sup_tag['id'] = footnote_data['unique_fnref_id']
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
                    
                    footnote_data = find_footnote_in_sections(identifier, text_node.parent)
                    if footnote_data:
                        new_content.append(NavigableString(text[last_index:match.start()]))
                        new_sup = soup.new_tag('sup', id=footnote_data['unique_fnref_id'])
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
        
        # Also remove class attributes from all nested elements
        for nested_element in node.find_all():
            if nested_element.has_attr('class'):
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
        footnotes_in_node = [a.get('fn-count-id', '') for a in node.find_all('sup') if a.get('fn-count-id')]
        node_object = {
            "id": node_key, "book": book_id, "chunk_id": chunk_id, 
            "startLine": start_line_counter, "content": str(node), 
            "references": references_in_node, "footnotes": footnotes_in_node, 
            "hypercites": [], "hyperlights": [],
            "plainText": node.get_text(strip=True),
            "type": node.name if hasattr(node, 'name') else 'p'
        }
        node_chunks_data.append(node_object)

    print("\n--- Writing JSON output files ---")
    os.makedirs(output_dir, exist_ok=True)
    
    with open(os.path.join(output_dir, 'references.json'), 'w', encoding='utf-8') as f: 
        json.dump(references_data, f, ensure_ascii=False, indent=4)
    print(f"Successfully created {os.path.join(output_dir, 'references.json')}")
    
    with open(os.path.join(output_dir, 'footnotes.json'), 'w', encoding='utf-8') as f: 
        json.dump(footnotes_data, f, ensure_ascii=False, indent=4)
    print(f"Successfully created {os.path.join(output_dir, 'footnotes.json')}")
    
    with open(os.path.join(output_dir, 'nodeChunks.json'), 'w', encoding='utf-8') as f: 
        json.dump(node_chunks_data, f, ensure_ascii=False, indent=4)
    print(f"Successfully created {os.path.join(output_dir, 'nodeChunks.json')}")

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
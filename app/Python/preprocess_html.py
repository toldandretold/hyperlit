#!/usr/bin/env python3

import sys
import os
import re
from bs4 import BeautifulSoup, NavigableString

def normalize_paragraph_ids(soup):
    """
    Give all paragraphs and content elements sequential numerical IDs
    """
    print("--- Normalizing paragraph IDs ---")
    
    # Find all elements that should get IDs (paragraphs, headers, lists, etc.)
    content_elements = soup.find_all(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'div'])
    
    # Filter to only elements that contain meaningful content
    meaningful_elements = []
    for element in content_elements:
        text = element.get_text().strip()
        if text and len(text) > 3:  # Skip elements with minimal content
            meaningful_elements.append(element)
    
    print(f"Found {len(meaningful_elements)} content elements to normalize")
    
    # Assign sequential IDs
    for i, element in enumerate(meaningful_elements, 1):
        old_id = element.get('id', 'none')
        element['id'] = str(i)
        print(f"Element {i}: {element.name} - '{element.get_text()[:50]}...' (was: {old_id})")
    
    return len(meaningful_elements)

def extract_and_process_footnotes(soup):
    """
    Find all <sup> elements, match them to footnotes using classes/data attributes,
    and convert them to the expected format
    """
    print("--- Processing footnotes (HTML-specific with class/data matching) ---")
    
    # Find all <sup> elements in the main content
    sup_elements = soup.find_all('sup')
    footnote_map = {}
    
    print(f"Found {len(sup_elements)} <sup> elements")
    
    # Extract footnote numbers/references from <sup> elements
    for sup in sup_elements:
        text = sup.get_text().strip()
        print(f"Processing <sup>: '{text}'")
        
        # Try to extract number or reference from the sup text
        if text.isdigit():
            footnote_num = int(text)
            footnote_map[footnote_num] = {
                'sup_element': sup,
                'original_text': text,
                'content': None,
                'group_class': None,
                'group_data': None
            }
        elif re.match(r'^\d+$', text):
            footnote_num = int(text)
            footnote_map[footnote_num] = {
                'sup_element': sup,
                'original_text': text,
                'content': None,
                'group_class': None,
                'group_data': None
            }
    
    print(f"Mapped {len(footnote_map)} footnote references")
    
    # Strategy 1: Look for matching classes or data attributes
    footnote_content_by_group = find_footnote_content_by_groups(soup, footnote_map)
    
    # Strategy 2: Fallback to original position-based matching
    if not footnote_content_by_group:
        print("No group-based footnotes found, falling back to position-based matching")
        footnote_content = find_footnote_content(soup, footnote_map.keys())
        # Update footnote_map with content
        for num, content in footnote_content.items():
            if num in footnote_map:
                footnote_map[num]['content'] = content
    else:
        print(f"Found {len(footnote_content_by_group)} group-based footnote matches")
        for num, content in footnote_content_by_group.items():
            if num in footnote_map:
                footnote_map[num]['content'] = content
    
    # Don't add fn-count-id here - let the main processor handle all footnote linking
    # We just ensure the <sup> tags are clean and the classes are set for matching
    print(f"Preprocessor completed: {len(footnote_map)} footnotes found and classes applied")
    
    return footnote_map

def find_footnote_content_by_groups(soup, footnote_map):
    """
    Find footnote content using matching classes or data attributes
    Supports patterns like:
    - class="fn-group-X" on both <sup> and footnote definition
    - data-fn-group="groupname" on both elements
    """
    print("--- Searching for group-based footnote content ---")
    
    footnote_content = {}
    
    # Check each <sup> element for grouping attributes
    for footnote_num, footnote_data in footnote_map.items():
        sup_element = footnote_data['sup_element']
        
        # Look for class patterns like "fn-group-X" or "footnote-group-X"
        sup_classes = sup_element.get('class', [])
        group_class = None
        for cls in sup_classes:
            if 'fn-group-' in cls or 'footnote-group-' in cls:
                group_class = cls
                break
        
        # Look for data attributes like data-fn-group="groupname"
        group_data = sup_element.get('data-fn-group') or sup_element.get('data-footnote-group')
        
        if group_class:
            print(f"  <sup>{footnote_num} has group class: {group_class}")
            # Find footnote definition with matching class
            matching_paragraphs = soup.find_all('p', class_=group_class)
            for p in matching_paragraphs:
                text = p.get_text().strip()
                # Look for [num]: pattern
                match = re.match(r'^(?:\[(\d+)\]:|(\d+)[\.\)\s]+)(.+)', text)
                if match:
                    found_num = int(match.group(1) or match.group(2))
                    if found_num == footnote_num:
                        content = match.group(3).strip()
                        footnote_content[footnote_num] = content
                        print(f"    Matched by class '{group_class}': footnote {footnote_num} -> {content[:50]}...")
                        break
        
        elif group_data:
            print(f"  <sup>{footnote_num} has group data: {group_data}")
            # Find footnote definition with matching data attribute
            matching_paragraphs = soup.find_all('p', attrs={'data-fn-group': group_data}) + \
                                  soup.find_all('p', attrs={'data-footnote-group': group_data})
            for p in matching_paragraphs:
                text = p.get_text().strip()
                # Look for [num]: pattern
                match = re.match(r'^(?:\[(\d+)\]:|(\d+)[\.\)\s]+)(.+)', text)
                if match:
                    found_num = int(match.group(1) or match.group(2))
                    if found_num == footnote_num:
                        content = match.group(3).strip()
                        footnote_content[footnote_num] = content
                        print(f"    Matched by data attribute '{group_data}': footnote {footnote_num} -> {content[:50]}...")
                        break
        else:
            print(f"  <sup>{footnote_num} has no group attributes")
    
    print(f"Found group-based content for {len(footnote_content)} footnotes")
    return footnote_content

def find_footnote_content(soup, footnote_numbers):
    """
    Find footnote content by looking for patterns like:
    - Numbered lists at the end
    - Paragraphs starting with numbers
    - Elements with footnote-like content
    """
    print("--- Searching for footnote content ---")
    
    footnote_content = {}
    
    # Strategy 1: Look for ordered lists (ol) that might contain footnotes
    ordered_lists = soup.find_all('ol')
    for ol in ordered_lists:
        list_items = ol.find_all('li')
        print(f"Found ordered list with {len(list_items)} items")
        
        for i, li in enumerate(list_items, 1):
            text = li.get_text().strip()
            if i in footnote_numbers:
                footnote_content[i] = text
                print(f"  Footnote {i}: {text[:100]}...")
    
    # Strategy 2: Look for paragraphs that start with numbers or [numbers]:
    all_paragraphs = soup.find_all('p')
    for p in all_paragraphs:
        text = p.get_text().strip()
        # Match patterns like "1. footnote text", "1 footnote text", or "[1]: footnote text"
        match = re.match(r'^(?:\[(\d+)\]:|(\d+)[\.\)\s]+)(.+)', text)
        if match:
            num = int(match.group(1) or match.group(2))
            content = match.group(3).strip()
            if num in footnote_numbers:
                footnote_content[num] = content
                print(f"  Found footnote {num} in paragraph: {content[:100]}...")
    
    # Strategy 3: Look for div or section elements that might contain footnotes
    footnote_sections = soup.find_all(['div', 'section'], class_=re.compile(r'footnote|note'))
    for section in footnote_sections:
        print(f"Found potential footnote section: {section.get('class')}")
        # Process elements within footnote sections
        elements = section.find_all(['p', 'div', 'li'])
        for elem in elements:
            text = elem.get_text().strip()
            match = re.match(r'^(?:\[(\d+)\]:|(\d+)[\.\)\s]+)(.+)', text)
            if match:
                num = int(match.group(1) or match.group(2))
                content = match.group(3).strip()
                if num in footnote_numbers:
                    footnote_content[num] = content
                    print(f"  Found footnote {num} in section: {content[:100]}...")
    
    print(f"Found content for {len(footnote_content)} footnotes")
    return footnote_content

def normalize_headings(soup):
    """
    Normalize heading hierarchy to eliminate gaps
    """
    print("--- Normalizing headings ---")
    
    headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    
    if not headings:
        print("No headings found")
        return
    
    print(f"Found {len(headings)} headings")
    
    current_level = 0
    changes_made = 0
    
    for heading in headings:
        original_level = int(heading.name[1])
        
        if original_level == 1:
            new_level = 1
            current_level = 1
        elif original_level <= current_level + 1:
            new_level = original_level
            current_level = max(current_level, original_level)
        else:
            # Gap detected! Normalize to current_level + 1
            new_level = current_level + 1
            current_level = new_level
            changes_made += 1
        
        if new_level != original_level:
            # Change the heading level
            new_tag = soup.new_tag(f'h{new_level}')
            new_tag.string = heading.get_text()
            
            # Copy attributes
            for attr, value in heading.attrs.items():
                new_tag[attr] = value
            
            heading.replace_with(new_tag)
            print(f"Changed h{original_level} -> h{new_level}: '{heading.get_text()[:50]}...'")
    
    print(f"Made {changes_made} heading level changes")

def clean_html_structure(soup):
    """
    Clean up HTML structure issues
    """
    print("--- Cleaning HTML structure ---")
    
    # Remove empty paragraphs
    empty_paragraphs = soup.find_all('p', string=re.compile(r'^\s*$'))
    print(f"Removing {len(empty_paragraphs)} empty paragraphs")
    for p in empty_paragraphs:
        p.decompose()
    
    # Remove paragraphs with only whitespace
    whitespace_paragraphs = []
    for p in soup.find_all('p'):
        if not p.get_text().strip():
            whitespace_paragraphs.append(p)
    
    print(f"Removing {len(whitespace_paragraphs)} whitespace-only paragraphs")
    for p in whitespace_paragraphs:
        p.decompose()

def preprocess_html_file(input_file, output_file):
    """
    Main preprocessing function
    """
    print(f"Preprocessing HTML file: {input_file}")
    print(f"Output will be saved to: {output_file}")
    
    # Read the HTML file
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    soup = BeautifulSoup(content, 'html.parser')
    
    print(f"Original HTML length: {len(content)} characters")
    
    # Step 1: Clean HTML structure
    clean_html_structure(soup)
    
    # Step 2: Normalize headings
    normalize_headings(soup)
    
    # Step 3: Extract and process footnotes
    footnote_map = extract_and_process_footnotes(soup)
    
    # Step 4: Normalize paragraph IDs
    num_elements = normalize_paragraph_ids(soup)
    
    # Save the processed HTML
    processed_html = str(soup)
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(processed_html)
    
    print(f"Processed HTML length: {len(processed_html)} characters")
    print(f"Processing complete:")
    print(f"  - {num_elements} elements got IDs")
    print(f"  - {len(footnote_map)} footnotes processed")
    
    return {
        'elements_processed': num_elements,
        'footnotes_found': len(footnote_map),
        'footnote_details': footnote_map
    }

def main():
    if len(sys.argv) != 3:
        print("Usage: python3 preprocess_html.py <input_file> <output_file>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' does not exist")
        sys.exit(1)
    
    try:
        result = preprocess_html_file(input_file, output_file)
        print(f"\nSUCCESS: HTML preprocessing completed")
        print(f"Results: {result}")
    except Exception as e:
        print(f"ERROR: HTML preprocessing failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
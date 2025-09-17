#!/usr/bin/env python3

import sys
import re
import json
import time
import os
from bs4 import BeautifulSoup, NavigableString

def process_html_footnotes(html_file, output_dir, book_id):
    """
    Simple HTML footnote processor that matches <sup> tags to footnotes by class and number
    """
    print(f"Processing HTML footnotes for book: {book_id}")
    
    with open(html_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f.read(), 'html.parser')
    
    # Find all <sup> tags with classes
    sup_tags = soup.find_all('sup', class_=True)
    print(f"Found {len(sup_tags)} <sup> tags with classes")
    
    # Find all potential footnote definition elements with classes
    footnote_elements = []
    for element in soup.find_all(['p', 'div', 'li'], class_=True):
        text = element.get_text().strip()
        # Match patterns: [1]:, [^1]:, 1., etc.
        if re.match(r'^(?:\[\^?(\d+)\][:.]|(\d+)[\.\):])', text):
            footnote_elements.append(element)
    
    print(f"Found {len(footnote_elements)} potential footnote definitions")
    
    # Process each <sup> tag
    processed_footnotes = []
    footnote_counter = 1
    
    for sup in sup_tags:
        sup_text = sup.get_text().strip()
        sup_classes = sup.get('class', [])
        
        print(f"Processing <sup>{sup_text}</sup> with classes: {sup_classes}")
        
        if not sup_text.isdigit():
            print(f"  Skipping non-numeric <sup>: {sup_text}")
            continue
            
        sup_number = int(sup_text)
        
        # Find matching footnote definition
        matching_footnote = None
        for footnote_elem in footnote_elements:
            footnote_classes = footnote_elem.get('class', [])
            footnote_text = footnote_elem.get_text().strip()
            
            # Check if classes overlap
            if not set(sup_classes) & set(footnote_classes):
                continue
                
            # Extract footnote number from text
            match = re.match(r'^(?:\[\^?(\d+)\][:.]|(\d+)[\.\):])(.+)', footnote_text)
            if match:
                footnote_number = int(match.group(1) or match.group(2))
                footnote_content = match.group(3).strip()
                
                if footnote_number == sup_number:
                    matching_footnote = {
                        'element': footnote_elem,
                        'content': footnote_content,
                        'number': footnote_number
                    }
                    print(f"  ✅ Matched to footnote: {footnote_content[:50]}...")
                    break
        
        if matching_footnote:
            # Generate unique IDs
            unique_fn_id = f"{book_id}_Fn{int(time.time() * 1000)}{footnote_counter}"
            unique_fnref_id = f"{book_id}_Fnref{int(time.time() * 1000)}{footnote_counter}"
            
            # Transform <sup> tag into clickable footnote reference
            sup['id'] = unique_fnref_id
            sup['fn-count-id'] = str(footnote_counter)
            
            # Clear existing content and add clickable link
            sup.clear()
            a_tag = soup.new_tag('a', href=f"#{unique_fn_id}")
            a_tag['class'] = 'footnote-ref'
            a_tag.string = str(sup_number)
            sup.append(a_tag)
            
            # Transform footnote definition
            footnote_elem = matching_footnote['element']
            
            # Add anchor at the beginning of footnote
            anchor_tag = soup.new_tag('a', id=unique_fn_id)
            anchor_tag['fn-count-id'] = str(footnote_counter)
            footnote_elem.insert(0, anchor_tag)
            
            # Store footnote data for JSON output
            processed_footnotes.append({
                "footnoteId": unique_fn_id,
                "content": matching_footnote['content']
            })
            
            print(f"  ✅ Created footnote link: {unique_fnref_id} -> {unique_fn_id}")
            footnote_counter += 1
            
        else:
            print(f"  ❌ No matching footnote found for <sup>{sup_text}</sup>")
    
    # Create node chunks from content
    print(f"Creating node chunks...")
    chunks = create_node_chunks(soup, book_id)
    
    # Save outputs
    save_outputs(output_dir, chunks, processed_footnotes, book_id)
    
    print(f"✅ HTML footnote processing complete:")
    print(f"  - {len(processed_footnotes)} footnotes linked")
    print(f"  - {len(chunks)} content chunks created")

def create_node_chunks(soup, book_id):
    """Create node chunks from the processed HTML"""
    chunks = []
    chunk_size = 25  # Paragraphs per chunk
    
    # Find all content elements
    content_elements = soup.find_all(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'])
    
    print(f"Found {len(content_elements)} content elements")
    
    for i, element in enumerate(content_elements, 1):
        chunk_id = (i - 1) // chunk_size
        node_key = f"{book_id}_{i}"
        
        # ✅ FIX: Force DOM ID to match startLine
        # Debug logging to file
        debug_msg = f"Processing element: {element.name}, startLine: {i}, content: {str(element)[:50]}\n"
        with open('/tmp/hyperlit_debug.log', 'a') as f:
            f.write(debug_msg)
        
        # Set the ID to match startLine
        if hasattr(element, 'name') and element.name:
            # Initialize attrs dict if it doesn't exist
            if not hasattr(element, 'attrs') or element.attrs is None:
                element.attrs = {}
            # Set the ID using direct attribute assignment
            element.attrs['id'] = str(i)
            # Also try the dictionary-style assignment as backup
            try:
                element['id'] = str(i)
            except:
                pass
            
            # Verify the ID was actually set
            final_id = element.get('id') if hasattr(element, 'get') else None
            if final_id != str(i):
                error_msg = f"WARNING: ID assignment failed for {element.name} tag. Expected: {i}, Got: {final_id}\n"
                error_msg += f"Element content: {str(element)[:100]}\n\n"
                with open('/tmp/hyperlit_debug.log', 'a') as f:
                    f.write(error_msg)
                # Force it one more time
                element.attrs['id'] = str(i)
        
        # Extract footnotes and references from this element
        footnotes_in_node = []
        for sup in element.find_all('sup'):
            fn_count_id = sup.get('fn-count-id')
            if fn_count_id:
                footnotes_in_node.append(fn_count_id)
        
        # Basic node structure
        node_object = {
            "id": node_key,
            "book": book_id,
            "chunk_id": chunk_id,
            "startLine": i,
            "content": str(element),
            "footnotes": footnotes_in_node,
            "references": [],  # Could be enhanced later
            "hypercites": [],
            "hyperlights": [],
            "plainText": element.get_text().strip(),
            "type": element.name
        }
        
        chunks.append(node_object)
    
    return chunks

def save_outputs(output_dir, chunks, footnotes, book_id):
    """Save all output files"""
    
    # Save nodeChunks.json
    chunks_file = os.path.join(output_dir, 'nodeChunks.json')
    with open(chunks_file, 'w', encoding='utf-8') as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)
    print(f"Saved {len(chunks)} chunks to: {chunks_file}")
    
    # Save footnotes.json
    footnotes_file = os.path.join(output_dir, 'footnotes.json')
    with open(footnotes_file, 'w', encoding='utf-8') as f:
        json.dump(footnotes, f, ensure_ascii=False, indent=2)
    print(f"Saved {len(footnotes)} footnotes to: {footnotes_file}")
    
    # Save empty references.json for compatibility
    references_file = os.path.join(output_dir, 'references.json')
    with open(references_file, 'w', encoding='utf-8') as f:
        json.dump([], f)
    print(f"Saved empty references to: {references_file}")

def main():
    if len(sys.argv) != 4:
        print("Usage: python3 html_footnote_processor.py <html_file> <output_dir> <book_id>")
        sys.exit(1)
    
    html_file = sys.argv[1]
    output_dir = sys.argv[2]
    book_id = sys.argv[3]
    
    if not os.path.exists(html_file):
        print(f"Error: HTML file '{html_file}' does not exist")
        sys.exit(1)
    
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    
    try:
        process_html_footnotes(html_file, output_dir, book_id)
        print("SUCCESS: HTML footnote processing completed")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
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
            # Generate unique footnote ID (shorter format without book prefix)
            unique_fn_id = f"Fn{int(time.time() * 1000)}{footnote_counter:03d}"

            # Transform <sup> tag into clickable footnote reference
            # New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
            sup['fn-count-id'] = str(footnote_counter)
            sup['id'] = unique_fn_id
            sup['class'] = sup.get('class', []) + ['footnote-ref']

            # Set text content directly (no anchor)
            sup.string = str(sup_number)
            
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
            
            print(f"  ✅ Created footnote link: {unique_fn_id}ref -> {unique_fn_id}")
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
    
    # Find all content elements. <table> is included so each top-level table
    # (e.g. ar5iv's lifted ltx_table figures) becomes its own node, and
    # <ul>/<ol> so each list becomes a single chunk with its <li>s intact —
    # otherwise the downstream DOM holds orphan <li>s whose marker falls into
    # the left margin (the ul/ol CSS rules that normally fix the marker
    # position never match).
    #
    # Anything NESTED inside <table>, <ul>, <ol>, or <li> is dropped — the
    # outer container already captures it as one node, so re-emitting an inner
    # <p>/<li>/sub-<table> would duplicate content. This is important for
    # ar5iv list items which look like <li><p class="ltx_p">text</p></li>
    # after the preprocessor strips the <div class="ltx_para"> wrapper;
    # without this filter both the list wrapper and the inner <p> would
    # become nodes and the reader would see each bullet twice.
    raw_elements = soup.find_all(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table'])

    def _is_nested(el):
        for ancestor in el.parents:
            if ancestor.name in ('ul', 'ol', 'li', 'table'):
                return True
        return False

    content_elements = [el for el in raw_elements if not _is_nested(el)]

    # Hyperlit's editor (resources/js/editToolbar/listConverter.js) walks UP
    # from a <li> to find the parent <ul>/<ol> with an id, and saves the
    # whole list as one IndexedDB record. So the list wrapper owns identity;
    # <li>s carry no id of their own.
    #
    # preprocess_html.py:normalize_paragraph_ids runs earlier and assigns
    # sequential numeric IDs to every <p>/<li>/<blockquote>/<div>/<h*> it
    # finds — including descendants of <ul>/<ol>/<table> wrappers that the
    # chunker now treats as single nodes. Those descendant IDs both violate
    # the editor contract and collide with real chunk IDs assigned below.
    # Strip only the numeric ones — footnote anchors (FnXXX) and any other
    # meaningful IDs survive.
    for el in content_elements:
        if el.name in ('ul', 'ol', 'table'):
            for descendant in el.find_all(True):
                desc_id = descendant.attrs.get('id')
                if desc_id and desc_id.isdigit():
                    del descendant.attrs['id']

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
        
        # Extract footnote IDs and markers from sup elements
        # Store as objects {id, marker} to support non-numeric markers (*, 23a, etc.)
        footnotes_in_node = []
        seen_ids = set()
        # New format: sup with class="footnote-ref" and id
        for sup_tag in element.find_all('sup', class_='footnote-ref'):
            sup_id = sup_tag.get('id', '')
            marker = sup_tag.get('fn-count-id', '')
            if sup_id and 'Fn' in sup_id:
                if sup_id not in seen_ids:
                    footnotes_in_node.append({'id': sup_id, 'marker': marker})
                    seen_ids.add(sup_id)
        # Old format fallback: anchor with href inside sup
        for sup_tag in element.find_all('sup'):
            a_tag = sup_tag.find('a', class_='footnote-ref')
            if a_tag:
                href = a_tag.get('href', '')
                if href.startswith('#') and 'Fn' in href:
                    footnote_id = href[1:]  # Remove leading #
                    marker = sup_tag.get('fn-count-id', '')
                    if footnote_id not in seen_ids:
                        footnotes_in_node.append({'id': footnote_id, 'marker': marker})
                        seen_ids.add(footnote_id)
        
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
    
    # Save nodes.json
    chunks_file = os.path.join(output_dir, 'nodes.json')
    with open(chunks_file, 'w', encoding='utf-8') as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)
    print(f"Saved {len(chunks)} chunks to: {chunks_file}")
    
    # Save footnotes.json — but ONLY if no upstream step (e.g. ar5iv_preprocessor.py)
    # already wrote a populated one. Same rationale as references.json below.
    footnotes_file = os.path.join(output_dir, 'footnotes.json')
    write_footnotes = True
    if os.path.exists(footnotes_file):
        try:
            with open(footnotes_file, 'r', encoding='utf-8') as f:
                existing = json.load(f)
            if isinstance(existing, list) and existing:
                print(f"Keeping existing footnotes.json with {len(existing)} entries")
                write_footnotes = False
        except Exception:
            pass
    if write_footnotes:
        with open(footnotes_file, 'w', encoding='utf-8') as f:
            json.dump(footnotes, f, ensure_ascii=False, indent=2)
        print(f"Saved {len(footnotes)} footnotes to: {footnotes_file}")
    
    # Save empty references.json for compatibility — but ONLY if no upstream step
    # (e.g. ar5iv_preprocessor.py) already wrote a populated one.
    references_file = os.path.join(output_dir, 'references.json')
    if not os.path.exists(references_file):
        with open(references_file, 'w', encoding='utf-8') as f:
            json.dump([], f)
        print(f"Saved empty references to: {references_file}")
    else:
        try:
            with open(references_file, 'r', encoding='utf-8') as f:
                existing = json.load(f)
            if isinstance(existing, list) and existing:
                print(f"Keeping existing references.json with {len(existing)} entries")
            else:
                # Existing file is empty or malformed — fine to rewrite as empty.
                with open(references_file, 'w', encoding='utf-8') as f:
                    json.dump([], f)
        except Exception:
            with open(references_file, 'w', encoding='utf-8') as f:
                json.dump([], f)

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
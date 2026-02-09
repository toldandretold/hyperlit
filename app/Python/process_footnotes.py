# app/python/process_footnotes.py (STANDALONE, ROBUST VERSION)

import sys
import re
import json
import time
from bs4 import BeautifulSoup, NavigableString

def main(html_file_path):
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    # --- PASS 1A: Find all unique footnote markers used in the text ---
    print("--- PASS 1A: Finding all in-text markers ---")
    # THE CRITICAL FIX: Search the raw HTML string, not the plain text.
    html_content = str(soup)
    markers_found = set(re.findall(r'\[\^(\w+)\]|<sup>(\d+)</sup>', html_content))
    markers_found = {m[0] or m[1] for m in markers_found if m[0] or m[1]}
    print(f"Found markers for IDs: {markers_found}")

    # --- PASS 1B: Find definitions that match the markers, then remove them ---
    print("\n--- PASS 1B: Finding and extracting footnote definitions ---")
    footnote_map = {}
    nodes_to_remove = []

    for p in reversed(soup.find_all('p')):
        text = p.get_text(strip=True)
        
        md_match = re.match(r'\[\^(\w+)\]:\s*(.*)', text, re.DOTALL)
        if md_match:
            identifier, content = md_match.groups()
            if identifier in markers_found:
                footnote_map[identifier] = content.strip()
                nodes_to_remove.append(p)
                print(f"Found and stored definition for '{identifier}'")
            continue

        num_match = re.match(r'^(\d+)\.\s*(.*)', text, re.DOTALL)
        if num_match:
            identifier, content = num_match.groups()
            if identifier in markers_found:
                footnote_map[identifier] = content.strip()
                nodes_to_remove.append(p)
                print(f"Found and stored definition for '{identifier}'")
            continue

    for node in nodes_to_remove:
        node.decompose()

    # --- PASS 2: Find in-text markers and replace them with proper links ---
    print("\n--- PASS 2: Linking In-Text Footnote Markers ---")

    # Track footnote ID mappings: display number -> unique ID
    footnote_id_map = {}
    fn_counter = [0]  # Use list to allow modification in nested function

    def generate_footnote_id():
        """Generate unique footnote ID in canonical format: Fn{timestamp}_{counter}"""
        fn_counter[0] += 1
        return f"Fn{int(time.time() * 1000)}{fn_counter[0]:03d}"

    def get_or_create_footnote_id(identifier):
        """Get existing or create new unique ID for a display number"""
        if identifier not in footnote_id_map:
            footnote_id_map[identifier] = generate_footnote_id()
        return footnote_id_map[identifier]

    # Part A: Handle Markdown-style [^...] markers in text nodes
    for text_node in soup.find_all(string=True):
        text = str(text_node)
        if '[^' not in text: continue

        def replace_md_marker(match):
            identifier = match.group(1)
            if identifier in footnote_map:
                unique_id = get_or_create_footnote_id(identifier)
                # Canonical format: <sup fn-count-id="N" id="footnoteId" class="footnote-ref">N</sup>
                return f'<sup fn-count-id="{identifier}" id="{unique_id}" class="footnote-ref">{identifier}</sup>'
            return match.group(0)

        new_html = re.sub(r'\[\^(\w+)\]', replace_md_marker, text)
        if new_html != text:
            text_node.replace_with(BeautifulSoup(new_html, 'html.parser'))

    # Part B: Handle <sup>...</sup> markers by converting to canonical format
    for sup_tag in soup.find_all('sup'):
        # Skip if already in canonical format
        if sup_tag.get('class') and 'footnote-ref' in sup_tag.get('class', []):
            continue
        identifier = sup_tag.get_text(strip=True)
        if identifier in footnote_map:
            unique_id = get_or_create_footnote_id(identifier)
            # Convert to canonical format
            sup_tag['fn-count-id'] = identifier
            sup_tag['id'] = unique_id
            sup_tag['class'] = 'footnote-ref'
            sup_tag.string = identifier
            print(f"Converted <sup>{identifier}</sup> to canonical format with id={unique_id}")

    # --- PASS 3: Generate JSON output ---
    print("\n--- PASS 3: Generating JSON Output ---")
    # Use unique footnote IDs (Fn...) instead of display numbers
    footnotes_data = [
        {"footnoteId": footnote_id_map.get(key, key), "content": value}
        for key, value in footnote_map.items()
        if key in footnote_id_map  # Only include footnotes that were actually referenced
    ]
    book_id = f"book_{int(time.time() * 1000)}"
    node_chunks_data = {}
    start_line_counter = 0
    CHUNK_SIZE = 50
    content_root = soup.body if soup.body else soup

    for node in content_root.find_all(recursive=False):
        if isinstance(node, NavigableString) and not node.strip():
            continue

        start_line_counter += 1
        chunk_id = (start_line_counter - 1) // CHUNK_SIZE
        node_key = f"{book_id}_{start_line_counter}"

        footnotes_in_node = []
        # Find canonical format: <sup class="footnote-ref" id="...">
        found_footnotes = node.find_all('sup', class_='footnote-ref')
        for sup_tag in found_footnotes:
            fn_id = sup_tag.get('id', '')
            if fn_id and 'Fn' in fn_id and fn_id not in footnotes_in_node:
                footnotes_in_node.append(fn_id)

        node_object = {
            "book": book_id,
            "chunk_id": chunk_id,
            "startLine": start_line_counter,
            "content": str(node),
            "references": [],
            "footnotes": footnotes_in_node,
            "hypercites": [],
            "hyperlights": []
        }
        node_chunks_data[node_key] = node_object

    # --- Final Step: Write the JSON files ---
    print("\n--- Writing JSON output files ---")
    with open('footnotes.json', 'w', encoding='utf-8') as f:
        json.dump(footnotes_data, f, ensure_ascii=False, indent=4)
    print("Successfully created footnotes.json")

    with open('nodes.json', 'w', encoding='utf-8') as f:
        json.dump(node_chunks_data, f, ensure_ascii=False, indent=4)
    print("Successfully created nodes.json")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 process_footnotes.py <path_to_html_file>")
        sys.exit(1)
    main(sys.argv[1])
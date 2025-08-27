import sys
import re
import json
import time
import os
import argparse
from bs4 import BeautifulSoup, NavigableString

# --- UTILITY FUNCTIONS (No changes here) ---

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

    # --- 1B: Process Footnotes (FIXED) ---
    # --- 1B: Process Footnotes (FIXED) ---
    footnote_map = {}
    footnotes_data = []

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

            # Generate unique IDs
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

            # Store all IDs in footnote_map for PASS 2B
            footnote_map[identifier] = {
                'unique_fn_id': unique_fn_id, 
                'unique_fnref_id': unique_fnref_id,
                'content': content
            }
        
        print(f"Unwrapping {len(list_items)} footnote items to be processed as individual nodes.")
        fn_container.replace_with(*list_items)

    footnotes_data = [{"footnoteId": v['unique_fn_id'], "content": v['content']} for k, v in footnote_map.items()]
    print(f"Found and extracted {len(footnotes_data)} footnote definitions.")

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

    # --- 2B: Link Footnotes (COMPLETELY REWRITTEN) ---
    # Handle existing <a> tags with #fn pattern
    # --- 2B: Link Footnotes (UPDATED) ---
    for a_tag in soup.find_all('a', href=re.compile(r'^#fn\d+')):
        identifier_match = re.search(r'(\d+)', a_tag.get('href', ''))
        if not identifier_match: continue
        identifier = identifier_match.group(1)
        text_content = a_tag.get_text(strip=True)

        if identifier in footnote_map and text_content == identifier:
            new_sup = soup.new_tag('sup', id=footnote_map[identifier]['unique_fnref_id'])
            new_sup['fn-count-id'] = identifier
            new_a = soup.new_tag('a', href=f"#{footnote_map[identifier]['unique_fn_id']}", attrs={'class': 'footnote-ref'})
            new_a.string = text_content
            new_sup.append(new_a)
            a_tag.replace_with(new_sup)

    # Handle existing <sup> tags
    for sup_tag in soup.find_all('sup'):
        if sup_tag.find('a', class_='footnote-ref'): continue
        identifier = sup_tag.get_text(strip=True)
        if identifier in footnote_map:
            sup_tag['id'] = footnote_map[identifier]['unique_fnref_id']
            sup_tag['fn-count-id'] = identifier
            a_tag = soup.new_tag('a', href=f"#{footnote_map[identifier]['unique_fn_id']}", attrs={'class': 'footnote-ref'})
            a_tag.string = identifier
            sup_tag.string = '' 
            sup_tag.append(a_tag)

    # Handle [^identifier] patterns in text
    for text_node in soup.find_all(string=True):
        if not text_node.parent.name in ['style', 'script', 'a']:
            text = str(text_node)
            matches = list(re.finditer(r'\[\^(\w+)\]', text))
            if matches:
                new_content = []
                last_index = 0
                for match in matches:
                    identifier = match.group(1)
                    if identifier in footnote_map:
                        new_content.append(NavigableString(text[last_index:match.start()]))
                        new_sup = soup.new_tag('sup', id=footnote_map[identifier]['unique_fnref_id'])
                        new_sup['fn-count-id'] = identifier
                        new_a = soup.new_tag('a', href=f"#{footnote_map[identifier]['unique_fn_id']}", attrs={'class': 'footnote-ref'})
                        new_a.string = identifier
                        new_sup.append(new_a)
                        new_content.append(new_sup)
                        last_index = match.end()
                new_content.append(NavigableString(text[last_index:]))
                text_node.replace_with(*new_content)

    # ========================================================================
    # PASS 3: GENERATE FINAL JSON OUTPUT
    # ========================================================================
    print("\n--- PASS 3: Generating Final JSON Output ---")
    book_id = f"book_{int(time.time() * 1000)}"
    node_chunks_data = []
    start_line_counter = 0
    CHUNK_SIZE = 50
    content_root = soup.body if soup.body else soup

    for node in content_root.find_all(recursive=False):
        if isinstance(node, NavigableString) and not node.strip(): continue
        start_line_counter += 1
        chunk_id = (start_line_counter - 1) // CHUNK_SIZE
        node_key = f"{book_id}_{start_line_counter}"
        
        # Force footnote li elements and bibliography p elements to get startLine IDs, keep others' existing IDs
        if node.name == 'li' and node.find('a', attrs={'fn-count-id': True}):
            original_id = node.get('id')  # Store the original footnote ID (e.g., "fn1")
            node['id'] = start_line_counter  # Set numerical ID for startLine
            # Add anchor tag with original footnote ID at the beginning
            if original_id:
                original_anchor = soup.new_tag('a', id=original_id)
                node.insert(0, original_anchor)
        elif node.name == 'p' and node.find('a', class_='bib-entry'):
            node['id'] = start_line_counter
        elif not node.has_attr('id'):
            node['id'] = start_line_counter
        
        references_in_node = [a['href'].lstrip('#') for a in node.find_all('a', class_='in-text-citation')]
        footnotes_in_node = [a.get('fn-count-id', '') for a in node.find_all('sup') if a.get('fn-count-id')]
        node_object = {
            "id": node_key, "book": book_id, "chunk_id": chunk_id, 
            "startLine": start_line_counter, "content": str(node), 
            "references": references_in_node, "footnotes": footnotes_in_node, 
            "hypercites": [], "hyperlights": []
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
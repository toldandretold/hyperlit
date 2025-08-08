# app/python/process_document.py (HANDLES REFERENCES AND ALL FOOTNOTE STYLES)

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

def main(html_file_path, output_dir):
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    # ========================================================================
    # PASS 1: EXTRACT ALL DEFINITIONS (No changes here)
    # ========================================================================
    print("--- PASS 1: Extracting All Definitions ---")
    
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
            div_wrapper = soup.new_tag("div", attrs={"class": "bib-entry", "id": entry_id})
            p.wrap(div_wrapper)
            references_data.append({"referenceId": entry_id, "content": str(div_wrapper)})
            for key in keys: bibliography_map[key] = entry_id
    
    print(f"Found and processed {len(references_data)} reference entries (kept in DOM).")

    footnote_map = {}
    footnotes_data = []
    fn_nodes_to_remove = []

    for p in soup.find_all('p'):
        text = p.get_text(strip=True)
        num_match = re.match(r'^(\d+)\.\s*(.*)', text, re.DOTALL)
        if num_match:
            identifier, content = num_match.groups()
            footnote_map[identifier] = content.strip()
            fn_nodes_to_remove.append(p)
    
    for node in fn_nodes_to_remove: node.decompose()
    footnotes_data = [{"footnoteId": k, "content": v} for k, v in footnote_map.items()]
    print(f"Found and extracted {len(footnotes_data)} footnote definitions.")

    # ========================================================================
    # PASS 2: LINK ALL IN-TEXT MARKERS
    # ========================================================================
    print("\n--- PASS 2: Linking All In-Text Markers ---")

    # --- 2A: Link References ---
    for text_node in soup.find_all(string=True):
        if not text_node.find_parent("div", class_="bib-entry"):
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
                                # --- MODIFIED SECTION START ---
                                # Find the year to wrap the link around it specifically.
                                year_match = re.search(r'(\d{4}[a-z]?)', sub_cite)
                                
                                if year_match:
                                    # Split the citation string into parts: before, year, and after.
                                    author_part = sub_cite[:year_match.start(0)]
                                    year_part = year_match.group(0)
                                    trailing_part = sub_cite[year_match.end(0):]

                                    # 1. Add the author part as plain text
                                    if author_part:
                                        new_content.append(NavigableString(author_part))

                                    # 2. Create the link ONLY for the year
                                    a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}", attrs={'class': 'in-text-citation'})
                                    a_tag.string = year_part
                                    new_content.append(a_tag)

                                    # 3. Add any trailing text (e.g., page numbers) as plain text
                                    if trailing_part:
                                        new_content.append(NavigableString(trailing_part))
                                else:
                                    # Fallback for safety: if no year found, link the whole citation
                                    a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}", attrs={'class': 'in-text-citation'})
                                    a_tag.string = sub_cite
                                    new_content.append(a_tag)
                                
                                linked = True
                                break
                                # --- MODIFIED SECTION END ---

                        if not linked: new_content.append(NavigableString(sub_cite))
                        if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                    new_content.append(NavigableString(")"))
                    last_index = match.end()
                new_content.append(NavigableString(text[last_index:]))
                text_node.replace_with(*new_content)

    # --- 2B: Link Footnotes (No changes here) ---
    html_content = str(soup)
    for identifier in footnote_map.keys():
        pattern1 = rf'\[\^{re.escape(identifier)}\]'
        replacement1 = f'<sup id="fnref:{identifier}"><a class="footnote-ref" href="#fn:{identifier}">{identifier}</a></sup>'
        html_content = re.sub(pattern1, replacement1, html_content)
        pattern2 = rf'([^>]*)(\b{re.escape(identifier)}\b)(\s*</(?:p|div|h[1-6]|blockquote)>)'
        def replace_plain_footnote(match):
            text_before = match.group(1)
            if '<a ' in text_before and '</a>' not in text_before: return match.group(0)
            if re.search(r'\d{4}', text_before[-10:]) or re.search(r'[,-]\s*\d+', text_before[-10:]): return match.group(0)
            sup_tag = f'<sup id="fnref:{identifier}"><a class="footnote-ref" href="#fn:{identifier}">{identifier}</a></sup>'
            return f'{text_before}{sup_tag}{match.group(3)}'
        html_content = re.sub(pattern2, replace_plain_footnote, html_content)
    soup = BeautifulSoup(html_content, "html.parser")

    # ========================================================================
    # PASS 3: GENERATE FINAL JSON OUTPUT (No changes here)
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
        references_in_node = [a['href'].lstrip('#') for a in node.find_all('a', class_='in-text-citation')]
        footnotes_in_node = [a['href'].split(':')[-1] for a in node.find_all('a', class_='footnote-ref')]
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
    args = parser.parse_args()

    if not os.path.isfile(args.html_file):
        print(f"Error: Input file not found at {args.html_file}")
        sys.exit(1)

    main(args.html_file, args.output_dir)
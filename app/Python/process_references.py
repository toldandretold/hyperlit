# app/python/process_references.py (DEFINITIVE, JSON OUTPUT VERSION)

import sys
import re
import json
import time
from bs4 import BeautifulSoup, NavigableString

def generate_keys_from_text(text, context_text=""):
    """
    Generates keys from a citation string. If the string lacks an author,
    it uses the provided context_text to find one.
    """
    processed_text = re.sub(r'\[\d{4}\]\s*', '', text)
    year_match = re.search(r'(\d{4}[a-z]?)', processed_text)
    if not year_match:
        return []
    year = year_match.group(1)

    authors_part = text.split(year)[0]
    keys = set()
    has_author_in_citation = re.search(r'[a-zA-Z]', authors_part)
    author_source_text = authors_part

    if not has_author_in_citation and context_text:
        author_candidates = re.findall(r'\b[A-Z][a-zA-Z’\']+\b', context_text)
        if author_candidates:
            author_source_text = author_candidates[-1]

    first_word_match = re.match(r'^\s*([A-Za-z’\']{2,})', author_source_text)
    if first_word_match:
        keys.add(first_word_match.group(1).lower().replace("’s", "") + year)

    surnames = re.findall(r'\b[A-Z][a-zA-Z’\']+\b', author_source_text)
    excluded_words = {'And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'}
    surnames = [s.lower().replace("’s", "") for s in surnames if s not in excluded_words]
    if surnames:
        surnames.sort()
        keys.add("".join(surnames) + year)

    acronyms = re.findall(r'\b[A-Z]{2,}\b', author_source_text)
    for acronym in acronyms:
        keys.add(acronym.lower() + year)

    if "United Nations General Assembly" in text:
        keys.add("un" + year)

    return list(keys)

def is_likely_reference(p_tag):
    if not p_tag: return False
    text = p_tag.get_text(" ", strip=True)
    return re.match(r'^\s*[A-Z]', text) and re.search(r'\d{4}', text)

def main(html_file_path):
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    # --- PASS 1: Build the bibliography map and data for references.json ---
    print("--- PASS 1: Building Bibliography Map ---")
    bibliography_map = {}
    references_data = []

    all_paragraphs = soup.find_all('p')
    reference_p_tags = []
    for p in reversed(all_paragraphs):
        if is_likely_reference(p):
            reference_p_tags.insert(0, p)
        else:
            if p.get_text(strip=True).lower() in ["references", "bibliography", "works cited", "notes"]:
                break
            
    if reference_p_tags:
        for p in reference_p_tags:
            text = p.get_text(" ", strip=True)
            keys = generate_keys_from_text(text)
            if keys:
                entry_id = keys[0]
                # THE CRITICAL FIX: Wrap each reference <p> in its own div IN-PLACE.
                # Do NOT group them under a single parent container.
                div_wrapper = soup.new_tag("div", attrs={"class": "bib-entry", "id": entry_id})
                p.wrap(div_wrapper)

                ref_obj = {
                    "referenceId": entry_id,
                    "content": str(div_wrapper) # Use the new wrapper as the content
                }
                references_data.append(ref_obj)
                for key in keys:
                    bibliography_map[key] = entry_id

    # --- PASS 2: Link in-text citations in the soup object ---
    print("\n--- PASS 2: Linking In-Text Citations (in memory) ---")
    for text_node in soup.find_all(string=True):
        # Now we check for the 'bib-entry' class on the parent div
        if not text_node.find_parent("div", class_="bib-entry"):
            text = str(text_node)
            matches = list(re.finditer(r"\((?!https?:\/\/)([^)]*?\d{4}[^)]*?)\)", text))
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
                        keys = generate_keys_from_text(sub_cite, context_text=preceding_text)
                        linked = False
                        for key in keys:
                            if key in bibliography_map:
                                target_id = bibliography_map[key]
                                a_tag = soup.new_tag("a", href=f"#{target_id}")
                                a_tag['class'] = 'in-text-citation'
                                a_tag.string = sub_cite
                                new_content.append(a_tag)
                                linked = True
                                break
                        if not linked:
                            new_content.append(NavigableString(sub_cite))
                        if i < len(sub_citations) - 1:
                            new_content.append(NavigableString("; "))
                    new_content.append(NavigableString(")"))
                    last_index = match.end()
                new_content.append(NavigableString(text[last_index:]))
                text_node.replace_with(*new_content)

    # --- PASS 3: Generate one object per node for nodes.json ---
    print("\n--- PASS 3: Generating Node Chunks ---")
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

        references_in_node = []
        found_refs = node.find_all('a', class_='in-text-citation')
        for a_tag in found_refs:
            ref_id = a_tag['href'].lstrip('#')
            if ref_id not in references_in_node:
                references_in_node.append(ref_id)

        node_object = {
            "book": book_id,
            "chunk_id": chunk_id,
            "startLine": start_line_counter,
            "content": str(node),
            "references": references_in_node,
            "footnotes": [],
            "hypercites": [],
            "hyperlights": []
        }
        
        node_chunks_data[node_key] = node_object

    # --- Final Step: Write the JSON files ---
    print("\n--- Writing JSON output files ---")
    with open('references.json', 'w', encoding='utf-8') as f:
        json.dump(references_data, f, ensure_ascii=False, indent=4)
    print("Successfully created references.json")

    with open('nodes.json', 'w', encoding='utf-8') as f:
        json.dump(node_chunks_data, f, ensure_ascii=False, indent=4)
    print("Successfully created nodes.json")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 process_references.py <path_to_html_file>")
        sys.exit(1)
    main(sys.argv[1])
import re
import json
import uuid
import sys
import argparse
import os
from bs4 import BeautifulSoup
import markdown

def generate_unique_id(prefix=""):
    """Generates a unique ID string."""
    return f"{prefix}{uuid.uuid4().hex[:12]}"

def process_chapter_pair(chapter_html, refs_html, book_id):
    """
    Processes a single pair of chapter and reference HTML strings.
    Returns modified BeautifulSoup objects and the structured citation data.
    """
    chapter_soup = BeautifulSoup(chapter_html, 'html.parser')
    refs_soup = BeautifulSoup(refs_html, 'html.parser')
    
    references_db = {}
    
    # Process references to build the database
    for p_tag in refs_soup.find_all('p'):
        ref_text_content = p_tag.get_text()
        ref_html_content = p_tag.decode_contents()
        match = re.search(r"([A-Za-z\s,.'&-]+)\s*\(?(\d{4}[a-z]?)\)?", ref_text_content)
        
        if match:
            author = match.group(1).strip().split(',')[0]
            year = match.group(2)
            key = (author.lower(), year)
            
            ref_id = generate_unique_id("ref_")
            references_db[key] = {
                "id": ref_id,
                "content": ref_html_content,
            }
            # Add the ID to the paragraph tag itself for later wrapping
            p_tag['id'] = ref_id
    
    # Find and replace citations in the chapter text
    citation_data_for_json = []
    author_date_pattern = re.compile(r"\(([A-Za-z]+),\s*(\d{4}[a-z]?)\)")

    for p_tag in chapter_soup.find_all(['p', 'h1', 'h2', 'h3', 'blockquote']):
        original_html = p_tag.decode_contents()
        
        def replace_citation(match):
            author = match.group(1)
            year = match.group(2)
            key = (author.lower(), year)
            
            if key in references_db:
                ref_info = references_db[key]
                ref_id = ref_info["id"]
                link_id = generate_unique_id("link_")
                
                citation_data_for_json.append({
                    "bookId": book_id,
                    "footnoteId": ref_id,
                    "content": ref_info["content"],
                    "startLine": p_tag.get('data-original-line', 'unknown')
                })
                
                return f'({author}, <a id="{link_id}" class="citation-link" href="#{ref_id}">{year}</a>)'
            else:
                return match.group(0)

        modified_html = author_date_pattern.sub(replace_citation, original_html)
        
        if modified_html != original_html:
            p_tag.string = ""
            p_tag.append(BeautifulSoup(modified_html, 'html.parser'))
            
    return chapter_soup, refs_soup, citation_data_for_json

def main():
    parser = argparse.ArgumentParser(
        description="Process a simple manuscript file to link citations."
    )
    parser.add_argument("input_file", help="Path to the input Markdown (.md) file.")
    args = parser.parse_args()

    input_path = args.input_file
    if not os.path.exists(input_path):
        print(f"❌ Error: Input file not found at '{input_path}'")
        sys.exit(1)

    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split the entire document into major chapter/reference blocks
    blocks = content.split('\n---\n')
    print(f"Found {len(blocks)} major section(s) separated by '---'.")

    final_soup = BeautifulSoup("<body></body>", 'html.parser')
    all_citations = {}
    book_id = f"book_{os.path.splitext(os.path.basename(input_path))[0]}"

    # Regex to find the "References" or "Bibliography" heading
    # It's case-insensitive and looks for any level of heading (#, ##, etc.)
    refs_heading_pattern = re.compile(r'^\s*#+\s*(References|Bibliography)', re.IGNORECASE | re.MULTILINE)

    for i, block in enumerate(blocks):
        chapter_num = i + 1
        print(f"\nProcessing Chapter {chapter_num}...")

        match = refs_heading_pattern.search(block)
        if not match:
            print(f"⚠️ Warning: No '## References' heading found in block {chapter_num}. Skipping.")
            continue

        # Split the block into chapter text and reference text
        chapter_md = block[:match.start()].strip()
        refs_md = block[match.start():].strip()

        # Convert both parts to HTML
        chapter_html = markdown.markdown(chapter_md)
        refs_html = markdown.markdown(refs_md)

        # Process the pair
        processed_chapter_soup, processed_refs_soup, chapter_citations = process_chapter_pair(
            chapter_html, refs_html, book_id
        )

        # Wrap the processed content in the required divs
        chapter_div = final_soup.new_tag('div', id=f'chapter{chapter_num}')
        chapter_div.extend(processed_chapter_soup.contents)
        
        footnotes_div = final_soup.new_tag('div', **{'class': f'footnotes4chapter{chapter_num}'})
        # Re-wrap each reference in its own div
        for p in processed_refs_soup.find_all('p'):
            if p.get('id'):
                ref_div = final_soup.new_tag('div', id=p['id'])
                p.attrs = {} # clean the id from the p tag
                ref_div.append(p)
                footnotes_div.append(ref_div)
            else:
                footnotes_div.append(p) # Append non-matching refs directly

        final_soup.body.append(chapter_div)
        final_soup.body.append(footnotes_div)

        # Add the collected citations to the main dictionary
        for item in chapter_citations:
            key = f"{item['bookId']}_{item['footnoteId']}"
            all_citations[key] = item
        
        print(f"✅ Chapter {chapter_num} processed. Found {len(chapter_citations)} linked citations.")

    # Write the output files
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    output_html_path = f"{base_name}_processed.html"
    output_json_path = f"{base_name}_citations.json"

    with open(output_html_path, 'w', encoding='utf-8') as f:
        f.write(final_soup.prettify())
    print(f"\n✅ Successfully generated processed HTML: {output_html_path}")

    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(all_citations, f, indent=2)
    print(f"✅ Successfully generated citation JSON: {output_json_path}")

if __name__ == "__main__":
    main()
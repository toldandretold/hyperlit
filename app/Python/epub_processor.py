
import sys
import os
import xml.etree.ElementTree as ET
from bs4 import BeautifulSoup
import re

def strip_tag_namespace(tag):
    """Remove namespace from an XML tag if present."""
    return re.sub(r'\{.*?\}', '', tag)

def find_opf_path(epub_dir, debug_log):
    """Finds the path to the .opf file from container.xml."""
    container_path = os.path.join(epub_dir, 'META-INF', 'container.xml')
    debug_log.write(f"DEBUG: Looking for container.xml at: {container_path}\n")
    if not os.path.exists(container_path):
        raise FileNotFoundError("META-INF/container.xml not found. Is this a valid EPUB directory?")
    
    tree = ET.parse(container_path)
    root = tree.getroot()
    
    for elem in root.iter():
        elem.tag = strip_tag_namespace(elem.tag)

    rootfile = root.find('rootfiles/rootfile')
    if rootfile is None:
        raise ValueError("Could not find <rootfile> in container.xml")
        
    opf_path = os.path.join(epub_dir, rootfile.get('full-path'))
    debug_log.write(f"DEBUG: Found OPF file path: {opf_path}\n")
    return opf_path

def parse_opf(opf_path, debug_log):
    """Parses the .opf file to get the manifest and spine, ignoring XML namespaces."""
    if not os.path.exists(opf_path):
        raise FileNotFoundError(f"OPF file not found at: {opf_path}")

    tree = ET.parse(opf_path)
    root = tree.getroot()

    for elem in root.iter():
        elem.tag = strip_tag_namespace(elem.tag)

    manifest = {item.get('id'): item.get('href') for item in root.findall('.//manifest/item')}
    debug_log.write(f"DEBUG: Found {len(manifest)} items in manifest.\n")
        
    spine = [item.get('idref') for item in root.findall('.//spine/itemref')]
    debug_log.write(f"DEBUG: Found {len(spine)} items in spine.\n")
    
    if not manifest or not spine:
        debug_log.write("WARNING: Manifest or spine is empty. The EPUB may be malformed or empty.\n")

    return manifest, spine

def advanced_cleanup(content_soup, debug_log):
    """Converts styled divs to semantic tags and cleans up the structure, with logging."""
    debug_log.write("--- Starting Advanced Cleanup ---\n")

    # Pass 1: Identify and convert headings
    for div in content_soup.find_all('div'):
        class_str = ' '.join(div.get('class', [])).lower()
        if 'heading' in class_str or 'title' in class_str:
            original_div_str = str(div)[:200].replace('\n', '')
            level = 1
            match = re.search(r'[h_s]?(?P<level>\d+)', class_str)
            if match:
                level = int(match.group('level'))
                if level == 0: level = 1
                if level > 6: level = 6
            
            div.name = f'h{level}'
            for attr in list(div.attrs):
                if attr != 'id':
                    del div[attr]
            debug_log.write(f"DEBUG-CONVERT: HEADING: {original_div_str} ---> {str(div)}\n")

    # Pass 2: Identify and convert blockquotes
    for div in content_soup.find_all('div'):
        class_str = ' '.join(div.get('class', [])).lower()
        if 'blockquote' in class_str or 'quote' in class_str or 'epigraph' in class_str:
            original_div_str = str(div)[:200].replace('\n', '')
            div.name = 'blockquote'
            for attr in list(div.attrs):
                if attr != 'id':
                    del div[attr]
            debug_log.write(f"DEBUG-CONVERT: BLOCKQUOTE: {original_div_str} ---> {str(div)}\n")

    # Pass 3: Convert all remaining <div> tags to <p> tags
    for div in content_soup.find_all('div'):
        div.name = 'p'
        for attr in list(div.attrs):
            if attr != 'id':
                del div[attr]

    # Pass 4: Safer Cleanup - unwrap nested tags. Run a few times.
    for i in range(3):
        unwrapped = False
        
        # Unwrap headings from paragraphs
        for heading in content_soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
            if heading.parent.name == 'p':
                heading.parent.unwrap()
                unwrapped = True
                debug_log.write(f"DEBUG-UNWRAP: Freed heading {heading.name} from paragraph\\n")
        
        # Unwrap nested paragraphs
        for p in content_soup.find_all('p'):
            if p.parent.name == 'p':
                p.parent.unwrap()
                unwrapped = True
                
        # Unwrap nested blockquotes        
        for bq in content_soup.find_all('blockquote'):
            if bq.parent.name == 'blockquote':
                bq.parent.unwrap()
                unwrapped = True
                
        if unwrapped:
            debug_log.write(f"DEBUG-UNWRAP: Pass {i+1} completed, tags were unwrapped.\\n")

    debug_log.write("--- Finished Advanced Cleanup ---\n")
    return content_soup

def normalize_heading_hierarchy(soup, debug_log):
    """
    Normalizes heading hierarchy to eliminate gaps.
    E.g., if we have h1 -> h4, it converts h4 to h2.
    """
    # Find all headings in document order
    headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    
    if not headings:
        debug_log.write("No headings found in the document.\\n")
        return
    
    debug_log.write(f"Found {len(headings)} headings to normalize\\n")
    
    # Track the current heading level and changes
    current_level = 0
    changes_made = 0
    
    for heading in headings:
        # Get the current heading level (1-6)
        original_level = int(heading.name[1])
        
        # Determine what the new level should be
        if original_level == 1:
            # H1 always stays H1, reset hierarchy
            new_level = 1
            current_level = 1
        elif original_level <= current_level + 1:
            # Normal progression (same level or one level deeper)
            new_level = original_level
            current_level = max(current_level, original_level)
        else:
            # Gap detected! Normalize to current_level + 1
            new_level = current_level + 1
            current_level = new_level
        
        # Apply the change if needed
        if original_level != new_level:
            old_tag = heading.name
            heading.name = f'h{new_level}'
            text_preview = heading.get_text()[:50] + ("..." if len(heading.get_text()) > 50 else "")
            debug_log.write(f"NORMALIZE: {old_tag} -> h{new_level}: {text_preview}\\n")
            changes_made += 1
    
    debug_log.write(f"Heading normalization complete: {changes_made} changes made\\n")

def process_epub(epub_dir, output_file):
    """
    Processes an extracted EPUB directory to create a single, clean HTML file.
    """
    debug_log_path = os.path.join(os.path.dirname(output_file), 'epub_debug_log.txt')
    try:
        with open(debug_log_path, 'w', encoding='utf-8') as debug_log:
            opf_path = find_opf_path(epub_dir, debug_log)
            opf_dir = os.path.dirname(opf_path)
            manifest, spine = parse_opf(opf_path, debug_log)

            combined_soup = BeautifulSoup('<html><head><title>Combined EPUB</title></head><body></body></html>', 'html.parser')
            body = combined_soup.body

            if not spine:
                with open(output_file, 'w', encoding='utf-8') as f:
                    f.write("")
                return

            for idref in spine:
                if idref not in manifest:
                    debug_log.write(f"SKIP: {idref} not in manifest\\n")
                    continue
                
                file_href = manifest[idref]
                file_path = os.path.normpath(os.path.join(opf_dir, file_href))
                debug_log.write(f"\\n=== PROCESSING FILE: {file_path} ===\\n")
                
                if not os.path.exists(file_path):
                    debug_log.write(f"SKIP: File does not exist: {file_path}\\n")
                    continue

                with open(file_path, 'r', encoding='utf-8') as f:
                    soup = BeautifulSoup(f, 'html.parser')
                    debug_log.write(f"ORIGINAL CONTENT LENGTH: {len(str(soup))} chars\\n")
                    
                    content = soup.body
                    if not content:
                        content = soup
                        debug_log.write("Using entire soup (no body found)\\n")
                    else:
                        debug_log.write("Using body content\\n")

                    if not content:
                        debug_log.write("SKIP: No content found\\n")
                        continue

                    children_before = list(content.children)
                    debug_log.write(f"BEFORE CLEANUP: {len(children_before)} children\\n")
                    for i, child in enumerate(children_before):
                        if hasattr(child, 'name') and child.name:
                            debug_log.write(f"  Child {i}: <{child.name}> - {str(child)[:100]}...\\n")
                    
                    content = advanced_cleanup(content, debug_log)

                    children_after = list(content.children)
                    debug_log.write(f"AFTER CLEANUP: {len(children_after)} children\\n")
                    for i, child in enumerate(children_after):
                        if hasattr(child, 'name') and child.name:
                            debug_log.write(f"  Child {i}: <{child.name}> - {str(child)[:100]}...\\n")

                    for a in content.find_all('a', href=True):
                        href = a['href']
                        if '#' in href:
                            a['href'] = '#' + href.split('#', 1)[-1]

                    for img in content.find_all('img', src=True):
                        src = img['src']
                        if not src.startswith(('http', 'data:')):
                            img_path_from_opf_dir = os.path.normpath(os.path.join(os.path.dirname(file_href), src))
                            final_img_path = os.path.relpath(os.path.join(opf_dir, img_path_from_opf_dir), os.path.dirname(output_file))
                            img['src'] = final_img_path

                    # Convert to list to avoid iterator consumption issues
                    children_to_add = list(content.children)
                    children_added = 0
                    for child in children_to_add:
                        if hasattr(child, 'name') and child.name:  # Only add actual tags, not text nodes
                            body.append(child)
                            children_added += 1
                    debug_log.write(f"ADDED TO OUTPUT: {children_added} children out of {len(children_to_add)} total\\n")
            
            # Normalize heading hierarchy before final output
            debug_log.write("\\n--- Starting Heading Normalization ---\\n")
            normalize_heading_hierarchy(combined_soup, debug_log)
            debug_log.write("--- Finished Heading Normalization ---\\n")
            
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(str(combined_soup))

    except Exception as e:
        # Write any exception to the debug log as well
        with open(debug_log_path, 'a', encoding='utf-8') as debug_log:
            debug_log.write(f"\n--- AN ERROR OCCURRED ---\n")
            debug_log.write(str(e))
        # Also print to stderr for the PHP process to catch
        print(f"An error occurred: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: python epub_processor.py <path_to_extracted_epub_directory>", file=sys.stderr)
        sys.exit(1)
        
    epub_directory = sys.argv[1]
    
    output_directory = os.path.dirname(epub_directory)
    final_output_file = os.path.join(output_directory, 'main-text.html')

    process_epub(epub_directory, final_output_file)

import sys
import re
import json
import time
import os
import argparse
import random
import string
from collections import Counter
from bs4 import BeautifulSoup, NavigableString
from PIL import Image as PILImage
import bleach

# Shared decision-trace collector (extracted to conversion/assessment.py so every
# modular pipeline piece records to the same instance). See conversion/assessment.py.
from conversion.assessment import Assessment, ASSESSMENT
# Pure citation-key + reference-detection logic (unit-tested in tests/conversion/unit/).
from conversion.refkeys import generate_ref_keys, normalize_unicode_name, is_likely_reference
# Footnote-strategy selection + numbering-linkability guard + bibliography-heading regex.
from conversion.strategy import (
    analyze_document_structure, detect_footnote_sections,
    _footnote_numbering_is_linkable, _summarize_footnote_numbers, _BIBLIOGRAPHY_HEADING_RE,
)
# HTML sanitization + inner-HTML extraction (security plumbing).
from conversion.sanitize import sanitize_html, get_element_html_content
# Footnote extraction by strategy (whole-document, sequential).
from conversion.footnotes import process_whole_document_footnotes, process_sequential_footnotes, link_footnotes
# Citation linking (PASS 2A): wrap (Author Year) / [Author Year] in in-text-citations.
from conversion.citations import link_citations
# Footnote-linking audit (gaps / duplicates / unmatched refs+defs).
from conversion.audit import compute_footnote_audit


def emit_progress(pct, stage, detail=""):
    """Emit a machine-readable progress line for the PHP job runner."""
    print("PROGRESS:" + json.dumps({"percent": pct, "stage": stage, "detail": detail}), flush=True)


# --- UTILITY FUNCTIONS ---




# --- MAIN PROCESSING LOGIC ---

def main(html_file_path, output_dir, book_id):
    ASSESSMENT.reset(output_dir)
    emit_progress(48, "doc_parse", "Parsing HTML document")
    with open(html_file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    # Check if this is a STEM bibliography-style document
    footnote_meta_path = os.path.join(output_dir, 'footnote_meta.json')
    is_stem = False
    footnote_warnings = []
    segment_boundaries = []
    if os.path.exists(footnote_meta_path):
        with open(footnote_meta_path, 'r') as f:
            footnote_meta = json.load(f)
            is_stem = footnote_meta.get('classification') == 'wackSTEMbibliographyNotes'
            footnote_warnings = footnote_meta.get('footnote_warnings', []) or []
            segment_boundaries = footnote_meta.get('segment_boundaries', []) or []
    if is_stem:
        print("📐 STEM bibliography mode detected — using wackSTEM marker conversion")

    # ========================================================================
    # SAFARI FIX: Remove RTL spans that cause findTextSamplesByVisualExamination lag
    # Pandoc generates <span dir="rtl">'</span> for smart quotes from DOCX
    # These trigger Safari's bidirectional text analysis and freeze the browser
    # ========================================================================
    rtl_spans = soup.find_all('span', attrs={'dir': 'rtl'})
    for span in rtl_spans:
        # Replace the span with just its text content (the quote character)
        span.replace_with(span.get_text())
    if rtl_spans:
        print(f"🔧 SAFARI FIX: Removed {len(rtl_spans)} RTL spans from document")

    # ========================================================================
    # PRE-PROCESS: Split multi-entry bibliography paragraphs
    # ========================================================================
    # PDF conversion sometimes crams many reference entries into a single <p>,
    # separated by newlines. Split these so each entry gets its own <p>.
    split_count = 0
    for p in list(soup.find_all('p')):
        inner = p.decode_contents()
        if '\n' not in inner:
            continue
        lines = [l.strip() for l in inner.split('\n') if l.strip()]
        if len(lines) < 2:
            continue
        # Count lines that look like reference entries (start with uppercase + contain a year)
        ref_lines = 0
        for l in lines:
            line_text = BeautifulSoup(l, 'html.parser').get_text()
            if line_text and line_text[0].isupper() and re.search(r'\d{4}', line_text):
                ref_lines += 1
        if ref_lines >= 2:
            new_elements = []
            for line in lines:
                new_p = soup.new_tag('p')
                new_p.append(BeautifulSoup(line, 'html.parser'))
                new_elements.append(new_p)
            # Insert after original in reverse, then remove original
            for new_p in reversed(new_elements):
                p.insert_after(new_p)
            p.decompose()
            split_count += 1
            print(f"  Split multi-entry <p> into {len(new_elements)} individual entries")
    if split_count:
        print(f"Pre-processed {split_count} multi-entry bibliography paragraphs")


    # ========================================================================
    # STEM BIBLIOGRAPHY PROCESSING (wackSTEMbibliographyNotes)
    # ========================================================================
    if is_stem:
        references_data = []
        footnotes_data = []
        all_footnotes_data = []

        # Convert wackSTEMdef → bib-entry and collect references
        for a_tag in soup.find_all('a', class_='wackSTEMdef'):
            ref_id = a_tag.get('id', '')
            a_tag['class'] = 'bib-entry'
            # Store just the text for popup display (not the <a>/<p> wrapper)
            ref_text = a_tag.get_text()
            if ref_text:
                references_data.append({"referenceId": ref_id, "content": ref_text})

        # Convert wackSTEMcite → in-text-citation with href
        for a_tag in soup.find_all('a', class_='wackSTEMcite'):
            cite_text = a_tag.get_text()
            data_refs = a_tag.get('data-refs')
            if data_refs:
                # Range citation: href points to first ref, data-refs preserved
                first_ref = data_refs.split(',')[0]
                a_tag['href'] = f'#{first_ref}'
            else:
                num_match = re.search(r'\d+', cite_text)
                if num_match:
                    a_tag['href'] = f'#stemref_{num_match.group()}'
            a_tag['class'] = 'in-text-citation'

        stem_cites = len(soup.find_all('a', class_='in-text-citation'))
        print(f"Converted {len(references_data)} STEM bibliography entries")
        print(f"Converted {stem_cites} STEM in-text citations")

        # Write audit.json
        os.makedirs(output_dir, exist_ok=True)
        audit_data = {
            'stem_mode': True,
            'total_refs': stem_cites,
            'total_defs': len(references_data),
            'gaps': [], 'duplicates': [],
            'unmatched_refs': [], 'unmatched_defs': [],
            'font_encoding_warnings': footnote_warnings,
            'segment_boundaries': segment_boundaries,
        }
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (STEM path)
        conversion_stats = {
            'references_found': len(references_data),
            'citations_total': stem_cites,
            'citations_linked': stem_cites,
            'footnotes_matched': 0,
            'footnote_strategy': 'stem_bibliography',
            'citation_style': 'numbered-bracket',
            'font_encoding_warning_count': len(footnote_warnings),
            'segment_count': len(segment_boundaries) + 1 if segment_boundaries else 1,
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

    # ========================================================================
    # STANDARD PROCESSING: PASS 1 + PASS 2 + AUDIT (skipped for STEM)
    # ========================================================================
    if not is_stem:

        # ========================================================================
        # PASS 1: EXTRACT ALL DEFINITIONS
        # ========================================================================
        emit_progress(52, "doc_bibliography", "Scanning for bibliography")
        print("--- PASS 1: Extracting All Definitions ---")

        # --- 1A: Process Bibliography / References ---
        bibliography_map = {}
        references_data = []
        all_paragraphs = soup.find_all('p')
        reference_p_tags = []

        print(f"📚 Scanning {len(all_paragraphs)} paragraphs for reference section...")

        # Common reference section headers
        REFERENCE_HEADERS = ["references", "bibliography", "works cited", "sources", "literature cited", "reference list"]

        # PRIMARY: Find reference section by heading (more reliable for academic papers)
        all_headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
        for heading in all_headings:  # Forward scan to find first matching heading
            header_text = heading.get_text(strip=True).lower()
            if header_text in REFERENCE_HEADERS:
                print(f"  📖 Found references heading: '{header_text}'")
                bib_heading_level = int(heading.name[1])  # e.g. h2 → 2
                # Collect ALL paragraphs until the next same-or-higher-level heading
                next_sibling = heading.find_next_sibling()
                while next_sibling:
                    if next_sibling.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                        sibling_level = int(next_sibling.name[1])
                        if sibling_level <= bib_heading_level:
                            # Peek ahead: are subsequent paragraphs reference-like?
                            # Use strict check: year must appear near start of text (first 80 chars).
                            # Body text has years scattered in citations far from the start;
                            # bibliography entries always have Author. Year. near the beginning.
                            peek = next_sibling.find_next_sibling()
                            peek_refs = 0
                            peek_total = 0
                            while peek and peek_total < 3:
                                if peek.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                                    peek = peek.find_next_sibling()
                                    continue
                                if peek.name == 'p':
                                    peek_total += 1
                                    peek_text = peek.get_text(" ", strip=True)
                                    # Strict: reference-like AND year within first 80 chars
                                    if is_likely_reference(peek) and re.search(r'\d{4}', peek_text[:80]):
                                        peek_refs += 1
                                peek = peek.find_next_sibling()
                            if peek_total >= 2 and peek_refs >= 2:
                                # Multiple reference-like paragraphs follow — heading is OCR artifact
                                print(f"  ⚠️ Skipping embedded heading (OCR artifact): '{next_sibling.get_text(strip=True)[:60]}'")
                                next_sibling = next_sibling.find_next_sibling()
                                continue
                            break  # Real section boundary
                        # Lower level → alphabetical marker or sub-section within bibliography, skip it
                    if next_sibling.name == 'p' and is_likely_reference(next_sibling):
                        reference_p_tags.append(next_sibling)
                        text_preview = next_sibling.get_text(" ", strip=True)[:80]
                        print(f"  ✓ Detected reference: {text_preview}...")
                    next_sibling = next_sibling.find_next_sibling()
                # Don't break — continue scanning for more reference sections (multi-chapter books)

        # FALLBACK: If no heading found, use reverse paragraph scan
        if not reference_p_tags:
            print("  ⚠️ No references heading found, scanning paragraphs...")
            for p in reversed(all_paragraphs):
                text_preview = p.get_text(" ", strip=True)[:80]
                if is_likely_reference(p):
                    reference_p_tags.insert(0, p)
                    print(f"  ✓ Detected reference: {text_preview}...")
                elif reference_p_tags:
                    header_text = p.get_text(strip=True).lower()
                    if header_text in REFERENCE_HEADERS:
                        reference_p_tags.insert(0, p)
                        print(f"  📖 Found references header: '{header_text}'")
                    break

        print(f"📚 Found {len(reference_p_tags)} reference paragraphs")

        # Detect markdown list markers (- or *) used consistently across entries
        list_marker_count = sum(
            1 for p in reference_p_tags
            if re.match(r'^\s*[-*]\s', p.get_text(" ", strip=True))
        )
        strip_list_marker = list_marker_count > len(reference_p_tags) * 0.5
        if strip_list_marker:
            print(f"  📋 Detected list-marker format ({list_marker_count}/{len(reference_p_tags)} entries) — stripping '- ' prefixes")

        seen_references = {}  # base_entry_id → {"text": str, "suffix_count": int}
        used_ids = set()      # all entry_ids actually assigned (including suffixed)
        last_bib_author = ""  # Track last author for em-dash (—) repeat-author entries

        for p in reference_p_tags:
            text = p.get_text(" ", strip=True)
            if strip_list_marker:
                text = re.sub(r'^\s*[-*]\s+', '', text)

            # Handle em-dash repeat-author entries (e.g. "—. 2014. Title...")
            # Common academic convention: — means "same author as previous entry"
            dash_match = re.match(r'^[\u2014\u2013\u2012\u2015—–-]{1,3}[\.\,\s]', text)
            if dash_match and last_bib_author:
                # Replace the dash with the previous author name
                text_with_author = last_bib_author + text[dash_match.end()-1:]
                print(f"  ↩️ Dash-author entry, substituting '{last_bib_author}': {text[:60]}...")
                keys = generate_ref_keys(text_with_author)
            else:
                keys = generate_ref_keys(text)
                # Update last_bib_author from this entry (text before the year)
                if keys and not dash_match:
                    year_match = re.search(r'\d{4}', text)
                    if year_match:
                        last_bib_author = text[:year_match.start()].rstrip(' .,;:(')
                # For entries with prefix year (Author (YEAR1)) that also have a different
                # publication year in the body (YEAR2), generate keys for both years
                # to handle OCR errors in the prefix year
                if keys:
                    paren_yr = re.search(r'\((\d{4}[a-z]?)\)', text)
                    if paren_yr:
                        prefix_yr = paren_yr.group(1)
                        body_text = text[paren_yr.end():]
                        body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', body_text))
                        body_years = [m for m in body_years if 1900 <= int(m.group(1)) <= 2099 and m.group(1) != prefix_yr]
                        if body_years:
                            alt_yr = body_years[-1].group(1)
                            alt_keys = [k.replace(prefix_yr, alt_yr) for k in keys if prefix_yr in k]
                            keys = list(set(keys + alt_keys))

            if not keys:
                # Fallback: for entries with garbled prefix initials like "K. E. (2005) Daniel Kennefick..."
                # extract author names from the text AFTER the parenthesized year prefix
                paren_year_match = re.search(r'\((\d{4}[a-z]?)\)', text)
                if paren_year_match:
                    remainder = text[paren_year_match.end():].strip()
                    prefix_year = paren_year_match.group(1)
                    # Extract author block from remainder (before title start: ". " after 2+ lowercase chars + uppercase)
                    # Avoids matching initials like "H. G" or "D. L"
                    author_block_match = re.search(r'(?<=[a-z]{2})\.\s+[A-Z]', remainder)
                    if author_block_match:
                        author_text = remainder[:author_block_match.start()] + " " + prefix_year
                    else:
                        author_text = remainder.split('.')[0] + " " + prefix_year
                    keys = generate_ref_keys(author_text)
                    # Also generate keys with alternative years from body text
                    body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', remainder))
                    body_years = [m for m in body_years if 1900 <= int(m.group(1)) <= 2099 and m.group(1) != prefix_year]
                    if body_years:
                        alt_year = body_years[-1].group(1)
                        alt_keys = generate_ref_keys(author_text.replace(prefix_year, alt_year))
                        keys = list(set(keys + alt_keys))
                    if keys:
                        print(f"  🔄 Fallback keys from post-prefix text: {keys}")

            if not keys:
                print(f"  ⚠️ No keys generated for: {text[:60]}...")
                continue

            base_entry_id = keys[0]

            if base_entry_id not in seen_references:
                # First time seeing this base key
                if base_entry_id not in used_ids:
                    # ID is free — add normally
                    seen_references[base_entry_id] = {"text": text, "suffix_count": 0}
                    entry_id = base_entry_id
                else:
                    # ID was already taken by a collision suffix from a different base key
                    # Treat this as a new base that needs an immediate suffix
                    seen_references[base_entry_id] = {"text": text, "suffix_count": 0}
                    suffix_num = 1
                    while base_entry_id + chr(ord('a') + suffix_num) in used_ids:
                        suffix_num += 1
                    entry_id = base_entry_id + chr(ord('a') + suffix_num)
                    seen_references[base_entry_id]["suffix_count"] = suffix_num
                    print(f"  🔀 ID '{base_entry_id}' already taken by suffix — using {entry_id}")
            else:
                prev = seen_references[base_entry_id]
                # Compare content (first 60 alphanum chars, normalized) to detect true dupes vs collisions
                normalize = lambda t: re.sub(r'[^a-z0-9]', '', t.lower())[:60]
                if normalize(prev["text"]) == normalize(text):
                    # True duplicate — skip DOM/data, but still add keys
                    for key in keys:
                        bibliography_map[key] = base_entry_id if prev["suffix_count"] == 0 else base_entry_id + "a"
                    print(f"  ⏭️ Duplicate reference skipped (keys still added): {base_entry_id}")
                    continue
                else:
                    # Collision — different paper, same author+year
                    # Retroactively suffix the first entry if this is the first collision
                    if prev["suffix_count"] == 0:
                        old_id = base_entry_id
                        # Find a free suffix for the first entry
                        first_suffix = 0  # 'a'
                        while base_entry_id + chr(ord('a') + first_suffix) in used_ids:
                            first_suffix += 1
                        new_first_id = base_entry_id + chr(ord('a') + first_suffix)
                        # Update the first entry's anchor and references_data
                        first_anchor = soup.find("a", {"id": old_id, "class": "bib-entry"})
                        if first_anchor:
                            first_anchor["id"] = new_first_id
                            parent_p = first_anchor.find_parent('p')
                        else:
                            parent_p = None
                        for rd in references_data:
                            if rd["referenceId"] == old_id:
                                rd["referenceId"] = new_first_id
                                if first_anchor and parent_p:
                                    rd["content"] = str(parent_p)
                                break
                        # Remap bibliography_map entries pointing to old_id
                        for k, v in list(bibliography_map.items()):
                            if v == old_id:
                                bibliography_map[k] = new_first_id
                        used_ids.discard(old_id)
                        used_ids.add(new_first_id)
                        seen_references[base_entry_id]["suffix_count"] = first_suffix
                        print(f"  🔀 Collision detected! Retroactively suffixed first entry: {old_id} → {new_first_id}")

                    prev["suffix_count"] += 1
                    suffix = chr(ord('a') + prev["suffix_count"])
                    # Skip past any suffixes already taken
                    while base_entry_id + suffix in used_ids:
                        prev["suffix_count"] += 1
                        suffix = chr(ord('a') + prev["suffix_count"])
                    entry_id = base_entry_id + suffix
                    print(f"  🔀 Collision: assigned suffix → {entry_id}")

            used_ids.add(entry_id)

            # Add keys to bibliography_map
            for key in keys:
                bibliography_map[key] = entry_id
            # Add DOM anchor + references_data entry
            anchor_tag = soup.new_tag("a", attrs={"class": "bib-entry", "id": entry_id})
            p.insert(0, anchor_tag)
            references_data.append({"referenceId": entry_id, "content": str(p)})
            print(f"  🔑 Generated keys for reference: {keys} → {entry_id}")

        print(f"📚 Bibliography map has {len(bibliography_map)} entries: {list(bibliography_map.keys())[:10]}{'...' if len(bibliography_map) > 10 else ''}")
        print(f"Found and processed {len(references_data)} reference entries (kept in DOM).")

        # --- 1B: Process Footnotes (ROUTER-BASED) ---
        # Check if footnotes.json already exists (e.g., from epub_normalizer.py)
        # If so, use that instead of detecting footnotes ourselves
        existing_footnotes_path = os.path.join(output_dir, 'footnotes.json')
        if os.path.exists(existing_footnotes_path):
            try:
                with open(existing_footnotes_path, 'r', encoding='utf-8') as f:
                    existing_footnotes = json.load(f)
                if existing_footnotes and len(existing_footnotes) > 0:
                    print(f"--- Using existing footnotes.json ({len(existing_footnotes)} footnotes) ---")
                    all_footnotes_data = existing_footnotes
                    footnote_sections = []
                    sectioned_footnote_map = {}
                    all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
                    # Skip to node chunking
                    strategy = 'pre_processed'
                else:
                    strategy, strategy_info = analyze_document_structure(soup)
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Could not read existing footnotes.json: {e}")
                strategy, strategy_info = analyze_document_structure(soup)
        else:
            strategy, strategy_info = analyze_document_structure(soup)

        # Defaults so link_footnotes() can take all four maps unconditionally; the
        # linker only consults the one matching `strategy`, so non-matching branches
        # leaving these empty is behaviour-identical.
        global_footnote_map = {}
        sequential_footnote_map = {}

        if strategy == 'sequential':
            # Use sequential footnote processing (ref/def sections restart numbering)
            sequential_footnote_map, all_footnotes_data = process_sequential_footnotes(soup, book_id)
            sectioned_footnote_map = sequential_footnote_map
            footnotes_data = all_footnotes_data
            footnote_sections = []
            all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img', 'a'])
        elif strategy == 'whole_document':
            # Use simple whole-document footnote processing
            global_footnote_map, footnotes_data = process_whole_document_footnotes(soup, book_id)
            # CONFIDENCE GUARD (modus operandi: never a confident wrong link).
            # If the definition/marker numbering doesn't cleanly correspond, number
            # matching would drift and mislink — so keep the extracted note content
            # but drop the linking map. The body markers stay unlinked (honest)
            # rather than pointing at the wrong note (misleading).
            if global_footnote_map and not _footnote_numbering_is_linkable(global_footnote_map, soup):
                summary = _summarize_footnote_numbers(global_footnote_map)
                print(f"⚠️  Footnote numbering not cleanly alignable "
                      f"({summary}); suppressing "
                      f"number-based links to avoid confident mislinks. Notes still extracted.")
                ASSESSMENT.record(
                    module='footnote_linking_guard',
                    code_ref='process_document.py:_footnote_numbering_is_linkable',
                    decision='suppressed whole-document footnote links',
                    rationale=f'definition/marker numbering not cleanly alignable ({summary}); '
                              f'number-matching would drift — extract notes but emit no links',
                    evidence={'definition_numbers': summary},
                )
                global_footnote_map = {}
            sectioned_footnote_map = {'whole_document': global_footnote_map}
            all_footnotes_data = footnotes_data
            footnote_sections = []
            all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
        elif strategy != 'pre_processed':
            # Use section-aware footnote processing
            footnote_sections, all_elements = detect_footnote_sections(soup)
            sectioned_footnote_map = {}
            all_footnotes_data = []
    
        # Process traditional footnotes container first (skip if pre-processed)
        fn_container = soup.find('section', class_='footnotes')
        if fn_container and strategy != 'pre_processed':
            list_items = fn_container.find_all('li')
        
            for li in list_items:
                back_link = li.find('a', class_='footnote-back')
                if not back_link: continue

                href = back_link.get('href', '')
                id_match = re.search(r'#fnref(\d+)', href)
                if not id_match: continue
            
                identifier = id_match.group(1)

                # Generate unique footnote ID for traditional footnotes (shorter format without book prefix)
                random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
                unique_fn_id = f"Fn{int(time.time() * 1000)}_{random_suffix}"

                # Add anchor with unique ID and count attribute
                anchor_tag = soup.new_tag('a', id=unique_fn_id)
                anchor_tag['fn-count-id'] = identifier
                li.insert(0, anchor_tag)

                # Update the back-link to point to the unique in-text reference (same ID)
                back_link['href'] = f"#{unique_fn_id}"

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
                    'content': content,
                    'section_id': 'traditional'
                }
            
                all_footnotes_data.append({"footnoteId": unique_fn_id, "content": content})
        
            print(f"Unwrapping {len(list_items)} traditional footnote items to be processed as individual nodes.")
            fn_container.replace_with(*list_items)
    
        # Process sectioned footnotes with multi-paragraph support
        for section in footnote_sections:
            section_id = section['id']
            sectioned_footnote_map[section_id] = {}

            # Get the range of elements in this section's footnotes area
            fn_start_idx = section.get('footnotes_start_idx', 0)
            fn_end_idx = section.get('footnotes_end_idx', len(all_elements))

            # Get elements in the footnotes range
            section_elements = all_elements[fn_start_idx:fn_end_idx]

            # Find indices of footnote starts within this range
            footnote_starts = []
            for i, element in enumerate(section_elements):
                text = element.get_text().strip()
                if re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*\S|^\s*\[\^?\d+\]\s+[A-Z]', text):
                    footnote_starts.append(i)

            # Process each footnote with its continuation elements
            for j, start_idx in enumerate(footnote_starts):
                # End index is either next footnote start or end of section
                end_idx = footnote_starts[j + 1] if j + 1 < len(footnote_starts) else len(section_elements)

                # Get the first element (contains the marker)
                first_element = section_elements[start_idx]
                first_text = first_element.get_text().strip()

                # Extract footnote number from first element
                number_match = re.search(r'^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*)', first_text, re.DOTALL)
                if not number_match:
                    continue

                # Extract the digit from either group 2 or group 3
                identifier = number_match.group(2) or number_match.group(3)

                # Extract content from inner HTML to preserve <a>, <em> etc.
                first_inner_html = ''.join(str(c) for c in first_element.children)
                html_match = re.search(r'^\s*(\[\^?\d+\]|\^\d+)\s*[:.]\s*(.*)', first_inner_html, re.DOTALL)
                first_content = html_match.group(2).strip() if html_match else number_match.group(4).strip()

                # Collect content from all elements for this footnote
                content_parts = [first_content] if first_content else []

                # Add continuation elements (elements between this footnote and the next)
                # Stop at headings or horizontal rules (section boundaries)
                for elem in section_elements[start_idx + 1:end_idx]:
                    # Stop if we hit a heading or hr (section boundary)
                    if elem.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']:
                        break
                    elem_content = get_element_html_content(elem)
                    if elem_content and elem_content.strip():
                        content_parts.append(elem_content.strip())

                # Combine all content with HTML line breaks for multi-paragraph support
                full_content = '<br><br>'.join(content_parts) if len(content_parts) > 1 else (content_parts[0] if content_parts else '')

                print(f"Processing footnote {identifier} in section {section_id}: {full_content[:30]}... ({len(content_parts)} parts)")

                # Generate unique footnote ID with section prefix (shorter format without book prefix)
                random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
                unique_fn_id = f"s{section_id}_Fn{int(time.time() * 1000)}_{random_suffix}"

                # Add anchor with unique ID and section info to the first element
                anchor_tag = soup.new_tag('a', id=unique_fn_id)
                anchor_tag['fn-count-id'] = identifier
                anchor_tag['fn-section-id'] = section_id
                first_element.insert(0, anchor_tag)

                sectioned_footnote_map[section_id][identifier] = {
                    'unique_fn_id': unique_fn_id,
                    'content': full_content,
                    'section_id': section_id,
                    'element': first_element
                }

                all_footnotes_data.append({"footnoteId": unique_fn_id, "content": full_content})
    
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
        emit_progress(62, "doc_footnotes", f"Found {total_footnotes} footnotes across {len(footnote_sections)} sections")

        # ========================================================================
        # PASS 2: LINK ALL IN-TEXT MARKERS
        # ========================================================================
        emit_progress(68, "doc_linking", "Linking in-text citations")
        print("\n--- PASS 2: Linking All In-Text Markers ---")

        # --- 2A: Link References → conversion/citations.py ---
        citations_found, citations_linked, citations_unlinked = link_citations(
            soup, bibliography_map, emit_progress)


        # Citation linking summary
        emit_progress(75, "doc_linking", f"Linked {citations_linked} of {citations_found} citations")
        print(f"\n📖 Citation linking summary:")
        print(f"  - Total in-text citations found: {citations_found}")
        print(f"  - Successfully linked: {citations_linked}")
        print(f"  - Unlinked: {citations_found - citations_linked}")
        if citations_unlinked:
            print(f"  - All unlinked citations ({len(citations_unlinked)}):")
            for item in citations_unlinked:
                print(f"    • '{item['citation']}' → keys tried: {item['generated_keys']}")
        print(f"  - Bibliography map keys ({len(bibliography_map)}): {sorted(bibliography_map.keys())}")

        emit_progress(76, "doc_footnote_linking", "Linking footnote references")
        # --- 2B: Link Footnotes (STRATEGY-AWARE) → conversion/footnotes.py ---
        link_footnotes(soup, all_elements, strategy, global_footnote_map,
                       sequential_footnote_map, sectioned_footnote_map, footnote_sections)

        # ========================================================================
        # AUDIT PASS: Validate footnote linking
        # ========================================================================
        emit_progress(77, "doc_audit", "Validating footnote linking")
        print("\n--- AUDIT: Validating footnote linking ---")
        audit_data = compute_footnote_audit(soup, footnotes_data if 'footnotes_data' in dir() else all_footnotes_data)

        print(f"📊 Audit: {audit_data['total_refs']} refs, {audit_data['total_defs']} defs, "
              f"{len(audit_data['gaps'])} gaps, {len(audit_data['duplicates'])} duplicates, "
              f"{len(audit_data['unmatched_refs'])} unmatched refs, {len(audit_data['unmatched_defs'])} unmatched defs")
        _n_gaps, _n_uref, _n_udef = (len(audit_data['gaps']), len(audit_data['unmatched_refs']),
                                     len(audit_data['unmatched_defs']))
        ASSESSMENT.record(
            module='footnote_audit',
            code_ref='process_document.py:main (audit pass)',
            decision=('clean' if (_n_gaps == 0 and _n_uref == 0) else 'faulty'),
            rationale=(f"{audit_data['total_refs']} refs / {audit_data['total_defs']} defs; "
                       f"{_n_gaps} numbering gaps, {_n_uref} unmatched refs, {_n_udef} unmatched defs"),
            evidence={'total_refs': audit_data['total_refs'], 'total_defs': audit_data['total_defs'],
                      'gaps': _n_gaps, 'unmatched_refs': _n_uref, 'unmatched_defs': _n_udef},
        )

        # Annotate audit with mojibake warnings + segment info pulled from footnote_meta.json
        audit_data['font_encoding_warnings'] = footnote_warnings
        audit_data['segment_boundaries'] = segment_boundaries

        # Write audit.json
        os.makedirs(output_dir, exist_ok=True)
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (standard path)
        # Determine citation style from what was detected
        if len(references_data) > 0 and citations_found > 0:
            citation_style = 'author-year-bracket'
        elif len(references_data) > 0:
            citation_style = 'bibliography-only'
        else:
            citation_style = 'none'

        conversion_stats = {
            'references_found': len(references_data),
            'citations_total': citations_found,
            'citations_linked': citations_linked,
            'footnotes_matched': len(all_footnotes_data),
            'footnote_strategy': strategy,
            'citation_style': citation_style,
            'font_encoding_warning_count': len(footnote_warnings),
            'segment_count': len(segment_boundaries) + 1 if segment_boundaries else 1,
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

    # ========================================================================
    # PASS 3: GENERATE FINAL JSON OUTPUT
    # ========================================================================
    emit_progress(78, "doc_json_gen", "Building node chunks")
    print("\n--- PASS 3: Generating Final JSON Output ---")
    # Use the passed book_id parameter instead of generating a new one
    node_chunks_data = []
    start_line_counter = 0
    CHUNK_SIZE = 50
    content_root = soup.body if soup.body else soup

    # Rewrite bare image src to servable route path: img-1.jpeg → /{book_id}/media/img-1.jpeg
    # Also inject width/height from file on disk to prevent layout shift
    for img_tag in content_root.find_all('img'):
        src = img_tag.get('src', '')
        if src and not src.startswith('/') and not src.startswith('http'):
            # Inject dimensions from file on disk before rewriting src
            img_path = os.path.join(output_dir, 'media', src)
            try:
                with PILImage.open(img_path) as pil_img:
                    w, h = pil_img.size
                    img_tag['width'] = str(w)
                    img_tag['height'] = str(h)
            except Exception:
                pass  # image missing or unreadable — skip silently
            img_tag['src'] = f'/{book_id}/media/{src}'

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
        
        # Also remove class attributes from all nested elements EXCEPT functional classes
        preserved_classes = {'in-text-citation', 'footnote-ref', 'bib-entry', 'pageNumber'}
        for nested_element in node.find_all():
            if nested_element.has_attr('class'):
                # Keep only functional classes, remove styling classes
                element_classes = nested_element.get('class', [])
                if isinstance(element_classes, str):
                    element_classes = element_classes.split()
                functional_classes = [c for c in element_classes if c in preserved_classes]
                if functional_classes:
                    nested_element['class'] = functional_classes
                else:
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
        
        references_in_node = []
        for a in node.find_all('a', class_='in-text-citation'):
            data_refs = a.get('data-refs')
            if data_refs:
                references_in_node.extend(data_refs.split(','))
            else:
                references_in_node.append(a['href'].lstrip('#'))
        # Extract footnote IDs and markers from sup elements
        # Store as objects {id, marker} to support non-numeric markers (*, 23a, etc.)
        # This enables dynamic renumbering for numeric footnotes while preserving symbolic markers
        footnotes_in_node = []
        for sup in node.find_all('sup'):
            # Get marker from fn-count-id attribute
            marker = sup.get('fn-count-id', '')
            # New format: sup has id directly and class="footnote-ref"
            if sup.get('class') and 'footnote-ref' in sup.get('class', []):
                footnote_id = sup.get('id', '')
                if footnote_id:
                    footnotes_in_node.append({'id': footnote_id, 'marker': marker})
            else:
                # Old format: anchor inside sup with class="footnote-ref"
                fn_link = sup.find('a', class_='footnote-ref')
                if fn_link and fn_link.get('href'):
                    footnote_id = fn_link['href'].lstrip('#')
                    if footnote_id:
                        footnotes_in_node.append({'id': footnote_id, 'marker': marker})
        node_object = {
            "id": node_key, "book": book_id, "chunk_id": chunk_id, 
            "startLine": start_line_counter, "content": str(node), 
            "references": references_in_node, "footnotes": footnotes_in_node, 
            "hypercites": [], "hyperlights": [],
            "plainText": node.get_text(strip=True),
            "type": node.name if hasattr(node, 'name') else 'p'
        }
        node_chunks_data.append(node_object)

    emit_progress(80, "doc_sanitize", "Sanitizing output")
    print("\n--- Sanitizing and writing JSON output files ---")
    os.makedirs(output_dir, exist_ok=True)

    # Security: Sanitize all HTML content before writing to JSON
    sanitized_references = [
        {"referenceId": r.get("referenceId", ""), "content": sanitize_html(r.get("content", ""))}
        for r in references_data
    ]
    sanitized_footnotes = [
        {"footnoteId": f.get("footnoteId", ""), "content": sanitize_html(f.get("content", ""))}
        for f in footnotes_data
    ]
    total_nodes = len(node_chunks_data)
    sanitized_nodes = []
    for i, node in enumerate(node_chunks_data):
        sanitized_node = node.copy()
        sanitized_node["content"] = sanitize_html(node.get("content", ""))
        sanitized_nodes.append(sanitized_node)
        if (i + 1) % 5000 == 0:
            emit_progress(80 + int((i / total_nodes) * 4), "doc_sanitize", f"Sanitized {i + 1} / {total_nodes} nodes")

    emit_progress(84, "doc_json_write", "Writing output files")

    # Preserve a populated references.json written by an upstream step in the same
    # run (e.g. ar5iv_preprocessor.py translates LaTeXML bibitems into Hyperlit's
    # bib shape before process_document.py runs). Only fall back to our own
    # extracted references when no usable file already exists. The import pipeline
    # deletes references.json at the start of every import/reconvert, so a file
    # present here was written deliberately this run. Mirrors the guard the legacy
    # html_footnote_processor.py applied on the old HTML path.
    references_path = os.path.join(output_dir, 'references.json')
    existing_refs = None
    if os.path.exists(references_path):
        try:
            with open(references_path, 'r', encoding='utf-8') as f:
                existing_refs = json.load(f)
        except Exception:
            existing_refs = None
    if isinstance(existing_refs, list) and existing_refs:
        print(f"Keeping existing references.json with {len(existing_refs)} entries")
    else:
        with open(references_path, 'w', encoding='utf-8') as f:
            json.dump(sanitized_references, f, ensure_ascii=False)
        print(f"Successfully created {references_path}")

    # Write footnotes as JSONL for memory-efficient PHP streaming
    footnotes_path = os.path.join(output_dir, 'footnotes.jsonl')
    with open(footnotes_path, 'w', encoding='utf-8') as f:
        for fn in sanitized_footnotes:
            f.write(json.dumps(fn, ensure_ascii=False) + '\n')
    print(f"Successfully created {footnotes_path}")

    # Write nodes as JSONL (one JSON object per line) for memory-efficient PHP streaming
    nodes_path = os.path.join(output_dir, 'nodes.jsonl')
    with open(nodes_path, 'w', encoding='utf-8') as f:
        for node in sanitized_nodes:
            f.write(json.dumps(node, ensure_ascii=False) + '\n')
    print(f"Successfully created {nodes_path}")
    emit_progress(85, "doc_json_written", f"Written {len(sanitized_nodes)} nodes, {len(sanitized_footnotes)} footnotes, {len(sanitized_references)} references")

    # Decision-trace: what the pipeline decided, in which module, and why.
    ASSESSMENT.dump(output_dir)
    print(f"Successfully created {os.path.join(output_dir, 'assessment.json')} ({len(ASSESSMENT.records)} records)")

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
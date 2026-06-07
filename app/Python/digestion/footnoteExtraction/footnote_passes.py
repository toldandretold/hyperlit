"""Digestion — footnote-EXTRACTION DocPasses (whole-document / sectioned strategies + map flattening).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
from bs4 import BeautifulSoup
from shared.pipeline_base import DocPass
from digestion._doc_shared import emit_progress
from shared.sanitize import get_element_html_content
import random
import re
import string
import time


class TraditionalFootnotes(DocPass):
    name = 'traditional_footnotes'
    description = '[standard] Unwrap a <section class="footnotes"> container into individually-processed notes.'

    def apply(self, ctx):
        if ctx.is_stem:
            return
        soup = ctx.soup
        # Process traditional footnotes container first (skip if pre-processed)
        fn_container = soup.find('section', class_='footnotes')
        if fn_container and ctx.strategy != 'pre_processed':
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
                if 'traditional' not in ctx.sectioned_footnote_map:
                    ctx.sectioned_footnote_map['traditional'] = {}

                ctx.sectioned_footnote_map['traditional'][identifier] = {
                    'unique_fn_id': unique_fn_id,
                    'content': content,
                    'section_id': 'traditional'
                }

                ctx.all_footnotes_data.append({"footnoteId": unique_fn_id, "content": content})

            print(f"Unwrapping {len(list_items)} traditional footnote items to be processed as individual nodes.")
            fn_container.replace_with(*list_items)


class SectionedFootnotes(DocPass):
    name = 'sectioned_footnotes'
    description = '[standard] Extract per-section footnotes with multi-paragraph continuation support.'

    def apply(self, ctx):
        if ctx.is_stem:
            return
        soup = ctx.soup
        all_elements = ctx.all_elements
        # Process sectioned footnotes with multi-paragraph support
        for section in ctx.footnote_sections:
            section_id = section['id']
            ctx.sectioned_footnote_map[section_id] = {}

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

                ctx.sectioned_footnote_map[section_id][identifier] = {
                    'unique_fn_id': unique_fn_id,
                    'content': full_content,
                    'section_id': section_id,
                    'element': first_element
                }

                ctx.all_footnotes_data.append({"footnoteId": unique_fn_id, "content": full_content})


class FlattenFootnoteMap(DocPass):
    name = 'flatten_footnote_map'
    description = '[standard] Flatten the per-section footnote maps into one keyed map + count totals.'

    def apply(self, ctx):
        if ctx.is_stem:
            return
        # Create flattened map for backward compatibility
        footnote_map = {}
        for section_id, section_footnotes in ctx.sectioned_footnote_map.items():
            for identifier, footnote_data in section_footnotes.items():
                # Use section-prefixed key to avoid conflicts
                map_key = f"{section_id}_{identifier}" if section_id != 'traditional' else identifier
                footnote_map[map_key] = footnote_data
        ctx.footnote_map = footnote_map

        ctx.footnotes_data = ctx.all_footnotes_data
        total_footnotes = sum(len(section_footnotes) for section_footnotes in ctx.sectioned_footnote_map.values())
        print(f"Found and extracted {total_footnotes} footnote definitions across {len(ctx.footnote_sections)} sections.")
        emit_progress(62, "doc_footnotes", f"Found {total_footnotes} footnotes across {len(ctx.footnote_sections)} sections")

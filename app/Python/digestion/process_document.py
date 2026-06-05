"""Digestion orchestrator — runs the DOC_PASSES pipeline over the ingested HTML.

Extract bibliography → select footnote strategy → extract + link footnotes/citations → audit → emit
nodes/footnotes/references. main() is a thin shell over the ordered DOC_PASSES registry.
"""
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
from shared.assessment import Assessment, ASSESSMENT
# Pure citation-key + reference-detection logic (unit-tested in tests/conversion/unit/).
from shared.refkeys import generate_ref_keys, normalize_unicode_name, is_likely_reference
# Footnote-strategy selection + numbering-linkability guard + bibliography-heading regex.
from digestion.strategySelection.strategy import (
    analyze_document_structure, detect_footnote_sections,
    _footnote_numbering_is_linkable, _summarize_footnote_numbers, _BIBLIOGRAPHY_HEADING_RE,
)
# HTML sanitization + inner-HTML extraction (security plumbing).
from shared.sanitize import sanitize_html, get_element_html_content
# Footnote extraction by strategy (whole-document, sequential).
from digestion.footnoteExtraction.footnotes import process_whole_document_footnotes, process_sequential_footnotes, link_footnotes
# Citation linking (PASS 2A): wrap (Author Year) / [Author Year] in in-text-citations.
from digestion.citationLinking.citations import link_citations
# Bibliography extraction (PASS 1A): builds the key->entry_id map the citation linker uses.
from digestion.bibliographyExtraction.bibliography import extract_bibliography
# Footnote-linking audit (gaps / duplicates / unmatched refs+defs).
from digestion.finalAudit.audit import compute_footnote_audit, assess_link_fidelity
# Ordered orchestration registry — main() is now a thin shell over DOC_PASSES (see below).
from shared.pipeline_base import DocPass, run_passes


def emit_progress(pct, stage, detail=""):
    """Emit a machine-readable progress line for the PHP job runner."""
    print("PROGRESS:" + json.dumps({"percent": pct, "stage": stage, "detail": detail}), flush=True)


# --- UTILITY FUNCTIONS ---


# ===========================================================================
# The pipeline as an ordered registry of DocPass units threading a DocContext.
# main() was a single ~618-line function; each phase is now a small, guarded,
# independently-testable pass. ORDER MATTERS (the registry list IS the order):
# the id-generation sequence (time/random) must match the monolith for byte-
# identical output, and extract precedes link precedes audit. A new conversion
# step is absorbed by ADDING a pass (op:add + op:register into DOC_PASSES),
# never by editing this orchestration. See conversion/pipeline_base.py.
# ===========================================================================
class DocContext:
    """Shared state threaded through the conversion passes — the same locals the monolithic main()
    carried. Everything is defaulted so the always-run passes (node-gen, sanitize/write) never hit an
    unset branch variable, regardless of which branch (STEM vs standard) ran upstream."""

    def __init__(self, html_file_path, output_dir, book_id):
        self.html_file_path = html_file_path
        self.output_dir = output_dir
        self.book_id = book_id
        self.soup = None
        # STEM / footnote-meta signals
        self.is_stem = False
        self.footnote_warnings = []
        self.segment_boundaries = []
        # PASS 1 outputs
        self.bibliography_map = {}
        self.references_data = []
        self.footnotes_data = []
        self.all_footnotes_data = []
        self.strategy = None
        self.strategy_info = None
        self.all_elements = []
        self.global_footnote_map = {}
        self.sequential_footnote_map = {}
        self.sectioned_footnote_map = {}
        self.footnote_sections = []
        self.footnote_map = {}
        # PASS 2 outputs
        self.citations_found = 0
        self.citations_linked = 0
        self.citations_unlinked = []
        # AUDIT
        self.audit_data = None
        # PASS 3
        self.node_chunks_data = []


class LoadDocument(DocPass):
    name = 'load_document'
    description = 'Seed the assessment trace, parse the HTML, and read footnote_meta.json (STEM signals).'

    def apply(self, ctx):
        ASSESSMENT.reset(ctx.output_dir)
        emit_progress(48, "doc_parse", "Parsing HTML document")
        with open(ctx.html_file_path, "r", encoding="utf-8") as f:
            ctx.soup = BeautifulSoup(f, "html.parser")

        # Check if this is a STEM bibliography-style document
        footnote_meta_path = os.path.join(ctx.output_dir, 'footnote_meta.json')
        if os.path.exists(footnote_meta_path):
            with open(footnote_meta_path, 'r') as f:
                footnote_meta = json.load(f)
                ctx.is_stem = footnote_meta.get('classification') == 'wackSTEMbibliographyNotes'
                ctx.footnote_warnings = footnote_meta.get('footnote_warnings', []) or []
                ctx.segment_boundaries = footnote_meta.get('segment_boundaries', []) or []
        if ctx.is_stem:
            print("📐 STEM bibliography mode detected — using wackSTEM marker conversion")


class SafariRtlFix(DocPass):
    name = 'safari_rtl_fix'
    description = 'Strip <span dir="rtl"> smart-quote spans that freeze Safari bidi analysis.'

    def apply(self, ctx):
        # ====================================================================
        # SAFARI FIX: Remove RTL spans that cause findTextSamplesByVisualExamination lag
        # Pandoc generates <span dir="rtl">'</span> for smart quotes from DOCX
        # These trigger Safari's bidirectional text analysis and freeze the browser
        # ====================================================================
        soup = ctx.soup
        rtl_spans = soup.find_all('span', attrs={'dir': 'rtl'})
        for span in rtl_spans:
            # Replace the span with just its text content (the quote character)
            span.replace_with(span.get_text())
        if rtl_spans:
            print(f"🔧 SAFARI FIX: Removed {len(rtl_spans)} RTL spans from document")


class SplitBibliographyParagraphs(DocPass):
    name = 'split_bibliography_paragraphs'
    description = 'Split multi-entry reference paragraphs (newline-crammed PDF bibliographies) into one <p> each.'

    def apply(self, ctx):
        # ====================================================================
        # PRE-PROCESS: Split multi-entry bibliography paragraphs
        # ====================================================================
        # PDF conversion sometimes crams many reference entries into a single <p>,
        # separated by newlines. Split these so each entry gets its own <p>.
        soup = ctx.soup
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


class StemBibliography(DocPass):
    name = 'stem_bibliography'
    description = '[STEM only] Convert wackSTEM markers to bib-entry/in-text-citation; write audit + stats.'
    plain = ('The backend half of the wackSTEM path: the numbered [1] markers + reference list (wrapped '
             'by the PDF frontend) become bib-entries and in-text citations. A terminal branch — the '
             'normal footnote passes are skipped for STEM docs.')

    def apply(self, ctx):
        # ====================================================================
        # STEM BIBLIOGRAPHY PROCESSING (wackSTEMbibliographyNotes)
        # ====================================================================
        if not ctx.is_stem:
            return
        soup = ctx.soup
        output_dir = ctx.output_dir
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
            'font_encoding_warnings': ctx.footnote_warnings,
            'segment_boundaries': ctx.segment_boundaries,
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
            'font_encoding_warning_count': len(ctx.footnote_warnings),
            'segment_count': len(ctx.segment_boundaries) + 1 if ctx.segment_boundaries else 1,
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

        ctx.references_data = references_data
        ctx.footnotes_data = footnotes_data
        ctx.all_footnotes_data = all_footnotes_data


class ExtractBibliography(DocPass):
    name = 'extract_bibliography'
    description = '[standard] PASS 1A — build the bibliography key→entry-id map + references data.'
    plain = ('Find the reference list and give each entry an id, so in-text citations have something to '
             'point at. If citations do not link, suspect THIS (the link targets are missing) before '
             'blaming the citation linker.')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        # ====================================================================
        # PASS 1: EXTRACT ALL DEFINITIONS
        # ====================================================================
        emit_progress(52, "doc_bibliography", "Scanning for bibliography")
        print("--- PASS 1: Extracting All Definitions ---")

        # --- 1A: Process Bibliography / References → conversion/bibliography.py ---
        ctx.bibliography_map, ctx.references_data = extract_bibliography(ctx.soup)


class SelectFootnoteStrategy(DocPass):
    name = 'select_footnote_strategy'
    description = '[standard] PASS 1B — pick the footnote strategy + run its extraction setup (maps, elements).'
    plain = ('Now it is HTML — are the footnotes one continuous end-list (whole_document), restarting '
             'per section (sectioned), or none? This decides HOW markers get wired to definitions. '
             'Includes a linkability guard: if the numbering looks scrambled, keep the notes but emit NO '
             'links — a missing link beats a confident-wrong one.')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        soup = ctx.soup
        book_id = ctx.book_id
        output_dir = ctx.output_dir

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
                    ctx.all_footnotes_data = existing_footnotes
                    ctx.footnote_sections = []
                    ctx.sectioned_footnote_map = {}
                    ctx.all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
                    # Skip to node chunking
                    ctx.strategy = 'pre_processed'
                else:
                    ctx.strategy, ctx.strategy_info = analyze_document_structure(soup)
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Could not read existing footnotes.json: {e}")
                ctx.strategy, ctx.strategy_info = analyze_document_structure(soup)
        else:
            ctx.strategy, ctx.strategy_info = analyze_document_structure(soup)

        # Defaults so link_footnotes() can take all four maps unconditionally; the
        # linker only consults the one matching `strategy`, so non-matching branches
        # leaving these empty is behaviour-identical.
        ctx.global_footnote_map = {}
        ctx.sequential_footnote_map = {}

        if ctx.strategy == 'sequential':
            # Use sequential footnote processing (ref/def sections restart numbering)
            ctx.sequential_footnote_map, ctx.all_footnotes_data = process_sequential_footnotes(soup, book_id)
            ctx.sectioned_footnote_map = ctx.sequential_footnote_map
            ctx.footnotes_data = ctx.all_footnotes_data
            ctx.footnote_sections = []
            ctx.all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img', 'a'])
        elif ctx.strategy == 'whole_document':
            # Use simple whole-document footnote processing
            ctx.global_footnote_map, ctx.footnotes_data = process_whole_document_footnotes(soup, book_id)
            # CONFIDENCE GUARD (modus operandi: never a confident wrong link).
            # If the definition/marker numbering doesn't cleanly correspond, number
            # matching would drift and mislink — so keep the extracted note content
            # but drop the linking map. The body markers stay unlinked (honest)
            # rather than pointing at the wrong note (misleading).
            # The fork (link vs suppress) is recorded to assessment.json inside
            # _footnote_numbering_is_linkable itself (both outcomes, with the guard
            # that fired). Here we just act on the verdict.
            if ctx.global_footnote_map and not _footnote_numbering_is_linkable(ctx.global_footnote_map, soup):
                summary = _summarize_footnote_numbers(ctx.global_footnote_map)
                print(f"⚠️  Footnote numbering not cleanly alignable "
                      f"({summary}); suppressing "
                      f"number-based links to avoid confident mislinks. Notes still extracted.")
                ctx.global_footnote_map = {}
            ctx.sectioned_footnote_map = {'whole_document': ctx.global_footnote_map}
            ctx.all_footnotes_data = ctx.footnotes_data
            ctx.footnote_sections = []
            ctx.all_elements = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'li', 'hr', 'table', 'blockquote', 'pre', 'ul', 'ol', 'figure', 'img'])
        elif ctx.strategy != 'pre_processed':
            # Use section-aware footnote processing
            ctx.footnote_sections, ctx.all_elements = detect_footnote_sections(soup)
            ctx.sectioned_footnote_map = {}
            ctx.all_footnotes_data = []


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


class LinkCitationsPass(DocPass):
    name = 'link_citations'
    description = '[standard] PASS 2A — wrap (Author Year) / [Author Year] in-text citations.'
    plain = ('Turn each in-text "(Author Year)" into a clickable link to its bibliography entry. Links '
             'only when a matching entry was extracted — 0/N against a near-empty bibliography is '
             'usually a non-problem (those were not real citations), not a bug.')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        # ====================================================================
        # PASS 2: LINK ALL IN-TEXT MARKERS
        # ====================================================================
        emit_progress(68, "doc_linking", "Linking in-text citations")
        print("\n--- PASS 2: Linking All In-Text Markers ---")

        # --- 2A: Link References → conversion/citations.py ---
        ctx.citations_found, ctx.citations_linked, ctx.citations_unlinked = link_citations(
            ctx.soup, ctx.bibliography_map, emit_progress)

        # Citation linking summary
        emit_progress(75, "doc_linking", f"Linked {ctx.citations_linked} of {ctx.citations_found} citations")
        print(f"\n📖 Citation linking summary:")
        print(f"  - Total in-text citations found: {ctx.citations_found}")
        print(f"  - Successfully linked: {ctx.citations_linked}")
        print(f"  - Unlinked: {ctx.citations_found - ctx.citations_linked}")
        if ctx.citations_unlinked:
            print(f"  - All unlinked citations ({len(ctx.citations_unlinked)}):")
            for item in ctx.citations_unlinked:
                print(f"    • '{item['citation']}' → keys tried: {item['generated_keys']}")
        print(f"  - Bibliography map keys ({len(ctx.bibliography_map)}): {sorted(ctx.bibliography_map.keys())}")


class LinkFootnotesPass(DocPass):
    name = 'link_footnotes'
    description = '[standard] PASS 2B — wire in-text footnote markers to their definitions (strategy-aware).'
    plain = ('Wire each in-text footnote marker to its definition (strategy-aware). A marker links only '
             'if its definition was DETECTED and the marker SURVIVED — a definition absent from the '
             'input can never be linked here, so look upstream (extraction / the frontend).')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        emit_progress(76, "doc_footnote_linking", "Linking footnote references")
        # --- 2B: Link Footnotes (STRATEGY-AWARE) → conversion/footnotes.py ---
        link_footnotes(ctx.soup, ctx.all_elements, ctx.strategy, ctx.global_footnote_map,
                       ctx.sequential_footnote_map, ctx.sectioned_footnote_map, ctx.footnote_sections)


class AuditPass(DocPass):
    name = 'audit'
    description = '[standard] Validate footnote linking (gaps/unmatched), record the VERDICT, write audit + stats.'
    plain = ('The final report card: did every footnote marker find its definition, with no gaps or '
             'leftover orphans? Records the verdict the fix-loop reacts to. Note: per-chapter numbering '
             'gaps are EXPECTED in renumbered books — a "faulty" stamp on those is over-flagging, not a '
             'real linking failure.')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        soup = ctx.soup
        output_dir = ctx.output_dir
        # ====================================================================
        # AUDIT PASS: Validate footnote linking
        # ====================================================================
        emit_progress(77, "doc_audit", "Validating footnote linking")
        print("\n--- AUDIT: Validating footnote linking ---")
        audit_data = compute_footnote_audit(soup, ctx.footnotes_data)

        print(f"📊 Audit: {audit_data['total_refs']} refs, {audit_data['total_defs']} defs, "
              f"{len(audit_data['gaps'])} gaps, {len(audit_data['duplicates'])} duplicates, "
              f"{len(audit_data['unmatched_refs'])} unmatched refs, {len(audit_data['unmatched_defs'])} unmatched defs")
        _n_gaps, _n_uref, _n_udef = (len(audit_data['gaps']), len(audit_data['unmatched_refs']),
                                     len(audit_data['unmatched_defs']))
        _n_dup = len(audit_data['duplicates'])
        _faults = _n_gaps + _n_uref + _n_udef
        _total = audit_data['total_refs'] + audit_data['total_defs']
        # The VERDICT (did the chosen path work?) — the second half of the diagnostic loop
        # alongside the strategy/linking forks. Falsifiable: names WHICH refs/defs are unmatched.
        ASSESSMENT.record(
            module='footnote_audit',
            code_ref='audit.py:compute_footnote_audit',
            node_help=self.plain,
            decision=('clean' if (_n_gaps == 0 and _n_uref == 0) else 'faulty'),
            rationale=(f"{audit_data['total_refs']} refs / {audit_data['total_defs']} defs; "
                       f"{_n_gaps} numbering gaps, {_n_uref} unmatched refs, {_n_udef} unmatched defs"),
            evidence={'total_refs': audit_data['total_refs'], 'total_defs': audit_data['total_defs'],
                      'gaps': _n_gaps, 'unmatched_refs': _n_uref, 'unmatched_defs': _n_udef,
                      'duplicates': _n_dup,
                      'gap_sample': [g.get('missing') for g in audit_data['gaps'][:8]],
                      'unmatched_ref_sample': [u.get('ref_id') for u in audit_data['unmatched_refs'][:8]],
                      'unmatched_def_sample': [u.get('footnote_id') for u in audit_data['unmatched_defs'][:8]]},
            question='Did the footnote linking produce a clean ref/def correspondence? (the VERDICT)',
            confidence=round(1.0 if not _total else max(0.0, 1 - _faults / max(_total, 1)), 2),
            margin=('no gaps or unmatched markers — footnote linking is sound' if not _faults
                    else f'{_n_uref} marker(s) with no definition + {_n_udef} definition(s) never '
                         f'referenced + {_n_gaps} numbering gap(s) — cross-check the linker/extractor'),
        )

        # Annotate audit with mojibake warnings + segment info pulled from footnote_meta.json
        audit_data['font_encoding_warnings'] = ctx.footnote_warnings
        audit_data['segment_boundaries'] = ctx.segment_boundaries
        ctx.audit_data = audit_data

        # Write audit.json
        os.makedirs(output_dir, exist_ok=True)
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (standard path)
        # Determine citation style from what was detected
        if len(ctx.references_data) > 0 and ctx.citations_found > 0:
            citation_style = 'author-year-bracket'
        elif len(ctx.references_data) > 0:
            citation_style = 'bibliography-only'
        else:
            citation_style = 'none'

        conversion_stats = {
            'references_found': len(ctx.references_data),
            'citations_total': ctx.citations_found,
            'citations_linked': ctx.citations_linked,
            'footnotes_matched': len(ctx.all_footnotes_data),
            'footnote_strategy': ctx.strategy,
            'citation_style': citation_style,
            'font_encoding_warning_count': len(ctx.footnote_warnings),
            'segment_count': len(ctx.segment_boundaries) + 1 if ctx.segment_boundaries else 1,
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

        # Cross-stage "whose bug is it": when a late symptom (0 citations / 0 footnote markers linked) was
        # caused UPSTREAM, record a flagged fork naming the upstream stage — so the fix-loop is sent there,
        # not the linker. Diagnostic-only (records to the trace; no soup/output change). Conservative: a
        # deliberate guard-suppression is not flagged. `ASSESSMENT.records` spans ingestion+digestion.
        for _fork in assess_link_fidelity(conversion_stats, audit_data, ASSESSMENT.records):
            ASSESSMENT.record(**_fork)


class GenerateNodeChunks(DocPass):
    name = 'generate_node_chunks'
    description = 'PASS 3 — walk the body into node chunks (numeric ids, extracted refs/footnotes, images).'

    def apply(self, ctx):
        soup = ctx.soup
        output_dir = ctx.output_dir
        book_id = ctx.book_id
        # ====================================================================
        # PASS 3: GENERATE FINAL JSON OUTPUT
        # ====================================================================
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

        ctx.node_chunks_data = node_chunks_data


class SanitizeAndWrite(DocPass):
    name = 'sanitize_and_write'
    description = 'Sanitize all HTML + write references.json / footnotes.jsonl / nodes.jsonl + dump the assessment.'

    def apply(self, ctx):
        output_dir = ctx.output_dir
        node_chunks_data = ctx.node_chunks_data
        references_data = ctx.references_data
        footnotes_data = ctx.footnotes_data

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


# Ordered registry — the conversion sequence main() ran top-to-bottom. ORDER MATTERS (id-generation
# sequence + extract→link→audit dependency). A new conversion step is absorbed by ADDING a pass here.
DOC_PASSES = [
    LoadDocument(),
    SafariRtlFix(),
    SplitBibliographyParagraphs(),
    StemBibliography(),
    ExtractBibliography(),
    SelectFootnoteStrategy(),
    TraditionalFootnotes(),
    SectionedFootnotes(),
    FlattenFootnoteMap(),
    LinkCitationsPass(),
    LinkFootnotesPass(),
    AuditPass(),
    GenerateNodeChunks(),
    SanitizeAndWrite(),
]


# --- MAIN PROCESSING LOGIC ---

def main(html_file_path, output_dir, book_id):
    """Thin shell — build a DocContext and run the ordered DOC_PASSES registry. The conversion logic
    lives in the DocPass units above; this preserves the CLI contract (same args, byte-identical
    output) the PHP jobs + vibe loop invoke."""
    ctx = DocContext(html_file_path, output_dir, book_id)
    run_passes(DOC_PASSES, ctx)


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

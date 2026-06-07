"""Digestion — BIBLIOGRAPHY-extraction DocPasses (the STEM numeric-ref branch + the standard author-year extract).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
from shared.pipeline_base import DocPass
from digestion._doc_shared import _detect_file_type
from digestion._doc_shared import emit_progress
from digestion.bibliographyExtraction.bibliography import extract_bibliography
import json
import os
import re


class StemBibliography(DocPass):
    name = 'stem_bibliography'
    description = '[STEM only] Convert wackSTEM markers to bib-entry/in-text-citation; write audit + stats.'
    plain = ('The digestion half of the wackSTEM path: the numbered [1] markers + reference list (wrapped '
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
            'file_type': _detect_file_type(output_dir),
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

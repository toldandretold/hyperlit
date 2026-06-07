"""Digestion — LOAD / input prep (the first DocPasses). Parse the ingested HTML + seed the
assessment trace + read footnote_meta.json STEM signals (LoadDocument), strip Safari rtl
smart-quote spans (SafariRtlFix), and split newline-crammed multi-entry reference paragraphs
into one <p> each (SplitBibliographyParagraphs). Cheap prep before bibliography/footnote work.
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
import json
import os
import re
from bs4 import BeautifulSoup
from shared.assessment import ASSESSMENT
from shared.pipeline_base import DocPass
from digestion._doc_shared import emit_progress


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

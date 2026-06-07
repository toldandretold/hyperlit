"""Digestion — footnote-STRATEGY-selection DocPass (analyze structure -> STRATEGY_RULES; sets the extract path).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
from shared.pipeline_base import DocPass
from digestion.strategySelection.strategy import _footnote_numbering_is_linkable
from digestion.strategySelection.strategy import _summarize_footnote_numbers
from digestion.strategySelection.strategy import analyze_document_structure
from digestion.strategySelection.strategy import detect_footnote_sections
import json
import os
from digestion.footnoteExtraction.footnotes import process_sequential_footnotes
from digestion.footnoteExtraction.footnotes import process_whole_document_footnotes


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

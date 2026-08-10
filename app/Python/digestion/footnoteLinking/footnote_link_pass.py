"""Digestion — footnote-LINKING DocPass (link markers to definitions via MARKER_LINK_RULES).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
import json
import os

from shared.pipeline_base import DocPass
from digestion._doc_shared import emit_progress
from digestion.footnoteExtraction.footnotes import link_footnotes


class LinkFootnotesPass(DocPass):
    name = 'link_footnotes'
    description = '[standard] PASS 2B — wire in-text footnote markers to their definitions (strategy-aware).'
    plain = ('Wire each in-text footnote marker to its definition (strategy-aware). A marker links only '
             'if its definition was DETECTED and the marker SURVIVED — a definition absent from the '
             'input can never be linked here, so look upstream (extraction / the frontend).')

    def apply(self, ctx):
        if ctx.is_stem and not getattr(ctx, 'stem_caret_footnotes', False):
            return   # STEM hybrid keeps the footnote passes ON for its real [^N] footnotes
        emit_progress(76, "doc_footnote_linking", "Linking footnote references")
        # --- 2B: Link Footnotes (STRATEGY-AWARE) → conversion/footnotes.py ---
        link_footnotes(ctx.soup, ctx.all_elements, ctx.strategy, ctx.global_footnote_map,
                       ctx.sequential_footnote_map, ctx.sectioned_footnote_map, ctx.footnote_sections)

        # STEM hybrid: StemBibliography already wrote conversion_stats with footnotes_matched
        # hardcoded 0 (its branch is terminal for CITATIONS and normally has no footnotes).
        # The footnote passes just ran on the hybrid's real [^N] footnotes — patch the count.
        if ctx.is_stem and getattr(ctx, 'stem_caret_footnotes', False):
            stats_path = os.path.join(ctx.output_dir, 'conversion_stats.json')
            if os.path.isfile(stats_path):
                stats = json.load(open(stats_path))
                stats['footnotes_matched'] = len(ctx.all_footnotes_data or [])
                with open(stats_path, 'w', encoding='utf-8') as f:
                    json.dump(stats, f, ensure_ascii=False, indent=4)

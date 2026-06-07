"""Digestion — footnote-LINKING DocPass (link markers to definitions via MARKER_LINK_RULES).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
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
        if ctx.is_stem:
            return
        emit_progress(76, "doc_footnote_linking", "Linking footnote references")
        # --- 2B: Link Footnotes (STRATEGY-AWARE) → conversion/footnotes.py ---
        link_footnotes(ctx.soup, ctx.all_elements, ctx.strategy, ctx.global_footnote_map,
                       ctx.sequential_footnote_map, ctx.sectioned_footnote_map, ctx.footnote_sections)

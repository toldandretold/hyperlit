"""Digestion — citation-LINKING DocPass (wrap (Author Year)/[Author Year] against the bibliography map).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
from shared.pipeline_base import DocPass
from digestion._doc_shared import emit_progress
from digestion.citationLinking.citations import link_citations


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

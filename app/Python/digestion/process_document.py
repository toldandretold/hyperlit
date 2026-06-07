"""Digestion orchestrator — runs the DOC_PASSES pipeline over the ingested HTML.

Extract bibliography → select footnote strategy → extract + link footnotes/citations → audit → emit
nodes/footnotes/references. main() is a thin shell over the ordered DOC_PASSES registry.
"""
import sys
import os
import argparse

# Re-exported here for backward-compat (`process_document.ASSESSMENT`); the DocPasses record to it.
from shared.assessment import ASSESSMENT
# The DocPass base + ordered-pass runner. ALL conversion logic now lives in the DocPass units below — each
# in its own stage folder (load/ · bibliographyExtraction/ · strategySelection/ · footnoteExtraction/ ·
# citationLinking/ · footnoteLinking/ · finalAudit/ · finalize/). This file is just the orchestrator:
# registry + main(). DocPass stays imported HERE so an op:add can register a NEW pass into DOC_PASSES.
from shared.pipeline_base import DocPass, run_passes
from digestion.load.load import LoadDocument, SafariRtlFix, SplitBibliographyParagraphs
from digestion.bibliographyExtraction.bib_passes import StemBibliography, ExtractBibliography
from digestion.strategySelection.strategy_pass import SelectFootnoteStrategy
from digestion.footnoteExtraction.footnote_passes import TraditionalFootnotes, SectionedFootnotes, FlattenFootnoteMap
from digestion.citationLinking.citation_pass import LinkCitationsPass
from digestion.footnoteLinking.footnote_link_pass import LinkFootnotesPass
from digestion.finalAudit.audit_pass import AuditPass
from digestion.finalize.finalize import (
    StructuralCoverageAssessment, StripStylingSpans, GenerateNodeChunks, SanitizeAndWrite,
)


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
    StructuralCoverageAssessment(),
    StripStylingSpans(),
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

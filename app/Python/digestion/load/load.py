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
from digestion.bibliographyExtraction.bibliography import has_reference_structure


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
            # HYBRID paper (MDPI shape): superscript FOOTNOTES alongside the [N] citations.
            # The frontend normalises those to "[^N]:" defs (79c3d8e4: "en masse^{2}." + its
            # Notes entry). The stem branch stays terminal for CITATIONS, but these footnotes
            # still need the standard footnote passes — flag them so those gates open.
            ctx.stem_caret_footnotes = bool(re.search(r'\[\^\d+\]\s*:', str(ctx.soup)))
            if ctx.stem_caret_footnotes:
                print("📐 STEM hybrid: caret-form footnote defs present — footnote passes stay ON")


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


# A line CLOSES an entry when it ends the way a sentence does. A hard-wrapped line breaks
# mid-clause and does not. NOTE the apostrophes are deliberately absent: "Developing Countries'"
# is a possessive at a wrap point, not the end of anything.
_LINE_CLOSES_ENTRY_RE = re.compile(r'[.!?)\]"”»]\s*$')

# A trailing bare URL/DOI ends an entry without any closing punctuation. Recognised so the line
# after one can still be seen as a boundary — and, for the OPENS test, blanked before the scan:
# the old gate accepted any `\d{4}` ANYWHERE in the line, and the digits inside
# "https://doi.org/10.1080/00472338285390361" passed it, which is how an ordinary hard-wrapped
# entry scored two "reference lines" and got shredded.
_URL_LIKE_RE = re.compile(r'\b(?:https?://|www\.|doi\.org/|10\.\d{4,}/)\S*', re.IGNORECASE)
_LINE_IS_URL_TAIL_RE = re.compile(r'(?:https?://|www\.|doi\.org/)\S*\s*$', re.IGNORECASE)


def _closes_reference_entry(line_text):
    t = (line_text or '').strip()
    return bool(_LINE_CLOSES_ENTRY_RE.search(t) or _LINE_IS_URL_TAIL_RE.search(t))


def _opens_reference_entry(line_text):
    """Does this LINE start a new reference entry (rather than continue a wrapped one)?

    STRUCTURE ONLY — "Marcuse, H. 1964…", "Ostrom, Elinor (1990)…", "[1] …". Deliberately
    strict, because the two failure modes are not symmetric: a false NEGATIVE leaves a crammed
    <p> as one node (recoverable, and what the pipeline did before this pass existed), while a
    false POSITIVE shreds a real entry into fragments that then fail is_likely_reference and
    takes the WHOLE reference list out. So an institution-shaped opener ("Progressive
    International. May 5, 2024.") is NOT accepted — it is far more often the second line of a
    wrapped entry than the first line of a crammed one.
    """
    bare = _URL_LIKE_RE.sub(' ', line_text or '').strip()
    return bool(bare) and has_reference_structure(bare)


def _entry_start_indices(line_texts):
    """Indices of the lines that BEGIN a reference entry: line 0, plus any later line that both
    opens an entry and follows a line that closed one."""
    starts = [0]
    for i in range(1, len(line_texts)):
        if _opens_reference_entry(line_texts[i]) and _closes_reference_entry(line_texts[i - 1]):
            starts.append(i)
    return starts


class SplitBibliographyParagraphs(DocPass):
    name = 'split_bibliography_paragraphs'
    description = 'Split multi-entry reference paragraphs (newline-crammed PDF bibliographies) into one <p> each.'

    def apply(self, ctx):
        # ====================================================================
        # PRE-PROCESS: Split multi-entry bibliography paragraphs
        # ====================================================================
        # PDF conversion sometimes crams many reference entries into a single <p>,
        # separated by newlines. Split these so each entry gets its own <p>.
        #
        # THE TRAP THIS PASS FELL INTO: a newline inside a <p> is not evidence of anything on
        # its own — most HTML writers hard-WRAP their source (pandoc wrapped at ~72 columns on
        # the whole docx lane until --wrap=none). So the gate has to tell an ENTRY BOUNDARY
        # (the previous line closed, this one opens) from a WRAP POINT (the previous line broke
        # mid-clause). The old gate did neither: it asked only whether ≥2 lines began with a
        # capital and held four digits anywhere, and then split at EVERY newline. One wrapped
        # entry scored 2 on the digits inside its own DOI, was shredded into ~3 fragments, and
        # none of those survived is_likely_reference — so the ENTIRE reference list went
        # missing and every docx reported refs=0 / citation_style=none.
        soup = ctx.soup
        split_count = 0
        for p in list(soup.find_all('p')):
            inner = p.decode_contents()
            if '\n' not in inner:
                continue
            lines = [l.strip() for l in inner.split('\n') if l.strip()]
            if len(lines) < 2:
                continue
            # Parse a line as markup only when it CONTAINS markup — a bare-URL line otherwise
            # trips BeautifulSoup's "looks more like a URL than markup" warning, straight into
            # the conversion stdout that Laravel logs.
            line_texts = [BeautifulSoup(l, 'html.parser').get_text() if '<' in l else l
                          for l in lines]
            starts = _entry_start_indices(line_texts)
            if len(starts) < 2:
                continue
            # Split at the BOUNDARIES, not at every newline — a crammed block whose own entries
            # are also wrapped keeps each entry whole instead of being torn line by line.
            new_elements = []
            for a, b in zip(starts, starts[1:] + [len(lines)]):
                new_p = soup.new_tag('p')
                new_p.append(BeautifulSoup('\n'.join(lines[a:b]), 'html.parser'))
                new_elements.append(new_p)
            # Insert after original in reverse, then remove original
            for new_p in reversed(new_elements):
                p.insert_after(new_p)
            p.decompose()
            split_count += 1
            print(f"  Split multi-entry <p> into {len(new_elements)} individual entries")
        if split_count:
            print(f"Pre-processed {split_count} multi-entry bibliography paragraphs")

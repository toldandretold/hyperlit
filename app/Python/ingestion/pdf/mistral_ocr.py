#!/usr/bin/env python3
"""
Convert a PDF to markdown using Mistral OCR.

Usage:
  python3 mistral_ocr.py <pdf_path> <output_dir> [--api-key KEY]

The script reads the API key from --api-key or MISTRAL_OCR_API_KEY env var.
Output:
  <output_dir>/main-text.md   — assembled markdown
  <output_dir>/ocr_response.json — cached raw OCR response
  <output_dir>/media/          — extracted images
"""

import sys
import os
import json
import re
import argparse
import base64
from pathlib import Path
from statistics import median
from mistralai.client import Mistral
from pypdf import PdfReader, PdfWriter

# ===========================================================================
# PHASE MODULES (folders mirror the decision tree). The bases + shared text
# helpers live in the pdf_shared.py leaf; each pipeline phase is its own file.
# Re-exported here so the flat shim, the visual-tree generators, and the
# regression all keep seeing them under `mistral_ocr` (PDF_CLASSIFIERS,
# classify_footnotes, PDF_ASSEMBLERS, assemble_markdown, assess_harvest_fidelity…).
# ===========================================================================
from ingestion.pdf import pdf_shared as _pdf_shared      # noqa: E402
from ingestion.pdf import ocrFetch as _ocrFetch          # noqa: E402
from ingestion.pdf import classification as _classification  # noqa: E402
from ingestion.pdf import recovery as _recovery          # noqa: E402
from ingestion.pdf import assembly as _assembly          # noqa: E402
# Re-export EVERYTHING (incl. single-underscore module-level names like _UNKNOWN_CLASSIFIER /
# _DEFAULT_ASSEMBLER / _pdf_classification_story that `import *` would drop) so `mistral_ocr.X` resolves
# exactly as before the split — the flat shim, the generators, and the unit tests all read these off it.
for _phase in (_pdf_shared, _ocrFetch, _classification, _recovery, _assembly):
    globals().update({_k: _v for _k, _v in vars(_phase).items() if not _k.startswith('__')})


def write_classification_assessment(footnote_meta, output_dir, markdown=None, footnote_warnings=None):
    """Emit the PDF stage's footnote-layout decision as an assessment.json fork-record.
    process_document.py later seeds from this file (ASSESSMENT.reset(output_dir)) so the
    final trace spans the PDF classification AND the downstream strategy/linking forks.
    Mirrors epub_normalizer._write_assessment. Best-effort; never breaks conversion.

    When `markdown` is supplied, ALSO appends the harvest-fidelity record (whose-bug-is-it
    discriminator) so the trace carries it into the report and the vibe loop; `footnote_warnings`
    makes that record pypdf-recovery-aware (the residual upstream loss after re-extraction)."""
    _cls_plain = {c.name: getattr(c, 'plain', '') for c in PDF_CLASSIFIERS}
    _cls_plain.setdefault('unknown', getattr(UnknownClassifier, 'plain', ''))
    cls_name = footnote_meta.get('classification', 'unknown')
    record = {
        'seq': 0,
        'module': 'pdf_footnote_classification',
        'code_ref': 'classification.py:classify_footnotes',
        'node_help': _cls_plain.get(cls_name, ''),
        'decision': f"footnote_layout={cls_name}",
        'rationale': footnote_meta.get('rationale', ''),
        'evidence': footnote_meta.get('signals', {}),
        'question': 'What is the PDF footnote layout? (drives per-page renumbering & assembly)',
        'considered': footnote_meta.get('considered', []),
        'confidence': footnote_meta.get('confidence'),
        'margin': footnote_meta.get('margin'),
    }
    records = [record]
    if markdown is not None:
        fidelity = assess_harvest_fidelity(footnote_meta, markdown, footnote_warnings)
        if fidelity:
            records.append(fidelity)
    try:
        with open(os.path.join(str(output_dir), 'assessment.json'), 'w', encoding='utf-8') as f:
            json.dump({'records': records}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Warning: could not write assessment.json: {e}")


def main():
    parser = argparse.ArgumentParser(description="Convert PDF to markdown via Mistral OCR")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("output_dir", help="Directory for output files")
    parser.add_argument("--api-key", help="Mistral API key (or set MISTRAL_OCR_API_KEY env var)")
    parser.add_argument("--ocr-model", default="mistral-ocr-2512",
                        help="Mistral OCR model id (default: mistral-ocr-2512 = OCR 3). "
                             "The billing side prices per served model recorded in ocr_response.json.")
    parser.add_argument("--no-cache", action="store_true", help="Force re-download from Mistral")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("MISTRAL_OCR_API_KEY")
    ocr_model = args.ocr_model

    pdf_path = Path(args.pdf_path)
    output_dir = Path(args.output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    json_cache = output_dir / "ocr_response.json"

    # API key only required when there's no cached OCR response
    if not api_key and not json_cache.exists():
        print("Error: No API key provided. Use --api-key or set MISTRAL_OCR_API_KEY.", file=sys.stderr)
        sys.exit(1)

    if not pdf_path.exists() and not json_cache.exists():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)
    output_md = output_dir / "main-text.md"
    media_dir = output_dir / "media"

    # Fetch or load cached OCR response
    if json_cache.exists() and not args.no_cache:
        print(f"Using cached OCR response: {json_cache}")
        emit_progress(45, "ocr", "Using cached OCR result — skipping the page scan")
        response_dict = json.loads(json_cache.read_text(encoding="utf-8"))
    else:
        # Strip absurdly oversized image XObjects (see ocrFetch.MAX_IMAGE_PIXELS) BEFORE the
        # size branch below — normalising changes the file size, and that size is what picks
        # chunked-vs-single and upload-vs-inline delivery. A book with no oversized image gets
        # its original path straight back, so this is a no-op for everything else.
        # `pdf_path` itself stays the ORIGINAL: the mojibake scan and assembly re-read it for
        # pypdf text recovery, and only the OCR fetch should ever see the rewritten copy.
        ocr_pdf_path, normalize_report = normalize_oversized_images(pdf_path, output_dir)
        if ocr_pdf_path.stat().st_size > CHUNK_TARGET_BYTES:
            response_dict = fetch_ocr_chunked(ocr_pdf_path, api_key, output_dir, model=ocr_model)
        else:
            # The OCR request is one opaque blocking call that scales with book
            # length — tell the user what's happening (page count + rough ETA)
            # and keep the bar creeping via the heartbeat, or the frontend
            # poller times the import out as "stalled" after 5 silent minutes.
            total_pages = None
            try:
                total_pages = len(PdfReader(str(pdf_path)).pages)
            except Exception:
                pass
            if total_pages:
                est_seconds = min(max(total_pages * 0.6, 45), 480)
                est_min = max(1, round(est_seconds / 60))
                detail = (f"Reading {total_pages} pages with OCR — roughly "
                          f"{est_min} minute{'s' if est_min != 1 else ''} for a document this length")
            else:
                est_seconds = 120
                detail = "Reading the PDF with OCR — this can take a few minutes"
            emit_progress(4, "ocr", detail)
            with progress_heartbeat(5, 44, "ocr", detail, est_seconds):
                response_dict = fetch_ocr(ocr_pdf_path, api_key, model=ocr_model)
            emit_progress(45, "ocr", f"OCR complete — read {len(response_dict.get('pages', []))} pages")
        if normalize_report["oversized"]:
            response_dict["_normalized_images"] = normalize_report
        json_cache.write_text(json.dumps(response_dict), encoding="utf-8")
        print(f"Cached raw response to: {json_cache}")
        # The rewritten copy exists only to satisfy the OCR request; ocr_response.json is
        # the artifact replays read, so keep nothing else around (it can be 20MB+).
        if ocr_pdf_path != pdf_path:
            try:
                ocr_pdf_path.unlink()
            except OSError:
                pass

    # Initial classification (used to gate the renumber pass — chapter_endnotes
    # books have their own per-chapter offset machinery and we must not double-shift).
    emit_progress(46, "ocr_analyze", "Analyzing footnote layout")
    footnote_meta = classify_footnotes(response_dict)
    print(f"Footnote classification: {footnote_meta['classification']} "
          f"(confidence: {footnote_meta['confidence']:.2f})")

    # Normalise OCR-4-style responses to the OCR-3 shape BEFORE renumbering: OCR 4 lifts page-bottom
    # footnote defs into each page's `footer` field (page-locally numbered), but renumber below
    # rewrites the in-text ref to a GLOBAL number — so a footer def linked later no longer matches
    # its ref (OCR 4 measured ~22% def coverage vs OCR 3's ~92%; folding restores it to ~89%).
    # STRICTLY page_bottom only: that is the sole layout where extract_footer yields page-bottom
    # DEFINITIONS. For other layouts a populated `footer` is references / numbered lists / chrome, and
    # folding it corrupts them (measured regressions: author-year-bracket refs 16→3, a 'none' book
    # 86→138). Re-classify on the richer markdown after folding.
    if footnote_meta['classification'] == "page_bottom":
        folded = fold_footer_defs_into_markdown(response_dict)
        if folded:
            footnote_meta = classify_footnotes(response_dict)
            print(f"Folded page-bottom footer defs on {folded} page(s); re-classified: "
                  f"{footnote_meta['classification']} (confidence: {footnote_meta['confidence']:.2f})")

    # Renumber footnote IDs across chunk and multi-paper resets — skip for
    # chapter_endnotes (existing chapter_fn_offsets handles those) AND for
    # wackSTEM bibliography docs: their in-text citations re-cite low numbers
    # constantly, so the "min ref == 1 → new-paper reset" heuristic fires on
    # ordinary re-citations and offsets the reference-LIST lines (+320 on the
    # Sci-Hub paper) while the [N] cites keep their real numbers — every
    # stemref link then points at nothing. Worse, the mutation is PERSISTED
    # into the cached ocr_response.json. Idempotent via the marker on
    # response_dict.
    # INVARIANT: ocr_response.json is Mistral's GROUND TRUTH and is never written
    # back to. The renumber mutates only the in-memory copy; every run re-derives
    # it deterministically (the `_chunk_boundaries` fetch provenance is cached, so
    # replays get the same boundary hints the original fetch had). A previous
    # version persisted the renumbered markdown over the cache "so re-runs see the
    # new IDs" — that permanently vandalised the source of truth (the Sci-Hub case:
    # refs 1–129 rewritten to 321–449 on disk, unrecoverable without a pristine
    # copy from a fixture/bundle). Caches already carrying the
    # `_footnote_renumber_version` marker from that era are served as-is (the
    # marker makes renumber a no-op), but they are damaged goods — restore from a
    # case bundle or fixture where one exists.
    if footnote_meta['classification'] not in ("chapter_endnotes", "wackSTEMbibliographyNotes"):
        renumber_chunk_footnotes(
            response_dict,
            response_dict.get("_chunk_boundaries"),
        )
        # If renumber shifted anything, re-classify so page_summary reflects the
        # corrected IDs.
        if response_dict.get("_footnote_renumber_boundaries"):
            footnote_meta = classify_footnotes(response_dict)

    # Revert the HALF-APPLIED segment renumbering (offsets hit [^N] + line-start defs but
    # never inline bracket refs or plain "N Text" defs — mismatched pairs never license, and
    # a ref links to the WRONG chapter's same-numbered note). page_bottom ONLY: its assembler
    # renumbers each page's pairs together, so restoring the original per-chapter numbering
    # is safe there and only there. See ocrFetch.revert_partial_renumber.
    if footnote_meta['classification'] == 'page_bottom':
        _reverted = revert_partial_renumber(response_dict)
        if _reverted:
            print(f"Reverted half-applied footnote renumbering on {_reverted} page(s) "
                  f"(page-local print numbering restored; renumber_page_footnotes owns uniqueness)")
            footnote_meta = classify_footnotes(response_dict)

    # Detect multi-paper segment boundaries (anthology PDFs)
    segment_boundaries = detect_segment_boundaries(response_dict, footnote_meta)
    if segment_boundaries:
        print(f"Detected {len(segment_boundaries)} segment boundary/boundaries at pages: {segment_boundaries}")
    footnote_meta["segment_boundaries"] = segment_boundaries

    # Scan for OCR mojibake on def pages and attempt pypdf fallback
    footnote_warnings = []
    if pdf_path.exists():
        footnote_warnings = scan_footnote_mojibake(response_dict, footnote_meta, pdf_path)
        if footnote_warnings:
            unrec = sum(len(w["unrecovered"]) for w in footnote_warnings)
            rec = sum(len(w["recovered"]) for w in footnote_warnings)
            print(f"Font-encoding mojibake on {len(footnote_warnings)} page(s): "
                  f"recovered {rec} defs via pypdf, {unrec} unrecoverable.")
    footnote_meta["footnote_warnings"] = footnote_warnings

    # Save images to media/ subdirectory
    img_count = save_images(response_dict, media_dir)
    if img_count:
        print(f"Saved {img_count} images to {media_dir}")

    # Assemble markdown — may append additional mojibake warnings to
    # `footnote_warnings` for pypdf-extracted defs we had to reject.
    print("Assembling markdown...")
    emit_progress(47, "ocr_assemble", "Assembling document text from OCR pages")
    markdown = assemble_markdown(
        response_dict,
        classification=footnote_meta['classification'],
        footnote_meta=footnote_meta,
        pdf_path=pdf_path,
        segment_boundaries=segment_boundaries,
        footnote_warnings=footnote_warnings,
    )
    output_md.write_text(markdown, encoding="utf-8")

    # Persist footnote_meta.json after assemble (which may have added warnings)
    meta_path = output_dir / "footnote_meta.json"
    meta_path.write_text(json.dumps(footnote_meta, indent=2), encoding="utf-8")

    # Emit the classification decision + the harvest-fidelity discriminator into the assessment
    # trace (process_document seeds from it). footnote_warnings carries the pypdf-recovery outcome
    # so fidelity_loss reflects what re-extraction already salvaged vs the genuine upstream residual.
    write_classification_assessment(footnote_meta, output_dir, markdown=markdown,
                                    footnote_warnings=footnote_warnings)

    # Stats
    fn_count = len(re.findall(r'\[\^\d+\]', markdown))
    heading_count = len(re.findall(r'^#{1,6} ', markdown, re.MULTILINE))

    print(f"\nSaved to: {output_md}")
    print(f"Total chars: {len(markdown)}")
    print(f"Footnotes: {fn_count}")
    print(f"Headings: {heading_count}")


if __name__ == "__main__":
    main()

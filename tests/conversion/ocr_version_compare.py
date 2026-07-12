#!/usr/bin/env python3
"""OCR version comparison harness — run the same PDFs through several Mistral OCR
versions (OCR 1 = mistral-ocr-2503, OCR 3 = mistral-ocr-2512, OCR 4 = mistral-ocr-4-0)
and score each with the SAME pipeline + metrics production uses, so we can decide
whether OCR 4 is worth its premium and where the versions actually differ.

Three things it measures:
  1. Output quality per version — reusing classify_footnotes / assemble_markdown /
     assess_harvest_fidelity / scan_footnote_mojibake / compute_printable_ratio.
  2. OCR 4 `blocks` upside — the installed mistralai SDK (2.0.0, old .client layout)
     has NO `include_blocks` on its typed ocr.process(), so the blocks variant goes
     via a raw POST /v1/ocr and we inspect the returned block-type labels / bboxes.
  3. Batch API timing — how much slower the (half-price) /v1/ocr batch path is vs
     the synchronous call. Opt-in (--batch); batch jobs can take minutes to hours.

SAFETY: re-OCR costs real money (OCR 4 ≈ $4/1k pages). The harness page-caps each
PDF to --max-pages (default 30) unless --full, caches every variant response, and
prints an estimated spend that you must confirm (or pass --yes) before it hits the API.

This is a research tool, NOT part of the conversion pipeline or its test suite. It
imports the pipeline read-only and never touches the production ocr_response.json name.

Usage:
  python3 tests/conversion/ocr_version_compare.py <pdf-or-dir> [more...] \\
      [--models mistral-ocr-2503,mistral-ocr-2512,mistral-ocr-4-0] [--blocks] \\
      [--max-pages 30 | --full] [--out DIR] [--dry-run] [--yes] [--refresh] \\
      [--batch [--batch-timeout-min 20]]
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

# --- import the production pipeline read-only (mirror run_regression.py path setup) ---
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
PY_DIR = PROJECT_ROOT / "app" / "Python"
sys.path.insert(0, str(PY_DIR))

from ingestion.pdf.ocrFetch import (  # noqa: E402
    fetch_ocr,
    renumber_chunk_footnotes,
    detect_segment_boundaries,
)
from ingestion.pdf.classification import classify_footnotes  # noqa: E402
from ingestion.pdf.assembly import assemble_markdown, fold_footer_defs_into_markdown  # noqa: E402
from ingestion.pdf.recovery import (  # noqa: E402
    scan_footnote_mojibake,
    assess_harvest_fidelity,
)
from pypdf import PdfReader, PdfWriter  # noqa: E402

# Published Mistral OCR standard per-1k-pages prices, for cost logging ONLY (confirm
# against your Mistral invoice — these are list prices, not a live quote). Batch ≈ half.
MODEL_PRICE_PER_1K = {
    "mistral-ocr-2503": 1.00,   # original OCR 1
    "mistral-ocr-2505": 2.00,   # OCR 2
    "mistral-ocr-2512": 2.00,   # OCR 3
    "mistral-ocr-4-0": 4.00,    # OCR 4 (what -latest now resolves to)
    "mistral-ocr-latest": 4.00,  # currently == 4-0
}
DEFAULT_MODELS = ["mistral-ocr-2503", "mistral-ocr-2512", "mistral-ocr-4-0"]
OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr"


def price_for(model):
    return MODEL_PRICE_PER_1K.get(model, MODEL_PRICE_PER_1K["mistral-ocr-4-0"])


# --------------------------------------------------------------------------- corpus

def resolve_pdfs(inputs):
    """Expand file/dir args into a flat, de-duplicated list of PDF paths."""
    pdfs = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            pdfs.extend(sorted(p.rglob("*.pdf")))
        elif p.suffix.lower() == ".pdf" and p.exists():
            pdfs.append(p)
        else:
            print(f"  ! skipping (not a PDF / not found): {raw}", file=sys.stderr)
    # de-dup preserving order
    seen, out = set(), []
    for p in pdfs:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            out.append(p)
    return out


def slice_pdf(pdf_path, max_pages, work_dir):
    """Write the first `max_pages` pages to a temp PDF (reusing pypdf, like
    split_pdf_into_chunks). Returns (sliced_path, n_pages). If the PDF already has
    <= max_pages pages, returns the original untouched."""
    reader = PdfReader(str(pdf_path))
    total = len(reader.pages)
    if max_pages is None or total <= max_pages:
        return pdf_path, total
    writer = PdfWriter()
    for i in range(max_pages):
        writer.add_page(reader.pages[i])
    work_dir.mkdir(parents=True, exist_ok=True)
    out = work_dir / f"{pdf_path.stem}.first{max_pages}.pdf"
    with open(out, "wb") as f:
        writer.write(f)
    return out, max_pages


# ------------------------------------------------------------------- metric pipeline

def run_pipeline(response_dict, pdf_path):
    """Replicate ingestion/pdf/mistral_ocr.py:main's analysis order on an in-memory
    OCR response and return (markdown, footnote_meta, fidelity). No files written."""
    footnote_meta = classify_footnotes(response_dict)
    # Mirror production (mistral_ocr.py:main): fold OCR-4 footer defs into markdown before renumber,
    # STRICTLY for page_bottom (the only layout where extract_footer yields page-bottom defs).
    if footnote_meta["classification"] == "page_bottom":
        if fold_footer_defs_into_markdown(response_dict):
            footnote_meta = classify_footnotes(response_dict)
    if footnote_meta["classification"] != "chapter_endnotes":
        renumber_chunk_footnotes(response_dict, response_dict.get("_chunk_boundaries"))
        if response_dict.get("_footnote_renumber_boundaries"):
            footnote_meta = classify_footnotes(response_dict)

    segment_boundaries = detect_segment_boundaries(response_dict, footnote_meta)
    footnote_meta["segment_boundaries"] = segment_boundaries

    footnote_warnings = []
    if pdf_path is not None and Path(pdf_path).exists():
        try:
            footnote_warnings = scan_footnote_mojibake(response_dict, footnote_meta, pdf_path)
        except Exception as e:  # noqa: BLE001 — mojibake scan is best-effort here
            print(f"    (mojibake scan skipped: {e})", file=sys.stderr)
    footnote_meta["footnote_warnings"] = footnote_warnings

    markdown = assemble_markdown(
        response_dict,
        classification=footnote_meta["classification"],
        footnote_meta=footnote_meta,
        pdf_path=pdf_path,
        segment_boundaries=segment_boundaries,
        footnote_warnings=footnote_warnings,
    )
    fidelity = assess_harvest_fidelity(footnote_meta, markdown, footnote_warnings)
    return markdown, footnote_meta, fidelity


# minimal printable ratio import kept local so a rename upstream surfaces loudly
from ingestion.pdf.pdf_shared import compute_printable_ratio  # noqa: E402


def metrics_row(model, response_dict, pdf_path, elapsed_s):
    """Compute one comparison row for (model, response). Defensive: a pipeline error
    on one variant is captured, not fatal to the whole run."""
    pages = response_dict.get("pages", [])
    row = {
        "model": model,
        "served_model": response_dict.get("model"),
        "pages": len(pages),
        "fetch_seconds": round(elapsed_s, 1) if elapsed_s is not None else None,
        "est_cost_usd": round(len(pages) / 1000 * price_for(model), 4),
        "error": None,
    }
    try:
        markdown, meta, fidelity = run_pipeline(response_dict, pdf_path)
        sig = meta.get("signals", {})
        ev = fidelity.get("evidence", {})
        all_text = "\n".join(p.get("markdown", "") for p in pages)
        row.update({
            "classification": meta.get("classification"),
            "confidence": round(meta.get("confidence", 0), 3),
            "refs_in_ocr": ev.get("refs_in_ocr"),
            "coverage_vs_refs": ev.get("coverage_vs_refs"),
            "defs_in_ocr": ev.get("defs_in_ocr"),
            "defs_harvested": ev.get("defs_harvested"),
            "collision_count": ev.get("collision_count"),
            "fidelity_verdict": fidelity.get("decision"),
            "trailing_pagenum_consistency": sig.get("trailing_page_number_consistency"),
            "printable_ratio": round(compute_printable_ratio(all_text), 4),
            "mojibake_unrecovered": sum(len(w.get("unrecovered", [])) for w in meta.get("footnote_warnings", [])),
            "md_chars": len(markdown),
            # markers = every [^N] token (refs AND defs); def_lines = actual "[^N]:" definition
            # lines. Keep them separate — conflating them was misleading (a def count that
            # secretly included refs). The authoritative coverage is coverage_vs_refs above.
            "footnote_markers": len(re.findall(r"\[\^\d+\]", markdown)),
            "footnote_def_lines": len(re.findall(r"(?m)^\s*\[\^\d+\]:", markdown)),
            "headings": len(re.findall(r"^#{1,6} ", markdown, re.MULTILINE)),
        })
    except Exception as e:  # noqa: BLE001 — record and continue
        row["error"] = f"{type(e).__name__}: {e}"
    return row


# ---------------------------------------------------------------- fetch (cached)

def fetch_variant(pdf_for_ocr, api_key, model, cache_path, refresh):
    """Fetch (or load cached) an OCR response for one model. Returns (dict, elapsed_or_None)."""
    if cache_path.exists() and not refresh:
        print(f"    cache hit: {cache_path.name}")
        return json.loads(cache_path.read_text(encoding="utf-8")), None
    t0 = time.monotonic()
    resp = fetch_ocr(pdf_for_ocr, api_key, model=model)
    elapsed = time.monotonic() - t0
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(resp), encoding="utf-8")
    print(f"    fetched in {elapsed:.1f}s → {cache_path.name}")
    return resp, elapsed


def fetch_blocks_variant(pdf_for_ocr, api_key, cache_path, refresh):
    """OCR 4 with include_blocks=True via a RAW /v1/ocr POST (the installed SDK's
    typed process() can't send include_blocks). Returns (dict, elapsed_or_None)."""
    if cache_path.exists() and not refresh:
        print(f"    cache hit: {cache_path.name}")
        return json.loads(cache_path.read_text(encoding="utf-8")), None
    import base64
    import httpx
    b64 = base64.b64encode(Path(pdf_for_ocr).read_bytes()).decode()
    body = {
        "model": "mistral-ocr-4-0",
        "document": {"type": "document_url", "document_url": f"data:application/pdf;base64,{b64}"},
        "include_image_base64": True,
        "extract_header": True,
        "extract_footer": True,
        "include_blocks": True,
    }
    t0 = time.monotonic()
    r = httpx.post(
        OCR_ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=body,
        timeout=600,
    )
    r.raise_for_status()
    resp = r.json()
    elapsed = time.monotonic() - t0
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(resp), encoding="utf-8")
    print(f"    fetched (blocks) in {elapsed:.1f}s → {cache_path.name}")
    return resp, elapsed


def analyze_blocks(response_dict):
    """Summarise the OCR-4 `blocks` array: which type labels appear, how many, and
    whether footer/aside/page-number-ish blocks (the footnote/page-number signal) exist."""
    from collections import Counter
    types = Counter()
    n_blocks = 0
    has_bbox = False
    for page in response_dict.get("pages", []):
        for b in (page.get("blocks") or []):
            n_blocks += 1
            t = b.get("type") or b.get("block_type") or "?"
            types[t] += 1
            if any(k in b for k in ("bbox", "bounding_box", "top_left_x", "x0")):
                has_bbox = True
    return {
        "blocks_present": n_blocks > 0,
        "n_blocks": n_blocks,
        "type_counts": dict(types),
        "has_bbox": has_bbox,
        "footnote_signal_types": [t for t in types if t in ("footer", "aside_text", "references")],
    }


# --------------------------------------------------------------------------- report

def fmt_row(row):
    if row.get("error"):
        return (f"  - **{row['model']}** — {row['pages']}p, "
                f"{_secs(row['fetch_seconds'])}, ~${row['est_cost_usd']}. "
                f"PIPELINE ERROR: {row['error']}")
    return (
        f"  - **{row['model']}** (served: `{row.get('served_model')}`) — "
        f"{row['pages']}p, {_secs(row['fetch_seconds'])}, ~${row['est_cost_usd']}\n"
        f"    - footnote layout: `{row['classification']}` (conf {row['confidence']})\n"
        f"    - in-text refs (OCR): {row['refs_in_ocr']} · defs harvested/in_ocr: "
        f"{row['defs_harvested']}/{row['defs_in_ocr']} · coverage (defs/refs): {row['coverage_vs_refs']} · "
        f"collisions: {row['collision_count']} · fidelity: `{row['fidelity_verdict']}`\n"
        f"    - printable_ratio: {row['printable_ratio']} · mojibake unrecovered: "
        f"{row['mojibake_unrecovered']} · page-num consistency: {row['trailing_pagenum_consistency']}\n"
        f"    - md chars: {row['md_chars']} · footnote markers (refs+defs): {row['footnote_markers']} "
        f"· actual def-lines: {row['footnote_def_lines']} · headings: {row['headings']}"
    )


def _secs(s):
    return "cached" if s is None else f"{s}s"


def write_report(results, blocks_summaries, batch_result, out_dir, max_pages):
    lines = ["# OCR version comparison\n"]
    cap = "full document" if max_pages is None else f"first {max_pages} pages"
    lines.append(f"Scope per PDF: **{cap}**. Prices are Mistral list prices for cost estimation — confirm against your invoice.\n")

    total_cost = sum(r["est_cost_usd"] for doc in results.values() for r in doc)
    lines.append(f"Estimated total OCR spend for this run: **~${round(total_cost, 2)}**.\n")

    lines.append("## Per-document results\n")
    for pdf_name, rows in results.items():
        lines.append(f"### {pdf_name}\n")
        for r in rows:
            lines.append(fmt_row(r))
        # agreement note
        classes = {r.get("classification") for r in rows if not r.get("error")}
        if len(classes) > 1:
            lines.append(f"  - ⚠️ models DISAGREE on footnote layout: {sorted(c for c in classes if c)}")
        lines.append("")

    if blocks_summaries:
        lines.append("## OCR 4 `blocks` probe (include_blocks via raw /v1/ocr)\n")
        for pdf_name, summ in blocks_summaries.items():
            if summ.get("blocks_present"):
                lines.append(
                    f"- **{pdf_name}** — {summ['n_blocks']} blocks, bbox present: {summ['has_bbox']}. "
                    f"type counts: {summ['type_counts']}. "
                    f"footnote/page signal blocks: {summ['footnote_signal_types'] or 'NONE'}")
            else:
                lines.append(f"- **{pdf_name}** — no `blocks` array returned (API/model may not support include_blocks).")
        lines.append("")

    if batch_result is not None:
        lines.append("## Batch API timing\n")
        lines.append(batch_result)
        lines.append("")

    report_path = out_dir / "REPORT.md"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReport written: {report_path}")
    return report_path


# ----------------------------------------------------------------------- batch test

def run_batch_timing(pdfs_for_ocr, api_key, out_dir, timeout_min):
    """Submit a small OCR batch via the SDK (endpoint /v1/ocr) and measure wall-clock
    to completion vs the synchronous path. Returns a markdown paragraph. Defensive:
    any failure is reported, not raised."""
    try:
        import base64
        from mistralai.client import Mistral
        from mistralai.client import models as m
        client = Mistral(api_key=api_key)

        # Build a JSONL of OCR requests (inline base64 documents).
        jsonl_lines = []
        for i, p in enumerate(pdfs_for_ocr):
            b64 = base64.b64encode(Path(p).read_bytes()).decode()
            jsonl_lines.append(json.dumps({
                "custom_id": str(i),
                "body": {
                    "model": "mistral-ocr-4-0",
                    "document": {"type": "document_url", "document_url": f"data:application/pdf;base64,{b64}"},
                },
            }))
        jsonl_path = out_dir / "batch_input.jsonl"
        jsonl_path.write_text("\n".join(jsonl_lines), encoding="utf-8")

        up = client.files.upload(
            file={"file_name": "batch_input.jsonl", "content": jsonl_path.read_bytes()},
            purpose="batch",
        )
        t0 = time.monotonic()
        job = client.batch.jobs.create(
            endpoint=m.APIEndpoint("/v1/ocr"),
            input_files=[up.id],
            model="mistral-ocr-4-0",
        )
        job_id = job.id
        print(f"  batch job {job_id} submitted; polling up to {timeout_min} min...")
        deadline = t0 + timeout_min * 60
        status = job.status
        while time.monotonic() < deadline:
            job = client.batch.jobs.get(job_id=job_id)
            status = job.status
            if str(status).upper() in ("SUCCESS", "FAILED", "CANCELLED", "TIMEOUT_EXCEEDED", "COMPLETED"):
                break
            time.sleep(15)
        elapsed = time.monotonic() - t0
        return (f"- Batch of {len(pdfs_for_ocr)} doc(s), endpoint `/v1/ocr`, model `mistral-ocr-4-0`.\n"
                f"- Final status after {elapsed:.0f}s: `{status}` (job `{job_id}`).\n"
                f"- Batch price ≈ ½ the synchronous rate; compare this wall-clock against the "
                f"synchronous `fetch_seconds` in the per-document rows above.")
    except Exception as e:  # noqa: BLE001
        return f"- Batch test failed/unsupported by installed SDK: `{type(e).__name__}: {e}`"


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Compare Mistral OCR versions on the same PDFs.")
    ap.add_argument("inputs", nargs="+", help="PDF files and/or directories to scan for PDFs")
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS),
                    help="comma-separated pinned OCR model ids")
    ap.add_argument("--blocks", action="store_true", help="also run an OCR-4 include_blocks variant (raw HTTP)")
    ap.add_argument("--max-pages", type=int, default=30, help="page cap per PDF (cost guard); default 30")
    ap.add_argument("--full", action="store_true", help="disable the page cap (OCR whole documents — costs more)")
    ap.add_argument("--out", default=str(SCRIPT_DIR / "ocr-compare-out"), help="output dir for caches + report")
    ap.add_argument("--api-key", help="Mistral API key (else MISTRAL_OCR_API_KEY)")
    ap.add_argument("--dry-run", action="store_true", help="estimate cost only; do not call the API")
    ap.add_argument("--yes", action="store_true", help="skip the spend confirmation prompt")
    ap.add_argument("--refresh", action="store_true", help="ignore cached responses and re-fetch")
    ap.add_argument("--batch", action="store_true", help="also run the batch-API timing sub-test")
    ap.add_argument("--batch-timeout-min", type=int, default=20, help="max minutes to poll the batch job")
    args = ap.parse_args()

    api_key = args.api_key or os.environ.get("MISTRAL_OCR_API_KEY")
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    max_pages = None if args.full else args.max_pages
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    pdfs = resolve_pdfs(args.inputs)
    if not pdfs:
        print("No PDFs found.", file=sys.stderr)
        sys.exit(1)

    # Slice for cost cap + estimate spend up front.
    print(f"Corpus: {len(pdfs)} PDF(s); variants: {models}"
          f"{' + blocks' if args.blocks else ''}; scope: "
          f"{'full' if max_pages is None else f'first {max_pages}p'}\n")
    sliced = []  # (original_pdf, sliced_path, n_pages)
    est_total = 0.0
    work_dir = out_dir / "_sliced"
    for pdf in pdfs:
        try:
            spath, npages = slice_pdf(pdf, max_pages, work_dir)
        except Exception as e:  # noqa: BLE001
            print(f"  ! cannot read {pdf.name}: {e}", file=sys.stderr)
            continue
        sliced.append((pdf, spath, npages))
        per_variant = sum(npages / 1000 * price_for(m) for m in models)
        if args.blocks:
            per_variant += npages / 1000 * price_for("mistral-ocr-4-0")
        est_total += per_variant
        print(f"  {pdf.name}: {npages}p → ~${per_variant:.3f}")
    print(f"\nEstimated total spend (excl. any cache hits): ~${est_total:.2f}")

    if args.dry_run:
        print("Dry run — no API calls made.")
        return
    if not api_key:
        print("Error: no API key (set MISTRAL_OCR_API_KEY or pass --api-key).", file=sys.stderr)
        sys.exit(1)
    if not args.yes:
        resp = input("Proceed and incur this cost? [y/N] ").strip().lower()
        if resp != "y":
            print("Aborted.")
            return

    results = {}
    blocks_summaries = {}
    for pdf, spath, npages in sliced:
        print(f"\n=== {pdf.name} ({npages}p) ===")
        rows = []
        doc_cache = out_dir / pdf.stem
        for model in models:
            cache = doc_cache / f"ocr_response.{model}.json"
            try:
                resp, elapsed = fetch_variant(spath, api_key, model, cache, args.refresh)
                rows.append(metrics_row(model, resp, spath, elapsed))
            except Exception as e:  # noqa: BLE001
                print(f"    ! {model} failed: {e}", file=sys.stderr)
                rows.append({"model": model, "pages": npages, "fetch_seconds": None,
                             "est_cost_usd": 0.0, "error": f"fetch: {type(e).__name__}: {e}"})
        if args.blocks:
            cache = doc_cache / "ocr_response.mistral-ocr-4-0.blocks.json"
            try:
                resp, _ = fetch_blocks_variant(spath, api_key, cache, args.refresh)
                blocks_summaries[pdf.name] = analyze_blocks(resp)
            except Exception as e:  # noqa: BLE001
                print(f"    ! blocks variant failed: {e}", file=sys.stderr)
                blocks_summaries[pdf.name] = {"blocks_present": False, "error": str(e)}
        results[pdf.name] = rows

    batch_result = None
    if args.batch:
        print("\n=== batch timing sub-test ===")
        batch_result = run_batch_timing([s for _, s, _ in sliced], api_key, out_dir, args.batch_timeout_min)
        print(f"  {batch_result.splitlines()[0]}")

    write_report(results, blocks_summaries, batch_result, out_dir, max_pages)


if __name__ == "__main__":
    main()

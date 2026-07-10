"""Phase ⓪ — Mistral OCR acquisition: fetch the OCR JSON (chunking PDFs over the 50MB API limit), then the chunk/segment renumbering that stitches multi-chunk responses back into one page sequence."""
import sys
import os
import json
import re
import time
import argparse
import base64
from pathlib import Path
from statistics import median
from mistralai.client import Mistral
from pypdf import PdfReader, PdfWriter

from ingestion.pdf.pdf_shared import *  # noqa: F401,F403

MISTRAL_MAX_BYTES = 50 * 1024 * 1024


CHUNK_TARGET_BYTES = 40 * 1024 * 1024


# PDFs at or under this size skip the upload+signed-url round-trip and are sent
# inline as a base64 data-URL. That middle step ("get a signed URL for the file I
# just uploaded") is the one subject to Mistral's eventual-consistency lag — it can
# 404 with "No file matches the given query" before the upload has propagated across
# their backend. Inline delivery has no stored file to become queryable, so it cannot
# hit that failure at all. Kept conservative: base64 inflates bytes ~33%, so 8MB → ~11MB
# of request body, well under Mistral's inline-body ceiling. Larger files must still
# upload (base64 would blow the request-size limit).
INLINE_MAX_BYTES = 8 * 1024 * 1024


def _get_signed_url_with_retry(client, file_id, expiry=1, attempts=6):
    """Fetch a signed URL for a just-uploaded file, retrying on a transient 404.

    Mistral's `files.upload` returns before the new file is consistently queryable,
    so an immediate `get_signed_url` can 404 with "No file matches the given query"
    even though the upload succeeded. That's eventual-consistency, not a real miss —
    retry with exponential backoff (~0.5,1,2,4,8s ≈ 15s total) before giving up.
    Any non-404 error is re-raised immediately (genuine auth/SDK failure).
    """
    last_err = None
    for i in range(attempts):
        try:
            return client.files.get_signed_url(file_id=file_id, expiry=expiry)
        except Exception as e:  # noqa: BLE001 — SDK error class path varies by version
            msg = str(e)
            if "404" not in msg and "No file matches" not in msg:
                raise
            last_err = e
            if i < attempts - 1:
                wait = 0.5 * (2 ** i)
                print(f"  signed-url 404 (file not yet queryable), retry {i + 1}/{attempts - 1} in {wait:.1f}s...")
                time.sleep(wait)
    raise last_err


def _run_ocr(client, document):
    """Run Mistral OCR on an already-resolved document reference and return the dict.

    `document` is either an inline base64 data-URL or a signed URL — both take the
    same {"type": "document_url", "document_url": ...} shape, so the OCR call and
    its options live here once for both delivery paths.
    """
    ocr_response = client.ocr.process(
        document=document,
        model="mistral-ocr-latest",
        include_image_base64=True,
        extract_header=True,
        extract_footer=True,
    )
    response_dict = json.loads(ocr_response.model_dump_json())
    print(f"Got {len(response_dict['pages'])} pages back")
    return response_dict


def _upload_and_get_signed_url(client, pdf_path, upload_attempts=2):
    """Upload the PDF and return a signed URL, re-uploading on a persistent 404.

    `_get_signed_url_with_retry` already rides out the common eventual-consistency
    lag (~15s of backoff on the same file id). But if that id is genuinely stuck —
    never becomes queryable within the window — re-polling it forever is useless.
    A *fresh* upload gets a fresh id that usually propagates cleanly (this is exactly
    the manual "just re-run the import" fix, automated). So on a persistent 404 we
    upload again from scratch. Any non-404 error (auth/SDK) re-raises immediately.
    """
    last_err = None
    for attempt in range(upload_attempts):
        uploaded_file = client.files.upload(
            file={"file_name": pdf_path.name, "content": pdf_path.read_bytes()},
            purpose="ocr",
        )
        print(f"Upload response: id={uploaded_file.id}")
        try:
            return _get_signed_url_with_retry(client, uploaded_file.id, expiry=1)
        except Exception as e:  # noqa: BLE001 — SDK error class path varies by version
            last_err = e
            msg = str(e)
            is_transient_404 = "404" in msg or "No file matches" in msg
            if not is_transient_404 or attempt == upload_attempts - 1:
                raise
            print(f"  file still not queryable after retries — re-uploading (attempt {attempt + 2}/{upload_attempts})...")
    raise last_err


def fetch_ocr(pdf_path, api_key):
    """Send a PDF to Mistral OCR and return the raw response dict.

    Small PDFs (<= INLINE_MAX_BYTES) are sent inline as a base64 data-URL, skipping
    the upload+signed-url dance entirely — that dance's middle step is the source of
    the "No file matches the given query" 404 (see INLINE_MAX_BYTES). Larger files
    must upload (base64 would exceed the request-size limit); that path re-uploads on
    a persistent 404 via `_upload_and_get_signed_url`.
    """
    client = Mistral(api_key=api_key)

    file_size = pdf_path.stat().st_size
    if file_size <= INLINE_MAX_BYTES:
        print(f"Sending {pdf_path.name} ({file_size / 1024 / 1024:.1f}MB) inline (base64, no upload)...")
        b64 = base64.b64encode(pdf_path.read_bytes()).decode()
        document = {"type": "document_url", "document_url": f"data:application/pdf;base64,{b64}"}
        print("Running OCR... (this may take a few minutes)")
        return _run_ocr(client, document)

    print(f"Uploading {pdf_path.name} ({file_size / 1024 / 1024:.1f}MB)...")
    signed_url = _upload_and_get_signed_url(client, pdf_path)
    print("Running OCR... (this may take a few minutes)")
    return _run_ocr(client, {"type": "document_url", "document_url": signed_url.url})


def split_pdf_into_chunks(pdf_path, target_bytes, work_dir):
    """Split a PDF into chunks each under the Mistral 50MB limit.

    Strategy: estimate pages-per-chunk from average page size (with headroom for PDF
    overhead), write each chunk to disk, and if a chunk still exceeds the hard limit,
    halve it recursively. Returns chunk paths in original page order.
    """
    reader = PdfReader(str(pdf_path))
    total_pages = len(reader.pages)
    file_size = pdf_path.stat().st_size

    chunks_dir = work_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    chunk_paths = []
    counter = {"i": 0}

    def flush(pages):
        if not pages:
            return
        writer = PdfWriter()
        for p in pages:
            writer.add_page(p)
        chunk_path = chunks_dir / f"chunk_{counter['i']:03d}.pdf"
        with open(chunk_path, "wb") as f:
            writer.write(f)
        size = chunk_path.stat().st_size
        if size > MISTRAL_MAX_BYTES:
            chunk_path.unlink()
            if len(pages) == 1:
                raise RuntimeError(
                    f"Single PDF page is {size / 1024 / 1024:.1f}MB, exceeding Mistral's 50MB limit. "
                    f"This page cannot be OCR'd."
                )
            mid = len(pages) // 2
            flush(pages[:mid])
            flush(pages[mid:])
        else:
            chunk_paths.append(chunk_path)
            counter["i"] += 1

    avg_page_bytes = file_size / max(total_pages, 1)
    # Leave 15% headroom for PDF trailer/xref overhead per chunk.
    pages_per_chunk = max(1, int((target_bytes * 0.85) / avg_page_bytes))

    for start in range(0, total_pages, pages_per_chunk):
        end = min(start + pages_per_chunk, total_pages)
        flush([reader.pages[i] for i in range(start, end)])

    return chunk_paths


def fetch_ocr_chunked(pdf_path, api_key, work_dir):
    """For PDFs over Mistral's 50MB limit: split, OCR each chunk, merge responses.

    Image IDs are namespaced per chunk (e.g. c0-img-0.jpeg) to prevent collisions
    when save_images() writes them to media/. Markdown image refs in each page are
    rewritten to match.
    """
    file_mb = pdf_path.stat().st_size / 1024 / 1024
    emit_progress(
        5, "pdf_splitting",
        f"Large PDF detected ({file_mb:.0f}MB). Splitting into chunks for OCR — this takes longer than smaller files."
    )

    chunk_paths = split_pdf_into_chunks(pdf_path, CHUNK_TARGET_BYTES, work_dir)
    n = len(chunk_paths)
    emit_progress(8, "pdf_splitting", f"Split into {n} chunks. Starting OCR...")

    merged_pages = []
    chunk_boundary_indices = []  # page index where each chunk (after the first) begins
    for i, chunk_path in enumerate(chunk_paths):
        percent = 10 + int(68 * i / n)
        emit_progress(
            percent, "ocr_chunk",
            f"Running OCR on chunk {i + 1} of {n} (each chunk takes around 30-60 seconds)..."
        )
        chunk_response = fetch_ocr(chunk_path, api_key)

        if i > 0:
            chunk_boundary_indices.append(len(merged_pages))

        for page in chunk_response.get("pages", []):
            md = page.get("markdown", "")
            for img in page.get("images", []):
                old_id = img.get("id", "")
                if not old_id:
                    continue
                new_id = f"c{i}-{old_id}"
                md = md.replace(old_id, new_id)
                img["id"] = new_id
            page["markdown"] = md
            merged_pages.append(page)

    # Cleanup chunk PDFs (the merged ocr_response.json is now the only artifact we need).
    for p in chunk_paths:
        try:
            p.unlink()
        except OSError:
            pass
    try:
        (work_dir / "chunks").rmdir()
    except OSError:
        pass

    emit_progress(78, "ocr_chunk", f"OCR complete for all {n} chunks. Assembling document...")
    return {
        "pages": merged_pages,
        "_chunk_boundaries": chunk_boundary_indices,
    }


def _collect_page_refs_and_defs(md):
    """Return (sorted unique refs, sorted unique defs) for a single page's markdown.

    Lightweight version of classify_footnotes per-page logic — used by
    renumber_chunk_footnotes which runs *before* the classifier.
    """
    md = convert_footnotes(md)
    refs = set()
    for m in re.finditer(r'\[\^?(\d+)\]', md):
        num = int(m.group(1))
        if num > 500 or num < 1:
            continue
        pos = m.start()
        if pos == 0 or md[pos - 1] == '\n':
            continue
        refs.add(num)
    defs = set(int(n) for n in re.findall(r'^\[\^(\d+)\]', md, re.MULTILINE))
    defs |= set(int(n) for n in re.findall(r'^(\d{1,3})\. \S', md, re.MULTILINE))
    defs |= set(int(n) for n in re.findall(r'^(\d{1,3}) [A-Z‘“\'"]', md, re.MULTILINE))
    return sorted(refs), sorted(defs)


def renumber_chunk_footnotes(response_dict, chunk_boundary_indices=None):
    """Renumber footnote IDs across chunk boundaries so they stay globally unique.

    When a >50MB PDF is split for OCR, each chunk's Mistral response starts its
    footnote numbering from 1, so the merged response contains duplicate [^N]
    markers. This pass walks pages in order, tracks the running max footnote
    number, and when it sees a reset (lowest ref drops to 1 while running max
    >= 5) it offsets that page and everything after it by the running max.

    `chunk_boundary_indices` (optional): when called from fetch_ocr_chunked,
    we know exactly where chunks begin — passing these page indices makes
    detection deterministic. When None (cache re-runs), fall back to heuristic
    detection based on number resets alone.

    Idempotent via response_dict["_footnote_renumber_version"] marker.
    Mutates page["markdown"] in place. Returns the response_dict.
    """
    if response_dict.get("_footnote_renumber_version"):
        return response_dict

    pages = response_dict.get("pages", [])
    if not pages:
        response_dict["_footnote_renumber_version"] = 1
        return response_dict

    # Collect per-page refs+defs
    per_page = [_collect_page_refs_and_defs(p.get("markdown", "")) for p in pages]

    boundary_hint = set(chunk_boundary_indices or [])
    running_max = 0
    total_offset = 0
    reset_boundaries = []  # list of (page_idx, offset_to_add)

    for i, (refs, defs) in enumerate(per_page):
        if not refs and not defs:
            continue
        page_min = min(refs) if refs else (min(defs) if defs else None)
        page_max = max(refs + defs) if (refs or defs) else 0

        # Detect reset: page_min == 1 AND running_max sufficiently above 1 AND
        # either the boundary_hint matches OR running_max is large enough that
        # an organic restart is implausible without a real document break.
        is_reset = (
            page_min == 1
            and running_max >= 5
            and (i in boundary_hint or running_max >= 5)
        )
        if is_reset:
            total_offset += running_max
            reset_boundaries.append((i, total_offset))
            running_max = page_max  # reset tracking for this new sub-sequence
        else:
            running_max = max(running_max, page_max)

    # Apply offsets. Iterate boundaries in reverse so later offsets apply first
    # (we walk forward but each boundary's offset replaces the prior one).
    page_offsets = [0] * len(pages)
    if reset_boundaries:
        # Build per-page offset lookup
        active_offset = 0
        boundary_map = {idx: off for idx, off in reset_boundaries}
        for i in range(len(pages)):
            if i in boundary_map:
                active_offset = boundary_map[i]
            page_offsets[i] = active_offset

        for i, page in enumerate(pages):
            off = page_offsets[i]
            if off <= 0:
                continue
            md = page.get("markdown", "")

            # Normalize superscripts and LaTeX-superscripts to [^N] before
            # shifting, otherwise non-[^N] forms slip through unchanged and
            # collide with the un-shifted IDs from earlier pages.
            md = convert_footnotes(md)
            md = re.sub(r'\$\^\{?(\d+)\}?\$', r'[^\1]', md)

            # Renumber [^N] (refs and defs alike)
            def _shift_footnote_ref(m, _off=off):
                return f'[^{int(m.group(1)) + _off}]'
            md = re.sub(r'\[\^(\d+)\]', _shift_footnote_ref, md)

            # Renumber bracket-form [N] line-starts only when small N (defs),
            # so we don't corrupt things like [2015]
            def _shift_bracket_def(m, _off=off):
                num = int(m.group(1))
                if num < 1 or num > 500:
                    return m.group(0)
                return f'[{num + _off}]{m.group(2)}'
            md = re.sub(r'^\[(\d+)\]( .)', _shift_bracket_def, md, flags=re.MULTILINE)

            # Renumber "N. text" line-starts (numbered def lists on notes pages).
            # Only shift when the original N is small (def-sized) to avoid
            # renumbering legitimate numbered lists in body prose.
            def _shift_numdot_def(m, _off=off):
                num = int(m.group(1))
                if num < 1 or num > 200:
                    return m.group(0)
                return f'{num + _off}. {m.group(2)}'
            md = re.sub(r'^(\d{1,3})\. (\S)', _shift_numdot_def, md, flags=re.MULTILINE)

            page["markdown"] = md

    response_dict["_footnote_renumber_version"] = 1
    response_dict["_footnote_renumber_boundaries"] = [b[0] for b in reset_boundaries]
    response_dict["_footnote_renumber_page_offsets"] = page_offsets
    return response_dict


def detect_segment_boundaries(response_dict, footnote_meta):
    """Identify multi-paper boundaries from footnote-number resets, anchored to headings.

    Only renumber-detected resets are treated as candidates for being paper
    boundaries — most documents that legitimately have many `# ` headings
    (multi-chapter books) DO NOT restart footnote numbering between chapters,
    so the reset signal is what distinguishes an anthology from a single work.

    For each renumber boundary we anchor to the nearest top-level `# ` heading
    (on the boundary page itself or the one before — paper titles often sit
    on a page just before the first footnote ref of the new paper). Resets
    that don't correlate with any nearby `# ` heading are dropped, on the
    assumption that they're chunking artifacts rather than real paper breaks.

    Returns a sorted, deduplicated list of page indices. Empty for documents
    with no inter-paper resets.
    """
    if not footnote_meta:
        return []
    pages = response_dict.get("pages", [])
    if not pages:
        return []

    raw_boundaries = sorted(set(response_dict.get("_footnote_renumber_boundaries") or []))
    if not raw_boundaries:
        return []

    confirmed = set()
    for page_idx in raw_boundaries:
        if page_idx <= 0 or page_idx >= len(pages):
            continue
        md = pages[page_idx].get("markdown", "") or ""
        prev_md = pages[page_idx - 1].get("markdown", "") or ""
        if re.search(r'^# [^#]', md, re.MULTILINE):
            confirmed.add(page_idx)
        elif re.search(r'^# [^#]', prev_md, re.MULTILINE):
            confirmed.add(page_idx - 1)
        # No nearby heading → almost certainly a chunking artifact; skip.

    # Dedupe near-adjacent boundaries (within 2 pages = same paper break)
    if not confirmed:
        return []
    sorted_b = sorted(confirmed)
    merged = [sorted_b[0]]
    for b in sorted_b[1:]:
        if b - merged[-1] <= 2:
            continue
        merged.append(b)
    return merged

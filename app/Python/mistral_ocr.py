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

SUPERSCRIPT_MAP = str.maketrans("\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079", "0123456789")


def convert_footnotes(text):
    """Convert Unicode superscript numbers to [^N] markdown footnotes."""
    def replace_fn(m):
        num = m.group(0).translate(SUPERSCRIPT_MAP)
        return f"[^{num}]"
    return re.sub(r'[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+', replace_fn, text)


def renumber_page_footnotes(page_md, global_counter):
    """Renumber footnotes on a single page from local numbering to global sequential.

    For "page_bottom" documents where each page restarts at [^1].
    Converts superscripts first, then maps local numbers to global ones.

    Returns (processed_md, new_global_counter).
    """
    # First convert any Unicode superscripts to [^N] format
    page_md = convert_footnotes(page_md)

    # Collect unique local footnote numbers in order of first appearance
    seen = set()
    local_numbers = []
    for m in re.finditer(r'\[\^(\d+)\]', page_md):
        num = m.group(1)
        if num not in seen:
            seen.add(num)
            local_numbers.append(num)

    if not local_numbers:
        return page_md, global_counter

    # Build mapping: local number → global sequential number
    local_to_global = {}
    for local_num in local_numbers:
        local_to_global[local_num] = str(global_counter)
        global_counter += 1

    # Single-pass replacement using a callback
    def replace_local(m):
        local_num = m.group(1)
        return f'[^{local_to_global[local_num]}]'

    page_md = re.sub(r'\[\^(\d+)\]', replace_local, page_md)

    return page_md, global_counter


def split_body_and_footnotes(md):
    """Split a page's markdown into body text and footnote definitions.

    Footnote definitions start with [^N] at the beginning of a line.
    Returns (body, footnotes) where footnotes may be empty string.
    """
    match = re.search(r'^\[\^\d+\]\s*:?\s*[A-Z\d"]', md, re.MULTILINE)
    if not match:
        return md, ""

    body = md[:match.start()].rstrip()
    footnotes = md[match.start():]

    # Move any <a class="pageNumber"> anchor from footnotes back to body
    page_anchor = re.search(r'\s*<a class="pageNumber"[^>]*></a>', footnotes)
    if page_anchor:
        body = body + page_anchor.group(0)
        footnotes = footnotes[:page_anchor.start()] + footnotes[page_anchor.end():]

    return body, footnotes


def fetch_ocr(pdf_path, api_key):
    """Upload PDF to Mistral OCR and return raw response dict."""
    client = Mistral(api_key=api_key)

    print(f"Uploading {pdf_path.name} ({pdf_path.stat().st_size // 1024 // 1024}MB)...")
    uploaded_file = client.files.upload(
        file={"file_name": pdf_path.stem, "content": pdf_path.read_bytes()},
        purpose="ocr",
    )
    signed_url = client.files.get_signed_url(file_id=uploaded_file.id, expiry=1)

    print("Running OCR... (this may take a few minutes)")
    ocr_response = client.ocr.process(
        document={"type": "document_url", "document_url": signed_url.url},
        model="mistral-ocr-latest",
        include_image_base64=True,
        extract_header=True,
        extract_footer=True,
    )

    response_dict = json.loads(ocr_response.model_dump_json())
    print(f"Got {len(response_dict['pages'])} pages back")
    return response_dict


def is_page_number_header(header_text):
    """Check if a header line is just a page number."""
    if not header_text:
        return False
    return bool(re.match(r'^\d+$', header_text.strip()))


def extract_section_name(header_text):
    """Extract a clean section name from a header, stripping page numbers."""
    if not header_text:
        return None
    stripped = header_text.strip()
    # Pure page number — not a section
    if re.match(r'^\d+$', stripped):
        return None
    # Strip trailing page number (e.g. "Introduction 35")
    cleaned = re.sub(r'\s+\d+$', '', stripped)
    # Strip leading page number (e.g. "42 Some Title")
    cleaned = re.sub(r'^\d+\s+', '', cleaned)
    if cleaned:
        return cleaned
    return None


def rejoin_page_breaks(text):
    """Rejoin paragraphs that were split across page boundaries."""
    lines = text.split('\n')
    result = []
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()

        # Skip empty lines, headings, HRs
        if not stripped or stripped.startswith('#') or stripped == '---':
            result.append(line)
            i += 1
            continue

        # Find the next non-empty line
        next_nonempty = ''
        next_idx = None
        for j in range(i + 1, min(i + 4, len(lines))):
            if lines[j].strip():
                next_nonempty = lines[j].strip()
                next_idx = j
                break

        if next_nonempty and next_idx and next_idx > i + 1:
            # There's a blank gap between this line and the next content

            # Case 1: Hyphenated word break — "accumu-" + "lation"
            if stripped.endswith('-') and not stripped.endswith('---') and next_nonempty[0].islower():
                result.append(stripped[:-1] + next_nonempty)
                i = next_idx + 1
                continue

            # Case 2: Paragraph continues — line doesn't end with sentence punct,
            # next starts lowercase
            # Strip trailing footnote refs so [^N] isn't mistaken for sentence-ending ']'
            stripped_for_check = re.sub(r'\[\^\d+\]\s*$', '', stripped).rstrip()
            if (not stripped_for_check.endswith(('.', '!', '?', ':', ';', '"', ')', ']', '---'))
                    and next_nonempty[0].islower()
                    and not next_nonempty.startswith('#')
                    and len(stripped) > 20):
                result.append(stripped + ' ' + next_nonempty)
                i = next_idx + 1
                continue

        result.append(line)
        i += 1

    return '\n'.join(result)


def classify_footnotes(response_dict):
    """Classify footnote style from raw OCR JSON before assembly.

    Returns a dict with classification, confidence, signals, and page_summary.
    """
    pages = response_dict["pages"]
    total_pages = len(pages)

    # --- Step 1: Per-page signal collection ---
    page_data = []  # list of {refs, defs, trailing_number}
    for page in pages:
        md = page.get("markdown", "")
        header = page.get("header") or ""
        md = convert_footnotes(md)

        # Inline refs: [^N] or [N] NOT at start of a line
        # Filter out numbers > 500 to avoid matching years like [2015]
        refs = set()
        for m in re.finditer(r'\[\^?(\d+)\]', md):
            num = int(m.group(1))
            if num > 500:
                continue
            pos = m.start()
            if pos == 0:
                continue
            if md[pos - 1] == '\n':
                # start of a line — likely a definition, not an inline ref
                continue
            refs.add(num)

        # Definitions: [^N] at start of line, or numbered list "1. Text" format
        defs = set(int(n) for n in re.findall(r'^\[\^(\d+)\]', md, re.MULTILINE))
        defs |= set(int(n) for n in re.findall(r'^(\d{1,3})\. \S', md, re.MULTILINE))

        # Trailing standalone number (page number candidate)
        trailing_num = None
        last_line = md.rstrip().rsplit('\n', 1)[-1].strip()
        if re.match(r'^\d{1,4}$', last_line):
            trailing_num = int(last_line)

        # Notes header detection
        has_notes_header = bool(
            re.search(r'\bNotes\b', header) or re.search(r'\bNOTES\b', header)
        )

        page_data.append({
            "refs": refs,
            "defs": defs,
            "trailing_number": trailing_num,
            "has_notes_header": has_notes_header,
        })

    # --- Step 2: Aggregate signals ---
    pages_with_refs = sum(1 for p in page_data if p["refs"])
    pages_with_defs = sum(1 for p in page_data if p["defs"])
    pages_with_both = sum(
        1 for p in page_data if p["refs"] & p["defs"]
    )

    co_location_ratio = (
        pages_with_both / pages_with_refs if pages_with_refs > 0 else 0.0
    )
    def_clustering_ratio = pages_with_defs / total_pages if total_pages > 0 else 0.0

    # Reset detection: when the lowest ref number on a page <= previous page's lowest ref
    reset_count = 0
    prev_min_ref = None
    for p in page_data:
        if p["refs"]:
            cur_min = min(p["refs"])
            if prev_min_ref is not None and cur_min <= prev_min_ref:
                reset_count += 1
            prev_min_ref = cur_min

    reset_frequency = reset_count / pages_with_refs if pages_with_refs > 0 else 0.0

    # Notes pages
    notes_page_indices = [i for i, p in enumerate(page_data) if p["has_notes_header"]]
    notes_page_count = len(notes_page_indices)

    # Page number detection via trailing numbers
    trailing_offsets = []
    for i, p in enumerate(page_data):
        if p["trailing_number"] is not None:
            trailing_offsets.append(p["trailing_number"] - i)

    if trailing_offsets:
        trailing_page_number_offset = median(trailing_offsets)
        matching = sum(
            1 for off in trailing_offsets if off == trailing_page_number_offset
        )
        trailing_page_number_consistency = matching / len(trailing_offsets)
    else:
        trailing_page_number_offset = None
        trailing_page_number_consistency = 0.0

    # Bibliography signal: how many pages does each ref number appear on?
    ref_page_spread = {}  # ref_number -> set of page indices
    for i, p in enumerate(page_data):
        for r in p["refs"]:
            ref_page_spread.setdefault(r, set()).add(i)

    ref_number_max_page_spread = (
        max(len(pgs) for pgs in ref_page_spread.values()) if ref_page_spread else 0
    )
    numbers_on_multiple_pages = sum(
        1 for pgs in ref_page_spread.values() if len(pgs) >= 2
    )

    all_refs = set()
    for p in page_data:
        all_refs |= p["refs"]
    max_ref_number = max(all_refs) if all_refs else 0

    signals = {
        "total_pages": total_pages,
        "pages_with_refs": pages_with_refs,
        "pages_with_defs": pages_with_defs,
        "pages_with_both": pages_with_both,
        "co_location_ratio": round(co_location_ratio, 4),
        "def_clustering_ratio": round(def_clustering_ratio, 4),
        "reset_count": reset_count,
        "reset_frequency": round(reset_frequency, 4),
        "notes_page_count": notes_page_count,
        "notes_page_indices": notes_page_indices,
        "trailing_page_number_offset": trailing_page_number_offset,
        "trailing_page_number_consistency": round(trailing_page_number_consistency, 4),
        "ref_number_max_page_spread": ref_number_max_page_spread,
        "numbers_on_multiple_pages": numbers_on_multiple_pages,
        "max_ref_number": max_ref_number,
    }

    # --- Step 3: Classification decision tree ---
    if pages_with_refs == 0:
        classification = "none"

    elif (ref_number_max_page_spread >= 3
          and co_location_ratio < 0.2
          and notes_page_count == 0
          and (reset_frequency < 0.2 or max_ref_number > 50)):
        classification = "wackSTEMbibliographyNotes"

    elif (co_location_ratio > 0.5
          and reset_frequency > 0.4):
        classification = "page_bottom"

    elif (notes_page_count > 0
          and co_location_ratio < 0.3):
        classification = "chapter_endnotes"

    # Chapter endnotes without "Notes" header — detected via resets + separate def pages
    elif (co_location_ratio < 0.3
          and pages_with_defs > 0
          and reset_frequency > 0.3):
        classification = "chapter_endnotes"

    elif (co_location_ratio < 0.15
          and def_clustering_ratio < 0.1):
        classification = "document_endnotes"

    else:
        classification = "unknown"

    # --- Step 4: Confidence scoring ---
    confidence = 0.0
    if classification == "page_bottom":
        if co_location_ratio > 0.8:
            confidence += 0.3
        if reset_frequency > 0.7:
            confidence += 0.3
        if notes_page_count == 0:
            confidence += 0.2
        if trailing_page_number_consistency > 0.5:
            confidence += 0.2

    elif classification == "chapter_endnotes":
        if notes_page_count > 0:
            confidence += 0.3
        if co_location_ratio < 0.1:
            confidence += 0.3
        if reset_count > 0:
            confidence += 0.2
        if def_clustering_ratio < 0.2:
            confidence += 0.2

    elif classification == "document_endnotes":
        if co_location_ratio < 0.05:
            confidence += 0.3
        if def_clustering_ratio < 0.05:
            confidence += 0.3
        if notes_page_count == 0:
            confidence += 0.2
        if reset_count == 0:
            confidence += 0.2

    elif classification == "wackSTEMbibliographyNotes":
        if ref_number_max_page_spread >= 5:
            confidence += 0.3
        if numbers_on_multiple_pages > 10:
            confidence += 0.3
        if co_location_ratio < 0.1:
            confidence += 0.2
        if notes_page_count == 0:
            confidence += 0.2

    elif classification == "none":
        confidence = 1.0

    # --- Build page summary (only pages with refs or defs) ---
    page_summary = []
    for i, p in enumerate(page_data):
        if p["refs"] or p["defs"]:
            page_summary.append({
                "index": i,
                "refs": sorted(p["refs"]),
                "defs": sorted(p["defs"]),
                "trailing_number": p["trailing_number"],
            })

    return {
        "version": 1,
        "classification": classification,
        "confidence": round(confidence, 2),
        "signals": signals,
        "page_summary": page_summary,
    }


def wrap_stem_citations(text):
    """Wrap inline [N] citations with <a class="wackSTEMcite"> tags.

    Handles single citations like [36], comma-separated multi-cites like [36, 72],
    and range citations like [6-8] (meaning refs 6, 7, 8).
    Only matches mid-line occurrences (not at start of line) with N <= 500.
    """
    def replace_range_cite(m):
        start, end = int(m.group(1)), int(m.group(2))
        if start >= end or end > 500:
            return m.group(0)
        refs = ','.join(f'stemref_{i}' for i in range(start, end + 1))
        return f'<a class="wackSTEMcite" data-refs="{refs}">[{start}-{end}]</a>'

    def replace_cite(m):
        inner = m.group(1)
        # Check if ALL numbers are <= 500
        nums = re.findall(r'\d+', inner)
        if not nums or any(int(n) > 500 for n in nums):
            return m.group(0)
        # Multi-cite: [36, 72] → separate tags joined by ", "
        if ',' in inner:
            parts = []
            for n in nums:
                parts.append(f'<a class="wackSTEMcite">[{n}]</a>')
            return ', '.join(parts)
        # Single cite
        return f'<a class="wackSTEMcite">[{inner.strip()}]</a>'

    # Range citations [N-M] first (before single/comma pattern consumes them)
    text = re.sub(r'(?<!^)(?<=.)\[(\d{1,3})-(\d{1,3})\]', replace_range_cite, text, flags=re.MULTILINE)
    # Match [N] or [N, N, ...] NOT at start of line
    text = re.sub(r'(?<!^)(?<=.)\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]', replace_cite, text, flags=re.MULTILINE)
    return text


def wrap_stem_definitions(text):
    """Wrap bibliography definitions at start of line with <a class="wackSTEMdef"> tags.

    Handles both formats:
      N. Author text...   → <a class="wackSTEMdef" id="stemref_N">N. Author text...</a>
      [N] Author text...  → <a class="wackSTEMdef" id="stemref_N">[N] Author text...</a>
    """
    def replace_numbered(m):
        num = m.group(1)
        if int(num) > 500:
            return m.group(0)
        return f'<a class="wackSTEMdef" id="stemref_{num}">{m.group(0)}</a>'

    def replace_bracketed(m):
        num = m.group(1)
        if int(num) > 500:
            return m.group(0)
        return f'<a class="wackSTEMdef" id="stemref_{num}">{m.group(0)}</a>'

    # Format 1: "N. text" at start of line (N <= 500)
    text = re.sub(r'^(\d{1,3})\. (.+)', replace_numbered, text, flags=re.MULTILINE)
    # Format 2: "[N] text" at start of line
    text = re.sub(r'^\[(\d{1,3})\] (.+)', replace_bracketed, text, flags=re.MULTILINE)
    return text


def assemble_markdown(response_dict, classification="unknown", footnote_meta=None):
    """Assemble pages into markdown, injecting section headings from headers."""
    pages = response_dict["pages"]

    # Extract page number offset for stripping trailing page numbers
    page_number_offset = None
    if footnote_meta and footnote_meta.get('signals', {}).get('trailing_page_number_consistency', 0) > 0.5:
        page_number_offset = footnote_meta['signals'].get('trailing_page_number_offset')
    md_parts = []
    seen_sections = set()
    # Track repeated headers to identify running headers (book title etc.)
    header_counts = {}
    for page in pages:
        header = page.get("header") or ""
        for line in header.split('\n'):
            name = extract_section_name(line)
            if name:
                header_counts[name] = header_counts.get(name, 0) + 1

    # Headers appearing on >40% of pages are likely running headers (book title)
    threshold = max(3, len(pages) * 0.4)
    running_headers = {name for name, count in header_counts.items() if count >= threshold}

    global_fn_counter = 1  # For page_bottom renumbering
    fn_defs_parts = []  # Collected footnote definitions for page_bottom

    for i, page in enumerate(pages):
        md = page.get("markdown", "")
        header = page.get("header") or ""
        md_stripped = md.strip()
        is_notes_page = "Notes" in header or "NOTES" in header

        # Replace trailing page number with inline anchor tag
        if page_number_offset is not None:
            expected = i + page_number_offset
            last_line = md_stripped.rsplit('\n', 1)[-1].strip() if md_stripped else ''
            if re.match(r'^\d{1,4}$', last_line) and int(last_line) == expected:
                md = md.rstrip()
                md = md[:md.rfind('\n')].rstrip() if '\n' in md else ''
                md += f' <a class="pageNumber" data-page="{int(expected)}"></a>'
                md_stripped = md.strip()

        # Extract section name from header
        section_name = None
        for line in header.split('\n'):
            name = extract_section_name(line)
            if name and name not in running_headers:
                section_name = name
                break

        # Only inject a heading from the header when ALL of:
        # 1. We got a real section name (not a running header / page number)
        # 2. This section hasn't been seen before
        # 3. The markdown body doesn't already start with a # heading
        # 4. The body starts with uppercase (new section, not a paragraph continuation)
        if (section_name
                and section_name not in seen_sections
                and not md_stripped.startswith('#')
                and md_stripped
                and md_stripped[0].isupper()):
            seen_sections.add(section_name)
            md = f"# {section_name}\n\n{md}"

        # Track sections from headings Mistral already detected in the body
        if md_stripped.startswith('#'):
            heading_text = re.sub(r'^#+\s*', '', md_stripped.split('\n')[0])
            seen_sections.add(heading_text)

        # Convert numbered notes to footnote definitions on Notes pages
        if is_notes_page and classification != "wackSTEMbibliographyNotes":
            md = re.sub(r'^(\d{1,3})\. (.+)', r'[^\1]: \2', md, flags=re.MULTILINE)

        # Renumber footnotes per-page for page_bottom classification
        if classification == "page_bottom":
            md, global_fn_counter = renumber_page_footnotes(md, global_fn_counter)
            body, fn_text = split_body_and_footnotes(md)
            if body.strip():
                md_parts.append(body)
            if fn_text.strip():
                fn_defs_parts.append(fn_text)
        elif md_stripped:
            md_parts.append(md)

    combined = "\n\n".join(md_parts)

    if classification == "wackSTEMbibliographyNotes":
        combined = wrap_stem_citations(combined)
        combined = wrap_stem_definitions(combined)
    elif classification == "page_bottom":
        # Rejoin body text only (footnotes were separated per-page)
        combined = rejoin_page_breaks(combined)
        # Format and append collected footnote definitions
        fn_defs = "\n\n".join(fn_defs_parts)
        fn_defs = re.sub(r'^(\[\^\d+\])\s+(?=[A-Z\d])', r'\1: ', fn_defs, flags=re.MULTILINE)
        if fn_defs.strip():
            combined = combined + "\n\n" + fn_defs
        return combined
    else:
        combined = convert_footnotes(combined)
        # Fix footnote definitions: OCR produces [^N] Text but markdown expects [^N]: Text
        # Only at start of line (definitions), not inline references
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Z\d])', r'\1: ', combined, flags=re.MULTILINE)

    combined = rejoin_page_breaks(combined)
    return combined


def save_images(response_dict, media_dir):
    """Extract and save base64-encoded images from the OCR response."""
    media_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for page in response_dict["pages"]:
        for img in page.get("images", []):
            img_id = img.get("id", "")
            img_b64 = img.get("image_base64", "")
            if not img_b64 or not img_id:
                continue
            # Strip data URI prefix if present
            if img_b64.startswith("data:"):
                img_b64 = img_b64.split(",", 1)[1]
            img_path = media_dir / img_id
            img_path.write_bytes(base64.b64decode(img_b64))
            count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description="Convert PDF to markdown via Mistral OCR")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("output_dir", help="Directory for output files")
    parser.add_argument("--api-key", help="Mistral API key (or set MISTRAL_OCR_API_KEY env var)")
    parser.add_argument("--no-cache", action="store_true", help="Force re-download from Mistral")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("MISTRAL_OCR_API_KEY")
    if not api_key:
        print("Error: No API key provided. Use --api-key or set MISTRAL_OCR_API_KEY.", file=sys.stderr)
        sys.exit(1)

    pdf_path = Path(args.pdf_path)
    output_dir = Path(args.output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    json_cache = output_dir / "ocr_response.json"

    if not pdf_path.exists() and not json_cache.exists():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)
    output_md = output_dir / "main-text.md"
    media_dir = output_dir / "media"

    # Fetch or load cached OCR response
    if json_cache.exists() and not args.no_cache:
        print(f"Using cached OCR response: {json_cache}")
        response_dict = json.loads(json_cache.read_text(encoding="utf-8"))
    else:
        response_dict = fetch_ocr(pdf_path, api_key)
        json_cache.write_text(json.dumps(response_dict), encoding="utf-8")
        print(f"Cached raw response to: {json_cache}")

    # Classify footnote style
    footnote_meta = classify_footnotes(response_dict)
    meta_path = output_dir / "footnote_meta.json"
    meta_path.write_text(json.dumps(footnote_meta, indent=2), encoding="utf-8")
    print(f"Footnote classification: {footnote_meta['classification']} "
          f"(confidence: {footnote_meta['confidence']:.2f})")

    # Save images to media/ subdirectory
    img_count = save_images(response_dict, media_dir)
    if img_count:
        print(f"Saved {img_count} images to {media_dir}")

    # Assemble markdown
    print("Assembling markdown...")
    markdown = assemble_markdown(response_dict, classification=footnote_meta['classification'], footnote_meta=footnote_meta)
    output_md.write_text(markdown, encoding="utf-8")

    # Stats
    fn_count = len(re.findall(r'\[\^\d+\]', markdown))
    heading_count = len(re.findall(r'^#{1,6} ', markdown, re.MULTILINE))

    print(f"\nSaved to: {output_md}")
    print(f"Total chars: {len(markdown)}")
    print(f"Footnotes: {fn_count}")
    print(f"Headings: {heading_count}")


if __name__ == "__main__":
    main()

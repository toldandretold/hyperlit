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
from pypdf import PdfReader

SUPERSCRIPT_MAP = str.maketrans("\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079", "0123456789")


def convert_footnotes(text):
    """Convert Unicode superscript numbers to [^N] markdown footnotes."""
    def replace_fn(m):
        num = m.group(0).translate(SUPERSCRIPT_MAP)
        return f"[^{num}]"
    return re.sub(r'[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+', replace_fn, text)


def normalize_all_footnote_refs(text):
    """Convert [N], bare numbers after punctuation, and LaTeX superscripts to [^N].

    Uses sequential validation: candidates are only converted if their number
    fits within the sequence of already-known [^N] refs. This prevents false
    positives like [2015] or table numbers from being converted.
    """
    # Step 1: Convert Unicode superscripts (already reliable)
    text = convert_footnotes(text)

    # Step 2: Convert LaTeX superscripts: $^{5}$ or $^5$ → [^5]
    text = re.sub(r'\$\^\{?(\d+)\}?\$', r'[^\1]', text)

    # Step 3: Collect known [^N] positions
    known = [(m.start(), int(m.group(1))) for m in re.finditer(r'\[\^(\d+)\]', text)]
    if not known:
        return text

    max_known = max(n for _, n in known)

    # Step 4: Collect candidates

    # [N] not at line start, not inside links/images (][, ](, ![)
    bracket_candidates = []
    for m in re.finditer(r'\[(\d+)\]', text):
        num = int(m.group(1))
        if num > 500 or num < 1:
            continue
        pos = m.start()
        # Skip line-start occurrences (definitions, not refs)
        if pos == 0 or text[pos - 1] == '\n':
            continue
        # Skip if part of markdown link/image syntax
        if pos > 0 and text[pos - 1] in (']', '!'):
            continue
        if m.end() < len(text) and text[m.end()] == '(':
            continue
        bracket_candidates.append((pos, num, m.start(), m.end(), 'bracket'))

    # Bare numbers after punctuation: .46 , ,47 — sentence-ending punctuation followed by number+space
    bare_candidates = []
    for m in re.finditer(r'(?<=[.,;:!?])(\d{1,3})\s', text):
        num = int(m.group(1))
        if num > 500 or num < 1:
            continue
        pos = m.start()
        # Skip if at line start
        if pos == 0 or text[pos - 1] == '\n':
            continue
        bare_candidates.append((pos, num, m.start(), m.start() + len(m.group(1)), 'bare'))

    all_candidates = bracket_candidates + bare_candidates
    if not all_candidates:
        return text

    # Step 5: Merge known + candidates, sort by position
    all_entries = [(pos, num, 'known') for pos, num in known]
    all_entries += [(pos, num, kind) for pos, num, _s, _e, kind in all_candidates]
    all_entries.sort(key=lambda x: x[0])

    # Build lookup for candidate replacement spans
    candidate_spans = {}
    for pos, num, start, end, kind in (bracket_candidates + bare_candidates):
        candidate_spans[pos] = (start, end, kind, num)

    # Step 6: Validate candidates against the known sequence
    validated = []
    for i, (pos, num, entry_kind) in enumerate(all_entries):
        if entry_kind == 'known':
            continue

        # Find nearest known refs before and after this position
        prev_known = None
        next_known = None
        for j in range(i - 1, -1, -1):
            if all_entries[j][2] == 'known':
                prev_known = all_entries[j][1]
                break
        for j in range(i + 1, len(all_entries)):
            if all_entries[j][2] == 'known':
                next_known = all_entries[j][1]
                break

        # Validate: number must fit between surrounding knowns
        valid = True
        if prev_known is not None and num <= prev_known:
            valid = False
        if next_known is not None and num >= next_known:
            valid = False
        # Must not exceed reasonable range
        if num > max_known + 20:
            valid = False
        # If no surrounding knowns at all, require number to be in range
        if prev_known is None and next_known is None:
            valid = False

        if valid:
            validated.append(pos)

    # Step 7: Replace validated candidates (work backwards to preserve positions)
    validated_set = set(validated)
    replacements = []
    for pos, num, start, end, kind in (bracket_candidates + bare_candidates):
        if pos in validated_set:
            replacements.append((start, end, f'[^{num}]'))

    # Sort by start position descending so replacements don't shift later positions
    replacements.sort(key=lambda x: x[0], reverse=True)
    for start, end, replacement in replacements:
        text = text[:start] + replacement + text[end:]

    return text


def normalize_footnote_defs(text):
    """Convert [N] at line start to [^N] definitions using the same sequential logic.

    Line-start [N] followed by text are likely footnote definitions if the number
    fits the document's footnote sequence.
    """
    # Collect known [^N] definition numbers
    known_def_nums = set(int(n) for n in re.findall(r'^\[\^(\d+)\]', text, re.MULTILINE))
    if not known_def_nums:
        return text

    max_known = max(known_def_nums)

    # Find line-start [N] that look like definitions
    def replace_def(m):
        num = int(m.group(1))
        if num in known_def_nums:
            return m.group(0)  # Already a known def — shouldn't happen, but safe
        if num > max_known + 20 or num < 1:
            return m.group(0)
        return f'[^{num}]{m.group(2)}'

    text = re.sub(r'^\[(\d+)\]( .)', replace_def, text, flags=re.MULTILINE)
    return text


def renumber_page_footnotes(page_md, global_counter):
    """Renumber footnotes on a single page from local numbering to global sequential.

    For "page_bottom" documents where each page restarts at [^1].
    Converts superscripts first, then maps local numbers to global ones.

    Returns (processed_md, new_global_counter).
    """
    # First convert any Unicode superscripts to [^N] format
    page_md = convert_footnotes(page_md)

    # Convert LaTeX superscripts: $^{5}$ or $^5$ → [^5]
    page_md = re.sub(r'\$\^\{?(\d+)\}?\$', r'[^\1]', page_md)

    # Convert inline [N] → [^N] (not at line start, N < 500)
    # Since we know this is page_bottom, inline [N] are footnote refs
    def convert_bracket_ref(m):
        num = int(m.group(1))
        if num > 500 or num < 1:
            return m.group(0)
        pos = m.start()
        if pos == 0 or page_md[pos - 1] == '\n':
            return m.group(0)  # Line-start = definition, not ref
        if pos > 0 and page_md[pos - 1] in (']', '!'):
            return m.group(0)  # Part of markdown link/image
        if m.end() < len(page_md) and page_md[m.end()] == '(':
            return m.group(0)
        return f'[^{m.group(1)}]'
    page_md = re.sub(r'\[(\d+)\]', convert_bracket_ref, page_md)

    # Convert bare numbers after sentence-ending punctuation: .46 This → .[^46] This
    # Only when followed by space + uppercase letter/opening quote (new sentence)
    # (?<!\d\.) prevents matching decimal numbers like "4.0" or "1.9 million"
    # (?<![A-Z]\.) prevents matching section/table numbering like "I.1", "V.2"
    page_md = re.sub(
        r'(?<!\d\.)(?<![A-Z]\.)(?<=[.!?"\u201d\u201c)])(\d{1,3})(?=\s+[A-Z\u201c\u201d"\u2018\'(])',
        r'[^\1]',
        page_md,
        flags=re.DOTALL
    )

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
    match = re.search(r'^\[\^\d+\]\s*:?\s*[A-Za-z\d"\'(*\u201c\u2018]', md, re.MULTILINE)
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

    file_size = pdf_path.stat().st_size
    print(f"Uploading {pdf_path.name} ({file_size / 1024 / 1024:.1f}MB)...")
    uploaded_file = client.files.upload(
        file={"file_name": pdf_path.name, "content": pdf_path.read_bytes()},
        purpose="ocr",
    )
    print(f"Upload response: id={uploaded_file.id}")
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

        # Definitions: [^N] at start of line, or numbered list "1. Text" format,
        # or "N Text" format (no period — common in document endnotes)
        defs = set(int(n) for n in re.findall(r'^\[\^(\d+)\]', md, re.MULTILINE))
        defs |= set(int(n) for n in re.findall(r'^(\d{1,3})\. \S', md, re.MULTILINE))
        defs |= set(int(n) for n in re.findall(r'^(\d{1,3}) [A-Z\u2018\u201c\'"]', md, re.MULTILINE))

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
          and reset_count <= 3
          and (reset_frequency < 0.2 or max_ref_number > 50)):
        classification = "wackSTEMbibliographyNotes"

    # Page-bottom with continuous numbering (no resets across pages)
    elif (co_location_ratio > 0.4
          and pages_with_both >= 3
          and reset_frequency < 0.1
          and max_ref_number > 10):
        classification = "page_bottom"

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

    # Chapter endnotes with well-separated defs/refs and multiple number resets
    elif (co_location_ratio < 0.15
          and pages_with_defs > 5
          and reset_count >= 3):
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
        elif co_location_ratio > 0.4:
            confidence += 0.15
        if reset_frequency > 0.7:
            confidence += 0.3
        elif reset_frequency < 0.1 and max_ref_number > 10:
            # Continuous numbering — high max ref is a strong signal
            confidence += 0.25
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


def fix_mangled_urls(text, pdf_path):
    """Fix URLs mangled by Mistral OCR into HTML-attribute format.

    OCR produces: <https: about-matrade="" en="" www.example.com="">
    Real URL is:  <https://www.example.com/en/about-matrade/>

    Uses pypdf to extract real URLs and matches by domain.
    """
    # Find all mangled URLs
    mangled_pattern = re.compile(r'<https?:\s[^>]*?=""[^>]*>')
    mangled_urls = mangled_pattern.findall(text)
    if not mangled_urls:
        return text

    # Extract real URLs from pypdf (all pages)
    reader = PdfReader(pdf_path)
    real_urls = []
    for page in reader.pages:
        page_text = page.extract_text() or ''
        # pypdf URLs may span lines; capture generously
        for m in re.finditer(r'https?://[^\s>)\]]+', page_text):
            real_urls.append(m.group().rstrip('.,;:'))

    # Build domain → [url, url, ...] map (preserving order)
    from collections import defaultdict
    domain_map = defaultdict(list)
    for url in real_urls:
        m = re.match(r'https?://([^/]+)', url)
        if m:
            domain_map[m.group(1).lower()].append(url)

    # Track which real URLs have been used per domain
    domain_used = defaultdict(int)

    def replace_mangled(m):
        mangled = m.group(0)
        # Extract attributes (the ="" parts)
        attrs = re.findall(r'([\w./?&=%~+:@!-]+)=""', mangled)
        if not attrs:
            return mangled

        # Identify domain: attribute with dots that looks like a hostname
        domain = None
        for attr in attrs:
            if re.match(r'^[\w-]+\.[\w.-]+\.\w{2,}$', attr):
                domain = attr.lower()
                break
        # Fallback: any attr with a dot
        if not domain:
            for attr in attrs:
                if '.' in attr and not attr.endswith('.pdf') and not attr.endswith('.html'):
                    domain = attr.lower()
                    break

        if domain and domain in domain_map:
            idx = domain_used[domain]
            urls = domain_map[domain]
            if idx < len(urls):
                domain_used[domain] += 1
                return f'<{urls[idx]}>'
            # More mangled than real — reconstruct
        # No pypdf match — reconstruct from parts
        if domain:
            path_parts = [a for a in attrs if a.lower() != domain]
            return f'<https://{domain}/{"/".join(path_parts)}>'
        return mangled

    text = mangled_pattern.sub(replace_mangled, text)
    # Remove closing tags: </https:>
    text = re.sub(r'</https?:[^>]*>', '', text)
    return text


def extract_pypdf_footnote_defs(pdf_path, running_headers=None):
    """Extract per-page footnote definitions from PDF using pypdf.

    Returns dict: {page_index: [(fn_number, definition_text), ...]}
    """
    reader = PdfReader(pdf_path)
    running_headers = running_headers or set()
    # Build lowercase set for matching
    running_lower = {h.lower().strip() for h in running_headers}

    # Copyright boilerplate pattern to strip from each page
    boilerplate_re = re.compile(
        r'East Asian Policy \d{4}\.\d+:\d+-\d+\. Downloaded from.*$',
        re.DOTALL
    )

    result = {}
    for page_idx in range(len(reader.pages)):
        text = reader.pages[page_idx].extract_text()
        if not text:
            continue

        # Strip copyright boilerplate
        text = boilerplate_re.sub('', text).rstrip()

        # Split into lines
        lines = text.split('\n')

        # Find footnote definitions: bare number at line start, 1-3 spaces, then text
        defs = []
        current_num = None
        current_text = None

        for line in lines:
            # Match: number (1-3 digits), 1-3 spaces, then text starting with uppercase, quote, or open paren
            m = re.match(r'^(\d{1,3})\s{1,3}([A-Z"\'(\u201c\u2018].{2,})', line)
            if m:
                num = int(m.group(1))
                def_text = m.group(2).strip()

                # Filter out page number lines like "116  east asian policy"
                # Check if the text (lowercased) starts with a running header
                is_page_num = False
                text_lower = def_text.lower().strip()
                for rh in running_lower:
                    if text_lower.startswith(rh):
                        is_page_num = True
                        break

                if is_page_num:
                    continue

                # Save previous definition if any
                if current_num is not None:
                    defs.append((current_num, current_text))

                current_num = num
                current_text = def_text
            elif current_num is not None:
                # Continuation line: non-empty, starts with lowercase, space, or quote
                stripped = line.strip()
                if stripped and not re.match(r'^\d{1,3}\s{1,3}[A-Z"\'(\u201c\u2018]', line):
                    current_text += ' ' + stripped
                else:
                    # Non-continuation: save current and reset
                    defs.append((current_num, current_text))
                    current_num = None
                    current_text = None

        # Save final definition
        if current_num is not None:
            defs.append((current_num, current_text))

        if defs:
            result[page_idx] = defs

    return result


def recover_missing_defs(ocr_defs_set, pypdf_defs_by_page, max_ref_number):
    """Return list of (number, text) for footnotes missing from OCR.

    Args:
        ocr_defs_set: set of footnote numbers already present as definitions
        pypdf_defs_by_page: output from extract_pypdf_footnote_defs()
        max_ref_number: highest footnote ref number in the document
    """
    recovered = []
    seen = set()
    for page_idx in sorted(pypdf_defs_by_page.keys()):
        for fn_num, fn_text in pypdf_defs_by_page[page_idx]:
            if fn_num in ocr_defs_set:
                continue
            if fn_num < 1 or fn_num > max_ref_number:
                continue
            if fn_num in seen:
                continue
            seen.add(fn_num)
            recovered.append((fn_num, fn_text))
    return recovered


def assemble_markdown(response_dict, classification="unknown", footnote_meta=None, pdf_path=None):
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

    # Build set of definition-heavy page indices from footnote_meta.
    # Two filters to avoid false positives (e.g., numbered lists in body text):
    # 1. Exclude pages that also have refs (body pages, not notes pages)
    # 2. Require a neighboring page also be def-heavy (notes pages cluster together)
    def_heavy_pages = set()
    if footnote_meta and classification == "chapter_endnotes":
        candidates = set()
        for entry in footnote_meta.get('page_summary', []):
            if len(entry.get('defs', [])) >= 3 and not entry.get('refs'):
                candidates.add(entry['index'])
        for p in candidates:
            if (p - 1) in candidates or (p + 1) in candidates:
                def_heavy_pages.add(p)

    # Pre-compute chapter offsets for chapter_endnotes renumbering.
    # Each chapter restarts footnote numbering at 1; we offset them to be globally unique.
    chapter_fn_offsets = None
    notes_transition_pages = {}  # page_idx → (threshold, old_offset, new_offset)
    if classification == "chapter_endnotes" and footnote_meta:
        chapter_fn_offsets = [0] * len(pages)
        cumulative = 0
        ch_max = 0          # max footnote number in current chapter (refs + defs)
        ref_ch_max = 0      # max ref number in current chapter (for detecting resets)

        for entry in footnote_meta.get('page_summary', []):
            refs = entry.get('refs', [])
            defs = entry.get('defs', [])

            if defs:
                ch_max = max(ch_max, max(defs))

            if refs:
                ref_max = max(refs)
                if ref_ch_max > 10 and ref_max < ref_ch_max * 0.5:
                    # Number reset — new chapter
                    cumulative += ch_max
                    ch_max = ref_max
                    ref_ch_max = ref_max
                    for j in range(entry['index'], len(pages)):
                        chapter_fn_offsets[j] = cumulative
                else:
                    ch_max = max(ch_max, ref_max)
                    ref_ch_max = max(ref_ch_max, ref_max)

        # --- Extend offsets into the notes section ---
        # Build ordered list of body chapter offsets
        body_offsets = sorted(set(chapter_fn_offsets))

        # Find last page with refs (notes section starts after this)
        last_ref_page = 0
        for entry in footnote_meta.get('page_summary', []):
            if entry.get('refs'):
                last_ref_page = max(last_ref_page, entry['index'])

        # In notes section, detect def resets and assign matching body chapter offsets.
        # Transition pages (where one chapter ends and the next begins) need per-def
        # offsets since they contain defs from two different chapters.
        notes_ch_idx = 0
        notes_def_max = 0
        for entry in footnote_meta.get('page_summary', []):
            if entry['index'] <= last_ref_page:
                continue
            defs = entry.get('defs', [])
            if not defs:
                continue
            def_max = max(defs)
            def_min = min(defs)
            if notes_def_max > 5 and def_min < notes_def_max * 0.3:
                # Record old offset before advancing chapter
                old_offset = body_offsets[notes_ch_idx] if notes_ch_idx < len(body_offsets) else 0
                threshold = notes_def_max * 0.5
                notes_ch_idx += 1
                # On transition pages, old chapter defs may still appear.
                # Only track new chapter's defs (below the reset threshold).
                new_ch_defs = [d for d in defs if d < threshold]
                notes_def_max = max(new_ch_defs) if new_ch_defs else def_min

                if notes_ch_idx < len(body_offsets):
                    new_offset = body_offsets[notes_ch_idx]
                    # Mark this as a transition page for per-def offsetting
                    notes_transition_pages[entry['index']] = (threshold, old_offset, new_offset)
                    # Start new offset on the NEXT page (transition page handled specially)
                    for j in range(entry['index'] + 1, len(pages)):
                        chapter_fn_offsets[j] = new_offset
            else:
                notes_def_max = max(notes_def_max, def_max)

                if notes_ch_idx < len(body_offsets):
                    offset = body_offsets[notes_ch_idx]
                    for j in range(entry['index'], len(pages)):
                        chapter_fn_offsets[j] = offset

    # Sticky notes section tracking: once we enter "Notes" at the end of the
    # book, stay in notes mode until we hit Acknowledgements/Bibliography/etc.
    in_notes_section = False
    last_ref_page_idx = 0
    if footnote_meta:
        for entry in footnote_meta.get('page_summary', []):
            if entry.get('refs'):
                last_ref_page_idx = max(last_ref_page_idx, entry['index'])

    for i, page in enumerate(pages):
        md = page.get("markdown", "")
        header = page.get("header") or ""
        md_stripped = md.strip()

        # Sticky notes section — only triggers AFTER all body refs are done.
        # This prevents mid-book "Notes" headings (in chapter-endnote books like
        # Road from Mont Pelerin) from accidentally flagging body pages.
        if not in_notes_section and i > last_ref_page_idx:
            if "Notes" in header or "NOTES" in header or "Footnotes" in header:
                in_notes_section = True
            elif re.search(r'^#+ *(Foot)?[Nn]otes\b', md_stripped):
                in_notes_section = True

        # Detect leaving notes section (Acknowledgements, Bibliography, Index, etc.)
        if in_notes_section:
            if re.search(r'^#+ *(Acknowledg|Bibliograph|Index|Appendi|General Bibliography)', md_stripped):
                in_notes_section = False

        is_notes_page = ("Notes" in header or "NOTES" in header
                          or i in def_heavy_pages
                          or in_notes_section)

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
            # Also handle N text format (no period) — common in document endnotes
            md = re.sub(r'^(\d{1,3}) ([A-Z\u2018\u201c\'"])', r'[^\1]: \2', md, flags=re.MULTILINE)
            # Also handle [N] text format — bracket-wrapped definitions
            md = re.sub(r'^\[(\d{1,3})\] (.+)', r'[^\1]: \2', md, flags=re.MULTILINE)

        # Renumber footnotes per-page for page_bottom classification
        if classification == "page_bottom":
            md, global_fn_counter = renumber_page_footnotes(md, global_fn_counter)
            body, fn_text = split_body_and_footnotes(md)
            if body.strip():
                md_parts.append(body)
            if fn_text.strip():
                fn_defs_parts.append(fn_text)
        elif classification == "chapter_endnotes":
            # Convert all footnote ref formats to [^N] (before offset)
            md = convert_footnotes(md)
            md = re.sub(r'\$\^\{?(\d+)\}?\$', r'[^\1]', md)

            # Convert inline [N] → [^N] (bracket refs from OCR)
            def _convert_bracket(m, _md=md):
                num = int(m.group(1))
                if num > 500 or num < 1:
                    return m.group(0)
                pos = m.start()
                if pos == 0 or _md[pos - 1] == '\n':
                    return m.group(0)
                if pos > 0 and _md[pos - 1] in (']', '!'):
                    return m.group(0)
                if m.end() < len(_md) and _md[m.end()] == '(':
                    return m.group(0)
                return f'[^{m.group(1)}]'
            md = re.sub(r'\[(\d+)\]', _convert_bracket, md)

            # Convert bare numbers after punctuation: .46 This → .[^46] This
            # (?<![A-Z]\.) rejects section/table numbering like "I.1", "V.2"
            md = re.sub(
                r'(?<!\d\.)(?<![A-Z]\.)(?<=[.!?"\u201d\u201c)])(\d{1,3})(?=\s+[A-Z\u201c\u201d"\u2018\'(])',
                r'[^\1]',
                md,
                flags=re.DOTALL
            )

            # Apply chapter offset for global uniqueness
            if chapter_fn_offsets:
                if i in notes_transition_pages:
                    # Transition page: old chapter tail + new chapter start need different offsets
                    threshold, old_off, new_off = notes_transition_pages[i]
                    def _apply_transition(m, _thr=threshold, _old=old_off, _new=new_off):
                        num = int(m.group(1))
                        off = _old if num >= _thr else _new
                        return f'[^{num + off}]' if off > 0 else m.group(0)
                    md = re.sub(r'\[\^(\d+)\]', _apply_transition, md)
                else:
                    offset = chapter_fn_offsets[i]
                    if offset > 0:
                        md = re.sub(
                            r'\[\^(\d+)\]',
                            lambda m: f'[^{int(m.group(1)) + offset}]',
                            md
                        )

            if md_stripped:
                md_parts.append(md)
        elif classification == "document_endnotes":
            md = convert_footnotes(md)
            md = re.sub(r'\$\^\{?(\d+)\}?\$', r'[^\1]', md)
            # Strip italic wrapping around numeric bracket refs: *[2]* → [2]
            md = re.sub(r'\*\[(\d{1,3})\]\*', r'[\1]', md)
            # Convert inline [N] → [^N] (not at line start, not markdown links)
            def _convert_bracket_endnote(m, _md=md):
                num = int(m.group(1))
                if num > 500 or num < 1:
                    return m.group(0)
                pos = m.start()
                if pos == 0 or _md[pos - 1] == '\n':
                    return m.group(0)
                if pos > 0 and _md[pos - 1] in (']', '!'):
                    return m.group(0)
                if m.end() < len(_md) and _md[m.end()] == '(':
                    return m.group(0)
                return f'[^{m.group(1)}]'
            md = re.sub(r'\[(\d+)\]', _convert_bracket_endnote, md)
            # Convert bare numbers after punctuation
            md = re.sub(
                r'(?<!\d\.)(?<![A-Z]\.)(?<=[.!?"\u201d\u201c)])(\d{1,3})(?=\s+[A-Z\u201c\u201d"\u2018\'(])',
                r'[^\1]',
                md,
                flags=re.DOTALL
            )
            if md_stripped:
                md_parts.append(md)
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
        fn_defs = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*\u201c\u2018])', r'\1: ', fn_defs, flags=re.MULTILINE)
        if fn_defs.strip():
            combined = combined + "\n\n" + fn_defs
    elif classification == "chapter_endnotes":
        # Superscripts already converted per-page with chapter offsets applied.
        # Fix def formatting and rejoin page breaks.
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*\u201c\u2018])', r'\1: ', combined, flags=re.MULTILINE)
        combined = rejoin_page_breaks(combined)
    elif classification == "document_endnotes":
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*\u201c\u2018])', r'\1: ', combined, flags=re.MULTILINE)
        combined = rejoin_page_breaks(combined)
    else:
        combined = normalize_all_footnote_refs(combined)
        combined = normalize_footnote_defs(combined)
        # Fix footnote definitions: OCR produces [^N] Text but markdown expects [^N]: Text
        # Only at start of line (definitions), not inline references
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*\u201c\u2018])', r'\1: ', combined, flags=re.MULTILINE)
        combined = rejoin_page_breaks(combined)

    # --- Fix mangled URLs from OCR ---
    if pdf_path:
        combined = fix_mangled_urls(combined, pdf_path)

    # --- pypdf fallback: recover missing footnote definitions ---
    # Skip for chapter_endnotes — renumbered offsets don't match pypdf's original numbers
    if pdf_path and classification not in ("wackSTEMbibliographyNotes", "chapter_endnotes"):
        # Collect definition numbers already in the assembled text
        ocr_def_nums = set(int(n) for n in re.findall(r'^\[\^(\d+)\]\s*:', combined, re.MULTILINE))
        # Collect all inline ref numbers
        ref_nums = set(int(n) for n in re.findall(r'\[\^(\d+)\]', combined))
        # Find refs that have no definition
        missing = ref_nums - ocr_def_nums
        if missing:
            max_ref = max(ref_nums) if ref_nums else 0
            pypdf_defs = extract_pypdf_footnote_defs(pdf_path, running_headers)
            recovered = recover_missing_defs(ocr_def_nums, pypdf_defs, max_ref)
            if recovered:
                recovered_lines = [f'[^{num}]: {text}' for num, text in recovered]
                combined = combined.rstrip() + "\n\n" + "\n\n".join(recovered_lines)
                print(f"  pypdf fallback: recovered {len(recovered)} missing footnote definitions")

    # --- Convert <url> autolinks to clickable links ---
    # Angle-bracket URLs like <https://example.com> get stripped by HTML parsers.
    # Use <a> tags directly since footnote content is stored as HTML.
    combined = re.sub(
        r'<(https?://[^>]+)>',
        r'<a href="\1" target="_blank">\1</a>',
        combined
    )

    # --- Reorder image-before-caption → caption-before-image ---
    # OCR places images before their figure/table captions.  Swap so the
    # caption (e.g. "FIGURE 4 …") sits above its image for readability.
    combined = re.sub(
        r'^(!\[[^\]]*\]\([^)]+\))\n+((?:FIGURE|TABLE|CHART|GRAPH)\s.+)',
        r'\2\n\1',
        combined,
        flags=re.MULTILINE | re.IGNORECASE,
    )

    # --- Add ## Footnotes heading before definitions ---
    # Find the first footnote definition and insert heading before it
    fn_heading_match = re.search(r'^(\[\^\d+\]\s*:)', combined, re.MULTILINE)
    if fn_heading_match:
        pos = fn_heading_match.start()
        combined = combined[:pos].rstrip() + "\n\n## Footnotes\n\n" + combined[pos:]

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
    markdown = assemble_markdown(response_dict, classification=footnote_meta['classification'], footnote_meta=footnote_meta, pdf_path=pdf_path)
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

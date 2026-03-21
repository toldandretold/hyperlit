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
from mistralai.client import Mistral

SUPERSCRIPT_MAP = str.maketrans("\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079", "0123456789")


def convert_footnotes(text):
    """Convert Unicode superscript numbers to [^N] markdown footnotes."""
    def replace_fn(m):
        num = m.group(0).translate(SUPERSCRIPT_MAP)
        return f"[^{num}]"
    return re.sub(r'[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+', replace_fn, text)


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
            if (not stripped.endswith(('.', '!', '?', ':', ';', '"', ')', ']', '---'))
                    and next_nonempty[0].islower()
                    and not next_nonempty.startswith('#')
                    and len(stripped) > 20):
                result.append(stripped + ' ' + next_nonempty)
                i = next_idx + 1
                continue

        result.append(line)
        i += 1

    return '\n'.join(result)


def assemble_markdown(response_dict):
    """Assemble pages into markdown, injecting section headings from headers."""
    pages = response_dict["pages"]
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

    for page in pages:
        md = page.get("markdown", "")
        header = page.get("header") or ""
        md_stripped = md.strip()
        is_notes_page = "Notes" in header or "NOTES" in header

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
        if is_notes_page:
            md = re.sub(r'^(\d{1,3})\. (.+)', r'[^\1]: \2', md, flags=re.MULTILINE)

        if md_stripped:
            md_parts.append(md)

    combined = "\n\n".join(md_parts)
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

    if not pdf_path.exists():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)
    json_cache = output_dir / "ocr_response.json"
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

    # Save images to media/ subdirectory
    img_count = save_images(response_dict, media_dir)
    if img_count:
        print(f"Saved {img_count} images to {media_dir}")

    # Assemble markdown
    print("Assembling markdown...")
    markdown = assemble_markdown(response_dict)
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

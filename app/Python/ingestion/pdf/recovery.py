"""Phase ③ — footnote RECOVERY + fidelity: resurrect mangled/missed notes from the PDF bytes via pypdf (mojibake re-OCR, missing-def fill), fix mangled URLs, and assess_harvest_fidelity (whose bug is a missing/duplicated footnote — ours vs an upstream OCR ceiling)."""
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

from ingestion.pdf.pdf_shared import *  # noqa: F401,F403

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


def recover_missing_defs(ocr_defs_set, pypdf_defs_by_page, max_ref_number,
                          page_offsets=None, targeted_pages=None,
                          allow_overwrite=False):
    """Return list of (number, text) for footnotes missing from OCR.

    Args:
        ocr_defs_set: set of footnote numbers already present as definitions
        pypdf_defs_by_page: output from extract_pypdf_footnote_defs()
        max_ref_number: highest footnote ref number in the document
        page_offsets: optional dict[page_idx, int] of offsets to add to each
            pypdf-extracted fn_num before matching. Used for multi-paper PDFs
            where the assembled doc has shifted IDs but pypdf returns originals.
        targeted_pages: optional set of page indices to restrict scanning to.
            When provided, only those pages are considered.
        allow_overwrite: when True, defs are emitted even if their number is
            already in ocr_defs_set (used for mojibake recovery where the
            existing OCR def is corrupt).
    """
    recovered = []
    seen = set()
    page_offsets = page_offsets or {}
    for page_idx in sorted(pypdf_defs_by_page.keys()):
        if targeted_pages is not None and page_idx not in targeted_pages:
            continue
        offset = page_offsets.get(page_idx, 0)
        for fn_num, fn_text in pypdf_defs_by_page[page_idx]:
            shifted_num = fn_num + offset
            if shifted_num in ocr_defs_set and not allow_overwrite:
                continue
            if shifted_num < 1 or shifted_num > max_ref_number:
                continue
            if shifted_num in seen:
                continue
            seen.add(shifted_num)
            recovered.append((shifted_num, fn_text))
    return recovered


def scan_footnote_mojibake(response_dict, footnote_meta, pdf_path,
                            threshold=0.85):
    """Detect mojibake on footnote-definition pages and try pypdf fallback.

    Looks at every page in page_summary that has defs. Slices the def text
    region (from the first def marker to end of page or next non-def block)
    and computes printable_ratio. Below `threshold` → attempt pypdf for that
    page; accept its def text only if its printable_ratio also clears
    `threshold`. Recovered defs are appended to the page markdown as
    `[^N]: text` lines so the assembler picks them up.

    Returns a list of warning dicts.
    """
    warnings = []
    if not footnote_meta or not pdf_path:
        return warnings

    page_summary = footnote_meta.get("page_summary", [])
    pages = response_dict.get("pages", [])
    if not page_summary or not pages:
        return warnings

    pypdf_defs_cache = None  # Lazily computed only if a mojibake page is found

    for entry in page_summary:
        defs = entry.get("defs", [])
        if not defs:
            continue
        idx = entry["index"]
        if idx >= len(pages):
            continue
        md = pages[idx].get("markdown", "") or ""

        # Slice the def section: first def marker → end of page
        def_match = re.search(
            r'^(?:\[\^?\d{1,3}\][:\s]|\d{1,3}\.?\s+[A-Z‘“\'"])',
            md, re.MULTILINE
        )
        if not def_match:
            continue
        def_section = md[def_match.start():]
        ratio = compute_printable_ratio(def_section)
        if ratio >= threshold:
            continue

        # Try pypdf for this page (lazy init of full extraction)
        if pypdf_defs_cache is None:
            try:
                pypdf_defs_cache = extract_pypdf_footnote_defs(pdf_path)
            except Exception as e:
                pypdf_defs_cache = {}
                print(f"  pypdf fallback unavailable: {e}")

        page_defs = pypdf_defs_cache.get(idx, [])
        recovered_lines = []
        recovered_nums = []
        unrecovered_nums = []
        for fn_num, fn_text in page_defs:
            if fn_num not in defs:
                continue
            if compute_printable_ratio(fn_text) >= threshold:
                recovered_lines.append(f'[^{fn_num}]: {fn_text}')
                recovered_nums.append(fn_num)
            else:
                unrecovered_nums.append(fn_num)

        # Any defs we couldn't recover at all (no pypdf entry)
        for d in defs:
            if d not in recovered_nums and d not in unrecovered_nums:
                unrecovered_nums.append(d)

        if recovered_lines:
            # Strip the mojibake def section and replace with recovered defs.
            # The body (everything before the first def marker) is preserved.
            body = md[:def_match.start()].rstrip()
            pages[idx]["markdown"] = body + "\n\n" + "\n\n".join(recovered_lines) + "\n"

        warnings.append({
            "page": idx,
            "fn_numbers": sorted(defs),
            "printable_ratio": round(ratio, 3),
            "recovered": sorted(recovered_nums),
            "unrecovered": sorted(unrecovered_nums),
            # We saw unreadable glyphs in the def-section slice. Could be
            # broken font CMap, could be non-def content on this page entirely.
            "reason": "unreadable_glyphs_in_def_region" if ratio < threshold else "ok",
        })

    return warnings


# Layouts that legitimately emit NO numbered [^N] definitions — harvesting 0 is correct, not a fault
# (their "definitions" are a reference list the citation/STEM path handles, or there are no notes at
# all). 'unknown' is deliberately NOT in this set: it is the classifier FALL-THROUGH — "we could not
# tell the layout", NOT a determination that the document has no numbered notes. A large harvest
# shortfall under 'unknown' is precisely the silent-loss case (Cox: 30 def-lines in OCR, 2 emitted)
# that must still be audited and flagged, so 'unknown' falls through to the coverage checks below.
_NON_HARVESTING_CLASSES = {'none', 'wackSTEMbibliographyNotes'}


def assess_harvest_fidelity(footnote_meta, markdown, footnote_warnings=None):
    """Three-way discriminator that tells WHOSE bug a missing/duplicated footnote is, by comparing
    what the OCR captured (page_summary refs/defs) against what we actually emitted (the markdown).
    Same symptom — "notes don't line up" — has THREE root causes with opposite remedies:

      • harvest_gap        defs sit in the raw OCR but we didn't emit them → OUR bug (fix the
                           assembler's extraction). flagged (low confidence).
      • fidelity_loss      the OCR itself captured far fewer defs than the body references → the
                           markers OCR'd but the definitions degraded/dropped upstream. NOT our bug;
                           don't burn fixer cycles. not flagged.
      • assembly_collisions defs harvested fine but global numbers aren't unique → numbering/offset
                           bug (e.g. chapter-endnote offsets). flagged.
      • clean / no_footnotes → nothing to do.

    `footnote_warnings` (from scan_footnote_mojibake + the assemble pypdf fallback, present only when a
    real PDF was available) makes the fidelity_loss verdict HONEST about resurrection: `markdown` is
    already POST-recovery, so defs_harvested reflects what pypdf clawed back; the warnings then explain
    the RESIDUAL — `unrecovered` defs are the ones pypdf ALSO failed on (mojibake/unreadable in the
    source), i.e. the genuinely-upstream loss. When footnote_warnings is None, pypdf never ran (e.g. the
    cached-OCR replay harness with pdf_path=None) — so a fidelity_loss there is UNTESTED, not confirmed.

    Returns a fork-record (or None if there's nothing to assess). Confidence is set so the vibe loop's
    `confidence < 0.5` flag fires ONLY for the two buckets that are genuinely ours to fix — same
    principle as the citation plausibility guard (don't flag what isn't a fault)."""
    ps = footnote_meta.get('page_summary', []) or []
    cls = footnote_meta.get('classification', 'unknown')
    # pypdf resurrection outcome (None = recovery never attempted, i.e. no source PDF in this harness)
    recovery_attempted = footnote_warnings is not None
    pypdf_recovered = sum(len(w.get('recovered', []) or []) for w in (footnote_warnings or []))
    pypdf_unrecovered = sum(len(w.get('unrecovered', []) or []) for w in (footnote_warnings or []))
    defs_in_ocr = sum(len(e.get('defs', []) or []) for e in ps)   # def-shaped lines the OCR captured
    refs_in_ocr = sum(len(e.get('refs', []) or []) for e in ps)   # in-text markers the OCR captured
    harvested = [int(n) for n in re.findall(r'^\[\^(\d+)\]\s*:', markdown or '', re.MULTILINE)]
    defs_harvested = len(harvested)
    counts = {}
    for n in harvested:
        counts[n] = counts.get(n, 0) + 1
    collisions = sorted(n for n, c in counts.items() if c > 1)
    # "Demand" is the in-text MARKERS (refs), not the def-shaped lines: def-line counts are inflated
    # by numbered-list noise (e.g. a book with 0 real footnotes can still show 400 "N." lines), so
    # measuring against defs_in_ocr over-penalizes. Coverage vs refs answers "did we emit a definition
    # for each marker that exists?"; harvest vs ocr answers "did we keep what the OCR's def-lines held?"
    coverage_vs_refs = round(defs_harvested / refs_in_ocr, 3) if refs_in_ocr else None
    harvest_vs_ocr = round(defs_harvested / defs_in_ocr, 3) if defs_in_ocr else None

    if refs_in_ocr == 0:
        # No in-text markers → any def-shaped lines are numbered-list noise, not a footnote system.
        verdict, confidence, why = ('no_footnotes', 0.9,
            'No in-text footnote markers in the OCR — nothing to link (def-shaped lines, if any, '
            'are numbered-list noise, not footnotes).')
    elif cls in _NON_HARVESTING_CLASSES:
        # This layout (none / wackSTEM / bibliography) does not emit [^N] footnote definitions —
        # harvesting 0 is correct, not a fault. Don't flag (same principle as the citation
        # plausibility guard: never flag what isn't ours to harvest). NOTE: 'unknown' is NOT here —
        # it falls through so a genuine harvest gap under the classifier fall-through is caught.
        verdict, confidence, why = ('not_applicable', 0.9,
            f'Layout {cls!r} does not produce numbered footnote definitions — harvest fidelity N/A.')
    elif coverage_vs_refs is not None and coverage_vs_refs < 0.85 and \
            (defs_in_ocr >= refs_in_ocr * 0.85):
        # The OCR HAS roughly enough definition lines, but we emitted far fewer than the markers
        # demand → definitions are being lost in OUR assembly. Flagged.
        verdict, confidence, why = ('harvest_gap', 0.4,
            f'OCR captured ~{defs_in_ocr} definition lines and the body references {refs_in_ocr} '
            f'notes, but we emitted only {defs_harvested} ({int(coverage_vs_refs*100)}% of markers) '
            f'— definitions are being LOST in assembly (our bug to fix).')
    elif coverage_vs_refs is not None and coverage_vs_refs < 0.85:
        # We're short of the markers AND the OCR itself didn't capture enough def lines → the
        # definitions degraded UPSTREAM in OCR. NOT our bug; don't burn fixer cycles. Not flagged.
        # But say HOW HARD we already tried: pypdf re-extraction is exactly the tool for this bucket.
        if recovery_attempted and pypdf_unrecovered > 0:
            tail = (f' pypdf re-extraction was attempted and ALSO failed on {pypdf_unrecovered} '
                    f'(mojibake/unreadable in the source PDF) — confirmed upstream, our best tool lost it.')
        elif recovery_attempted:
            tail = (' pypdf re-extraction ran from the source PDF and recovered what it could; the '
                    'rest is not present even in the raw PDF text.')
        else:
            tail = (' pypdf re-extraction was NOT attempted here (no source PDF in this harness) — the '
                    'real import may still recover some via the pypdf fallback; this is untested, not confirmed.')
        verdict, confidence, why = ('fidelity_loss', 0.55,
            f'The body references {refs_in_ocr} notes but the OCR only captured ~{defs_in_ocr} '
            f'definition lines (we emitted {defs_harvested}) — the definitions degraded UPSTREAM in '
            f'OCR, not in our code.' + tail)
    elif collisions:
        verdict, confidence, why = ('assembly_collisions', 0.45,
            f'Harvested {defs_harvested} definitions for {refs_in_ocr} markers but {len(collisions)} '
            f'global number(s) collide — a numbering/offset bug (e.g. chapter-endnote offsets), '
            f'not OCR.')
    else:
        verdict, confidence, why = ('clean', 0.9,
            f'Harvested {defs_harvested} definitions for {refs_in_ocr} markers, all globally unique.')

    return {
        'seq': 1,
        'module': 'pdf_footnote_harvest_fidelity',
        'code_ref': 'recovery.py:assess_harvest_fidelity',
        'node_help': assess_harvest_fidelity.plain,
        'decision': f'harvest={verdict}',
        'question': ('Did we harvest every footnote the OCR captured AND number them uniquely? '
                     '(separates OCR fidelity loss from a harvest bug from a numbering/offset bug)'),
        'rationale': why,
        'evidence': {
            'classification': cls,
            'refs_in_ocr': refs_in_ocr,
            'defs_in_ocr': defs_in_ocr,
            'defs_harvested': defs_harvested,
            'coverage_vs_refs': coverage_vs_refs,
            'harvest_vs_ocr': harvest_vs_ocr,
            'collision_count': len(collisions),
            'collision_numbers': collisions[:20],
            'pypdf_recovery_attempted': recovery_attempted,
            'pypdf_recovered': pypdf_recovered,
            'pypdf_unrecovered': pypdf_unrecovered,
        },
        'considered': ['clean', 'harvest_gap', 'fidelity_loss', 'assembly_collisions',
                       'no_footnotes', 'not_applicable'],
        'confidence': confidence,
        'margin': None,
    }


recover_missing_defs.plain = (
    'RECOVERY ③ missing-def fill: markers that have NO definition get their text pulled from the pypdf '
    'extraction (range-filtered, de-duped, multi-paper-offset-aware; mojibake candidates rejected). The '
    'matcher is pure logic; the extraction needs the PDF.')


scan_footnote_mojibake.plain = (
    'RECOVERY ② mojibake def re-OCR: a garbled (mojibake) definition page is re-extracted straight from '
    'the PDF bytes via pypdf and spliced back in. NEEDS the real PDF — so it runs in the live import but '
    'NOT in the cached-OCR replay; that gap is what test_pdf_recovery_real.py covers.')


assess_harvest_fidelity.plain = (
    'AFTER assembly, a self-check: if footnotes are missing or duplicated, WHOSE bug is it? It compares '
    'what the OCR captured (page_summary refs/defs) against what we emitted. harvest_gap (OCR had them, '
    'we dropped them) + assembly_collisions (numbers not unique) are OUR bugs → flagged for the fix '
    'loop; fidelity_loss is an UPSTREAM OCR ceiling, only CONFIRMED once pypdf recovery has also failed; '
    'not_applicable = a layout that does not produce numbered footnote definitions.')

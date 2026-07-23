"""Bibliography / reference-list extraction (PASS 1A). Finds the reference section
(by heading, else a reverse paragraph scan), generates citation keys for each entry,
resolves author+year collisions with retroactive letter-suffixing, and inserts the
bib-entry anchors. Mutates the soup; returns (bibliography_map, references_data).
bibliography_map (key -> entry_id) is the INPUT the citation linker matches against,
so its correctness directly governs whether in-text citations link to the right work."""

import os
import re

from shared.assessment import ASSESSMENT
from shared.refkeys import generate_ref_keys, is_likely_reference


# Per-entry key/collision chatter (one 🔑 line per reference, plus 🔀 collision
# lines) was jamming the Laravel log on every book-sized import — the PHP side
# logs the whole conversion stdout. Default runs now print only the end-of-scan
# summary; set HYPERLIT_CONVERSION_VERBOSE=1 to get the per-entry trace back
# when debugging a conversion. The assessment trace keeps the counts either way.
_VERBOSE = os.environ.get("HYPERLIT_CONVERSION_VERBOSE", "") == "1"


def _vprint(msg):
    if _VERBOSE:
        print(msg)


# Common reference section headers (module-level: shared by the heading scan + the reverse-scan tail).
REFERENCE_HEADERS = ["references", "bibliography", "works cited", "sources", "literature cited", "reference list"]

# A HEADING-LESS reverse-scan bibliography is believed only if it is a DENSE block (this many
# entries) OR carries genuine reference STRUCTURE (below). is_likely_reference is loose by design (a
# paragraph that starts with a capital and contains a year passes rule #5), so a footnote-cited paper
# with NO reference list otherwise yields ONE junk "reference" from its last sentence ("Nor should we
# ... 1990."), littering the bibliography and driving a phantom "0/N citations" stat. (The
# heading-anchored path is untouched — an explicit "References" heading is trusted at any length.)
_MIN_REVERSE_SCAN_ENTRIES = 3

# Structural signals that a paragraph is REALLY a reference — anchored to the START, because a
# reference declares its shape up front ("Marcuse, H. 1964…", "Ostrom, Elinor (1990)…", "[1] …").
# Prose that merely CONTAINS a buried "(2001)" or "Smith, J." mid-sentence must NOT qualify, or a
# footnote-cited paper's closing sentence sneaks back in as a junk reference.
_REF_STRUCTURE_RE = re.compile(
    r"^\s*[A-Z][a-zA-Z'’-]+,\s+(?:[A-Z]\.|[A-Z][a-z])"   # "Marcuse, H." / "Ostrom, Elinor"
    r"|^\s*[A-Z][a-zA-Z'’-]+.{0,40}?\(\d{4}[a-z]?\)"       # "Author … (2001)" author-year, near start
)
# ...or a numbered "[1]" / bracket-year "[2023]" / em-dash repeat-author / noble-particle OPENER.
_REF_STRUCTURE_START_RE = re.compile(
    r"^\s*(?:\[\d+\]|\[\d{4}\]"
    r"|[—–‒―-]{1,3}[.,\s]"
    r"|(?:von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-Z])",
    re.IGNORECASE)


def _has_reference_structure(text):
    return bool(_REF_STRUCTURE_RE.match(text) or _REF_STRUCTURE_START_RE.match(text))


def _find_reference_paragraphs(soup):
    """Locate the bibliography entries. PRIMARY: a 'References'/'Bibliography' heading, collecting
    reference-like <p> until the next same-or-higher heading (skipping OCR-artifact embedded headings
    that are really more references). FALLBACK: a reverse paragraph scan when no heading matches.
    Returns (reference_p_tags, used_reverse_scan)."""
    reference_p_tags = []
    used_reverse_scan = False
    all_paragraphs = soup.find_all('p')

    print(f"\U0001F4DA Scanning {len(all_paragraphs)} paragraphs for reference section...")

    # PRIMARY: Find reference section by heading (more reliable for academic papers)
    all_headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    for heading in all_headings:  # Forward scan to find first matching heading
        header_text = heading.get_text(strip=True).lower()
        if header_text in REFERENCE_HEADERS:
            print(f"  \U0001F4D6 Found references heading: '{header_text}'")
            bib_heading_level = int(heading.name[1])  # e.g. h2 -> 2
            # Collect ALL paragraphs until the next same-or-higher-level heading
            next_sibling = heading.find_next_sibling()
            while next_sibling:
                if next_sibling.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                    sibling_level = int(next_sibling.name[1])
                    if sibling_level <= bib_heading_level:
                        # Peek ahead: are subsequent paragraphs reference-like?
                        # Use strict check: year must appear near start of text (first 80 chars).
                        # Body text has years scattered in citations far from the start;
                        # bibliography entries always have Author. Year. near the beginning.
                        peek = next_sibling.find_next_sibling()
                        peek_refs = 0
                        peek_total = 0
                        while peek and peek_total < 3:
                            if peek.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                                peek = peek.find_next_sibling()
                                continue
                            if peek.name == 'p':
                                peek_total += 1
                                peek_text = peek.get_text(" ", strip=True)
                                # Strict: reference-like AND year within first 80 chars
                                if is_likely_reference(peek) and re.search(r'\d{4}', peek_text[:80]):
                                    peek_refs += 1
                            peek = peek.find_next_sibling()
                        if peek_total >= 2 and peek_refs >= 2:
                            # Multiple reference-like paragraphs follow — heading is OCR artifact
                            print(f"  ⚠️ Skipping embedded heading (OCR artifact): '{next_sibling.get_text(strip=True)[:60]}'")
                            next_sibling = next_sibling.find_next_sibling()
                            continue
                        break  # Real section boundary
                    # Lower level -> alphabetical marker or sub-section within bibliography, skip it
                if next_sibling.name == 'p' and is_likely_reference(next_sibling):
                    reference_p_tags.append(next_sibling)
                    text_preview = next_sibling.get_text(" ", strip=True)[:80]
                    _vprint(f"  ✓ Detected reference: {text_preview}...")
                next_sibling = next_sibling.find_next_sibling()
            # Don't break — continue scanning for more reference sections (multi-chapter books)

    # FALLBACK: If no heading found, use reverse paragraph scan
    if not reference_p_tags:
        used_reverse_scan = True
        print("  ⚠️ No references heading found, scanning paragraphs...")
        for p in reversed(all_paragraphs):
            text_preview = p.get_text(" ", strip=True)[:80]
            if is_likely_reference(p):
                reference_p_tags.insert(0, p)
                _vprint(f"  ✓ Detected reference: {text_preview}...")
            elif reference_p_tags:
                header_text = p.get_text(strip=True).lower()
                if header_text in REFERENCE_HEADERS:
                    reference_p_tags.insert(0, p)
                    print(f"  \U0001F4D6 Found references header: '{header_text}'")
                break

        # A SHORT heading-less run is only a bibliography if it carries real reference structure — a
        # dense block (>= threshold) is trusted, and so is any run with a structured entry
        # ("Marcuse, H. 1964…"), but a lone/paired prose sentence that merely passed rule #5 ("Nor
        # should we … 1990.") is discarded so we emit neither a junk entry nor a phantom citation
        # count. A real header at the top of the run is always trusted.
        found_header = bool(reference_p_tags) and \
            reference_p_tags[0].get_text(strip=True).lower() in REFERENCE_HEADERS
        structured = any(_has_reference_structure(p.get_text(" ", strip=True)) for p in reference_p_tags)
        if not found_header and not structured and 0 < len(reference_p_tags) < _MIN_REVERSE_SCAN_ENTRIES:
            print(f"  🚫 Discarding {len(reference_p_tags)} reverse-scan paragraph(s) — short and "
                  f"unstructured (looks like body prose, not a heading-less bibliography)")
            reference_p_tags = []

    print(f"\U0001F4DA Found {len(reference_p_tags)} reference paragraphs")
    return reference_p_tags, used_reverse_scan


# Human-readable `plain` note for the bibliography-extraction tree node (one source — node_help + gen + LLM).
_BIBLIOGRAPHY_PLAIN = (
    'Find the reference list and give each entry an id, so in-text citations have something to point '
    'at. If citations do not link, suspect THIS (the link targets are missing) before blaming the '
    'citation linker. Collision-suffixing (two works, same author+year) makes a bare key resolve to the '
    'LAST entry — an inherent ambiguity.')


def _record_bibliography_assessment(references_data, bibliography_map, via_heading,
                                    collisions, dups_skipped, dropped_no_keys):
    """Record the bibliography-extraction pass to the assessment trace. The link-correctness risk is
    the collision suffixing (two works, same author+year): when it fires, the bare key resolves to the
    LAST entry (an inherent ambiguity). Dropped entries = targets that exist but can never be linked."""
    ASSESSMENT.record(
        module='bibliography_extraction', code_ref='bibliography.py:extract_bibliography',
        node_help=_BIBLIOGRAPHY_PLAIN,
        decision=f'{len(references_data)} reference entr(y/ies); {collisions} collision-suffixed, '
                 f'{dups_skipped} duplicate(s) merged, {dropped_no_keys} dropped (unkeyable)',
        rationale=('references found via a heading match' if via_heading
                   else 'references found via the reverse paragraph scan (no heading matched)'),
        evidence={'entries': len(references_data), 'map_keys': len(bibliography_map),
                  'collisions_suffixed': collisions, 'duplicates_merged': dups_skipped,
                  'dropped_no_keys': dropped_no_keys,
                  'detection': 'heading' if via_heading else 'reverse_scan'},
        question='Which paragraphs are bibliography entries, and what id does each get?',
        considered=([{'option': 'disambiguate same author+year citations precisely',
                      'rejected_because': 'two or more works share an author+year; a bare "(Author Year)" '
                                          'citation has no a/b to distinguish them',
                      'would_need': 'an explicit a/b suffix in the in-text citation — otherwise the bare '
                                    'key resolves to the LAST-defined of the colliding entries'}]
                    if collisions else []),
        confidence=round(1.0 if not references_data
                         else max(0.3, 1 - (dropped_no_keys / (len(references_data) + dropped_no_keys))), 2),
        margin=(f'{dropped_no_keys} reference(s) could not be keyed — they exist as targets but no '
                f'citation can ever link to them' if dropped_no_keys
                else (f'{collisions} author+year collision(s) disambiguated by suffix' if collisions
                      else f'{len(references_data)} entries, clean keys, no collisions')))


def extract_bibliography(soup):
    # --- 1A: Process Bibliography / References ---
    bibliography_map = {}
    references_data = []
    reference_p_tags, used_reverse_scan = _find_reference_paragraphs(soup)

    # Detect markdown list markers (- or *) used consistently across entries
    list_marker_count = sum(
        1 for p in reference_p_tags
        if re.match(r'^\s*[-*]\s', p.get_text(" ", strip=True))
    )
    strip_list_marker = list_marker_count > len(reference_p_tags) * 0.5
    if strip_list_marker:
        print(f"  📋 Detected list-marker format ({list_marker_count}/{len(reference_p_tags)} entries) — stripping '- ' prefixes")

    seen_references = {}  # base_entry_id → {"text": str, "suffix_count": int}
    used_ids = set()      # all entry_ids actually assigned (including suffixed)
    last_bib_author = ""  # Track last author for em-dash (—) repeat-author entries
    _dropped_no_keys = 0  # entries we could not key (no link target produced)
    _dups_skipped = 0     # true duplicates collapsed onto an existing entry
    _collisions = 0       # distinct works sharing author+year, disambiguated by a/b suffix

    for p in reference_p_tags:
        text = p.get_text(" ", strip=True)
        if strip_list_marker:
            text = re.sub(r'^\s*[-*]\s+', '', text)

        # Handle em-dash repeat-author entries (e.g. "—. 2014. Title...")
        # Common academic convention: — means "same author as previous entry"
        dash_match = re.match(r'^[\u2014\u2013\u2012\u2015—–-]{1,3}[\.\,\s]', text)
        if dash_match and last_bib_author:
            # Replace the dash with the previous author name
            text_with_author = last_bib_author + text[dash_match.end()-1:]
            _vprint(f"  ↩️ Dash-author entry, substituting '{last_bib_author}': {text[:60]}...")
            keys = generate_ref_keys(text_with_author)
        else:
            keys = generate_ref_keys(text)
            # Update last_bib_author from this entry (text before the year)
            if keys and not dash_match:
                year_match = re.search(r'\d{4}', text)
                if year_match:
                    last_bib_author = text[:year_match.start()].rstrip(' .,;:(')
            # For entries with prefix year (Author (YEAR1)) that also have a different
            # publication year in the body (YEAR2), generate keys for both years
            # to handle OCR errors in the prefix year
            if keys:
                paren_yr = re.search(r'\((\d{4}[a-z]?)\)', text)
                if paren_yr:
                    prefix_yr = paren_yr.group(1)
                    body_text = text[paren_yr.end():]
                    body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', body_text))
                    body_years = [m for m in body_years if 1900 <= int(m.group(1)) <= 2099 and m.group(1) != prefix_yr]
                    if body_years:
                        alt_yr = body_years[-1].group(1)
                        alt_keys = [k.replace(prefix_yr, alt_yr) for k in keys if prefix_yr in k]
                        keys = list(set(keys + alt_keys))

        if not keys:
            # Fallback: for entries with garbled prefix initials like "K. E. (2005) Daniel Kennefick..."
            # extract author names from the text AFTER the parenthesized year prefix
            paren_year_match = re.search(r'\((\d{4}[a-z]?)\)', text)
            if paren_year_match:
                remainder = text[paren_year_match.end():].strip()
                prefix_year = paren_year_match.group(1)
                # Extract author block from remainder (before title start: ". " after 2+ lowercase chars + uppercase)
                # Avoids matching initials like "H. G" or "D. L"
                author_block_match = re.search(r'(?<=[a-z]{2})\.\s+[A-Z]', remainder)
                if author_block_match:
                    author_text = remainder[:author_block_match.start()] + " " + prefix_year
                else:
                    author_text = remainder.split('.')[0] + " " + prefix_year
                keys = generate_ref_keys(author_text)
                # Also generate keys with alternative years from body text
                body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', remainder))
                body_years = [m for m in body_years if 1900 <= int(m.group(1)) <= 2099 and m.group(1) != prefix_year]
                if body_years:
                    alt_year = body_years[-1].group(1)
                    alt_keys = generate_ref_keys(author_text.replace(prefix_year, alt_year))
                    keys = list(set(keys + alt_keys))
                if keys:
                    _vprint(f"  🔄 Fallback keys from post-prefix text: {keys}")

        if not keys:
            print(f"  ⚠️ No keys generated for: {text[:60]}...")
            _dropped_no_keys += 1
            continue

        base_entry_id = keys[0]

        if base_entry_id not in seen_references:
            # First time seeing this base key
            if base_entry_id not in used_ids:
                # ID is free — add normally
                seen_references[base_entry_id] = {"text": text, "suffix_count": 0}
                entry_id = base_entry_id
            else:
                # ID was already taken by a collision suffix from a different base key
                # Treat this as a new base that needs an immediate suffix
                seen_references[base_entry_id] = {"text": text, "suffix_count": 0}
                suffix_num = 1
                while base_entry_id + chr(ord('a') + suffix_num) in used_ids:
                    suffix_num += 1
                entry_id = base_entry_id + chr(ord('a') + suffix_num)
                seen_references[base_entry_id]["suffix_count"] = suffix_num
                _vprint(f"  🔀 ID '{base_entry_id}' already taken by suffix — using {entry_id}")
        else:
            prev = seen_references[base_entry_id]
            # Compare content (first 60 alphanum chars, normalized) to detect true dupes vs collisions
            normalize = lambda t: re.sub(r'[^a-z0-9]', '', t.lower())[:60]
            if normalize(prev["text"]) == normalize(text):
                # True duplicate — skip DOM/data, but still add keys
                for key in keys:
                    bibliography_map[key] = base_entry_id if prev["suffix_count"] == 0 else base_entry_id + "a"
                _vprint(f"  ⏭️ Duplicate reference skipped (keys still added): {base_entry_id}")
                _dups_skipped += 1
                continue
            else:
                # Collision — different paper, same author+year
                # Retroactively suffix the first entry if this is the first collision
                if prev["suffix_count"] == 0:
                    old_id = base_entry_id
                    # Find a free suffix for the first entry
                    first_suffix = 0  # 'a'
                    while base_entry_id + chr(ord('a') + first_suffix) in used_ids:
                        first_suffix += 1
                    new_first_id = base_entry_id + chr(ord('a') + first_suffix)
                    # Update the first entry's anchor and references_data
                    first_anchor = soup.find("a", {"id": old_id, "class": "bib-entry"})
                    if first_anchor:
                        first_anchor["id"] = new_first_id
                        parent_p = first_anchor.find_parent('p')
                    else:
                        parent_p = None
                    for rd in references_data:
                        if rd["referenceId"] == old_id:
                            rd["referenceId"] = new_first_id
                            if first_anchor and parent_p:
                                rd["content"] = str(parent_p)
                            break
                    # Remap bibliography_map entries pointing to old_id
                    for k, v in list(bibliography_map.items()):
                        if v == old_id:
                            bibliography_map[k] = new_first_id
                    used_ids.discard(old_id)
                    used_ids.add(new_first_id)
                    seen_references[base_entry_id]["suffix_count"] = first_suffix
                    _vprint(f"  🔀 Collision detected! Retroactively suffixed first entry: {old_id} → {new_first_id}")

                prev["suffix_count"] += 1
                suffix = chr(ord('a') + prev["suffix_count"])
                # Skip past any suffixes already taken
                while base_entry_id + suffix in used_ids:
                    prev["suffix_count"] += 1
                    suffix = chr(ord('a') + prev["suffix_count"])
                entry_id = base_entry_id + suffix
                _vprint(f"  🔀 Collision: assigned suffix → {entry_id}")
                _collisions += 1

        used_ids.add(entry_id)

        # Add keys to bibliography_map
        for key in keys:
            bibliography_map[key] = entry_id
        # Add DOM anchor + references_data entry
        anchor_tag = soup.new_tag("a", attrs={"class": "bib-entry", "id": entry_id})
        p.insert(0, anchor_tag)
        references_data.append({"referenceId": entry_id, "content": str(p)})
        _vprint(f"  🔑 Generated keys for reference: {keys} → {entry_id}")

    print(f"📚 Bibliography map has {len(bibliography_map)} entries: {list(bibliography_map.keys())[:10]}{'...' if len(bibliography_map) > 10 else ''}")
    print(f"Found and processed {len(references_data)} reference entries (kept in DOM): "
          f"{_collisions} author-year collision(s) suffixed, {_dups_skipped} duplicate(s) skipped, "
          f"{_dropped_no_keys} unkeyable. Set HYPERLIT_CONVERSION_VERBOSE=1 for the per-entry key trace.")

    via_heading = bool(reference_p_tags) and not used_reverse_scan
    _record_bibliography_assessment(references_data, bibliography_map, via_heading,
                                    _collisions, _dups_skipped, _dropped_no_keys)
    return bibliography_map, references_data

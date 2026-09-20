"""Bibliography / reference-list extraction (PASS 1A). Finds the reference section
(by heading, else a reverse paragraph scan), generates citation keys for each entry,
resolves author+year collisions with retroactive letter-suffixing, and inserts the
bib-entry anchors. Mutates the soup; returns (bibliography_map, references_data).
bibliography_map (key -> entry_id) is the INPUT the citation linker matches against,
so its correctness directly governs whether in-text citations link to the right work."""

import os
import re

from shared.assessment import ASSESSMENT
from shared.refkeys import (generate_ref_keys, is_likely_reference, is_plausible_year,
                            normalize_unicode_name, strip_access_clause)


# Per-entry key/collision chatter (one 🔑 line per reference, plus 🔀 collision
# lines) was jamming the Laravel log on every book-sized import — the PHP side
# logs the whole conversion stdout. Default runs now print only the end-of-scan
# summary; set HYPERLIT_CONVERSION_VERBOSE=1 to get the per-entry trace back
# when debugging a conversion. The assessment trace keeps the counts either way.
_VERBOSE = os.environ.get("HYPERLIT_CONVERSION_VERBOSE", "") == "1"


def _ordered_unique(items):
    """De-duplicate while PRESERVING first-appearance order. keys[0] is a reference's canonical
    anchor id, and `set()` iteration over strings is randomised per process — see the call sites."""
    out = []
    for it in items:
        if it not in out:
            out.append(it)
    return out


def _vprint(msg):
    if _VERBOSE:
        print(msg)


# Common reference section headers (module-level: shared by the heading scan + the reverse-scan tail).
REFERENCE_HEADERS = ["references", "bibliography", "works cited", "sources", "literature cited",
                     "reference list", "cited references", "list of references", "references cited",
                     "citations", "cited works",
                     # Elsevier "Current Opinion" journals title their reference list this way
                     # (6c4e7d58: 53 numbered entries under it were invisible to the exact match)
                     "references and recommended reading", "references and further reading"]

# A heading's text as the REFERENCE_HEADERS lookup sees it: lowercased, and with the trailing
# punctuation a typesetter may attach stripped. "## References:" (9a266e34) missed the exact match
# by ONE COLON — the heading-anchored walk never ran, the weak reverse scan salvaged a single entry,
# and 2 of that article's 105 citations linked. Trailing ':' / '.' / numbering punctuation carries no
# meaning here; the match itself stays EXACT (a containment check would swallow "Sources of Error").
def reference_header_key(text):
    return (text or '').strip().lower().rstrip(':.\u2013\u2014- ').strip()


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


def has_reference_structure(text):
    """Does this text OPEN like a reference entry? Public because the load-phase
    multi-entry splitter (digestion/load/load.py) asks the same question of each line of a
    newline-carrying <p> — one definition of "opens like a reference", not two."""
    return bool(_REF_STRUCTURE_RE.match(text) or _REF_STRUCTURE_START_RE.match(text))


def _in_footnote_container(tag):
    """Is this <p> inside an already-marked-up footnote/endnote block (pandoc's
    <section id="footnotes" class="footnotes" role="doc-endnotes">, and the EPUB/HTML
    equivalents)? Those paragraphs belong to the footnote system and must not be mined for
    references: a note is prose ABOUT a work and routinely carries an author and a year, so the
    reverse scan — which starts at the END of the document, exactly where pandoc puts the notes
    — swallowed the last note as a phantom bibliography entry AND duplicated its text."""
    for parent in tag.parents:
        if getattr(parent, 'name', None) not in ('section', 'div', 'aside', 'ol', 'ul', 'li'):
            continue
        classes = ' '.join(parent.get('class') or []).lower()
        if 'footnote' in classes or 'endnote' in classes:
            return True
        if (parent.get('id') or '').lower() in ('footnotes', 'endnotes'):
            return True
        if (parent.get('role') or '').lower() in ('doc-endnotes', 'doc-footnotes'):
            return True
    return False


def _find_reference_paragraphs(soup):
    """Locate the bibliography entries. PRIMARY: a 'References'/'Bibliography' heading, collecting
    reference-like <p> until the next same-or-higher heading (skipping OCR-artifact embedded headings
    that are really more references). FALLBACK: a reverse paragraph scan when no heading matches.
    Returns (reference_p_tags, used_reverse_scan)."""
    reference_p_tags = []
    used_reverse_scan = False
    all_paragraphs = [p for p in soup.find_all('p') if not _in_footnote_container(p)]

    print(f"\U0001F4DA Scanning {len(all_paragraphs)} paragraphs for reference section...")

    # PRIMARY: Find reference section by heading (more reliable for academic papers)
    all_headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    for heading in all_headings:  # Forward scan to find first matching heading
        header_text = reference_header_key(heading.get_text(strip=True))
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
        # One entry-shaped miss inside the run is tolerated: a YEARLESS in-press entry
        # ("Walz A, Braendle J, … Experience from customising IPCC scenarios…") fails the
        # year requirement, and a hard break there discards every entry above it (ed2cbd77:
        # 11 of ~300 survived). The miss must still OPEN like an author list; two misses in
        # a row (or body prose) still end the run.
        _MISS_AUTHOR_SHAPE_RE = re.compile(r"^\s*[A-ZÀ-ÖØ-Þ][\w'’-]+\s+[A-Z]{1,3}\b[,.]?\s")
        pending_miss = None
        for p in reversed(all_paragraphs):
            text_preview = p.get_text(" ", strip=True)[:80]
            if is_likely_reference(p):
                if pending_miss is not None:
                    reference_p_tags.insert(0, pending_miss)
                    pending_miss = None
                reference_p_tags.insert(0, p)
                _vprint(f"  ✓ Detected reference: {text_preview}...")
            elif reference_p_tags:
                header_text = reference_header_key(p.get_text(strip=True))
                if header_text in REFERENCE_HEADERS:
                    reference_p_tags.insert(0, p)
                    print(f"  \U0001F4D6 Found references header: '{header_text}'")
                    break
                text = p.get_text(" ", strip=True)
                if (pending_miss is None and len(text) < 500
                        and (_MISS_AUTHOR_SHAPE_RE.match(text) or has_reference_structure(text))):
                    pending_miss = p
                    continue
                break

        # A SHORT heading-less run is only a bibliography if it carries real reference structure — a
        # dense block (>= threshold) is trusted, and so is any run with a structured entry
        # ("Marcuse, H. 1964…"), but a lone/paired prose sentence that merely passed rule #5 ("Nor
        # should we … 1990.") is discarded so we emit neither a junk entry nor a phantom citation
        # count. A real header at the top of the run is always trusted.
        found_header = bool(reference_p_tags) and \
            reference_header_key(reference_p_tags[0].get_text(strip=True)) in REFERENCE_HEADERS
        structured = any(has_reference_structure(p.get_text(" ", strip=True)) for p in reference_p_tags)
        if not found_header and not structured and 0 < len(reference_p_tags) < _MIN_REVERSE_SCAN_ENTRIES:
            print(f"  🚫 Discarding {len(reference_p_tags)} reverse-scan paragraph(s) — short and "
                  f"unstructured (looks like body prose, not a heading-less bibliography)")
            reference_p_tags = []

    # ORDINAL-density gate: entries with a plain "N." / "N)" enumerator are a real numbered
    # bibliography only when their numbers form a DENSE ascending run (1..16 in 5f52d575,
    # 24..33 in 79c3d8e4 — density 1.0). Scattered ordinals (42, 64, 68, 81 in 85542c5e —
    # density 0.1) are numbered ENDNOTES whose openers happen to look author-shaped; keeping
    # them mints phantom references AND steals their text from the footnote system. Applies
    # only to the ordinal-prefixed subset; unnumbered entries are untouched.
    ordinals = []
    for p in reference_p_tags:
        m = re.match(r'^\s*(\d{1,4})[.)]\s', p.get_text(" ", strip=True))
        if m:
            ordinals.append((p, int(m.group(1))))
    if len(ordinals) >= 3:
        nums = sorted(n for _p, n in ordinals)
        span = nums[-1] - nums[0] + 1
        if span > 0 and len(set(nums)) / span < 0.5:
            dropped = {id(p) for p, _n in ordinals}
            print(f"  🚫 Dropping {len(ordinals)} ordinal-numbered paragraph(s) — numbers "
                  f"{nums[0]}..{nums[-1]} are too sparse for a numbered bibliography "
                  f"(density {len(set(nums)) / span:.2f}; these are endnotes, not references)")
            reference_p_tags = [p for p in reference_p_tags if id(p) not in dropped]

    print(f"\U0001F4DA Found {len(reference_p_tags)} reference paragraphs")
    return reference_p_tags, used_reverse_scan


# Human-readable `plain` note for the bibliography-extraction tree node (one source — node_help + gen + LLM).
_BIBLIOGRAPHY_PLAIN = (
    'Find the reference list and give each entry an id, so in-text citations have something to point '
    'at. If citations do not link, suspect THIS (the link targets are missing) before blaming the '
    'citation linker. Collision-suffixing (two works, same author+year) makes a bare key resolve to the '
    'LAST entry — an inherent ambiguity.')


def _record_bibliography_assessment(references_data, bibliography_map, via_heading,
                                    collisions, dups_skipped, dropped_no_keys, method='regex'):
    """Record the bibliography-extraction pass to the assessment trace. The link-correctness risk is
    the collision suffixing (two works, same author+year): when it fires, the bare key resolves to the
    LAST entry (an inherent ambiguity). Dropped entries = targets that exist but can never be linked.
    method='grobid' marks the ML-backed path (dropped_no_keys then means DOM-unanchorable refs)."""
    ASSESSMENT.record(
        module='bibliography_extraction', code_ref='bibliography.py:extract_bibliography',
        node_help=_BIBLIOGRAPHY_PLAIN,
        decision=f'{len(references_data)} reference entr(y/ies); {collisions} collision-suffixed, '
                 f'{dups_skipped} duplicate(s) merged, {dropped_no_keys} dropped (unkeyable)'
                 + (f' [via {method}]' if method != 'regex' else ''),
        rationale=('references segmented by GROBID from the source PDF' if method == 'grobid'
                   else ('references found via a heading match' if via_heading
                         else 'references found via the reverse paragraph scan (no heading matched)')),
        evidence={'entries': len(references_data), 'map_keys': len(bibliography_map),
                  'collisions_suffixed': collisions, 'duplicates_merged': dups_skipped,
                  'dropped_no_keys': dropped_no_keys, 'method': method,
                  'detection': 'grobid' if method == 'grobid'
                               else ('heading' if via_heading else 'reverse_scan')},
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


def _norm_probe(text):
    """Lowercased alphanumeric-only form used to locate a reference's text inside a DOM paragraph."""
    return re.sub(r'[^a-z0-9]', '', (text or '').lower())


_PAREN_YEAR_RE = re.compile(r'\((?:19|20)\d{2}[a-z]?\)')


def suspect_paragraph_indices(candidate_texts):
    """Indices of candidate paragraphs showing the glued/merged pathologies: (multi_year_set,
    overlong_set). multi_year = >=2 "(YYYY)" patterns in one paragraph (OCR-glued run-on entries);
    overlong = >=3x the median length, min 500 chars (merged blobs without parenthesised years)."""
    texts = [t or '' for t in candidate_texts]
    multi_year = {i for i, t in enumerate(texts) if len(_PAREN_YEAR_RE.findall(t)) >= 2}
    overlong = set()
    if texts:
        lengths = sorted(len(t) for t in texts)
        median = lengths[len(texts) // 2]
        overlong = {i for i, t in enumerate(texts) if len(t) >= max(500, 3 * median)}
    return multi_year, overlong


def assess_bibliography_health(candidate_texts):
    """Score the REGEX-SCANNED reference candidates for the pathologies that make the regex
    extraction unreliable — the mechanical trigger for escalating to GROBID. Pure function over the
    candidate paragraphs' TEXTS (read-only: runs BEFORE any anchors are inserted).

    suspect = True when either signal clears its floor (>=2 glued, or >=10% overlong)."""
    n = len(candidate_texts)
    multi_year_idx, overlong_idx = suspect_paragraph_indices(candidate_texts)
    multi_year, overlong = len(multi_year_idx), len(overlong_idx)
    reasons = []
    if multi_year >= 2:
        reasons.append(f'{multi_year} run-on entr(y/ies) carrying multiple (year) patterns')
    if n and overlong / n >= 0.10:
        reasons.append(f'{overlong}/{n} entries are >=3x the median length (merged blobs)')
    return {'entries': n, 'multi_year_entries': multi_year, 'overlong_entries': overlong,
            'suspect': bool(reasons), 'reasons': reasons,
            'suspect_indices': sorted(multi_year_idx | overlong_idx)}


def merge_grobid_refs(soup, refs, bibliography_map, references_data, suspect_ps):
    """SURGICAL core (pure of I/O, unit-testable): fold GROBID-segmented refs into an EXISTING
    regex extraction, additively. A ref is added ONLY when (a) NONE of its keys exist in the map —
    if the regex already reaches the work by any key, we never override or duplicate it — and
    (b) its text probe-locates inside one of the SUSPECT paragraphs (the glued/merged blobs the
    health scorer flagged). Everything the regex found is untouched by construction: this exists
    because the 2026-08 trial showed wholesale replacement fixes the glued entries but LOSES ~20%
    of the reference targets regex had (deploy/experiments/grobid.md). Returns entries added."""
    suspect_norm = [(p, _norm_probe(p.get_text(' ', strip=True))) for p in suspect_ps]
    used_ids = set(bibliography_map.values()) | {rd['referenceId'] for rd in references_data}
    added = 0
    for ref in refs:
        keys = list(generate_ref_keys(ref['raw'])) if ref['raw'] else []
        if ref['first_author'] and ref['year']:
            structured = normalize_unicode_name(ref['first_author']).lower().replace(' ', '') + ref['year']
            if structured not in keys:
                keys.insert(0, structured)
        if not keys or any(k in bibliography_map for k in keys):
            continue                                   # unkeyable, or regex already reaches it
        probe = _norm_probe((ref['raw'] or '')[:60]) or _norm_probe(ref['first_author'] + ref['title'])[:40]
        if len(probe) < 12:
            continue
        target_p = next((p for p, t in suspect_norm if probe in t), None)
        if target_p is None:
            continue                                   # not hidden inside a suspect blob — out of scope
        entry_id = keys[0]
        suffix = 0
        while entry_id in used_ids:
            suffix += 1
            entry_id = keys[0] + chr(ord('a') + suffix - 1)
        used_ids.add(entry_id)
        for k in keys:
            bibliography_map.setdefault(k, entry_id)
        anchor = soup.new_tag('a', attrs={'class': 'bib-entry', 'id': entry_id})
        target_p.insert(0, anchor)
        references_data.append({'referenceId': entry_id, 'content': str(target_p)})
        added += 1
    return added


def merge_grobid_into_bibliography(soup, pdf_path, base_url, bibliography_map, references_data,
                                   suspect_ps):
    """Transport wrapper for the surgical merge: GROBID client call + never-raise contract.
    Returns entries added (0 on any failure — the regex extraction stands either way)."""
    from digestion.bibliographyExtraction.grobid_client import extract_refs_from_pdf, grobid_alive
    try:
        if not grobid_alive(base_url):
            print('  ⚠️ GROBID configured but not reachable — regex extraction stands.')
            return 0
        refs = extract_refs_from_pdf(pdf_path, base_url)
    except Exception as e:                             # noqa: BLE001 — never-raise by contract
        print(f'  ⚠️ GROBID merge failed ({e.__class__.__name__}: {e}) — regex extraction stands.')
        return 0
    added = merge_grobid_refs(soup, refs, bibliography_map, references_data, suspect_ps)
    print(f'📚 GROBID bibliography: surgical merge added {added} hidden entr(y/ies) '
          f'(of {len(refs)} segmented) into {len(suspect_ps)} suspect paragraph(s)')
    return added


def extract_bibliography_via_grobid(soup, pdf_path, base_url, min_entries=3):
    """GROBID-backed PASS 1A: segment the PDF's references with GROBID's CRF model and build the
    same (bibliography_map, references_data) contract the regex path produces — but with entries
    the regex CANNOT free (run-on/DOI-glued blobs: book 93d34a74's "…doi:… Archambault…" chain).

    Anchoring: each GROBID reference is located in the DOM by normalized-substring probe and the
    <a class="bib-entry" id> anchor is inserted into its containing <p> (a still-glued paragraph
    carries several anchors — citation nav lands on the right paragraph). A reference that cannot
    be located in the DOM is SKIPPED entirely — a map key without a DOM anchor would be a dead
    link, and no link beats a dead one.

    Returns (bibliography_map, references_data) or None ("use the regex path"): None on transport
    failure, on an empty/thin GROBID result (<3 anchored entries), or if pypdf can't read the PDF.
    The caller treats None as fall-through, so this function must never raise."""
    from digestion.bibliographyExtraction.grobid_client import extract_refs_from_pdf, grobid_alive
    try:
        if not grobid_alive(base_url):
            print('  ⚠️ GROBID configured but not reachable — regex bibliography path.')
            return None
        refs = extract_refs_from_pdf(pdf_path, base_url)
    except Exception as e:                                     # noqa: BLE001 — fallback by contract
        print(f'  ⚠️ GROBID extraction failed ({e.__class__.__name__}: {e}) — regex bibliography path.')
        return None
    if not refs:
        print('  ⚠️ GROBID returned no references — regex bibliography path.')
        return None

    # Normalized text of every <p> once, for substring probes.
    paragraphs = [(p, _norm_probe(p.get_text(' ', strip=True))) for p in soup.find_all('p')]

    bibliography_map = {}
    references_data = []
    used_ids = set()
    skipped_unanchored = 0

    for ref in refs:
        # Keys: the raw citation string through the SAME key generator the linker's citations use,
        # plus the structured (first_author, year) key GROBID gives us directly.
        keys = list(generate_ref_keys(ref['raw'])) if ref['raw'] else []
        if ref['first_author'] and ref['year']:
            structured = normalize_unicode_name(ref['first_author']).lower().replace(' ', '') + ref['year']
            if structured not in keys:
                keys.insert(0, structured)
        if not keys:
            continue

        # Locate the entry's paragraph: probe with the raw string's head, else author+title head.
        probe = _norm_probe((ref['raw'] or '')[:60]) or _norm_probe(ref['first_author'] + ref['title'])[:40]
        target_p = None
        if len(probe) >= 12:                                  # too-short probes match everywhere
            for p, ptext in paragraphs:
                if probe in ptext:
                    target_p = p
                    break
        if target_p is None:
            skipped_unanchored += 1
            continue

        entry_id = keys[0]
        suffix = 0
        while entry_id in used_ids:                            # same-author-year collision → a/b/c…
            suffix += 1
            entry_id = keys[0] + chr(ord('a') + suffix - 1)
        used_ids.add(entry_id)

        for key in keys:
            bibliography_map.setdefault(key, entry_id)
        anchor = soup.new_tag('a', attrs={'class': 'bib-entry', 'id': entry_id})
        target_p.insert(0, anchor)
        references_data.append({'referenceId': entry_id, 'content': str(target_p)})

    if len(references_data) < max(3, min_entries):
        print(f'  ⚠️ GROBID anchored only {len(references_data)} entr(y/ies) in the DOM '
              f'(needed >={max(3, min_entries)}) — regex path.')
        return None

    print(f'📚 GROBID bibliography: {len(refs)} segmented, {len(references_data)} anchored '
          f'({skipped_unanchored} not locatable in DOM, skipped), map has {len(bibliography_map)} keys')
    _record_bibliography_assessment(references_data, bibliography_map, True, 0, 0, skipped_unanchored,
                                    method='grobid')
    return bibliography_map, references_data


def _register_keys(bibliography_map, alias_owned, keys, alias_keys, entry_id):
    """Claim this entry's match keys, keeping the two kinds of claim apart.

    A CANONICAL key comes from the year the entry actually prints; an ALIAS is the OCR-error
    guess ("maybe the printed year is wrong and the body's year is right"). Both used to be written
    with a plain `map[key] = entry_id`, so whichever entry happened to come later won — and an
    alias could therefore overwrite a real one. It did: every web-cited entry carrying "(accessed …
    2024)" aliased itself onto that year, and the last such entry in the list took `news2024` away
    from "News18 (2024)", pointing the article's only News18 citation at an Al Jazeera piece.

    So: canonical keys claim outright (and evict an alias squatting there); an alias only fills a
    key nobody has claimed at all.
    """
    for key in keys:
        bibliography_map[key] = entry_id
        alias_owned.discard(key)
    for key in alias_keys:
        if key not in bibliography_map:
            bibliography_map[key] = entry_id
            alias_owned.add(key)


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

    # Keys currently held in the map by a SPECULATIVE alias (the OCR-error alt-year guess below)
    # rather than by an entry's own printed year. An alias may fill a gap, but it must never
    # displace — nor be allowed to squat on — a key some entry states outright.
    alias_owned = set()

    for p in reference_p_tags:
        text = p.get_text(" ", strip=True)
        if strip_list_marker:
            text = re.sub(r'^\s*[-*]\s+', '', text)
        alias_keys = []

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
                    # An ACCESS DATE is not a publication year — `generate_ref_keys` strips the
                    # clause for exactly this reason, and this rescan has to do the same or every
                    # web-cited entry grows an alias keyed on the day someone opened the URL.
                    # "News Agencies (2023) … (accessed 1 July 2024)" minted news2024, which then
                    # overwrote the key of the real "News18 (2024)" entry, so the article's
                    # (News18, 2024) citation pointed at an unrelated Al Jazeera piece.
                    body_text = strip_access_clause(text[paren_yr.end():])
                    body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', body_text))
                    body_years = [m for m in body_years if is_plausible_year(m.group(1)) and m.group(1) != prefix_yr]
                    if body_years:
                        alt_yr = body_years[-1].group(1)
                        alt_keys = [k.replace(prefix_yr, alt_yr) for k in keys if prefix_yr in k]
                        # ORDER-PRESERVING, never set(): keys[0] becomes this entry's anchor id
                        # (base_entry_id below), and set() iteration over strings is randomised
                        # PER PROCESS — so the same book reconverted twice got a different
                        # bibliography anchor, silently orphaning every in-text citation that
                        # pointed at the old one. Production does not pin PYTHONHASHSEED (the
                        # regression harness does, which is why the goldens never caught it).
                        # The PRINTED year stays canonical; the body year is a match-only alias
                        # (Spencer 1884 … reprinted 1992 → anchor herbertspencer1884) — and an
                        # alias is a GUESS, so it is registered only into a key nobody claims.
                        alias_keys = _ordered_unique([k for k in alt_keys if k not in keys])

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
                # Also generate keys with alternative years from body text — same alias contract
                # as above: an access date is not a publication year, and a guess never displaces
                # an entry's own printed key.
                body_years = list(re.finditer(r'(?<!\d)(\d{4})(?!\d)', strip_access_clause(remainder)))
                body_years = [m for m in body_years if is_plausible_year(m.group(1)) and m.group(1) != prefix_year]
                if body_years:
                    alt_year = body_years[-1].group(1)
                    alt_keys = generate_ref_keys(author_text.replace(prefix_year, alt_year))
                    alias_keys = _ordered_unique([k for k in alt_keys if k not in keys])
                if keys:
                    _vprint(f"  🔄 Fallback keys from post-prefix text: {keys} (aliases: {alias_keys})")

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
                _dup_id = base_entry_id if prev["suffix_count"] == 0 else base_entry_id + "a"
                _register_keys(bibliography_map, alias_owned, keys, alias_keys, _dup_id)
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
        _register_keys(bibliography_map, alias_owned, keys, alias_keys, entry_id)
        # Add DOM anchor + references_data entry
        anchor_tag = soup.new_tag("a", attrs={"class": "bib-entry", "id": entry_id})
        p.insert(0, anchor_tag)
        references_data.append({"referenceId": entry_id, "content": str(p)})
        _vprint(f"  🔑 Generated keys for reference: {keys} (aliases: {alias_keys}) → {entry_id}")

    print(f"📚 Bibliography map has {len(bibliography_map)} entries: {list(bibliography_map.keys())[:10]}{'...' if len(bibliography_map) > 10 else ''}")
    print(f"Found and processed {len(references_data)} reference entries (kept in DOM): "
          f"{_collisions} author-year collision(s) suffixed, {_dups_skipped} duplicate(s) skipped, "
          f"{_dropped_no_keys} unkeyable. Set HYPERLIT_CONVERSION_VERBOSE=1 for the per-entry key trace.")

    via_heading = bool(reference_p_tags) and not used_reverse_scan
    _record_bibliography_assessment(references_data, bibliography_map, via_heading,
                                    _collisions, _dups_skipped, _dropped_no_keys)
    return bibliography_map, references_data

"""Phase ③ — footnote RECOVERY + fidelity: resurrect mangled/missed notes from the PDF bytes via pypdf (mojibake re-OCR, missing-def fill), fix mangled URLs, and assess_harvest_fidelity (whose bug is a missing/duplicated footnote — ours vs an upstream OCR ceiling)."""
import sys
import os
import json
import re
import argparse
import base64
from pathlib import Path
from collections import Counter
from statistics import median
from mistralai.client import Mistral
from pypdf import PdfReader, PdfWriter

from ingestion.pdf.pdf_shared import *  # noqa: F401,F403
from ingestion.pdf.pdf_shared import _TOC_ENTRY_TAIL_RE, _DATE_LINE_RE  # underscored — not in import *

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


# A note that opens LOWERCASE because it opens with scholarly apparatus rather than a sentence:
# "6  cf. Fuchs/Hofkirchner/Klauninger (2001)". The def scan otherwise demands an uppercase /
# quote / paren opener (a plain lowercase line after a number is far more often a numbered list
# item or a wrapped table row), so a whole note went missing (7fa30289 fn 6). The vocabulary is
# closed on purpose — these words open a REFERENCE, never a list item.
_APPARATUS_DEF_RE = re.compile(
    r'^(\d{1,3})\s{1,3}((?:cf|ibid|id|e\.g|i\.e|viz|vgl|cp|op\.\s*cit|loc\.\s*cit|siehe|see|'
    r'quoted|cited|translated|trans)\b[.,]?\s.{2,})', re.IGNORECASE)


# A page-bottom note the text layer glued to the end of ANOTHER line: a 3-plus-space run (the
# footnote rule), the note number, then the note. Captured to the end of the line or the next big
# gap. The text must open like a definition (capital / quote / paren / URL — the same vocabulary the
# line-anchored scan uses) and run at least MIN_GAP_DEF_CHARS, because a stray "…   12 Value" in a
# table row is the shape to avoid; recovery only ever injects for an ORPHANED marker anyway.
MIN_GAP_DEF_CHARS = 25
_GAP_DEF_RE = re.compile(
    r'(?:^|\s{3,})(\d{1,3})[ \t]((?:[A-Z"\'(“‘]|' + DEF_URL_OPENER + r')[^\n]*?)(?=\s{3,}|$)',
    re.MULTILINE)


# A page of prose is ~14-17% spaces (measured across the corpus books whose text
# layer works). Some PDFs encode no space glyphs at all, so pypdf returns one
# run-together word per line — soviet_marxism measures 0.000, and its "defs" are
# junk like "PoliticalTenetsworldcouldbestabilizedandhierarcbically". Such a page
# cannot witness anything: not which notes exist, not what they say.
_MIN_SPACE_RATIO = 0.04


def pypdf_text_is_usable(text):
    """False when a pypdf page text has no word separation to offer.

    Guards every consumer of the text layer: def extraction (which otherwise
    pattern-matches run-together prose as a definition), marker resurrection,
    and the definition-text repair — a witness with no spaces would be aligned
    against good OCR and "repaired" into nonsense.

    Judged at EVERY length, deliberately. An earlier version exempted pages
    under 200 characters as "too short to judge", which let soviet_marxism's
    front matter through as defs 1, 7, 23 and 201
    ("SovietMarxismACRITICALANALYSISByHerbertMarcuse", "PARTl:POLITICALTENETS").
    A page holding only run-together text has nothing to witness whatever its
    length, and refusing a short page costs nothing — there are no definitions
    on it to recover. (Consequence to know: a page whose text is one long URL,
    or a script that does not separate words, is refused on the same rule.)
    """
    if not text:
        return False
    return (text.count(' ') / len(text)) >= _MIN_SPACE_RATIO


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
        if not pypdf_text_is_usable(text):
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
            # Match: number (1-3 digits), 1-3 spaces, then text starting with uppercase, quote, or open paren.
            # GLUED fallback: pypdf renders some superscript def numbers with NO space at all
            # ("1Senate Education and Employment\u2026", deloitte fn 1) \u2014 accept zero-space only when
            # followed by Uppercase-then-lowercase, so "42AM" (a legal section id) never splits.
            m = re.match(r'^(\d{1,3})\s{1,3}((?:[A-Z"\'(\u201c\u2018]|' + DEF_URL_OPENER + r').{2,})', line) \
                or re.match(r'^(\d{1,3})([A-Z][a-z].{2,})', line) \
                or _APPARATUS_DEF_RE.match(line)
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

                # TOC entry ("01 Executive Summary 05") / cover date ("4 July 2025") \u2014 the same
                # junk shapes the OCR-side def scan guards against (pdf_shared): a def never
                # ends in a bare 1-3-digit page number, and a day-number is not a footnote.
                stripped_line = line.rstrip()
                if _TOC_ENTRY_TAIL_RE.search(stripped_line) or _DATE_LINE_RE.match(stripped_line.strip()):
                    continue

                # Save previous definition if any
                if current_num is not None:
                    defs.append((current_num, current_text))

                current_num = num
                current_text = def_text
            elif current_num is not None:
                # Continuation line: non-empty, starts with lowercase, space, or quote.
                # CAPPED: pypdf's content-stream order can put the page BODY right after the
                # footnote region, and unbounded gluing swallowed it whole (deloitte: a def
                # carrying "1.3.4 Compliance Model Design\u2026" \u2014 an entire page in one footnote).
                # A real citation def (title + report id + wrapped URL) fits well inside the
                # cap; when a continuation would blow past it, close the def instead.
                stripped = line.strip()
                # Page chrome ends the def: a running-header line, a "A | B" header, or a
                # numbered HEADING ("1. Executive Summary") \u2014 pypdf's content stream puts these
                # right after the note area, and gluing them gave "Ibid. 1. Executive Summary
                # Independent Review of \u2026" (deloitte p9 fn 10).
                low = stripped.lower()
                is_chrome = (' | ' in stripped
                             or re.match(r'^\d{1,3}\.\s+\S', stripped)
                             or any(low.startswith(rh) for rh in running_lower if rh))
                if stripped and not is_chrome \
                        and not re.match(r'^\d{1,3}\s{1,3}(?:[A-Z"\'(\u201c\u2018]|' + DEF_URL_OPENER + r')', line) \
                        and not re.match(r'^\d{1,3}[A-Z][a-z]', line) \
                        and not _APPARATUS_DEF_RE.match(line) \
                        and len(current_text) + len(stripped) <= 700:
                    current_text += ' ' + stripped
                else:
                    # Non-continuation (or cap reached): save current and reset
                    defs.append((current_num, current_text))
                    current_num = None
                    current_text = None

        # Save final definition
        if current_num is not None:
            defs.append((current_num, current_text))

        # A LINK-ONLY note the text layer never put on its own line. pypdf's content-stream order
        # routinely glues the page-bottom note onto the tail of a body/table line, separated only
        # by the big whitespace run that stands in for the footnote rule ("…a genuine open access
        # ␣␣␣␣2 http://wokinfo.com/…, accessed on July 26, 2013."). Every line-anchored rule above
        # misses it, so ffbb3ac7's notes — almost all bare URLs — were unrecoverable even though
        # the text layer carried each one. A number + URL after a 3-space run is not something else:
        # prose does not indent like that, and recovery only injects for an ORPHANED marker anyway.
        found = {n for n, _t in defs}
        for m in _GAP_DEF_RE.finditer(text):
            num = int(m.group(1))
            body = re.sub(r'\s+', ' ', m.group(2)).strip()
            if num in found or num > 500 or len(body) < MIN_GAP_DEF_CHARS:
                continue
            found.add(num)
            defs.append((num, body))

        if defs:
            result[page_idx] = defs

    _unglue_page_numbers(result)
    return result


def _unglue_page_numbers(defs_by_page):
    """The printed PAGE NUMBER glued onto the first note's number, in place.

    pypdf's content stream usually puts the printed page number on its own line before
    anything else ("6\\n1Senate Education…"), but not always — deloitte page 7 arrives as
    "75 Department of Employment and Workplace Relations (Cth), Secret ary's…", which is
    the page number 7 and note number 5 with no separator. Read literally that is note 75,
    which belongs to no page map, so the note gets NO WITNESS: its definition shipped with
    a wholly hallucinated URL (dewi.gov.au/insuringintegrity-…) that the text layer could
    have corrected outright.

    Only the FIRST definition on a page can be affected (the page number is drawn before
    the note block), and the evidence has to be positive on three counts before a number is
    rewritten: the digits really do open with this page's own number, the remainder
    continues the document's note run or repairs a DESCENT within the page (a real block
    never descends), and the glued reading is implausibly far above the run. Anything less
    and a genuine note 75 on page 7 would be silently renumbered to 5 — which is the same
    class of damage this whole module exists to undo.
    """
    prev_max = None
    for page_idx in sorted(defs_by_page.keys()):
        page_defs = defs_by_page[page_idx]
        num, text = page_defs[0]
        digits = str(num)
        prefix = str(page_idx + 1)
        page_max = max(n for n, _t in page_defs)

        if digits.startswith(prefix) and len(digits) > len(prefix):
            remainder = digits[len(prefix):]
            rem = int(remainder)
            later = [n for n, _t in page_defs[1:]]
            continues_run = prev_max is not None and rem == prev_max + 1
            repairs_descent = any(rem < n <= num for n in later)
            # The glued reading has to be an outlier, not merely larger.
            implausible = (num > prev_max + 20) if prev_max is not None else (num >= rem * 10)
            if rem >= 1 and not remainder.startswith('0') \
                    and (continues_run or repairs_descent) and implausible:
                page_defs[0] = (rem, text)
                page_max = max(n for n, _t in page_defs)

        prev_max = page_max


def extract_pypdf_page_texts(pdf_path):
    """Raw per-page text from the PDF's own text layer: {page_index: text}. Companion to
    extract_pypdf_footnote_defs for consumers that need the BODY text (marker resurrection)."""
    reader = PdfReader(pdf_path)
    out = {}
    for i in range(len(reader.pages)):
        text = reader.pages[i].extract_text()
        if text and pypdf_text_is_usable(text):
            out[i] = text
    return out


# A superscript marker as the PDF's text layer renders it: an anchor WORD, the punctuation
# closing its sentence/clause, the digit, then the next word. The layer spaces the digit three
# different ways depending on where the superscript fell in the printed line, so the shapes are
# classified after matching rather than by three near-identical patterns.
_PYPDF_MARKER_SEAM_RE = re.compile(
    r"([A-Za-z]{2,})"                                 # anchor word
    # TRIED AND REVERTED: widening this to a RUN of closing punctuation, optionally preceded
    # by a space, so it could cross deloitte's "…(negative compliance ).17". It does reach
    # that marker — and on the anand fixture it plants a SPURIOUS one, which consumes a global
    # number and shifts everything after it: markers 72/80 became 73/81 and marker 104 fell
    # off the end, costing a real definition. Measured both ways; the seams it newly finds are
    # mostly genuine, so the fault is not the shape alone and a wider seam cannot be made safe
    # by tightening the punctuation class (a leading-space rule separates neither case). A
    # marker in the wrong place is the exact damage this module exists to undo, so deloitte's
    # note 17 stays unlinked until there is evidence that distinguishes the two.
    r"([.,;:!?)]?[ \t]*['\"‘’“”]?)"   # punctuation closing it ("world.", "completely. ’")
    r"([ \t]*\n?[ \t]*)"                              # gap before the digit
    r"(\d{1,3})"
    r"([ \t]*\n?[ \t]*)"                              # gap after it
    r"([A-Za-z]{2,})")                                # the following word

# TRIED AND REJECTED: a fourth shape for a marker that ends its text block with no word after
# it, only a table number — "…prioritise systemic risk.120 ⏎ 5 Human-Centred…" (deloitte notes
# 120/130/133). Anchored on the preceding word alone it recovered one of the three orphans and
# cost more than it bought: a definition LOST and two NEW gaps (134, 136), because a marker
# planted in the wrong place shifts that page's local→global map and everything after it. One
# word is not enough evidence, and the exactly-one-match rule does not make it enough. These
# three notes render unlinked, which is the better debt.
_SENTENCE_END = re.compile(r"[.!?]")

# "(Report, 17 April 2025)" has the exact shape of a glued marker seam — word, punctuation,
# number, capitalised word — and it is a DATE. The number is a day, and planting [^17] there
# would put a marker inside another note's definition. Nothing else about the seam can tell
# the two apart, so the follower is checked by name.
_MONTH_FOLLOWER_RE = re.compile(
    r'^(January|February|March|April|May|June|July|August|September|October|November|December'
    r'|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$', re.IGNORECASE)


def _marker_seams(pypdf_text):
    """Yield (anchor_word, number, index_after_number, following_word) for every superscript-
    shaped marker in a page's text layer.

    THREE accepted shapes, and the reason there are three is that the layer's spacing records
    where the superscript sat in the printed line, not what it means:
      - GLUED, the original rule — "…mitigate risk.9 This" (deloitte p9).
      - LINE-BROKEN — "…he adopts. 63\\nThis", "…literature.\\n66 As", "…itself.\\n68\\nIn". The
        newline IS the signature: running prose does not break a line to isolate a number.
      - SENTENCE-BOUNDARY — "…the Soviet Union. 88 While dialectical". Spaced on both sides, so
        it needs the strictest test: the punctuation must END A SENTENCE and the next word must
        be Capitalised. That is what separates it from the shape the original rule deliberately
        excluded — a digit merely spaced inside a clause ("rose by 9 percent"), where nothing
        ends and the follower is lowercase.

    The anchor word is yielded rather than the literal seam because the OCR and the text layer
    disagree constantly on the punctuation between them (quote glyph, spacing); the caller
    rebuilds a tolerant pattern from word + follower.
    """
    for m in _PYPDF_MARKER_SEAM_RE.finditer(pypdf_text):
        word, punct, before, num, after, follow = m.groups()
        if not punct.strip():
            continue                     # no clause/sentence close at all — this is just prose
        glued = before == ''
        broken = '\n' in (before + after)
        sentence = bool(_SENTENCE_END.search(punct)) and re.match(r'[A-Z][a-z]', follow)
        if not (glued or broken or sentence):
            continue
        if _MONTH_FOLLOWER_RE.match(follow):
            continue                     # a day of the month, not a superscript
        yield word, int(num), m.end(4), follow


def resurrect_dropped_markers_from_pypdf(ocr_md, pypdf_text, def_nums, page_label='',
                                         def_texts=None):
    """Re-inject in-text markers Mistral dropped ENTIRELY, using the PDF text layer as witness.

    deloitte p9: printed "…mitigate risk.9 This ensures…" OCR'd as "…mitigate risk. This
    ensures…" — no digit at all, so no licensing rule can ever resurrect it from the OCR side.
    But pypdf keeps the superscript. For each def number the page's own note area carries with
    NO marker in the OCR text: find pypdf's word-punct+N+word seam, then find that exact seam
    (digit-less) in the OCR markdown — insert [^N] there. Gated hard: the number must carry the
    superscript signature in pypdf, must be one of THIS page's def numbers, must not already
    appear as a marker, and the seam must match EXACTLY ONCE in the OCR page — a wrong link is
    worse than a missing one, so any ambiguity skips.

    TWO seam shapes, because a page can lose its whole apparatus. On the Anand article the OCR
    emitted pages 7 and 9 of the PDF with no markers AND no note block at all, and the only
    ones the glued shape could reclaim were the two where the layer happened not to break the
    line — which matters far more than 2 markers, because a page_bottom page's definitions are
    recovered through the local→global map built from its markers (assembly.py), so a page with
    no markers cannot receive its definitions either. Accepting the line-broken shape took those
    two pages from 5 markers to 19 and let 19 definitions follow.

    `def_texts` (optional {num: [text, …]}): the page's definition BODIES. Used to reject a
    candidate whose digit is the note's own printed number at the head of its definition —
    "…of Kerala.\n63 P Kesavadev, Odayil Ninnu" is the note block, not a marker in the body.
    Without it the line-broken shape can plant a marker inside the note area.

    Returns (updated_md, resurrected_count).
    """
    existing = set(int(n) for n in re.findall(r'\[\^?(\d{1,3})\]', ocr_md))
    def_texts = def_texts or {}
    count = 0

    def _is_definition_head(num, at):
        """True when the text right after the digit IS that note's definition."""
        after = _comparable(pypdf_text[at:at + 40])
        for t in def_texts.get(num, ()):
            head = _comparable(t)[:30]
            if head and after.startswith(head):
                return True
        return False

    for word, num, after_num, follow in _marker_seams(pypdf_text):
        if num not in def_nums or num in existing:
            continue
        if _is_definition_head(num, after_num):
            continue
        # Anchor on the two WORDS and tolerate whatever punctuation sits between them: the OCR
        # and the text layer routinely render the same closing quote differently ("world.’70"
        # vs "world.'"), and an exact-seam match would simply never fire on those.
        # ...including the markdown EMPHASIS the OCR adds and the text layer cannot have:
        # "(*negative compliance*).\n\nHowever" against the layer's "(negative compliance ).17
        # However". Without the asterisks in the run the seam is found in the layer and then
        # never located in the OCR, which is silently indistinguishable from "the OCR reworded
        # it". Digits stay OUT of the class on purpose — see the month guard above.
        pattern = re.escape(word) + r"[.,;:!?)*_\s'\"‘’“”]{1,8}" + re.escape(follow)
        hits = list(re.finditer(pattern, ocr_md))
        if len(hits) != 1:
            continue                     # absent (OCR reworded) or ambiguous — skip, never guess
        # The marker belongs at the END of the punctuation run, not before it: "world.'[^70] Thus".
        at = hits[0].end() - len(follow)
        while at > hits[0].start() and ocr_md[at - 1].isspace():
            at -= 1
        ocr_md = ocr_md[:at] + f'[^{num}]' + ocr_md[at:]
        existing.add(num)
        count += 1
    if count:
        print(f"  pypdf marker resurrection: re-injected {count} dropped in-text marker(s){page_label}")
    return ocr_md, count


# A PDF whose DIGITS are mapped into the Unicode Private Use Area. Subset fonts from some
# typesetters (Advanced Typesetting's "AdvOT*", used across Cambridge journals) ship no usable
# ToUnicode CMap: the glyph shapes are digits but the file declares them as U+F6xx, and the
# /Differences array names them "/uniF646" — restating the PUA codepoint rather than the digit.
# Nothing in the PDF says these are numbers.
#
# Consequence, measured on cambridge-voluntariness (2026-09-19): Mistral OCR emitted only 8 of the
# article's 34 footnote markers, so 26 citations were never linked and the citation review produced
# 7 claims where the paste twin produced 29. The superscripts are plainly visible on the page.
_PUA_RANGE = (0xE000, 0xF8FF)


def derive_pua_digit_map(pdf_path):
    """{codepoint: digit} for a PDF whose digits live in the Private Use Area, else None.

    Derived, never hardcoded: collect every PUA codepoint the document uses and accept the mapping
    ONLY when there are exactly ten forming a consecutive run — which is what a ten-glyph digit
    subset looks like, and what almost nothing else does. Ascending codepoint order is ascending
    digit order (verified against this file's own DOI, which renders as U+F644 U+F643 '.' … for
    "10.1017/…", giving U+F643='0').

    Returning None on anything ambiguous is the point: a wrong digit map would invent footnote
    numbers, and a wrong marker is worse than a missing one.
    """
    try:
        reader = PdfReader(pdf_path)
    except Exception:
        return None

    seen = set()
    for page in reader.pages:
        try:
            text = page.extract_text() or ''
        except Exception:
            continue
        for ch in text:
            if _PUA_RANGE[0] <= ord(ch) <= _PUA_RANGE[1]:
                seen.add(ord(ch))
                if len(seen) > 10:
                    return None          # more than a digit set — not ours to interpret
    if len(seen) != 10:
        return None

    codes = sorted(seen)
    if codes != list(range(codes[0], codes[0] + 10)):
        return None                       # not one contiguous subset — refuse to guess

    return {code: str(i) for i, code in enumerate(codes)}


def _pua_only(fragment, digit_map):
    """The digits of a fragment made up ENTIRELY of PUA digits (and space), else None.

    A marker arrives as its own text-show operation because it is set in a different font, so the
    pypdf visitor hands it over isolated — "topic," then " \uf646" then " we identified". That
    isolation IS the superscript signal; a PUA digit embedded in a longer fragment is ordinary
    body text (a year, a page number) and is left alone.
    """
    stripped = fragment.strip()
    if not stripped or len(stripped) > 3:
        return None
    digits = ''
    for ch in stripped:
        d = digit_map.get(ord(ch))
        if d is None:
            return None
        digits += d
    return digits or None


def extract_pua_marker_seams(pdf_path, digit_map, context_chars=60):
    """Per page, the footnote markers the PDF draws as PUA superscripts: {page: [(num, seam)]}.

    `seam` is the body text immediately BEFORE the marker, which is what locates it in the OCR
    markdown — the marker itself is exactly what the OCR lost, so it cannot be searched for.
    """
    try:
        reader = PdfReader(pdf_path)
    except Exception:
        return {}

    out = {}
    for i, page in enumerate(reader.pages):
        frags = []
        page.extract_text(visitor_text=lambda t, cm, tm, fd, fs: frags.append(t))

        buf = ''
        found = []
        for frag in frags:
            num = _pua_only(frag, digit_map)
            if num is not None and buf.strip():
                found.append((num, buf[-context_chars:]))
                continue
            buf += frag
        if found:
            out[i] = found
    return out


def filter_ascending_marker_chain(seams, max_number):
    """Keep only the PUA candidates that behave like a document's footnote markers.

    Raw extraction is deliberately permissive and therefore noisy: on cambridge-voluntariness it
    offered 200 candidates, because the endnote pages set their page numbers and years in the SAME
    PUA font, isolated in their own fragments ("406", "426", "783"). Two constraints, both facts
    about what a marker IS rather than guesses about what these glyphs mean:

      - it is numbered within the document's definition range (1..max_number); and
      - markers are CONTIGUOUS through the document — 1, 2, 3, … — which is what
        `footnote_strategy: sequential` means, and the same invariant
        _repair_sequential_ref_misreads relies on.

    Contiguity rather than mere ascent, because ascent alone is too weak to survive the noise: the
    title page offers "4" and "10" (volume and issue numbers in the same font) which an ascending
    filter accepts, and those then lock out the genuine 3..9 that follow on page 3. Requiring
    last+1 rejects both, and the real chain resumes intact.

    The cost is deliberate: a marker genuinely absent from the text layer stalls the chain and
    everything after it is skipped. That is the safe direction — under-recovering leaves citations
    unlinked and visible in the audit, while a mis-numbered marker silently attributes a claim to
    the wrong work.

    On the measured file this reduces 200 candidates to the true chain 1..34 and drops every
    endnote-page page number, because those come after marker 34 and cannot extend the chain.

    @param seams {page_index: [(number_str, seam_text)]}
    @return the same shape, filtered
    """
    out = {}
    last = 0
    for page in sorted(seams):
        kept = []
        for num, seam in seams[page]:
            try:
                value = int(num)
            except ValueError:
                continue
            if value != last + 1 or value > max_number:
                continue
            kept.append((num, seam))
            last = value
        if kept:
            out[page] = kept
    return out


def resurrect_pua_markers(ocr_md, seams, page_label=''):
    """Re-inject markers the OCR dropped because the PDF encodes its digits in the PUA.

    Same contract as resurrect_glued_markers_from_pypdf, and the same refusal to guess: the number
    must not already be present, and the seam must locate EXACTLY ONE place in the page's markdown.
    Anything absent (OCR reworded the sentence) or ambiguous is skipped.

    Matching is done on a folded copy — ligatures, case, whitespace and punctuation removed, since
    pypdf and Mistral disagree about all four ("identi" + "\ufb01" + "ed" vs "identified") — and the
    insertion point is mapped back through _char_index_map, so the markdown itself is untouched
    apart from the inserted marker.

    Returns (updated_md, count).
    """
    if not seams:
        return ocr_md, 0

    existing = set(re.findall(r'\[\^(\d{1,3})\]', ocr_md))
    count = 0

    for num, seam in seams:
        if num in existing:
            continue

        folded_seam = _comparable(seam)
        if len(folded_seam) < 12:
            continue                      # too little context to place safely

        folded_md = _comparable(ocr_md)
        hits = [m.start() for m in re.finditer(re.escape(folded_seam), folded_md)]
        if len(hits) != 1:
            continue                      # absent or ambiguous — never guess

        index_map = _char_index_map(folded_md, ocr_md)
        insert_at = index_map.get(hits[0] + len(folded_seam))
        if insert_at is None:
            continue

        # Attach the marker TIGHT to the text it belongs to. The fold drops whitespace, so mapping
        # back can land just past a space ("needs, [^4]where"), which reads as though the note
        # belongs to the following word. A superscript sits against the word before it.
        while insert_at > 0 and ocr_md[insert_at - 1].isspace():
            insert_at -= 1

        ocr_md = ocr_md[:insert_at] + f'[^{num}]' + ocr_md[insert_at:]
        existing.add(num)
        count += 1

    if count:
        print(f"  PUA marker resurrection: re-injected {count} dropped in-text marker(s){page_label}")
    return ocr_md, count


def split_run_on_numbered_def(num, text):
    """A pypdf 'def' that is really a RUN-ON of consecutively numbered items on one text
    block — the affiliation-footer shape (a280cf5b: "1 School of International Development…,
    UK 2 Programme Strategy…, 3 African Climate…, 4 Institute for…, 5 Watershed…"): only item
    1 starts a line, so extraction returns ONE def whose text swallows items 2..5. Split on
    the ascending ' N ' boundaries. Gated: at least TWO boundaries must chain consecutively
    (a def that merely mentions one number never splits) and every inner segment must be
    substantial. Trailing 'Correspondence:' contact chrome is trimmed from the last item.
    Returns [(num, text)] unchanged when the shape does not hold."""
    flat = re.sub(r'\s+', ' ', text).strip()
    segs = []
    cur = num
    rest = flat
    while True:
        m = re.search(rf'\s{cur + 1}\s', rest)
        if not m:
            break
        segs.append((cur, rest[:m.start()].strip().rstrip(',;')))
        rest = rest[m.end():]
        cur += 1
    segs.append((cur, rest.strip()))
    if len(segs) < 3 or any(len(t) < 15 for _n, t in segs[:-1]):
        return [(num, text)]
    last_n, last_t = segs[-1]
    last_t = re.split(r'\bCorrespondence\b', last_t)[0].strip().rstrip(',;')
    segs[-1] = (last_n, last_t)
    return [(n, t) for n, t in segs if t]


# A short-form back-reference is SUPPOSED to repeat — that is what it is for. The chrome rule
# below rejects any text appearing under two or more numbers, which is right for a running
# footer ("2 PALGRAVE COMMUNICATIONS | 3:17092 | DOI…" on page 2 and "4 PALGRAVE…" on page 4)
# and catastrophic for "Ibid.": deloitte prints it 20-odd times, so EVERY ibid was silently
# dropped and its marker left with no definition at all. Kept short on purpose — a repeated
# paragraph is furniture whatever it opens with.
_SHORT_FORM_DEF_RE = re.compile(
    r'^(ibid|id|idem|op\.?\s*cit|loc\.?\s*cit|ebd|a\.?\s*a\.?\s*o)\b[.,]?\s*\S{0,40}$',
    re.IGNORECASE)


def recover_missing_defs(ocr_defs_set, pypdf_defs_by_page, max_ref_number,
                          page_offsets=None, targeted_pages=None,
                          allow_overwrite=False, only_numbers=None):
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
    # Running-footer CHROME rejection: the SAME text pattern-matched under two or more
    # DIFFERENT numbers is a page-number + running-footer line ("2 PALGRAVE COMMUNICATIONS |
    # 3:17092 | DOI…" on page 2, "4 PALGRAVE…" on page 4 — a280cf5b linked two authors to
    # journal chrome). Genuine defs never share identical text.
    text_counts = {}
    for page_defs in pypdf_defs_by_page.values():
        for _n, t in page_defs:
            key = re.sub(r'\s+', ' ', t).strip().lower()
            text_counts[key] = text_counts.get(key, 0) + 1
    chrome = {k for k, c in text_counts.items()
              if c >= 2 and not _SHORT_FORM_DEF_RE.match(k)}

    recovered = []
    seen = set()
    page_offsets = page_offsets or {}
    for page_idx in sorted(pypdf_defs_by_page.keys()):
        if targeted_pages is not None and page_idx not in targeted_pages:
            continue
        offset = page_offsets.get(page_idx, 0)
        for fn_num, fn_text in pypdf_defs_by_page[page_idx]:
            if re.sub(r'\s+', ' ', fn_text).strip().lower() in chrome:
                continue
            for split_num, split_text in split_run_on_numbered_def(fn_num, fn_text):
                shifted_num = split_num + offset
                if only_numbers is not None and shifted_num not in only_numbers:
                    continue
                # A definition opens with prose (letter or quote) — a candidate opening with
                # punctuation/digits is a BIBLIOGRAPHY fragment the extractor misread
                # (cece961b: "(4), 1 – 6 . Masalu, D.C., 2000…" became phantom "def 1").
                # Genuine orphan defs (no ref yet) stay recoverable as visible content.
                if not re.match(r'''^["'‘“\[(]?[A-Za-z]''', split_text.strip()):
                    continue
                if shifted_num in ocr_defs_set and not allow_overwrite:
                    continue
                if shifted_num < 1 or shifted_num > max_ref_number:
                    continue
                if shifted_num in seen:
                    continue
                seen.add(shifted_num)
                # The text layer's glyph-by-glyph spacing ships as-is here — there is no OCR
                # token stream to map onto — and a reader works around "In stitute o f In
                # ternal Au ditors". A URL does not: "…/risk -services/management/risk -
                # management-to olkit/…" is a dead link, and a recovered note is usually a
                # note whose URL is the only thing citation resolution can act on.
                recovered.append((shifted_num, sanitize_layer_def_text(split_text)))
    return recovered


# Markdown emphasis the OCR adds around titles. The PDF text layer never
# contains it, so it is held aside while aligning and left in place afterwards.
# Asterisk ONLY. Underscore is NOT treated as emphasis here: held aside, it is
# stripped from the alignment stream and so deleted from any substituted token —
# which silently destroys URLs, the one place underscores carry meaning
# ("…/Parliamentary_Business/…/Education_and_Employment/…" came back as
# "…/ParliamentaryBusiness/…/EducationandEmployment/…", a dead link). The
# converter's own emphasis is asterisk-based, so nothing is lost by excluding it.
_MARKUP_CHARS = frozenset('*')

# Below this character-level agreement the pypdf def is a DIFFERENT note (or
# extractor noise), and substituting from it would corrupt a good definition.
_REPAIR_MIN_SIMILARITY = 0.85

# ...but when the page's whole definition BLOCK has been aligned against the text layer's own
# block, identity is already settled and the floor is only in the way. Still a floor, because
# the alignment can be wrong and nothing should rewrite a definition out of all recognition.
_REPAIR_CONFIRMED_MIN_SIMILARITY = 0.40

_DASHES = '-‐‑‒–—'


def _strip_tokens(text):
    """Whitespace-free character stream plus a map back to the original tokens.

    Returns (chars, tokens) where each token is
    (orig_start, orig_end, strip_start, strip_end): a maximal run of non-space
    characters in `text`, and the span it occupies in `chars`. Markup characters
    are excluded from `chars` (the text layer has none) but stay inside the
    token's original span so emphasis survives untouched.
    """
    chars = []
    tokens = []
    orig_start = None
    strip_start = None
    for idx, ch in enumerate(text):
        if ch.isspace():
            if orig_start is not None:
                tokens.append((orig_start, idx, strip_start, len(chars)))
                orig_start = None
            continue
        if orig_start is None:
            orig_start = idx
            strip_start = len(chars)
        if ch not in _MARKUP_CHARS:
            chars.append(ch)
    if orig_start is not None:
        tokens.append((orig_start, len(text), strip_start, len(chars)))
    return ''.join(chars), tokens


def _comparable(s):
    """Fold a token to what a SUBSTANTIVE difference would show up in.

    Drops case, whitespace and punctuation, so a repair is never triggered by
    the text layer's own artifacts:
      - quote glyph direction — pypdf reads German „…“ as „…”, and OCR is the
        better witness for directional quotes;
      - line-break hyphenation — justified PDF text carries the hyphen from the
        wrap ("anderer-seits", "Blu-men") which the OCR correctly joined up.
    A hyphen BETWEEN DIGITS is kept, because there it is meaningful: a pinpoint
    range ("7-9") that OCR flattened to "79" is a real error worth fixing.

    Accents are folded to ASCII rather than dropped, so that the SAME letter
    written two ways compares equal: pypdf and OCR disagree on Unicode
    composition ("Pedro-Carañana" precomposed U+00F1 vs decomposed n + U+0303),
    which is not a spelling difference. Dropping the accent glyph instead left
    "caranana" against "carana" and substituted one encoding for the other —
    invisible in the text, but it broke a citation anchor (fixture a7fc96d5,
    citations_linked 86 -> 85).
    """
    import unicodedata
    # Dashes are folded to ASCII '-' FIRST: the ascii('ignore') step below drops
    # an en dash entirely, which would erase the very hyphen the digit rule then
    # looks for ("7–9" reduced to "79" and compared equal to the OCR's "79").
    folded = s
    for dash in _DASHES[1:]:
        folded = folded.replace(dash, '-')
    folded = unicodedata.normalize('NFKD', folded).encode('ascii', 'ignore').decode('ascii').lower()
    folded = re.sub(r'(?<![0-9])-|-(?![0-9])', '', folded)
    return re.sub(r'[^a-z0-9-]+', '', folded)


def _plausible_substitution(candidate, token_len):
    """A word-level OCR error is roughly length-preserving ("Gentelink" ->
    "Centrelink", "Gumknow" -> "Gummow", "TUV/W" -> "1UNSW").

    The check exists for the LAST token of a definition: the alignment pins the
    end of the OCR stream to the end of the pypdf stream, so any trailing text
    the extractor glued on gets absorbed into that final token —
    "2003a" became "2003a)(c)ViennaUniversityofTechnology2003." (fixture
    7fa30289). A candidate wildly longer than what it replaces is swallowing its
    neighbours, not correcting a word.

    The tolerance SCALES, and deliberately has a tight floor: a flat allowance of
    4 characters is nothing next to a long title but is most of a pinpoint, which
    let "510-13." become "510-13.7268" — digits from the page furniture appended
    to a citation, i.e. an invented page range. Short tokens get the least slack
    because that is where a few stray characters change the meaning.
    """
    return abs(len(candidate) - token_len) <= max(2, token_len // 3)


def _char_index_map(a, b):
    """Map every index of `a` (including len(a)) onto an index of `b`.

    Equal runs map one-to-one; inside a replaced run the position is scaled, so
    a token's span lands in the right neighbourhood even where the two streams
    disagree on length ("TUV/W" vs "1UNSW").
    """
    import difflib
    mapping = {}
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        span_a = i2 - i1
        span_b = j2 - j1
        for k in range(span_a):
            if tag == 'equal':
                mapping[i1 + k] = j1 + k
            else:
                scaled = int(round(k * span_b / span_a)) if span_a else 0
                mapping[i1 + k] = j1 + min(span_b, scaled)
    mapping[len(a)] = len(b)
    return mapping


# Below this ratio of lengths the two renderings are the same extent and there is no
# dropped continuation line to look for.
_TAIL_SLACK = 1.15

# A continuation line the OCR dropped is only restored when it is a URL and NOTHING else.
# That is the narrowest carve-out available: a URL is ASCII, carries no directional quotes,
# has no line-break hyphenation to import and no Unicode composition to get wrong — the
# four artifact classes that killed the earlier "rebuild the whole def from pypdf" version.
_URL_TAIL_RE = re.compile(r'^[\s.,;:)\]]*(https?://\S.*)$', re.S)
# A bare alphabetic word in the tail means it is prose, not a wrapped URL: pypdf splits a
# URL into fragments that keep their punctuation ("g-integrity-targeted-co", "mpliance-",
# "framework/announcements/secretarys"), whereas glued page chrome reads as words
# ("Independent Review of Targeted Compliance Framework").
_WORDLIKE_RE = re.compile(r'^[A-Za-z]{2,}$')


def _url_only_tail(tail_text):
    """The URL a dropped continuation line carried, or None if the tail is anything else."""
    match = _URL_TAIL_RE.match(tail_text)
    if not match:
        return None
    body = match.group(1)
    if '|' in body:
        return None
    for piece in body.split():
        if _WORDLIKE_RE.match(piece.strip('.,;:()[]')):
            return None
    url = re.sub(r'\s+', '', body).rstrip('.,;:')
    if not 12 <= len(url) <= 300:
        return None
    return url


def _prefix_cut(ocr_chars, pdf_chars):
    """Where the OCR def's coverage of the pypdf stream ENDS, or None if it can't be placed.

    Refuses unless the OCR stream is matched right to its own end — otherwise the two
    renderings disagree somewhere other than a dropped tail, and truncating the pypdf side
    would be inventing agreement.
    """
    import difflib
    blocks = [b for b in difflib.SequenceMatcher(
        None, ocr_chars.lower(), pdf_chars.lower(), autojunk=False
    ).get_matching_blocks() if b.size]
    if not blocks:
        return None
    last = blocks[-1]
    if last.a + last.size < len(ocr_chars) - 2:
        return None
    return last.b + last.size


def _orig_index_for_strip(tokens, text_len, strip_idx):
    """Map an index in a _strip_tokens stream back to an index in the original text."""
    last_end = 0
    for orig_start, orig_end, span_start, span_end in tokens:
        if strip_idx < span_start:
            return last_end
        if strip_idx <= span_end:
            return orig_start + (strip_idx - span_start)
        last_end = orig_end
    return text_len


def _respace_from_pypdf(ocr_text, pdf_text, min_similarity=_REPAIR_MIN_SIMILARITY,
                        identity_confirmed=False):
    """Substitute the words the OCR got wrong, using the PDF's own text layer.

    The two witnesses fail in opposite directions, which is what makes this
    possible. The embedded text layer is not recognised, so its LETTERS are
    exact — but PDF text is positioned glyph by glyph, so its spacing is junk
    ("John Braithw aite", "Commo nwealth", "Algo rith mic"). OCR reads the page
    as an image, so it gets word boundaries right and invents letters
    ("Breithwaite", "Gentelink", "Rigorthmic", "Respondility").

    So the comparison runs on the whitespace-STRIPPED streams (pypdf's spacing
    never enters), and the output is built from the OCR's OWN tokens with only
    the ones that disagree substituted. Rebuilding the whole definition from the
    text layer instead — an earlier version of this — imported every pypdf
    artifact along with the fix: line-break hyphens inside words
    ("anderer-seits"), flipped quote glyphs, and trailing page chrome glued on
    by the extractor (")(c)ViennaUniversityofTechnology2003"). Iterating the
    OCR's tokens makes all three impossible: nothing outside a substituted token
    can change, and no token can be appended.

    Returns (repaired_text, ratio), or (None, ratio) when no repair applies.
    """
    import difflib
    ocr_chars, tokens = _strip_tokens(ocr_text)
    pdf_chars, pdf_tokens = _strip_tokens(pdf_text)
    if not ocr_chars or not pdf_chars:
        return None, 0.0

    # A definition whose continuation LINE the OCR dropped is shorter than the note it is,
    # and the whole-string ratio then reads as "different note" and refuses the repair.
    # Measured on deloitte note 1, whose second printed line is the aph.gov.au URL: against
    # the full text layer the ratio is 0.65 (refused, "Failing Thaw" ships); against the
    # layer truncated to the OCR's own extent it is 0.977 and "Those" is restored.
    # The truncation is allowed ONLY when what it cuts off is a URL, so the length gate
    # keeps working as the guard against a wrongly PAIRED note everywhere else.
    restored_url = None
    if len(pdf_chars) > len(ocr_chars) * _TAIL_SLACK:
        cut = _prefix_cut(ocr_chars, pdf_chars)
        if cut is not None and cut < len(pdf_chars):
            tail_at = _orig_index_for_strip(pdf_tokens, len(pdf_text), cut)
            candidate_url = _url_only_tail(pdf_text[tail_at:])
            if candidate_url and candidate_url not in re.sub(r'\s+', '', ocr_text):
                restored_url = candidate_url
                pdf_chars = pdf_chars[:cut]
            elif identity_confirmed:
                # Not a URL, so nothing is restored — but the tail still has to go before
                # the comparison. The extractor glues up to 700 characters of the FOLLOWING
                # PAGE onto a page's last note, and that surplus drags the ratio down and
                # skews the scaled index map: deloitte's note 6 is 229 characters against a
                # 678-character layer copy whose tail is "1.3 Analysis and Findings Over the
                # past two years…", scoring 0.52 and repairing nothing, while the note
                # itself matches almost exactly. Only for a CONFIRMED pair, because here the
                # length gate is no longer doing identity work — the alignment already did.
                pdf_chars = pdf_chars[:cut]

    if ocr_chars == pdf_chars and restored_url is None:
        return None, 1.0

    ratio = difflib.SequenceMatcher(
        None, ocr_chars.lower(), pdf_chars.lower(), autojunk=False
    ).ratio()
    if ratio < min_similarity:
        return None, ratio

    mapping = _char_index_map(ocr_chars, pdf_chars)

    out = []
    cursor = 0
    changed = False
    for orig_start, orig_end, strip_start, strip_end in tokens:
        token = ocr_text[orig_start:orig_end]
        j1 = mapping.get(strip_start)
        j2 = mapping.get(strip_end)
        if j1 is None or j2 is None or j2 < j1:
            continue
        candidate = pdf_chars[j1:j2]
        if not candidate or _comparable(candidate) == _comparable(token):
            continue
        if not _plausible_substitution(candidate, strip_end - strip_start):
            continue

        # Keep the token's emphasis, replace only its body.
        prefix = token[:len(token) - len(token.lstrip(''.join(_MARKUP_CHARS)))]
        suffix = token[len(token.rstrip(''.join(_MARKUP_CHARS))):]
        # NFC so a repair never injects decomposed combining marks.
        import unicodedata
        out.append(ocr_text[cursor:orig_start])
        out.append(prefix + unicodedata.normalize('NFC', candidate) + suffix)
        cursor = orig_end
        changed = True

    if not changed and restored_url is None:
        return None, ratio
    out.append(ocr_text[cursor:])
    repaired = re.sub(r'[ \t]+', ' ', ''.join(out)).strip()
    if restored_url:
        repaired = (repaired + ' ' + restored_url).strip()
    return (repaired or None), ratio


def repair_def_text_from_pypdf(combined, pypdf_defs_by_page, page_offsets=None,
                               min_similarity=_REPAIR_MIN_SIMILARITY,
                               confirmed_numbers=None):
    """Repair footnote-definition TEXT that OCR garbled, against the PDF's own
    embedded text layer.

    The existing pypdf passes treat the text layer as a witness for which notes
    and MARKERS exist; this one uses it for what a note SAYS. A note whose text
    OCR mangled is otherwise kept verbatim and reads as the author's own words:
    deloitte2025independent shipped "Gentelink's Automated Debt Raising" for
    Centrelink's, "Minelle Hildebrandt"/"Rigorthmic Regulation" for Mireille
    Hildebrandt's 'Algorithmic Regulation', "No TUV/W Law Journal" for
    (2018) No 1 UNSW Law Journal — 55 of 136 notes damaged, every one of them
    clean in the PDF's own text layer, and citation resolution cannot match any
    of them.

    Only definitions whose two renderings clearly describe the SAME note are
    touched (see _respace_from_pypdf), and only the first line of a definition
    is considered.

    Returns (combined, repairs) where each repair records number/ratio/
    before/after for telemetry.
    """
    if not pypdf_defs_by_page:
        return combined, []

    page_offsets = page_offsets or {}
    by_num = {}
    for page_idx in sorted(pypdf_defs_by_page.keys()):
        offset = page_offsets.get(page_idx, 0)
        for fn_num, fn_text in pypdf_defs_by_page[page_idx]:
            for split_num, split_text in split_run_on_numbered_def(fn_num, fn_text):
                by_num.setdefault(split_num + offset, split_text)
    if not by_num:
        return combined, []

    repairs = []

    def _repair_line(match):
        num = int(match.group(1))
        ocr_text = match.group(2)
        pdf_text = by_num.get(num)
        if not pdf_text:
            return match.group(0)
        # The similarity floor is there to answer "is this the same note?" — which is exactly
        # what the block reconciliation has already settled for a CONFIRMED number, by aligning
        # the whole page against the text layer. Keeping the floor there would refuse the only
        # notes still worth repairing: a note garbled past recognition ("Michael Avasarheya and
        # Miklos A. Alas, 'The Naw Economy'") scores 0.42 against the note it plainly is.
        confirmed = bool(confirmed_numbers and num in confirmed_numbers)
        floor = _REPAIR_CONFIRMED_MIN_SIMILARITY if confirmed else min_similarity
        repaired, ratio = _respace_from_pypdf(ocr_text, pdf_text, floor,
                                              identity_confirmed=confirmed)
        if repaired is None or repaired == ocr_text.strip():
            return match.group(0)
        repairs.append({
            'number': num,
            'ratio': round(ratio, 3),
            'before': ocr_text.strip(),
            'after': repaired,
        })
        return '[^' + str(num) + ']: ' + repaired

    combined = re.sub(r'^\[\^(\d+)\]:[ \t]*(.+)$', _repair_line, combined,
                      flags=re.MULTILINE)
    return combined, repairs


def _norm_chunk(t):
    return re.sub(r'[^a-z0-9]+', ' ', (t or '').lower()).strip()


def scan_page_degeneration(response_dict, pdf_path=None):
    """Detect pages where the OCR model DEGENERATED — looped instead of transcribing.

    This is the most dangerous OCR failure mode we have, because it does not lose text visibly: it
    substitutes fluent, plausible FILLER. stem_bibliography_example's reference pages 35/36/38 came
    back at 727/1321/1176 chars against ~5.5 KB neighbours, carrying a repeated conference caption
    and the heading '# 4.2.2.2.2.2.2.2.2…'. References 62-103 and 124-155 were never transcribed,
    and nothing downstream could tell — the book simply read as though the author had written the
    filler. A dropped page is a visible hole; this is invented content sitting in a library.

    The measure is the DUPLICATION RATIO — what fraction of the page's prose sits in sentences that
    occur more than once — combined with the page COLLAPSING against its neighbours. Both are
    needed, and a repetition COUNT is not enough: a healthy page legitimately repeats a sentence
    three times (table captions, legal boilerplate, 'See Table 4.'), and counting occurrences
    flagged 47 pages of which 43 were fine. The ratio separates them cleanly — measured over this
    corpus, degenerate pages score 0.50-0.75 AND come in at a third of the median page, while the
    healthy repeaters score 0.05-0.42 at or ABOVE median length:

        stem_bibliography_example  p35  727 chars  ratio 0.50   <- degenerate
                                   p36 1321 chars  ratio 0.75   <- degenerate (+ runaway heading)
                                   p38 1176 chars  ratio 0.53   <- degenerate
                                   p34 5541 chars  ratio 0.20      healthy
        deloitte2025independent    p219 5496 chars ratio 0.42      healthy

    Repetition alone still cannot separate a degenerate page from a legitimately short, repetitive
    one — a figure page whose two captions share a boilerplate sentence is statistically identical
    (93d34a74 p359: 626 chars, ratio 0.50, and entirely genuine). The PDF's OWN TEXT LAYER settles
    it, and it is ground truth rather than a heuristic: on that page pypdf sees 588 chars against
    the OCR's 626 — the page really is that short — whereas a degenerate reference page hides
    thousands of characters pypdf can still read. So when the PDF is present, repetition is only
    believed if the text layer shows material MISSING text; that combination has zero false
    positives across every PDF-bearing book in this corpus.

    A runaway numeric heading ('# 4.2.2.2.2.2.2.2.2') triggers on its own — a pure decoder loop,
    never real structure, and cheap to recognise without the PDF.

    Without a PDF (the fixture replay) the verdict degrades to 'suspected' on repetition + collapse
    alone, and a caption-heavy figure page can land there. Production always has the PDF.

    Detection only — this neither repairs the page nor rejects the import. It exists so a
    degenerate run is VISIBLE instead of scoring clean.

    Returns a list of per-page dicts; [] when the response looks healthy.
    """
    pages = response_dict.get('pages') or []
    if not pages:
        return []
    non_empty = sorted(len(p.get('markdown') or '') for p in pages
                       if len(p.get('markdown') or '') > 200)
    if not non_empty:
        return []
    median = non_empty[len(non_empty) // 2]

    layer = {}
    if pdf_path:
        try:
            layer = extract_pypdf_page_texts(pdf_path)
        except Exception:
            layer = {}

    findings = []
    for page in pages:
        md = page.get('markdown') or ''
        if len(md) < 120:
            continue                       # a near-empty page is its own (visible) problem
        sents = [_norm_chunk(s) for s in re.split(r'(?<=[.!?])\s+', re.sub(r'\s+', ' ', md))]
        sents = [s for s in sents if len(s) > 40]
        counts = Counter(sents)
        total = sum(len(s) for s in sents)
        dup = sum(len(s) * n for s, n in counts.items() if n > 1)
        ratio = (dup / total) if total else 0.0
        collapsed = len(md) < median * 0.6
        # HEADING-scoped: a bare '.N.N.N…' run elsewhere on the page is ordinary content — a
        # mathematical integer partition ('5.4.1.3.2.3.1.1.2.2.1.2.1.1.1.1.1.1.1' in a power-law
        # paper) and a mangled-URL artifact both matched an unscoped pattern on prod.
        runaway = bool(re.search(r'(?m)^#{1,6}[^\n]*(?:\.\d){8,}', md))

        idx = page.get('index')
        layer_chars = len(layer.get(idx) or '') if layer else 0
        shortfall = bool(layer_chars) and layer_chars > len(md) * 1.5

        repeats = max(counts.values()) if counts else 0
        reasons = []
        verdict = None
        if runaway:
            verdict = 'confirmed'
            reasons.append('runaway numeric heading — a decoder loop, not real structure')
        # `repeats >= 3` is the decisive addition. Ratio + collapse alone still confused a figure
        # PLATE — two figures whose captions share a Source/Note boilerplate sentence — with a
        # loop: measured on prod, every true positive repeats one sentence 5x while every false
        # positive tops out at 2 (unctad2019digital p83, 93d34a74 p359, travis-ficarra-mfa p36/37).
        if ratio >= 0.45 and collapsed and repeats >= 3:
            detail = (f'{round(ratio * 100)}% of the page is repeated text, one sentence '
                      f'{repeats}x, at {len(md)} chars against a {median}-char median page')
            if shortfall:
                verdict = 'confirmed'
                reasons.append(detail + f" — and the PDF's own text layer holds {layer_chars} "
                                        f'chars here, so the text is missing, not absent')
            elif repeats >= 5:
                # 5 identical sentences is not a document. No corroboration needed.
                verdict = 'confirmed'
                reasons.append(detail)
            elif not layer_chars:
                verdict = verdict or 'suspected'
                reasons.append(detail + ' (no PDF text layer available to corroborate)')
            # layer present and NOT short ⇒ the page really is this short. Not degenerate.
        if not reasons:
            continue
        findings.append({
            'page': idx,
            'verdict': verdict,
            'ocr_chars': len(md),
            'duplication_ratio': round(ratio, 2),
            'max_sentence_repeats': repeats,
            'text_layer_chars': layer_chars or None,
            'median_page_chars': median,
            'reasons': reasons,
        })
    return findings


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


# A definition the text layer corroborates at or above this agrees with the print. Same bar as
# the repair's — both answer "is this the note the document carries?".
_DEF_WITNESS_MIN_SIMILARITY = 0.85
# Below this share of definitions corroborated, the unreliable witness is the text LAYER, not
# the book, and a verdict about the book would be a verdict about our extraction.
_DEF_WITNESS_MIN_COVERAGE = 0.5
# A definition this short carries no discriminating content either way ("Ibid.", "See ED75.").
_DEF_WITNESS_MIN_CHARS = 12


def assess_def_content_fidelity(markdown, pypdf_defs_by_page):
    """Per-definition: does the PDF's own text layer corroborate what we are about to ship?

    `assess_harvest_fidelity` counts — how many definitions for how many markers, are the
    numbers unique. Both questions were answered "clean" on a document that shipped a
    FABRICATED citation: deloitte's page-bottom notes are set in ~5pt part-italic type, the
    OCR could not read them, and what it produced instead ("EIER (2019) How to Make a World:
    A Guide to the TCF" where the page prints "Ibid.") is well-formed, plausible, and
    entirely invented. Counts cannot see that. Only reading the definitions can.

    So this is the CONTENT twin: every emitted definition is matched against the text layer's
    own definitions, document-wide and NUMBER-AGNOSTIC — the question is "does the PDF say
    this anywhere", so a numbering bug alone never produces an unwitnessed verdict. Only
    content the document does not carry falls out.

    Returns a fork-record, or None when there is nothing to witness with (the cached-OCR
    replay runs without a PDF, and a verdict there would be unsupported).
    """
    if not pypdf_defs_by_page:
        return None
    pool = []
    for page_defs in pypdf_defs_by_page.values():
        for _num, text in page_defs:
            folded = _comparable(text)
            if folded:
                pool.append(folded)
    if not pool:
        return None

    import difflib
    judged = 0
    witnessed = 0
    too_short = 0
    unwitnessed = []
    for match in re.finditer(r'^\[\^(\d+)\]:[ \t]*(.+)$', markdown or '', re.MULTILINE):
        number = int(match.group(1))
        body = match.group(2).strip()
        probe = _comparable(body)
        if len(probe) < _DEF_WITNESS_MIN_CHARS:
            too_short += 1
            continue
        judged += 1
        # Compare against the candidate's OPENING of comparable length, never its whole
        # text. The extractor glues up to 700 characters of following page onto a page's
        # last note, so the layer's copy of a 180-character note can be 700 characters long
        # and the symmetric ratio reads 0.44 for a definition that matches it word for word.
        # Capping the candidate is also what keeps this honest in the other direction: a
        # fabricated definition assembled out of a real note's URL PATH stays low, because
        # the fragments it was built from sit past the cap.
        window = int(len(probe) * 1.1) + 10
        # Every definition against every layer definition is O(defs x pool) over long strings —
        # 9.3s on this 234-page book, and it scales with the square of the apparatus. difflib's
        # own upper bounds (lengths, then the character multiset) are O(n) and let most
        # candidates be discarded without ever running the real comparison. The result is
        # EXACT: a candidate is only skipped when its ceiling is already at or below the best
        # score so far. The probe stays seq1 and the candidate is seq2, even though seq2 is the
        # cached side: SequenceMatcher.ratio() is NOT symmetric (find_longest_match breaks ties
        # by position in seq1), so swapping them to save the cache silently changes the number
        # — measured, it moved two of this book's 128 scores. Re-deriving seq2 per candidate is
        # cheap because the candidate is windowed; the ratio() calls are what cost.
        matcher = difflib.SequenceMatcher(None, autojunk=False)
        matcher.set_seq1(probe)
        best = 0.0
        for candidate in pool:
            matcher.set_seq2(candidate[:window])
            if matcher.real_quick_ratio() <= best or matcher.quick_ratio() <= best:
                continue
            best = max(best, matcher.ratio())
        if best >= _DEF_WITNESS_MIN_SIMILARITY:
            witnessed += 1
        else:
            unwitnessed.append({'number': number, 'ratio': round(best, 3), 'text': body[:120]})

    if not judged:
        return None
    fraction = round(witnessed / judged, 3)

    if fraction < _DEF_WITNESS_MIN_COVERAGE:
        # The layer corroborates almost nothing, which is a statement about the LAYER — a
        # scanned PDF, a subset font, an excerpt whose pages we never had. Saying the book's
        # citations are fabricated on this evidence would be the very error this exists to
        # prevent.
        verdict, confidence, why = ('not_witnessable', 0.9,
            f'Only {witnessed} of {judged} definitions ({int(fraction * 100)}%) have any '
            f'counterpart in the PDF text layer — the layer is not a usable witness for this '
            f'document, so no definition here is being called unwitnessed.')
    elif unwitnessed:
        verdict, confidence, why = ('content_unwitnessed', 0.4,
            f'{len(unwitnessed)} of {judged} definitions are NOT corroborated by the PDF\'s own '
            f'text layer (the other {witnessed} are): '
            + '; '.join('[^{0}] ({1}) {2}'.format(u['number'], u['ratio'], u['text'][:60])
                        for u in unwitnessed[:4])
            + '. Whatever the layer does not carry is our conversion\'s, not the author\'s. A '
              'low agreement means the words were invented where OCR could not read the print; '
              'one just under the bar means the note is recognisable but still says something '
              'the document does not.')
    else:
        verdict, confidence, why = ('content_witnessed', 0.9,
            f'All {judged} definitions are corroborated by the PDF\'s own text layer.')

    return {
        'seq': 1,
        'module': 'pdf_footnote_content_fidelity',
        'code_ref': 'recovery.py:assess_def_content_fidelity',
        'node_help': assess_def_content_fidelity.plain,
        'decision': 'def_content=' + verdict,
        'question': ('Does the PDF\'s own text layer corroborate the TEXT of each footnote '
                     'definition we are shipping? (counts cannot see a fabricated citation)'),
        'rationale': why,
        'evidence': {
            'defs_judged': judged,
            'witnessed': witnessed,
            'witnessed_fraction': fraction,
            'too_short_to_judge': too_short,
            'layer_defs_in_pool': len(pool),
            'unwitnessed_defs': unwitnessed[:20],
        },
        'considered': ['content_witnessed', 'content_unwitnessed', 'not_witnessable'],
        'confidence': confidence,
        'margin': None,
    }


assess_def_content_fidelity.plain = (
    'AFTER assembly, the CONTENT self-check: is each footnote definition we are shipping something the '
    'PDF actually says? Where OCR cannot read the print it does not leave a hole — it produces a '
    'plausible, well-formed citation that is not in the document, and every count-based check calls '
    'that clean. Each definition is matched against the PDF\'s own text layer, document-wide. A layer '
    'that corroborates almost nothing is reported as an unusable WITNESS, never as a damaged book.')


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

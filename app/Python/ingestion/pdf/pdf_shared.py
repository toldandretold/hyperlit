"""Zero-import leaf — shared PDF substrate: superscript map, the OCR/text-normalisation helpers, and the PdfClassifier / FootnoteAssembler base classes (+ AssemblyContext). Lives apart so the runpy-as-__main__ backend path cannot deadlock and every phase module can import the bases + helpers without a cycle."""
import sys
import os
import json
import re
import math
import time
import argparse
import base64
import threading
from contextlib import contextmanager
from pathlib import Path
from statistics import median
from mistralai.client import Mistral
from pypdf import PdfReader, PdfWriter


SUPERSCRIPT_MAP = str.maketrans("\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079", "0123456789")


def emit_progress(percent, stage, detail):
    """Emit a progress event consumed by StreamsProgress (PHP side) and written to progress.json."""
    print("PROGRESS:" + json.dumps({"percent": percent, "stage": stage, "detail": detail}), flush=True)


@contextmanager
def progress_heartbeat(start_pct, cap_pct, stage, detail, expected_seconds, interval=5.0):
    """Keep PROGRESS lines flowing while a long opaque call (the Mistral OCR request)
    blocks. The percent creeps asymptotically from start_pct toward cap_pct on the
    expected-duration curve \u2014 the bar keeps moving without ever overtaking the next
    real stage. The steady writes also keep progress.json's updated_at fresh: the
    frontend poller declares the import stalled after 5 silent minutes, so a long
    book's OCR with no heartbeat flashes a false failure while the job is fine."""
    stop = threading.Event()
    t0 = time.monotonic()

    def _beat():
        while not stop.wait(interval):
            elapsed = time.monotonic() - t0
            frac = 1.0 - math.exp(-elapsed / max(float(expected_seconds), 1.0))
            pct = int(round(start_pct + (cap_pct - start_pct) * frac))
            mins, secs = divmod(int(elapsed), 60)
            emit_progress(pct, stage, f"{detail} ({mins}m {secs:02d}s elapsed)")

    thread = threading.Thread(target=_beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=interval + 1)


# A UNIT token directly before a superscript 2/3 marks an EXPONENT, not a footnote marker \u2014
# "2 million km\u00b2" / "km^{2}" / "m\u00b3 of water" (80bb62b6: km\u00b2 linked to endnote 2). The unit must
# be its own token (preceded by space/digit/start), so "them\u00b2" or "Vietnam\u00b2" never match.
_UNIT_BEFORE_EXPONENT_RE = re.compile(r'(?:^|[\s\d(/\[])(?:km|cm|mm|nm|\u00b5m|\u03bcm|um|dm|hm|m|ha|s)$')


def is_unit_exponent(text, pos, digits):
    """True when the digits at `pos` are a unit exponent (\u00b2, \u00b3 after km/m/cm/\u2026)."""
    return digits in ('2', '3') and bool(_UNIT_BEFORE_EXPONENT_RE.search(text[max(0, pos - 8):pos]))


def convert_footnotes(text):
    """Convert Unicode superscript numbers to [^N] markdown footnotes."""
    def replace_fn(m):
        num = m.group(0).translate(SUPERSCRIPT_MAP)
        if is_unit_exponent(text, m.start(), num):
            return m.group(0)            # km\u00b2 \u2014 keep the literal superscript glyph
        return f"[^{num}]"
    return re.sub(r'[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+', replace_fn, text)


# A superscript CITATION run \u2014 one or more superscript numbers, optionally comma-separated
# ("piracy\u2077", "Elbakyan in 2011.\u00b9\u00b9,\u00b9\u00b2", "nations,\u00b9\u2074,\u00b9\u2075,\u00b9\u2076"). Only meaningful on the wackSTEM
# path, where the numbers point at a numbered bibliography, not footnote definitions.
_SUP_CITE_RUN_RE = re.compile(
    r'[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]{1,3}'
    r'(?:\s*,\s*[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]{1,3})*'
)


def convert_superscript_citations_to_brackets(text):
    """wackSTEM path ONLY: superscript citation markers \u2192 bracket citations ("piracy\u2077" \u2192 "piracy[7]",
    "2011.\u00b9\u00b9,\u00b9\u00b2" \u2192 "2011.[11,12]") so wrap_stem_citations links them exactly like the [N] forms a
    mixed-style paper also carries (42be715c cited BOTH ways; only the brackets linked). Math inside
    $\u2026$ is masked first so genuine exponents survive untouched."""
    spans = []

    def _mask(m):
        spans.append(m.group(0))
        return f'\x00SUPCITE{len(spans) - 1}\x00'

    masked = _MATH_SPAN_RE.sub(_mask, text)

    def repl(m):
        nums = [p.strip().translate(SUPERSCRIPT_MAP)
                for p in m.group(0).split(',')]
        return '[' + ','.join(nums) + ']'

    masked = _SUP_CITE_RUN_RE.sub(repl, masked)
    for i, s in enumerate(spans):
        masked = masked.replace(f'\x00SUPCITE{i}\x00', s)
    return masked


# A LaTeX superscript group of footnote numbers \u2014 the OCR's rendering of a superscript marker.
# Handles a COMMA-SEPARATED list ($^{1,2}$, common on author-affiliation markers like "Wan Wang^{1,2}")
# as well as the single-number case ($^{5}$ / $^5$). A single-number regex left $^{1,2}$ untouched, so
# the marker rendered as literal "1,2" and never linked to its [^1]:/[^2]: definitions.
_LATEX_SUP_RE = re.compile(r'\$\^\{?(\d+(?:\s*,\s*\d+)*)\}?\$')
# ORCID-glyph junk INSIDE a latex superscript \u2014 Mistral renders the ORCID logo after an author's
# affiliation number as \text{\u2030} (2c0544c4: "Frank Biermann $^{1\text{\u2030}}$"), which defeats
# _LATEX_SUP_RE and leaves the marker as literal math junk. Strip any digit-free \text{\u2026} payload
# from inside a numeric superscript group before conversion.
_LATEX_SUP_TEXT_JUNK_RE = re.compile(r'(\$\^\{\d+(?:\s*,\s*\d+)*)\s*\\text\{[^{}\d]*\}(\}\$)')
# Nature-style prose citation prefix: "\u2026criticized earlier on, for example, refs. $^{5,6}$" cites
# the numbered BIBLIOGRAPHY, never a footnote \u2014 expanding it to [^5][^6] wrong-links it to
# same-numbered author-affiliation defs when both number spaces coexist (2c0544c4).
_NATURE_REFS_PREFIX_RE = re.compile(r'(?i)\brefs?\.?\s*$')
# ROMAN-numeral superscript footnote marker \u2014 some journals number footnotes i, ii, \u2026 viii and
# Mistral renders the markers as $^{vii}$ while the DEF list arrives as arabic superscripts
# (3fbb92da: refs $^{iii}$/$^{iv}$/$^{vii}$ against defs \u00b9\u2026\u2077). Lowercase roman only, def-gated.
_LATEX_ROMAN_SUP_RE = re.compile(r'\$\^\{([ivxl]{1,7})\}\$')
_ROMAN_VALUES = {'i': 1, 'v': 5, 'x': 10, 'l': 50}


def _roman_to_int(s):
    total, prev = 0, 0
    for ch in reversed(s):
        v = _ROMAN_VALUES.get(ch, 0)
        if not v:
            return None
        total = total - v if v < prev else total + v
        prev = max(prev, v)
    return total if 0 < total <= 30 else None


def expand_latex_superscripts(text):
    """$^{5}$ -> [^5] (always). $^{1,2}$ -> [^1][^2] ONLY when the text carries a footnote DEFINITION
    for one of those numbers.

    A single superscript was already converted historically. A COMMA group is ambiguous: on an
    author line it's an affiliation-footnote marker ("Wan Wang$^{1,2}$" with "$^{1}$ School of…"
    defs → expand + link, book d4c0b31e), but in a science paper it's a Vancouver citation
    ("built environments$^{1,2,4}$" with NO footnote defs) that must stay a rendered math
    superscript, not become literal "[^1][^2][^4]" text. So we only split a comma group when a
    matching definition is present in the same text."""
    text = _LATEX_SUP_TEXT_JUNK_RE.sub(r'\1\2', text)

    # Definition forms: an already-[^N]: def, or a line-start single superscript "$^{1}$ School…".
    def_nums = set(re.findall(r'(?m)^\s*\[\^(\d+)\]:', text))
    def_nums |= set(re.findall(r'(?m)^\s*\$\^\{?(\d+)\}?\$\s', text))

    def repl(m):
        nums = re.findall(r'\d+', m.group(1))
        # "refs. $^{5,6}$" is a Nature-style bibliography citation, not a footnote marker —
        # demote to plain citation text ("refs. 5,6") instead of wrong-linking to
        # same-numbered affiliation defs.
        if _NATURE_REFS_PREFIX_RE.search(text[max(0, m.start() - 8):m.start()]):
            return ','.join(nums)
        if len(nums) == 1 and is_unit_exponent(text, m.start(), nums[0]):
            return {'2': '²', '3': '³'}[nums[0]]              # km$^{2}$ — a unit exponent
        if len(nums) == 1:
            return f'[^{nums[0]}]'
        if any(n in def_nums for n in nums):
            return ''.join(f'[^{n}]' for n in nums)
        return m.group(0)   # comma group with no matching def → leave as a math superscript

    def roman_repl(m):
        n = _roman_to_int(m.group(1))
        if n is not None and str(n) in def_nums:
            return f'[^{n}]'
        return m.group(0)   # not a plausible roman marker / no matching def → leave as math
    text = _LATEX_ROMAN_SUP_RE.sub(roman_repl, text)
    return _LATEX_SUP_RE.sub(repl, text)


# A bare-caret footnote marker/def — Mistral sometimes OCRs a superscript as a literal "^24" instead
# of ²⁴ / $^{24}$ (Barro 1974 fn 23/24: "proceeds^24—", "^23 This analysis…"). It is AMBIGUOUS with a
# math exponent ("(1-r)^2", "A^o"), so we convert ONLY when the digits are followed by a NON-alphanumeric
# boundary (space / dash / punctuation / EOL) — an exponent is followed by a letter/variable or the
# expression continues — and the caret is preceded by a word char or sentence punctuation (not "{"/"_",
# which sit inside maths). Math inside $…$ / $$…$$ is masked out first so exponents there are untouched.
_MATH_SPAN_RE = re.compile(r'\$\$.+?\$\$|\$(?!\$).+?(?<!\$)\$', re.DOTALL)
_BARE_CARET_FN_RE = re.compile(r'(?<=[A-Za-z0-9.,;:!?)\'"’”])\^(\d{1,3})(?![A-Za-z0-9])')
# Module-level so the substitution below doesn't need a backslash INSIDE an f-string
# expression — legal from Python 3.12 (PEP 701), a SyntaxError on 3.11 (prod's python3).
_WS_RUN_RE = re.compile(r'\s+')


def convert_bare_caret_footnotes(text):
    """"word^24" / line-start "^24 Text" → "[^24]" — outside maths only."""
    spans = []

    def _mask(m):
        spans.append(m.group(0))
        return f'\x00CARETMATH{len(spans) - 1}\x00'

    masked = _MATH_SPAN_RE.sub(_mask, text)
    # caret-PREFIXED bracket superscript — two more Mistral superscript renderings (3f202e8f):
    # wrapped "^[64]^" (refs "Kircz^[64]^", defs "^[60]^ Electronic Privacy…", pp≈170-180) and
    # open "^[87]" with no closing caret (defs "^[87] Sullivan 2000.", p130). Without this the
    # inner [N] still converts+renumbers but the caret survives, leaving literal "^[^295]^"
    # text: the def line starts with '^' so it is never collected as a definition, and the ref
    # never links. Unwrap to [N] and let the bracket rules downstream decide inline-ref vs
    # line-start definition. Digits-only inside the brackets — pandoc's textual "^[a note]"
    # inline-footnote form can never match. The \[\^? also unwraps a half-converted "^[^64]^".
    masked = re.sub(r'\^(\[\^?\d{1,3}\])\^?', r'\1', masked)
    # Nature-style prose citation: "refs.^{19--21}" / "refs.^{5,6}" cites the numbered
    # BIBLIOGRAPHY, not footnotes (2c0544c4) — demote to plain citation text ("refs. 19–21")
    # BEFORE the footnote conversions below can wrong-link the numbers to same-numbered
    # affiliation defs. Handles double-hyphen/en-dash/minus ranges and comma groups.
    masked = re.sub(
        r'(?i)\b(refs?\.?)\s*\^\{(\d{1,3})\s*(?:--|-|–|−)\s*(\d{1,3})\s*\}',
        r'\1 \2–\3', masked)
    masked = re.sub(
        r'(?i)\b(refs?\.?)\s*\^\{(\d{1,3}(?:\s*,\s*\d{1,3})*)\s*,?\}',
        lambda m: f"{m.group(1)} {_WS_RUN_RE.sub('', m.group(2))}", masked)
    # brace form "^{2}" without $-delimiters (79c3d8e4: "en masse^{2}.") — a naked LaTeX-style
    # superscript Mistral emits outside math mode. Genuine exponents live inside $…$ and are
    # masked above, so a surviving ^{N} is a footnote marker. Comma GROUPS expand to one marker
    # per number ("^{6,7,8,9,10}" — 0fb751c1 stacks five citations on one superscript).
    def _brace_sup(m):
        if is_unit_exponent(masked, m.start(), m.group(1).strip()):
            return {'2': '²', '3': '³'}[m.group(1).strip()]   # km^{2} — a unit exponent
        return ''.join(f'[^{n}]' for n in re.findall(r'\d{1,3}', m.group(1)))
    masked = re.sub(r'\^\{(\d{1,3}(?:\s*,\s*\d{1,3})*)\s*,?\}', _brace_sup, masked)
    # inline markers (preceded by a word/punct)
    masked = _BARE_CARET_FN_RE.sub(
        lambda m: ({'2': '²', '3': '³'}[m.group(1)]
                   if is_unit_exponent(masked, m.start(), m.group(1))
                   else f'[^{m.group(1)}]'),
        masked)
    # line-start definition form "^24 Text"
    masked = re.sub(r'(?m)^(\s*)\^(\d{1,3})(?=\s)', r'\1[^\2]', masked)
    for i, s in enumerate(spans):
        masked = masked.replace(f'\x00CARETMATH{i}\x00', s)
    return masked


# A TOC entry masquerading as a bare-number footnote def: "01 Executive Summary 05" /
# "06 Background & Methodology 44 Analysis 50" — leading number, no terminal punctuation,
# ENDING in a standalone 1-3-digit page number (deloitte2025independent's dotless Contents
# page became defs 1-13, priming a false anthology reset AND poisoning classification).
# Real "N Text" endnotes end in punctuation or a 4-digit year, so they never match.
_TOC_ENTRY_TAIL_RE = re.compile(r'\s\d{1,3}$')
# A standalone date line ("4 July 2025" on a report cover) — leading day-number read as def 4.
_DATE_LINE_RE = re.compile(
    r'^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|'
    r'November|December)\s+\d{4}$', re.IGNORECASE)


def collect_page_refs_and_defs(md_raw):
    """The ONE per-page footnote ref/def detector — shared by classify_footnotes (signal
    collection) and renumber_chunk_footnotes (anthology-reset detection). These two carried
    drifting copies of this scan; a doc that fooled one fooled the other differently, which is
    exactly how deloitte2025independent got a false +13 renumber AND an unknown classification.

    Returns (refs, defs) as sets of ints, computed on the SAME normalization conversion applies
    (unicode superscripts + Mistral's caret renderings), with the junk guards: legal pinpoints
    are not refs; TOC entries, date lines and caret-stripped evidence are handled for defs.
    """
    md = convert_footnotes(md_raw)
    # Unwrap Mistral's caret-BRACKET superscript rendering ("^[48]^" refs → "[48]", line-start
    # "^[48]" defs → "[48]") — without this, every def line "^[48] Text" is invisible to the
    # def scan while its inner [48] counts as an inline REF, so a page-bottom doc in this
    # rendering reads as refs-without-defs and falls through to unknown. Deliberately NOT the
    # full convert_bare_caret_footnotes: its naked-brace rule ("^{33}" → [^33]) would count a
    # STEM paper's citation superscripts as footnote refs and flip its classification (fixture
    # 37344d6e: a no-footnotes doc whose "described previously^{34}" cites reference 34).
    md = re.sub(r'\^(\[\^?\d{1,3}\])\^?', r'\1', md)

    # Inline refs: [^N] or [N] NOT at start of a line; numbers > 500 are years/junk.
    refs = set()
    for m in re.finditer(r'\[\^?(\d+)\]', md):
        num = int(m.group(1))
        if num > 500:
            continue
        pos = m.start()
        if pos == 0 or md[pos - 1] == '\n':
            continue                # line start — a definition, not an inline ref
        if is_pinpoint_bracket(md, pos):
            continue                # "626 [25]" / "at [25]-[26]" judgment pinpoints
        refs.add(num)

    # Definitions: [^N] at line start, numbered "N. Text", or bare "N Text" (document endnotes).
    defs = set(int(n) for n in re.findall(r'^\[\^(\d+)\]', md, re.MULTILINE))
    defs |= set(int(n) for n in re.findall(r'^(\d{1,3})\. \S', md, re.MULTILINE))
    for line in md.split('\n'):
        m = re.match(r'^(\d{1,3}) [A-Z‘“\'"]', line)
        if not m:
            continue
        stripped = line.rstrip()
        if _TOC_ENTRY_TAIL_RE.search(stripped) or _DATE_LINE_RE.match(stripped):
            continue                # TOC entry / cover date, not a footnote definition
        defs.add(int(m.group(1)))
    # Caret-prefixed line-start def ("^[48] Lisa…" / "^[48]^ …") — the caret is Mistral's
    # superscript rendering, so unlike a plain "[N] Text" line (just as often a bibliography
    # entry) this form is unambiguously a definition. Scan the RAW text: the normalization
    # above strips the caret evidence.
    defs |= set(int(n) for n in re.findall(r'^\^\[\^?(\d{1,3})\]\^?[.:]?\s', md_raw, re.MULTILINE))
    return refs, defs


def is_pinpoint_bracket(text, pos):
    """Is the "[N]" starting at `pos` a legal-citation PARAGRAPH PINPOINT, not a footnote marker?

    Law-report pinpoints cite judgment paragraphs in brackets, SPACE-separated from what precedes:
    "626 [25] (Gummow ACJ…)", "[2021] FCA 1019, [47] – [50]", "stated at [25]-[26]:" (deloitte2025).
    A real footnote marker is a rendered superscript, so OCR glues it to the preceding word or
    punctuation — but STEM prose legitimately cites space-separated too ("field, [1], in analogy",
    a "- [1] Author…" bulleted reference list), so each preceding-token rule is kept narrow:
    a digit ("626 [25]"), a digit-then-comma ("1019, [47]" — but NOT "field, [1]"), a closing
    bracket, a dash that itself follows "]" ("[47] – [50]" / "[25]-[26]" ranges — but NOT a
    line-start "- [1]" bullet), or the word "at". Linking a pinpoint to footnote N is the
    wrong-link failure class, so both the classifier's ref scan and the marker converters skip it.
    """
    j = pos - 1
    while j >= 0 and text[j] in ' \t':
        j -= 1
    if j == pos - 1 or j < 0:
        return False                    # glued (or line start) — not space-separated
    ch = text[j]
    if ch.isdigit() or ch == ']':
        return True
    if ch == ',':
        return j >= 1 and text[j - 1].isdigit()
    if ch in '–—-':
        k = j - 1
        while k >= 0 and text[k] in ' \t':
            k -= 1
        return k >= 0 and text[k] == ']'
    if ch in 'tT' and j >= 1 and text[j - 1] in 'aA' \
            and (j < 2 or not text[j - 2].isalnum()):
        return True                     # "… at [25]"
    return False


def convert_inline_footnote_markers(md, strip_italic_brackets=False):
    """The PER-PAGE inline footnote-MARKER converter, shared by the page_bottom / chapter_endnotes /
    document_endnotes assemblers (it was copy-pasted verbatim in all three). Turns OCR's varied marker
    renderings into [^N]: Unicode superscripts, LaTeX $^5$, inline [N] (skipping line-start definitions
    and markdown links/images), and bare numbers after sentence-ending punctuation when followed by a
    space + capital / opening quote. The (?<!\\d\\.) and (?<![A-Z]\\.) guards stop "4.0" / "V.2" being
    read as markers.

    This runs PER PAGE, so it cannot see the whole document's ref sequence \u2014 hence the "capital after"
    heuristic. The WHOLE-DOCUMENT path (DefaultAssembler) instead uses normalize_all_footnote_refs,
    which sequence-validates each candidate against every known [^N]. `strip_italic_brackets` unwraps
    *[2]* \u2192 [2] first (the document_endnotes variant)."""
    md = convert_footnotes(md)
    md = expand_latex_superscripts(md)
    md = convert_bare_caret_footnotes(md)
    if strip_italic_brackets:
        md = re.sub(r'\*\[(\d{1,3})\]\*', r'[\1]', md)

    def _convert_bracket(m, _md=md):
        num = int(m.group(1))
        if num > 500 or num < 1:
            return m.group(0)
        pos = m.start()
        if pos == 0 or _md[pos - 1] == '\n':
            return m.group(0)            # line-start = definition, not a ref
        if pos > 0 and _md[pos - 1] in (']', '!'):
            return m.group(0)            # part of a markdown link / image
        if m.end() < len(_md) and _md[m.end()] == '(':
            return m.group(0)
        if is_pinpoint_bracket(_md, pos):
            return m.group(0)            # judgment-paragraph pinpoint "at [25]" — not a marker
        return f'[^{m.group(1)}]'
    md = re.sub(r'\[(\d+)\]', _convert_bracket, md)

    # (?<!\.\.) / (?<!\u2026): a digit riding a dotted leader ("Introduction and Scope...3" /
    # "Chapter One\u202612") is a TOC PAGE NUMBER, not a footnote marker \u2014 per-page we can't
    # sequence-validate, and wrapping these poisoned the global renumber (whole TOCs became [^1..N]).
    # "#" in the follow class: a marker ending the last sentence BEFORE a heading ('\u2026occupation."75
    # \n\n## B. Survey Methods') is still a marker \u2014 the next block starting with # must not veto it.
    # A straight quote is the SAME glyph open or closed, so it counts as a closer ONLY in a
    # closing context: the char before it must be a letter or sentence punctuation. A space /
    # paren / digit before it marks an OPENING quote \u2014 'Peer. "10 Things for Curating\u2026' is a
    # TITLE number, not a marker (da18ab4f grew a footnote out of it). \u201c (an unambiguous
    # OPENING curly quote) is out of the closer class entirely for the same reason.
    # ',' and the single quotes join the closer class (85542c5e: "preferable,30" and "it.'29"
    # stayed literal text) \u2014 with guards: a digit before the comma is a thousands separator
    # ("3,141"); a straight quote needs the closing context above; and after a mid-sentence
    # comma the continuation is naturally LOWERCASE ("preferable,30 but"), so the comma closer
    # accepts a lowercase follow where the sentence-ending closers still demand a capital.
    def _bare_after_punct(m, _md=md):
        pos = m.start(1)
        closer = _md[pos - 1]
        before = _md[pos - 2] if pos >= 2 else ''
        if closer in ('"', "'"):
            if not (before.isalpha() or before in '.,;:!?'):
                return m.group(0)
        elif closer == ',' and before.isdigit():
            return m.group(0)
        fm = re.match(r'\s+(\S)', _md[m.end(1):])
        if not fm:
            return m.group(0)
        follow = fm.group(1)
        if closer == ',':
            ok = follow.isalpha() or follow in '\u201c\u201d"\u2018\'(#'
        else:
            ok = follow.isupper() or follow in '\u201c\u201d"\u2018\'(#'
        return f'[^{m.group(1)}]' if ok else m.group(0)
    md = re.sub(
        r"(?<!\d\.)(?<![A-Z]\.)(?<!\.\.)(?<!\u2026)(?<=[.,!?\"'\u201d\u2019)])(\d{1,3})(?=\s+\S)",
        _bare_after_punct,
        md,
        flags=re.DOTALL,
    )
    return md


def normalize_all_footnote_refs(text):
    """Convert [N], bare numbers after punctuation, and LaTeX superscripts to [^N].

    Uses sequential validation: candidates are only converted if their number
    fits within the sequence of already-known [^N] refs. This prevents false
    positives like [2015] or table numbers from being converted.
    """
    # Step 1: Convert Unicode superscripts (already reliable)
    text = convert_footnotes(text)

    # Step 2: Convert LaTeX superscripts: $^{5}$ or $^5$ → [^5]; $^{1,2}$ → [^1][^2]
    text = expand_latex_superscripts(text)

    # Step 2b: bare-caret superscripts Mistral left as "^24" (footnote refs/defs, not math exponents)
    text = convert_bare_caret_footnotes(text)

    # Step 3: Collect known [^N] positions — IN-TEXT REFS ONLY for the positional sequence.
    # A line-start [^N] is a DEFINITION line; definitions now live in one trailing block (the
    # assemblers defer them to the document end), so letting them anchor position-validation makes
    # every late-body candidate see next_known = 1 (the def block's first line) and get rejected —
    # Barro's final "…capital formation.29" stayed literal text. Defs still count toward max_known
    # (the plausible-number ceiling).
    all_marks = [(m.start(), int(m.group(1))) for m in re.finditer(r'\[\^(\d+)\]', text)]
    if not all_marks:
        return text
    known = [(pos, num) for pos, num in all_marks
             if not (pos == 0 or text[pos - 1] == '\n')]

    max_known = max(n for _, n in all_marks)

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
        if is_pinpoint_bracket(text, pos):
            continue
        bracket_candidates.append((pos, num, m.start(), m.end(), 'bracket'))

    # Bare numbers after punctuation: .46 , ,47 — punctuation/closing-quote followed by number+space, so
    # a marker right after a quotation/parenthetical is resurrected too (...the quote.”46 Next / (aside)46).
    # Curly closers (” ’) are directional → always OK. Straight quotes (" ') are the SAME glyph open or
    # closed, so they're accepted ONLY as a CLOSING quote: the char before the quote must be a letter or
    # sentence punctuation (a closing context) — never a space/paren/digit, which mark an OPENING quote
    # ("5 Questions with...) or an inch-mark (6"4). Sequential validation below still gates every hit.
    _closers = ".,;:!?”’)" + '"' + "'"
    bare_candidates = []
    # (?<!\.\.) / (?<!…): dotted-leader TOC page numbers ("Scope...3") are never markers.
    for m in re.finditer("(?<!\\.\\.)(?<!…)(?<=[" + re.escape(_closers) + "])(\\d{1,3})\\s", text):
        num = int(m.group(1))
        if num > 500 or num < 1:
            continue
        pos = m.start()
        # Skip if at line start
        if pos == 0 or text[pos - 1] == '\n':
            continue
        # Straight quote → require a closing context (letter / sentence punct before it).
        if text[pos - 1] in ('"', "'"):
            before = text[pos - 2] if pos >= 2 else ' '
            if not (before.isalpha() or before in '.!?,;:'):
                continue
        if text[pos - 1] == '.' and pos >= 2:
            prev = text[pos - 2]
            # "V.2" — digit after an initial is version/section punctuation, not a marker.
            if prev.isalpha() and prev.isupper():
                continue
            # Digits before the dot: "8.7" in a table cell is a DECIMAL (1–3 digit integer part),
            # but "…status quo in 2007.26" is a marker after a YEAR — a 4+ digit run stays eligible.
            if prev.isdigit():
                j = pos - 2
                while j >= 0 and text[j].isdigit():
                    j -= 1
                if pos - 2 - j <= 3:
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


def renumber_page_footnotes(page_md, global_counter, mapping_out=None, pypdf_licensed=None):
    """Renumber footnotes on a single page from local numbering to global sequential.

    For "page_bottom" documents where each page restarts at [^1].
    Converts superscripts first, then maps local numbers to global ones.

    `mapping_out` (optional dict): filled with {local_number: global_number} for this page —
    the ONLY record of the print→assembled numbering, which the pypdf missing-def recovery
    needs to pair a pypdf-extracted def (print-local number) with its renumbered marker.

    `pypdf_licensed` (optional set of ints): def numbers the PDF's own text layer carries on
    THIS page (pypdf extraction). They license line-end bare-marker conversion exactly like the
    OCR def block does — for the page whose defs Mistral dropped or mis-numbered but whose
    marker survived as a bare digit ("…three lines of defence. 10", deloitte p9: footer def
    misread 9→10 and "10 Ibid." dropped, so the OCR side had nothing to license the marker;
    once converted, the marker enters the page map and pypdf recovery injects the RIGHT text).

    Returns (processed_md, new_global_counter).
    """
    # Convert OCR's varied footnote-marker renderings to [^N] — shared per-page converter
    page_md = convert_inline_footnote_markers(page_md)

    # Convert "N. text" / "N Text" definitions at the page bottom into "[^N]: text".
    ref_nums = set(int(m.group(1)) for m in re.finditer(r'\[\^(\d+)\]', page_md))
    lines = page_md.split('\n')

    def _def_candidate(stripped):
        """(int_num, num_str, rest) if the line opens a footnote definition, else None."""
        # Converted-superscript def: Mistral rendered the page-bottom note NUMBER as a superscript
        # ("¹². For a more…"), which convert_inline_footnote_markers above already turned into a
        # leading "[^12]." / "[^12] ". Recognise that so those defs aren't stranded in the body as
        # inline-ref-looking text (ad752a46: notes 10-13 on the superscript-numbered pages).
        m = re.match(r'^\[\^(\d{1,3})\]\.?\s+(\S.+)', stripped)
        if m:
            return int(m.group(1)), m.group(1), m.group(2)
        # GLUED converted-superscript def: "¹Senate Education…" (no space after the superscript)
        # converts to "[^1]Senate…" — without this the def fails every candidate shape, strands
        # in the BODY as a paragraph whose leading [^1] renders as an in-text ref, and the pypdf
        # recovery then appends a colon-form DUPLICATE at the doc end (deloitte p5, defs 1-4).
        # Line-start [^N] glued to text is def-shaped everywhere in this pipeline (an inline ref
        # glues to the PRECEDING word); the ascending-run + ref-overlap licensing still gates it.
        m = re.match(r'^\[\^(\d{1,3})\]([A-Za-z\d"\'(*“‘].+)', stripped)
        if m:
            return int(m.group(1)), m.group(1), m.group(2)
        # Bracket-form def: "[17] Mackenzie Owen 2002." — Mistral renders some page-bottom notes
        # with the number in square brackets. convert_inline_footnote_markers converts the INLINE
        # [17] refs but leaves line-start brackets, so without this the body refs get renumbered
        # while their defs stay literal "[17] …" paragraphs stranded in the body (3f202e8f p20:
        # the [^N] markers linked to nothing and the defs rendered as in-text <p> nodes). The
        # ascending-run + ref-overlap gate below still protects a numbered [N] bibliography list.
        m = re.match(r'^\[(\d{1,3})\]\.?\s+(\S.+)', stripped)
        if m:
            return int(m.group(1)), m.group(1), m.group(2)
        m = re.match(r'^(\d{1,3})\.?\s+(\S.+)', stripped)
        if not m:
            return None
        num, rest = m.group(1), m.group(2)
        has_period = stripped[len(num)] == '.'
        if has_period or re.match(r'[A-Z‘“\'"]', rest):
            return int(num), num, rest
        return None

    # Collect the trailing contiguous block of definition candidates (skip blank lines /
    # page-number anchors), bottom-up, then flip to page order.
    block = []
    i = len(lines) - 1
    while i >= 0:
        stripped = lines[i].strip()
        if not stripped or re.match(r'^<a class="pageNumber"', stripped):
            i -= 1
            continue
        cand = _def_candidate(stripped)
        if cand is None:
            break
        block.append((i, *cand))
        i -= 1
    block.reverse()

    # A trailing run of STRICTLY ASCENDING numbers that overlaps this page's in-text refs is
    # unambiguously a page-bottom footnote block -- convert the WHOLE run, even numbers whose own
    # ref sits on the previous/next page (the OCR routinely splits a ref from its def across the
    # page turn; the old "stop at the first number not referenced on THIS page" rule dropped every
    # def above that break -- a 78-87 block where only 79/81/83/84/86 were referenced here leaked
    # all ten as body paragraphs). The ascending run + a ref overlap keeps a stray numbered list
    # (no matching footnote refs) from being mistaken for definitions.
    nums = [b[1] for b in block]
    ascending = len(nums) >= 2 and all(nums[k] < nums[k + 1] for k in range(len(nums) - 1))

    # BARE-marker recovery: on a messy page the OCR drops the superscript STYLE entirely and the
    # marker survives as a plain trailing number — "…seventeenth century'. 11" (3f202e8f p17,
    # where the page had defs 9/10/11 but ZERO detectable refs, so the block failed the licensing
    # test below and every def rendered as an in-text paragraph). A bare number at a LINE END,
    # directly after sentence-closing punctuation, that equals one of the trailing block's numbers
    # is that note's marker: convert it to [^N]. Gated hard — the number must be in the ascending
    # def block AND not already a converted ref, so years/counts in running prose never convert.
    licensed_bare = set(nums) if ascending else set()
    licensed_bare |= set(pypdf_licensed or ())
    if licensed_bare:
        bound = block[0][0] if (block and ascending) else len(lines)
        for li in range(bound):
            if lines[li].lstrip().startswith('[^'):
                continue                            # a def line itself, not body carrying a marker
            m = re.search(r"[.!?]['’”\"]?\s+(\d{1,3})\s*$", lines[li])
            if m and int(m.group(1)) in licensed_bare and int(m.group(1)) not in ref_nums:
                lines[li] = lines[li][:m.start(1)] + f'[^{m.group(1)}]'
                ref_nums.add(int(m.group(1)))

    # CONSTANT-OFFSET rekey: the fetch-time chunk renumberer (renumber_chunk_footnotes) shifts
    # [^N] forms and LINE-START [N] defs by the segment offset but NOT inline [N] refs — so a
    # cached response can carry defs "[241] Thompson…/[242] Shapin…" whose in-text markers still
    # read [65]/[66] (3f202e8f p176; p92 and p246 same, offsets 176/309). The block then shares
    # no numbers with the page's refs and every def strands in the body. When the ascending
    # block aligns with the page's HIGHEST refs at one constant offset (>=10 — small diffs are
    # OCR misreads, not segment offsets), rekey the defs back to the ref numbers.
    if ascending and not any(n in ref_nums for n in nums) and len(ref_nums) >= len(nums):
        tail = sorted(ref_nums)[-len(nums):]
        diffs = {n - r for n, r in zip(nums, tail)}
        if len(diffs) == 1 and next(iter(diffs)) >= 10:
            block = [(idx, r, str(r), rest) for (idx, _n, _s, rest), r in zip(block, tail)]
            nums = tail

    convert_all = ascending and any(n in ref_nums for n in nums)

    if convert_all:
        for idx, _n, num_str, rest in block:
            leading = len(lines[idx]) - len(lines[idx].lstrip())
            lines[idx] = ' ' * leading + f'[^{num_str}]: {rest}'
    elif ref_nums:
        # Conservative fallback (original behaviour): bottom-up, convert only numbers referenced
        # on this page, stopping at the first that isn't.
        for idx, n, num_str, rest in reversed(block):
            if n not in ref_nums:
                break
            leading = len(lines[idx]) - len(lines[idx].lstrip())
            lines[idx] = ' ' * leading + f'[^{num_str}]: {rest}'
    page_md = '\n'.join(lines)

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
    if mapping_out is not None:
        mapping_out.update({int(k): int(v) for k, v in local_to_global.items()})

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

        # Skip empty lines, headings, HRs — and TABLE lines: a table row ends with '|' (no
        # sentence punctuation), so the continuation rule glued the table's LAST row onto a
        # lowercase-starting next paragraph, breaking the row out of the table entirely
        # (1313c1a2 Table 2: '| Sentiment | 64.4 … |' + 'taken from Christopher Potts…').
        if not stripped or stripped.startswith('#') or stripped == '---' or stripped.lstrip().startswith('|'):
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


def compute_printable_ratio(text):
    """Ratio of characters in `text` that are 'good' printable / common chars.

    Used to detect OCR mojibake from PDFs whose fonts lack a ToUnicode CMap.
    Returns 1.0 for empty strings (no signal).
    """
    if not text:
        return 1.0
    good = 0
    total = 0
    for ch in text:
        total += 1
        cp = ord(ch)
        # ASCII printable + tab/newline
        if 0x20 <= cp <= 0x7E or cp in (0x09, 0x0A, 0x0D):
            good += 1
            continue
        # Latin-1 supplement, Latin Extended A/B, IPA, common diacritics, Greek, Cyrillic
        if 0x00A0 <= cp <= 0x052F:
            good += 1
            continue
        # General punctuation (curly quotes, en/em dash, ellipsis, etc.)
        if 0x2000 <= cp <= 0x206F:
            good += 1
            continue
        # Currency, super/subscript digits, letterlike symbols, number forms
        if 0x2070 <= cp <= 0x218F:
            good += 1
            continue
        # Math operators (sometimes legitimately in academic text)
        if 0x2200 <= cp <= 0x22FF:
            good += 1
            continue
        # CJK (legitimate when present)
        if 0x3000 <= cp <= 0x9FFF:
            good += 1
            continue
    return good / total if total else 1.0


def wrap_stem_citations(text):
    """Wrap inline [N] citations with <a class="wackSTEMcite"> tags.

    Handles single citations like [36], comma-separated multi-cites like [36, 72],
    and range citations like [6-8] (meaning refs 6, 7, 8) — with either an ASCII
    hyphen or the typographic en-dash ([1–3]), which is what real typesetting
    (and Mistral OCR faithfully reading it) produces.
    Only matches mid-line occurrences (not at start of line) with N <= 500.
    """
    def replace_range_cite(m):
        start, end = int(m.group(1)), int(m.group(3))
        if start >= end or end > 500:
            return m.group(0)
        refs = ','.join(f'stemref_{i}' for i in range(start, end + 1))
        # Keep the document's own dash character in the visible text.
        return f'<a class="wackSTEMcite" data-refs="{refs}">[{start}{m.group(2)}{end}]</a>'

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

    # Range citations [N-M] / [N–M] first (before single/comma pattern consumes them)
    text = re.sub(r'(?<!^)(?<=.)\[(\d{1,3})([-–])(\d{1,3})\]', replace_range_cite, text, flags=re.MULTILINE)
    # Match [N] or [N, N, ...] NOT at start of line
    text = re.sub(r'(?<!^)(?<=.)\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]', replace_cite, text, flags=re.MULTILINE)
    return text


def stem_notes_block_lines(lines):
    """Line indexes of a NOTES block masquerading inside the numbered-entry stream: a SHORT
    (<= 3 entries) ascending run of line-start "N." / "[N]" entries immediately followed by a
    LONGER run that restarts at a lower number. MDPI papers put real footnotes under a "Notes"
    heading right before "References" and Mistral drops BOTH headings (79c3d8e4: "1. unsub.org /
    2. i.e.…" directly above refs "1. Eglen…34."), so without this the notes wrap as
    stemref_1/stemref_2 and steal the [1]/[2] citations from the bibliography's real entries."""
    entries = []                          # (line_idx, num)
    for i, ln in enumerate(lines):
        m = re.match(r'^(\d{1,3})\. .', ln) or re.match(r'^\[(\d{1,3})\] .', ln)
        if m and int(m.group(1)) <= 500:
            entries.append((i, int(m.group(1))))
    runs, cur = [], []
    for e in entries:
        if cur and e[1] <= cur[-1][1]:
            runs.append(cur)
            cur = []
        cur.append(e)
    if cur:
        runs.append(cur)
    skip = set()
    for k, run in enumerate(runs[:-1]):
        if len(run) <= 3 and len(runs[k + 1]) > len(run):
            skip.update(i for i, _n in run)
    return skip


def wrap_stem_definitions(text):
    """Wrap bibliography definitions at start of line with <a class="wackSTEMdef"> tags.

    Handles both formats:
      N. Author text...   → <a class="wackSTEMdef" id="stemref_N">N. Author text...</a>
      [N] Author text...  → <a class="wackSTEMdef" id="stemref_N">[N] Author text...</a>

    A short notes block hiding in the entry stream (see stem_notes_block_lines) is left
    unwrapped — wrapping it would mint duplicate stemref ids that steal the citations.

    Plus, WITHIN the references section only: heading-shaped entries. Mistral
    sometimes reads a reference's bold title line as a heading and emits
    `# 79. The Rise of Pirate Libraries` — the entry is captured perfectly,
    just marked up as a heading (Sci-Hub paper, refs 79–87). Those are
    converted to plain wrapped defs (heading marker dropped, so they render
    like their sibling entries and stop polluting the book's heading
    structure). Scoped to after the References/Bibliography heading so a
    genuinely numbered SECTION heading (`# 3. Methods`) is never touched.
    """
    lines = text.split('\n')
    notes_lines = stem_notes_block_lines(lines)
    for i, ln in enumerate(lines):
        if i in notes_lines:
            continue
        m = re.match(r'^(\d{1,3})\. (.+)', ln) or re.match(r'^\[(\d{1,3})\] (.+)', ln)
        if m and int(m.group(1)) <= 500:
            lines[i] = f'<a class="wackSTEMdef" id="stemref_{m.group(1)}">{ln}</a>'
    text = '\n'.join(lines)

    # Format 3: heading-shaped defs, references section only.
    refs_heading = None
    for m in re.finditer(r'^#{1,6}\s*(References|Bibliography|Works Cited|Literature Cited)\s*$',
                         text, flags=re.MULTILINE | re.IGNORECASE):
        refs_heading = m  # last occurrence wins (an earlier body mention can't scope the tail)
    if refs_heading is not None:
        def replace_heading_def(m):
            num = m.group(1)
            if int(num) > 500:
                return m.group(0)
            return f'<a class="wackSTEMdef" id="stemref_{num}">{num}. {m.group(2)}</a>'

        tail_start = refs_heading.end()
        tail = re.sub(r'^#{1,6}\s+(\d{1,3})\. (.+)', replace_heading_def,
                      text[tail_start:], flags=re.MULTILINE)
        text = text[:tail_start] + tail

    return text


class PdfClassifier:
    """One PDF footnote-layout class: its gate + confidence + fork-story. Mirrors the LinkRule /
    DocPass registry pattern. Subclasses set `name` + `would_need` and override the hooks."""

    name = ''
    would_need = ''

    def matches(self, sig):
        return False

    def confidence(self, sig):
        return 0.0

    def rejected_because(self, sig):
        return ''

    def margin(self, sig):
        return ''


class FootnoteAssembler:
    """Per-classification markdown assembly — the per-page footnote handling + post-combine fixup for
    ONE PDF class. Registered in PDF_ASSEMBLERS by classification. The base is the generic path: keep
    each page body as-is (per_page); subclasses override the hooks they need."""

    def setup(self, ctx):
        """One-time precompute before the page loop (e.g. chapter-offset tables). Default: nothing."""
        pass

    def per_page(self, ctx, i, page, md, md_stripped):
        """Handle one page's footnotes + append to ctx.md_parts. Default: keep the body as-is."""
        if md_stripped:
            ctx.md_parts.append(md)

    def post_combine(self, ctx, combined):
        """Fix up the combined markdown for this class. Default: unchanged."""
        return combined


class AssemblyContext:
    """Shared state threaded through the markdown-assembly passes — the locals the monolith carried.
    Defaulted so a non-chapter assembler never touches chapter-only state."""

    def __init__(self, response_dict, classification, footnote_meta):
        self.response_dict = response_dict
        self.pages = response_dict["pages"]
        self.classification = classification
        self.footnote_meta = footnote_meta
        self.page_number_offset = None
        self.md_parts = []
        self.seen_sections = set()
        self.recent_opening_headings = []   # last 2 content pages' opening headings (leak dedupe)
        self.promoted_toc_titles = set()    # TOC-guided heading promotions already made
        self.toc_chapters_used = set()      # numbered TOC chapters already normalised in the body
        self.toc_structural_seen = {}       # structural TOC headings: casefold key -> first exact text
        self.global_fn_counter = 1          # for page_bottom renumbering
        self.fn_defs_parts = []             # collected footnote definitions for page_bottom
        self.deferred_defs_parts = []       # defs deferred to doc end: inline splits + footer recoveries (Default path)
        self.open_def_continuation = False  # a deferred def was cut mid-sentence at the page turn (Default path)
        self.footer_bare_candidates = {}     # {num: text} bare-number footer defs, injected only if [^N] is orphaned
        self.def_heavy_pages = set()
        self.page_local_to_global = {}       # page_idx → {local fn num: global fn num} (page_bottom renumber)
        self.pypdf_page_defs = None          # page_idx → [(num, text)] from the PDF text layer (page_bottom + real PDF)
        self.pypdf_page_texts = None         # page_idx → raw pypdf page text (marker resurrection)
        self.chapter_fn_offsets = None
        self.notes_transition_pages = {}    # page_idx → (threshold, old_offset, new_offset)
        self.in_notes_section = False
        self.last_ref_page_idx = 0


convert_inline_footnote_markers.plain = (
    'RECOVERY ① marker resurrection: OCR often renders a footnote marker as a superscript, a LaTeX '
    '$^5$, a bare [5], or a stray ".46" after punctuation — this restores them to [^N], gated by '
    'sequential validation so years / table numbers are never mis-converted. Needs no PDF, so it '
    'always runs (even in the cached-replay harness).')

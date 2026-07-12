"""Zero-import leaf — shared PDF substrate: superscript map, the OCR/text-normalisation helpers, and the PdfClassifier / FootnoteAssembler base classes (+ AssemblyContext). Lives apart so the runpy-as-__main__ backend path cannot deadlock and every phase module can import the bases + helpers without a cycle."""
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


SUPERSCRIPT_MAP = str.maketrans("\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079", "0123456789")


def emit_progress(percent, stage, detail):
    """Emit a progress event consumed by StreamsProgress (PHP side) and written to progress.json."""
    print("PROGRESS:" + json.dumps({"percent": percent, "stage": stage, "detail": detail}), flush=True)


def convert_footnotes(text):
    """Convert Unicode superscript numbers to [^N] markdown footnotes."""
    def replace_fn(m):
        num = m.group(0).translate(SUPERSCRIPT_MAP)
        return f"[^{num}]"
    return re.sub(r'[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+', replace_fn, text)


# A LaTeX superscript group of footnote numbers \u2014 the OCR's rendering of a superscript marker.
# Handles a COMMA-SEPARATED list ($^{1,2}$, common on author-affiliation markers like "Wan Wang^{1,2}")
# as well as the single-number case ($^{5}$ / $^5$). A single-number regex left $^{1,2}$ untouched, so
# the marker rendered as literal "1,2" and never linked to its [^1]:/[^2]: definitions.
_LATEX_SUP_RE = re.compile(r'\$\^\{?(\d+(?:\s*,\s*\d+)*)\}?\$')


def expand_latex_superscripts(text):
    """$^{5}$ -> [^5] (always). $^{1,2}$ -> [^1][^2] ONLY when the text carries a footnote DEFINITION
    for one of those numbers.

    A single superscript was already converted historically. A COMMA group is ambiguous: on an
    author line it's an affiliation-footnote marker ("Wan Wang$^{1,2}$" with "$^{1}$ School of…"
    defs → expand + link, book d4c0b31e), but in a science paper it's a Vancouver citation
    ("built environments$^{1,2,4}$" with NO footnote defs) that must stay a rendered math
    superscript, not become literal "[^1][^2][^4]" text. So we only split a comma group when a
    matching definition is present in the same text."""
    # Definition forms: an already-[^N]: def, or a line-start single superscript "$^{1}$ School…".
    def_nums = set(re.findall(r'(?m)^\s*\[\^(\d+)\]:', text))
    def_nums |= set(re.findall(r'(?m)^\s*\$\^\{?(\d+)\}?\$\s', text))

    def repl(m):
        nums = re.findall(r'\d+', m.group(1))
        if len(nums) == 1:
            return f'[^{nums[0]}]'
        if any(n in def_nums for n in nums):
            return ''.join(f'[^{n}]' for n in nums)
        return m.group(0)   # comma group with no matching def → leave as a math superscript
    return _LATEX_SUP_RE.sub(repl, text)


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
        return f'[^{m.group(1)}]'
    md = re.sub(r'\[(\d+)\]', _convert_bracket, md)

    md = re.sub(
        r'(?<!\d\.)(?<![A-Z]\.)(?<=[.!?"\u201d\u201c)])(\d{1,3})(?=\s+[A-Z\u201c\u201d"\u2018\'(])',
        r'[^\1]',
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

    # Bare numbers after punctuation: .46 , ,47 — punctuation/closing-quote followed by number+space, so
    # a marker right after a quotation/parenthetical is resurrected too (...the quote.”46 Next / (aside)46).
    # Curly closers (” ’) are directional → always OK. Straight quotes (" ') are the SAME glyph open or
    # closed, so they're accepted ONLY as a CLOSING quote: the char before the quote must be a letter or
    # sentence punctuation (a closing context) — never a space/paren/digit, which mark an OPENING quote
    # ("5 Questions with...) or an inch-mark (6"4). Sequential validation below still gates every hit.
    _closers = ".,;:!?”’)" + '"' + "'"
    bare_candidates = []
    for m in re.finditer("(?<=[" + re.escape(_closers) + "])(\\d{1,3})\\s", text):
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
    # Convert OCR's varied footnote-marker renderings to [^N] — shared per-page converter
    page_md = convert_inline_footnote_markers(page_md)

    # Convert "N. text" / "N Text" definitions at the page bottom into "[^N]: text".
    ref_nums = set(int(m.group(1)) for m in re.finditer(r'\[\^(\d+)\]', page_md))
    lines = page_md.split('\n')

    def _def_candidate(stripped):
        """(int_num, num_str, rest) if the line opens a footnote definition, else None."""
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
        self.global_fn_counter = 1          # for page_bottom renumbering
        self.fn_defs_parts = []             # collected footnote definitions for page_bottom
        self.def_heavy_pages = set()
        self.chapter_fn_offsets = None
        self.notes_transition_pages = {}    # page_idx → (threshold, old_offset, new_offset)
        self.in_notes_section = False
        self.last_ref_page_idx = 0


convert_inline_footnote_markers.plain = (
    'RECOVERY ① marker resurrection: OCR often renders a footnote marker as a superscript, a LaTeX '
    '$^5$, a bare [5], or a stray ".46" after punctuation — this restores them to [^N], gated by '
    'sequential validation so years / table numbers are never mis-converted. Needs no PDF, so it '
    'always runs (even in the cached-replay harness).')

"""GEOMETRIC blockquote detection from the source PDF — the layout truth Mistral throws away.

Mistral's markdown carries no indentation and no font info, so an indentation-only block quote
(no quote marks, no citation tail) is invisible to every typographic heuristic in assembly.py.
The print layout, however, states it plainly: quote blocks are set at a deeper left margin than
the body (244ae673: body x=72pt, quote lines uniformly x=106pt). This module reads per-line
x-positions from the PDF text layer (pypdf visitor — the same side-channel pypdf footnote
recovery uses), finds runs of consecutively-indented lines, and hands back their text split
into paragraphs so assembly can wrap the matching markdown paragraphs as blockquotes.

Traps this is built around (all measured on real books):
- Body FIRST-LINE indents sit within ~2pt of the quote indent (108 vs 106 in 244ae673). A
  first-line indent is a single line followed by body-margin continuations, so runs require
  >= MIN_LINES consecutive lines within a TIGHT x tolerance.
- Two-column layouts: the far column's lines read as a huge "indent"; the MAX_INDENT cap
  excludes them, so the worst case is a missed quote in the far column, never a false one.
- Page furniture: running headers / page numbers are single lines (min-lines gate); page-bottom
  footnote defs are excluded by the bottom-margin cut.

Alignment back to markdown is prefix-based on a normalised alphanumeric form, and requires the
match to be UNIQUE among paragraphs — an ambiguous prefix wraps nothing (a miss is cheap, a
false wrap rewrites body text).

Fixture replays carry no PDF, so this pass is inert there (same caveat as pypdf footnote
recovery) — its unit tests exercise the pure functions on synthetic line data, and real-book
validation happens at reconvert time.
"""

import re
import unicodedata
from collections import Counter

# An indented run must be at least this much deeper than the body margin (pt)…
MIN_INDENT = 12.0
# …and no deeper than this (beyond it: a second column / a table / marginalia).
MAX_INDENT = 150.0
# Lines within a run must agree on x this tightly (body first-line indents sit ~2pt off).
RUN_X_TOL = 1.5
# A run must span at least this many lines (kills first-line indents and page furniture).
MIN_LINES = 2
# Ignore the bottom strip of the page (page-bottom footnote defs, imprint lines).
BOTTOM_FRACTION = 0.12
# y-gap between consecutive lines that marks a paragraph break, as a multiple of the
# run's median line pitch.
PARA_GAP_FACTOR = 1.6
# Prefix length (normalised chars) used to align a block paragraph to a markdown paragraph.
MATCH_PREFIX = 40
# A block paragraph shorter than this (normalised) is too generic to match safely.
MIN_MATCH_CHARS = 20
# A figure/table CAPTION line — indented furniture that rides at the same x as body
# first-line indents (MDPI: caption + the next paragraph's first line form a false 2-line
# "run", and the first line then wraps its whole body paragraph). Breaks runs at detection
# time AND excludes caption paragraphs at wrap time.
CAPTION_LINE_RE = re.compile(r'(?i)^\s*(?:fig(?:ure)?|table|chart|box|scheme|plate)\b[\s.:0-9]')

# A margin x is a body-margin CANDIDATE only when it holds at least this share of the
# document's lines. A clean book has ONE dominant margin (measured: 73–96%); a recto/verso
# book has two (~27% + ~25%); a layout-chaotic report has none above ~8% (deloitte) — and
# with no candidate the margin model does not apply, so the whole document is skipped.
MARGIN_CANDIDATE_SHARE = 0.10
# Sanity cap on the WRAP share: quotes are sparse. If the alignment would wrap more than
# this fraction of the document's paragraphs, the margin model is mis-reading the layout —
# wrap nothing rather than blockquote the body.
MAX_WRAP_SHARE = 0.10


def _norm(text):
    """Normalisation used for PDF-text ↔ markdown alignment: NFKC (folds ligatures — a PDF
    text layer says 'Garﬁeld' where the OCR says 'Garfield'), then lowercase alphanumerics."""
    text = unicodedata.normalize('NFKC', text or '')
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def dedupe_text_layers(lines):
    """Some PDFs carry every line TWICE — an original text layer plus an OCR/revision overlay
    a few points apart (709c9348: 'Garfield'/'Garﬁeld' pairs ~4–11pt apart). Left alone, the
    duplication turns every SINGLE line into a '2-line run', defeating the MIN_LINES guard —
    a body paragraph's first-line indent then reads as an indented block. Collapse neighbours
    with the same x (±2.5pt), nearby y (±14pt) and the same normalised text head."""
    out = []
    for x, y, t in lines:
        head = _norm(t)[:40]
        dup = any(abs(px - x) <= 2.5 and abs(py - y) <= 14 and head == _norm(pt)[:40]
                  for px, py, pt in out[-3:])
        if not dup:
            out.append((x, y, t))
    return out


def lines_from_fragments(frags, y_tol=2.0):
    """Group visitor fragments (x, y, text) into lines: same-y fragments concatenated in x
    order. Returns [(x0, y, text)] sorted top-of-page first (descending y)."""
    buckets = {}
    for x, y, text in frags:
        if not (text or '').strip():
            continue
        key = None
        for ky in buckets:
            if abs(ky - y) <= y_tol:
                key = ky
                break
        if key is None:
            key = y
            buckets[key] = []
        buckets[key].append((x, text))
    lines = []
    for y, parts in buckets.items():
        parts.sort(key=lambda p: p[0])
        lines.append((parts[0][0], y, ''.join(t for _x, t in parts)))
    lines.sort(key=lambda l: -l[1])
    return lines


def body_margin(all_lines):
    """The document's dominant line-start x (mode over every page's lines), i.e. the body
    left margin. None when there is too little text to trust."""
    xs = Counter(round(x) for x, _y, _t in all_lines)
    if sum(xs.values()) < 20:
        return None
    return float(xs.most_common(1)[0][0])


def margin_candidates(all_lines):
    """Document-level body-margin CANDIDATES: x values holding >= MARGIN_CANDIDATE_SHARE of
    all lines. One for a clean book, two for a recto/verso (mirrored-margin) book, NONE for a
    layout-chaotic document — in which case the margin model does not apply and the caller
    must skip the document."""
    xs = Counter(round(x) for x, _y, _t in all_lines)
    total = sum(xs.values())
    if total < 20:
        return []
    return [float(x) for x, c in xs.most_common(4) if c / total >= MARGIN_CANDIDATE_SHARE]


def page_body_margin(lines, candidates, min_lines=3):
    """The candidate margin this PAGE actually uses: the one with the most line-starts on the
    page (ties -> leftmost). None when no candidate carries enough lines here (a plate page,
    a table page — skip it). Per-page resolution is what makes mirrored-margin books work,
    while quote-heavy pages still resolve correctly because the QUOTE indent is never a
    document-level candidate."""
    counts = Counter()
    for x, _y, _t in lines:
        for c in candidates:
            if abs(x - c) <= 1.0:
                counts[c] += 1
    if not counts:
        return None
    best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    return best[0] if best[1] >= min_lines else None


def indented_runs(lines, body_x, page_height=None):
    """Runs of >= MIN_LINES consecutive lines all indented MIN_INDENT..MAX_INDENT beyond the
    body margin and agreeing on x within RUN_X_TOL. Returns [[(x, y, text), …], …]."""
    floor = (page_height or 0) * BOTTOM_FRACTION
    runs, current = [], []
    for x, y, text in lines:
        if page_height and y < floor:
            continue
        indent = x - body_x
        fits = (MIN_INDENT <= indent <= MAX_INDENT
                and not CAPTION_LINE_RE.match(text))
        if fits and current and abs(x - current[0][0]) <= RUN_X_TOL:
            current.append((x, y, text))
        elif fits:
            if len(current) >= MIN_LINES:
                runs.append(current)
            current = [(x, y, text)]
        else:
            if len(current) >= MIN_LINES:
                runs.append(current)
            current = []
    if len(current) >= MIN_LINES:
        runs.append(current)
    return runs


def run_paragraphs(run):
    """Split a run's lines into paragraph texts using y-gap jumps (> PARA_GAP_FACTOR × the
    median line pitch)."""
    if not run:
        return []
    gaps = [run[i][1] - run[i + 1][1] for i in range(len(run) - 1)]
    positive = sorted(g for g in gaps if g > 0)
    pitch = positive[len(positive) // 2] if positive else 0
    paras, cur = [], [run[0][2]]
    for i in range(1, len(run)):
        gap = run[i - 1][1] - run[i][1]
        if pitch and gap > PARA_GAP_FACTOR * pitch:
            paras.append(' '.join(cur))
            cur = []
        cur.append(run[i][2])
    paras.append(' '.join(cur))
    return [re.sub(r'\s+', ' ', p).strip() for p in paras if p.strip()]


def filter_small_font_lines(lines, sizes, ratio=0.9):
    """Drop lines set clearly SMALLER than the page's dominant text size — page-bottom
    footnote blocks are both indented and small (3f202e8f: a footnote CONTINUATION rode
    above the bottom-strip cut and wrapped as a quote). `sizes` maps a line's (x, y) to its
    effective size; sizes are cm-scaled so only the RELATIVE comparison is meaningful."""
    counted = Counter(round(sizes.get((x, y), 0), 3) for x, y, _t in lines)
    counted.pop(0, None)
    if not counted:
        return lines
    dominant = counted.most_common(1)[0][0]
    return [(x, y, t) for x, y, t in lines
            if sizes.get((x, y), 0) == 0 or sizes.get((x, y), 0) >= dominant * ratio]


def detect_indented_quote_blocks(pdf_path):
    """Read the PDF and return indented blocks as lists of paragraph texts:
    [[para, para, …], …]. Empty list on any failure — this pass must never sink a convert."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        pages = []
        for page in reader.pages:
            frags = []
            frag_sizes = {}

            def visit(text, cm, tm, font_dict, font_size, frags=frags, frag_sizes=frag_sizes):
                if (text or '').strip():
                    x = cm[0] * tm[4] + cm[2] * tm[5] + cm[4]
                    y = cm[1] * tm[4] + cm[3] * tm[5] + cm[5]
                    frags.append((x, y, text))
                    frag_sizes[(x, y)] = (font_size or 0) * (abs(cm[0]) or 1.0)

            try:
                page.extract_text(visitor_text=visit)
                height = float(page.mediabox.height)
            except Exception:
                continue
            lines = lines_from_fragments(frags)
            # a line's size = its FIRST fragment's size (the line-start x,y key survives grouping)
            line_sizes = {(x, y): frag_sizes.get((x, y), 0) for x, y, _t in lines}
            lines = filter_small_font_lines(lines, line_sizes)
            pages.append((dedupe_text_layers(lines), height))
    except Exception:
        return []

    all_lines = [l for lines, _h in pages for l in lines]
    candidates = margin_candidates(all_lines)
    if not candidates:
        return []                         # no dominant margin — the model does not apply
    blocks = []
    for lines, height in pages:
        body_x = page_body_margin(lines, candidates)
        if body_x is None:
            continue                      # plate / table / chaotic page — skip
        for run in indented_runs(lines, body_x, page_height=height):
            paras = run_paragraphs(run)
            if paras:
                blocks.append(paras)
    return blocks


def wrap_geometry_blockquotes(md, blocks):
    """Wrap the markdown paragraphs matching each indented block as ONE '>' blockquote.
    A block paragraph matches a markdown paragraph iff the block's normalised prefix is the
    paragraph's normalised prefix and that prefix is UNIQUE among paragraphs. Only whole,
    consecutive matches merge into a single connected blockquote; partial matches wrap
    individually; ambiguity wraps nothing. Returns (md, wrapped_paragraph_count)."""
    paras = re.split(r'\n\s*\n', md)

    def unmark(p):
        """A paragraph's text with any existing '>' markers stripped (the typographic layer
        may already have wrapped part of a block — geometry absorbs it into one quote)."""
        return re.sub(r'(?m)^>\s?', '', p.strip()).strip()

    norm_paras = [_norm(unmark(p)) for p in paras]
    wrapped = 0

    _LIST_LINE_RE = re.compile(r'(?i)^\s*(?:[ivxl]{1,5}[.)]|\d{1,2}[.)]|[a-z][.)]|[-•*])\s')
    # Journal-article ABSTRACTS are indented front matter too (c2d6bdb1) — recognised by their
    # neighbourhood: a "Keywords:" / "Abstract" line beside them, or "(Received … 2011)"
    # publication-history chrome above.
    _ABSTRACT_NEIGHBOUR_RE = re.compile(r'(?i)^\s*#*\s*(?:abstract\b|key\s?words\b)')
    _PUB_HISTORY_RE = re.compile(r'(?i)\(?\s*(?:received|accepted|published)\b.{0,80}\d{4}')
    # Figure/table CAPTIONS are indented furniture, not quotes (824c39fd: "Fig 1. Citation
    # distributions…" / "Table 2: Percentage…").
    _CAPTION_RE = CAPTION_LINE_RE
    # A References/Bibliography heading — matches at or after it are hanging-indent
    # bibliography entries (their continuation lines ARE an indented run), never quotes
    # (304249a7 wrapped a split SSRN entry; 93d34a74 lost a reference to one).
    _REFS_HEADING_RE = re.compile(
        r'(?i)^\s*#{1,6}\s*(?:references|bibliography|works cited|literature cited)\b')
    # Front matter (title block, authors, AFFILIATIONS, abstract) is indented typography too
    # (82952c24 wrapped four affiliation lines). Epigraphs living up there are the typographic
    # layer's job (dash attributions / citation tails) — geometry stays out of the first
    # paragraphs entirely.
    FRONT_MATTER_PARAS = 10

    def is_listy(p):
        """An inset LIST is indented typography too — enumerated lines (i./ii., 1., -, •)
        must never wrap as a quotation."""
        lines = [l for l in unmark(p).split('\n') if l.strip()]
        return bool(lines) and (
            _LIST_LINE_RE.match(lines[0]) is not None
            or sum(1 for l in lines if _LIST_LINE_RE.match(l)) >= 2)

    def is_abstractish(i):
        def neighbour(step):
            j = i + step
            while 0 <= j < len(paras) and (paras[j] is None or not paras[j].strip()):
                j += step
            return unmark(paras[j]) if 0 <= j < len(paras) and paras[j] is not None else ''
        nxt, prev = neighbour(+1), neighbour(-1)
        return bool(_ABSTRACT_NEIGHBOUR_RE.match(nxt)
                    or _ABSTRACT_NEIGHBOUR_RE.match(prev)
                    or _PUB_HISTORY_RE.match(prev[:120]))

    # LAST refs heading: a mid-book '# References' SECTION heading is body (93d34a74) — the
    # hanging-indent entries live under the back-of-book one.
    refs_start = len(paras)
    for i, p in enumerate(paras):
        if p is not None and _REFS_HEADING_RE.match(p.strip()):
            refs_start = i

    # Author AFFILIATIONS ("School of Information, University of Texas at Austin") ride at a
    # quote-like indent below long author lists, beyond any fixed front-matter window
    # (82952c24: indices 12–21) — institution vocabulary + no sentence-terminal punctuation.
    _INSTITUTION_RE = re.compile(
        r'(?i)\b(?:universit|institut|department|school of|college|laborator|centre|'
        r'center for|library|libraries|academy|faculty of)\w*\b')

    def is_affiliationish(p):
        t = unmark(p)
        return (len(t) < 200 and '\n' not in t
                and not re.search(r'[.!?]\s*$', t)
                and _INSTITUTION_RE.search(t) is not None)

    # A DOI marks citation apparatus — a bibliography entry (or fragment of one), never a
    # quotation (93d34a74: "Annual Review of Information Science…, 43, 1–43. doi: 10.1002/…").
    # Ending on a bare URL is the same apparatus (da18ab4f: '…" https://mindthegap.pubpub.org/.').
    _DOI_RE = re.compile(r'(?i)\bdoi[.:]|\b10\.\d{4,9}/|https?://\S+\.?\s*$')

    def find_unique(prefix):
        hits = [i for i, np in enumerate(norm_paras)
                if np.startswith(prefix)
                and not paras[i].lstrip().startswith(('#', '[', '|', '!', '<'))
                # a quote opens with a letter/quote/bracket — a digit opener is a SPLIT
                # bibliography-entry fragment ("2016850). Rochester, NY: …", 304249a7)
                and (unmark(paras[i])[:1].isalpha()
                     or unmark(paras[i])[:1] in '"“‘\'…[')
                and not _CAPTION_RE.match(unmark(paras[i]))
                and not _DOI_RE.search(unmark(paras[i]))
                and not is_listy(paras[i])
                and not is_affiliationish(paras[i])
                and FRONT_MATTER_PARAS <= i < refs_start]
        if len(hits) != 1 or is_abstractish(hits[0]):
            return None
        return hits[0]

    def mark(text):
        """Prefix EVERY line — a lazy continuation line breaks the html collector."""
        return '> ' + text.strip().replace('\n', '\n> ')

    for block in blocks:
        idxs = []
        for btext in block:
            prefix = _norm(btext)[:MATCH_PREFIX]
            if len(prefix) < MIN_MATCH_CHARS:
                idxs.append(None)
                continue
            idxs.append(find_unique(prefix))
        found = [i for i in idxs if i is not None]
        if not found:
            continue
        consecutive = (idxs == list(range(found[0], found[0] + len(idxs)))
                       and None not in idxs)
        if consecutive and len(idxs) > 1:
            joined = '\n>\n'.join(mark(unmark(paras[i])) for i in idxs)
            paras[idxs[0]] = joined
            for i in idxs[1:]:
                paras[i] = None
            for i in idxs:
                norm_paras[i] = '\0'
            wrapped += len(idxs)
        else:
            for i in found:
                if paras[i].lstrip().startswith('>'):
                    continue                      # already wrapped typographically
                paras[i] = mark(paras[i])
                norm_paras[i] = '\0'
                wrapped += 1
    # Quotes are sparse: if the alignment would wrap a large share of the document, the
    # margin model mis-read the layout — wrap nothing rather than blockquote the body.
    if wrapped > max(3, int(len(paras) * MAX_WRAP_SHARE)):
        return md, 0
    return '\n\n'.join(p for p in paras if p is not None), wrapped

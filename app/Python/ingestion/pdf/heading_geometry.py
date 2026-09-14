"""Phase ② — HEADING GEOMETRY: the PDF's own type styles as the universal key for the section
structure Mistral's markdown lost.

Mistral decides "this is a heading" from appearance and gets it wrong in two recurring ways, both
INVISIBLE to any text-only rule:

  • a heading emitted as an ordinary paragraph — "The Social Distancing of Old, Weak and Ill
    Individuals" (5fc4aad4) is set in Arial-BoldMT exactly like the nine headings Mistral DID
    mark, and body text is ArialMT. Nothing in the markdown distinguishes it from a short
    paragraph, so the book simply loses a section.
  • a heading whose printed SECTION NUMBER was dropped — the PDF says "1.(Digital) Work and
    Labour: A Cultural-Materialist Perspective" and "1.1.Defining Cultural Labour" (c0813ca6);
    the markdown says neither number, so the numbering is gone AND the levels are whatever
    Mistral guessed (the number is what `_level_numbered_headings` needs to fix them).

The universal key is the TYPE STYLE (font + relative size). This pass never decides what a heading
looks like on its own: it learns which styles are headings from the ones the OCR already marked in
THIS document, then applies that evidence to identical lines it left plain. A style that never
appears as a marked heading promotes nothing.

Companion to quote_geometry (indentation as the key for blockquotes), same plumbing: detected from
the PDF at convert time, cached to heading_geometry.json so a PDF-less fixture replay reproduces
the same layout truth.
"""
import re
import unicodedata
from collections import Counter

from ingestion.pdf.quote_geometry import lines_from_fragments

# A heading candidate's length: long enough not to be a stray fragment, short enough to be a title.
MIN_HEADING_CHARS = 4
MAX_HEADING_CHARS = 160
# Lines set at least this much larger than the body count as headings even when not bold.
LARGER_RATIO = 1.05
# A style/text pair appearing on this many pages is a running header, not a section title.
RUNNING_HEAD_PAGES = 3
# Vertical gap (in text-space units) within which consecutive same-style lines are ONE wrapped
# heading ("3.The Policy and Industry Perspective: Gold Open Access " / "as New Business Model").
WRAP_Y_GAP = 30.0

_BOLD_RE = re.compile(r'bold|black|heavy|semib|demi', re.IGNORECASE)
# The printed section number at the head of a heading: "1.", "1.1.", "2)", "IV." — captured with
# whatever separator follows so it can be re-emitted as printed.
_LEADING_NUMBER_RE = re.compile(r'^\s*(\d{1,2}(?:\.\d{1,2})*\.?|[IVXLC]{1,5}\.)\s*')


def norm(text):
    """PDF-text ↔ markdown alignment key: NFKC (folds ligatures and the many hyphen variants a
    text layer uses), then lowercase alphanumerics separated by single spaces. The PDF layer
    routinely glues tokens ("1.(Digital)", "sion ofhealth"), so punctuation cannot be trusted as a
    separator — only the alphanumeric sequence is."""
    text = unicodedata.normalize('NFKC', text or '')
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def _style_of(font, size):
    """(font family, rounded size) — the style identity a heading shares with its siblings."""
    family = re.sub(r'^/', '', (font or '').split('+')[-1])
    return family, round(size or 0, 2)


def collect_styled_lines(pdf_path):
    """Every text line in the PDF with its style: [{page, y, text, style, bold}]. Empty on any
    failure — this pass must never sink a convert."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
    except Exception:
        return []
    out = []
    for page_idx, page in enumerate(reader.pages):
        frags, fonts, sizes = [], {}, {}

        def visit(text, cm, tm, font_dict, font_size, frags=frags, fonts=fonts, sizes=sizes):
            if not (text or '').strip():
                return
            x = cm[0] * tm[4] + cm[2] * tm[5] + cm[4]
            y = cm[1] * tm[4] + cm[3] * tm[5] + cm[5]
            frags.append((x, y, text))
            fonts[(x, y)] = str(font_dict.get('/BaseFont', '')) if isinstance(font_dict, dict) else ''
            # cm-scaled: many text layers report font_size 1.0 and put the real scale in the
            # matrix, so only the RELATIVE comparison between lines is meaningful.
            sizes[(x, y)] = (font_size or 0) * (abs(cm[0]) or 1.0)

        try:
            page.extract_text(visitor_text=visit)
            mid = float(page.mediabox.width) / 2
        except Exception:
            continue
        # Group by COLUMN as well as by line. A two-column journal page puts a right-column heading
        # at the same y as left-column BODY text, and a y-only grouping concatenates the two into one
        # "line" whose style is the body's — so the heading is not even a candidate (46c0fbb5 lost
        # '2.2.' style headings this way, and its right-column sections stayed unnumbered). Splitting
        # at the page midpoint costs nothing on a single-column page: a body line split in half is
        # two body lines, and a heading split in half is re-joined by the wrap merge below (same y,
        # same style).
        left = [f for f in frags if f[0] < mid]
        right = [f for f in frags if f[0] >= mid]
        for column in (left, right):
            for x, y, text in lines_from_fragments(column):
                out.append({'page': page_idx, 'y': y, 'x': x, 'text': text.strip(),
                            'style': _style_of(fonts.get((x, y)), sizes.get((x, y)))})
    out.sort(key=lambda l: (l['page'], -l['y'], l['x']))
    return out


def detect_heading_lines(pdf_path):
    """Heading CANDIDATES from the PDF text layer: lines whose style is not the body style and
    which are bold or larger than the body. Returns a JSON-safe dict:
    {'body_style': [family, size], 'lines': [{'page', 'text', 'style': [family, size]}]}."""
    lines = collect_styled_lines(pdf_path)
    if not lines:
        return {'body_style': None, 'lines': []}

    weight = Counter()
    for l in lines:
        weight[l['style']] += len(l['text'])
    body_style = weight.most_common(1)[0][0]
    body_size = body_style[1]
    body_bold = bool(_BOLD_RE.search(body_style[0]))

    # Merge consecutive same-style lines on a page — a heading that wrapped to two lines is ONE
    # heading, and its markdown paragraph carries the whole text.
    merged = []
    for l in lines:
        prev = merged[-1] if merged else None
        if (prev and prev['page'] == l['page'] and prev['style'] == l['style']
                and abs(prev['y'] - l['y']) <= WRAP_Y_GAP):
            prev['text'] = (prev['text'].rstrip() + ' ' + l['text'].lstrip()).strip()
            prev['y'] = l['y']
            continue
        merged.append(dict(l))

    candidates = []
    for l in merged:
        family, size = l['style']
        if l['style'] == body_style:
            continue
        is_bold = bool(_BOLD_RE.search(family)) and not body_bold
        if not (is_bold or size > body_size * LARGER_RATIO):
            continue
        if not (MIN_HEADING_CHARS <= len(l['text']) <= MAX_HEADING_CHARS):
            continue
        candidates.append(l)

    # A running header repeats across pages in the same style — never a section title.
    pages_per_text = {}
    for c in candidates:
        pages_per_text.setdefault(norm(c['text']), set()).add(c['page'])
    candidates = [c for c in candidates
                  if len(pages_per_text[norm(c['text'])]) < RUNNING_HEAD_PAGES]

    return {'body_style': list(body_style),
            'lines': [{'page': c['page'], 'text': c['text'], 'style': list(c['style']),
                       # bucketed x: the LEVEL rule treats only VISUALLY IDENTICAL headings as one
                       # class, and a heading's indent is part of how it looks (a two-column layout
                       # legitimately puts the same level at two x positions — two classes, each
                       # normalised on its own).
                       'x': round((c.get('x') or 0) / X_BUCKET)}
                      for c in candidates]}


_MD_HEADING_RE = re.compile(r'^(#{1,6})[ \t]+(.+?)\s*$')
# Paragraph shapes that are never a promotable heading, whatever the PDF says.
_NOT_A_HEADING_PARA = ('>', '|', '!', '[', '-', '*', '#')
# A repository COVER SHEET (Leiden/LSE/White Rose…) sets its labels in the same bold style the
# article uses for sections, and one of those labels ("Citation") is usually marked as a heading by
# the OCR — which confirms the style and then licenses promoting the rest of the cover's furniture
# ("Note: To cite this publication please use the final published version…", 24d86fb9). Front
# matter is never worth promoting, so skip the opening paragraphs outright, and never promote a
# metadata LABEL line wherever it appears.
FRONT_MATTER_PARAS = 8
_CHROME_LABEL_RE = re.compile(
    r'(?i)^(?:note|citation|version|licen[cs]e|downloaded from|please cite|available at|'
    r'published version|doi|issn|isbn|keywords?|abstract)\b\s*:?')


def squash(text):
    """`norm` with the spaces taken out. The PDF text layer glues tokens the markdown keeps apart —
    a two-column layout concatenates the OTHER column onto the heading's line ("2.2.Discussion and
    Debatehow the media operates. After a first phase of"), a column-break hyphenates the title
    itself ("1.4.Classifying Types of Internet Activ-"), and a wrap fuses two words ("the
    Economyto Political Order"). Spaces therefore carry no information in this comparison; the
    alphanumeric SEQUENCE does."""
    return re.sub(r'[^a-z0-9]', '', norm(text))


def _common_prefix_len(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


# How much of the markdown side a PDF line must cover to be the same heading. Generous for an
# EXISTING heading (the PDF line is routinely truncated at the column edge or hyphen-split);
# near-total for a PROMOTION, where a weak match would invent structure.
MATCH_SCORE_EXISTING = 0.6
MATCH_SCORE_PROMOTION = 0.9
MIN_MATCH_CHARS = 10
# A style class must have at least this many unnumbered, non-title headings before its plurality
# level is imposed on the outliers.
MIN_LEVEL_CLASS = 5
# Left-edge bucket (text-space units) for the level class key — absorbs sub-point jitter.
X_BUCKET = 4.0


def _best_match(line_text, items, min_score):
    """The one entry in `items` [(idx, squashed_text)] this PDF line names, or None.

    Scored on the common PREFIX of the two squashed strings — the glue and truncation above always
    happen at the END of the heading, never the start. A clear winner is required: the runner-up
    must cover strictly less, so "Information" and "Information: Key Concepts" never swap."""
    scored = []
    for idx, sq in items:
        if not sq:
            continue
        lcp = _common_prefix_len(line_text, sq)
        if lcp >= MIN_MATCH_CHARS and lcp / len(sq) >= min_score:
            scored.append((lcp / len(sq), lcp, idx))
    if not scored:
        return None
    scored.sort(reverse=True)
    if len(scored) > 1 and scored[0][1] == scored[1][1]:
        return None                             # tie on coverage — ambiguous, leave it alone
    return scored[0][2]


def recover_geometric_headings(md, heading_info):
    """Restore dropped section NUMBERS, PROMOTE plain paragraphs the PDF sets in a heading style,
    and NORMALISE levels within a style.

    Returns (md, renumbered, promoted, relevelled) — lists of descriptions, for logging. Every
    repair is gated on evidence from the SAME document: a style promotes only where the OCR already
    marked a heading in that style, and a PDF line must name its markdown counterpart with a clear
    prefix win (see `_best_match`).
    """
    lines = (heading_info or {}).get('lines') or []
    if not lines:
        return md, [], [], []

    paras = re.split(r'\n\s*\n', md)
    heading_paras = {}                          # para index -> (hashes, text)
    for i, p in enumerate(paras):
        m = _MD_HEADING_RE.match(p.strip())
        if m and '\n' not in p.strip():
            heading_paras[i] = (m.group(1), m.group(2))
    # Both sides are compared NUMBER-STRIPPED: the markdown heading may already carry its number
    # ("## 2. The Corporate Publishing Industry") while the PDF line's number is stripped to find
    # the title, and a leading digit at position 0 destroys the prefix score outright.
    heading_items = [(i, squash(_LEADING_NUMBER_RE.sub('', text, count=1)))
                     for i, (_h, text) in heading_paras.items()]
    title_idx = min(heading_paras) if heading_paras else None

    promotable_items = []
    for i, p in enumerate(paras):
        t = p.strip()
        if (not t or '\n' in t or t.startswith(_NOT_A_HEADING_PARA) or len(t) > MAX_HEADING_CHARS
                or i in heading_paras or i < FRONT_MATTER_PARAS or _CHROME_LABEL_RE.match(t)):
            continue
        promotable_items.append((i, squash(_LEADING_NUMBER_RE.sub('', t, count=1))))

    # --- Learn: which styles does THIS document use for headings, and at what level? ---------
    style_levels = {}                           # style -> [(page, level)]
    matched_style = {}                          # para index -> style
    matched_lines = set()
    renumber = []                               # (para_idx, number)
    for li, line in enumerate(lines):
        num_m = _LEADING_NUMBER_RE.match(line['text'])
        rest = squash(_LEADING_NUMBER_RE.sub('', line['text'], count=1))
        idx = _best_match(rest, heading_items, MATCH_SCORE_EXISTING)
        if idx is None:
            continue
        matched_lines.add(li)
        hashes, text = heading_paras[idx]
        style = tuple(line['style'])
        style_levels.setdefault(style, []).append((line['page'], len(hashes)))
        # The LEVEL class is narrower than the promotion class: same font AND same left edge, i.e.
        # headings that look EXACTLY alike. Nothing in the print distinguishes them, so nothing but
        # Mistral's guess distinguishes their markdown levels.
        matched_style.setdefault(idx, style + (line.get('x', 0),))
        if num_m and not _LEADING_NUMBER_RE.match(text):
            renumber.append((idx, num_m.group(1)))

    renumbered = []
    for idx, number in renumber:
        hashes, text = heading_paras[idx]
        number = number if number.endswith(('.', ')')) else number + '.'
        paras[idx] = f'{hashes} {number} {text}'
        heading_paras[idx] = (hashes, f'{number} {text}')
        renumbered.append(f'{number} {text}')

    # --- Promote: a plain paragraph set in a confirmed heading style ------------------------
    promoted = []
    for li, line in enumerate(lines):
        if li in matched_lines:
            continue
        style = tuple(line['style'])
        seen = style_levels.get(style)
        if not seen:
            continue                            # unconfirmed style — never guess
        # Try the line as printed, then minus its section number: a heading the OCR dropped BOTH the
        # mark and the number from ("3.The Policy and Industry Perspective: Gold Open Access as New
        # Business Model" — ffbb3ac7) is a plain paragraph carrying only the title.
        num_m = _LEADING_NUMBER_RE.match(line['text'])
        attempts = [(squash(_LEADING_NUMBER_RE.sub('', line['text'], count=1)),
                     num_m.group(1) if num_m else None)]
        idx = number = None
        for sq, num in attempts:
            idx = _best_match(sq, promotable_items, MATCH_SCORE_PROMOTION)
            if idx is not None:
                number = num
                break
        if idx is None:
            continue
        para = paras[idx].strip()
        # Level: the nearest confirmed heading of the SAME style, by page — locality tracks the
        # document's own nesting better than a document-wide majority.
        level = min(seen, key=lambda pl: (abs(pl[0] - line['page']), pl[0]))[1]
        if number:
            number = number if number.endswith(('.', ')')) else number + '.'
            para = f'{number} {para}'
        paras[idx] = '#' * level + ' ' + para
        heading_paras[idx] = ('#' * level, para)
        matched_style[idx] = style + (line.get('x', 0),)
        promotable_items = [(i, sq) for i, sq in promotable_items if i != idx]
        promoted.append(para)

    # --- Normalise LEVELS within a type style ----------------------------------------------
    # Headings that are typographically IDENTICAL are the same level. Mistral assigns levels by
    # guesswork: 5fc4aad4 sets every section in ONE style (Arial-BoldMT) and got #, ## and ###
    # scattered at random, so a mid-article section rendered as big as the document title ("why this
    # one big? in original same size as others"). Within a style class the PLURALITY level wins.
    # Exempt: the document title (the first heading — its style is often shared with References/About
    # the Author, and it must stay h1) and any NUMBERED heading (its number carries the level, and
    # _level_numbered_headings applies that afterwards). Needs a real class: >= MIN_LEVEL_CLASS
    # members and a strict majority, so a document with genuine same-style nesting is left alone.
    relevelled = []
    by_style = {}
    for idx, style in matched_style.items():
        if idx == title_idx:
            continue
        hashes, text = heading_paras[idx]
        if _LEADING_NUMBER_RE.match(text):
            continue
        by_style.setdefault(style, []).append((idx, len(hashes)))
    for style, members in by_style.items():
        if len(members) < MIN_LEVEL_CLASS:
            continue
        counts = Counter(level for _i, level in members).most_common()
        level, n = counts[0]
        runner_up = counts[1][1] if len(counts) > 1 else 0
        if n <= runner_up or n < len(members) * 0.4:
            continue                            # no clear plurality — leave the class alone
        for idx, was in members:
            if was == level:
                continue
            hashes, text = heading_paras[idx]
            paras[idx] = '#' * level + ' ' + text
            heading_paras[idx] = ('#' * level, text)
            relevelled.append((text, was, level))

    if not (renumbered or promoted or relevelled):
        return md, [], [], []
    return '\n\n'.join(paras), renumbered, promoted, relevelled

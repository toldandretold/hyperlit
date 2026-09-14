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
        except Exception:
            continue
        for x, y, text in lines_from_fragments(frags):
            out.append({'page': page_idx, 'y': y, 'text': text.strip(),
                        'style': _style_of(fonts.get((x, y)), sizes.get((x, y)))})
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
            'lines': [{'page': c['page'], 'text': c['text'], 'style': list(c['style'])}
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


def recover_geometric_headings(md, heading_info):
    """Restore dropped section NUMBERS on existing headings, and PROMOTE plain paragraphs the PDF
    sets in a style this document uses for headings.

    Returns (md, renumbered, promoted) where the two lists are '<text>' descriptions for logging.
    Both repairs are gated on evidence from the SAME document: a style promotes only where the OCR
    already marked at least one heading in that style, and a paragraph is only touched when the
    PDF line matches it whole and UNIQUELY (the alignment discipline quote_geometry uses).
    """
    lines = (heading_info or {}).get('lines') or []
    if not lines:
        return md, [], []

    paras = re.split(r'\n\s*\n', md)
    # Normalised paragraph text → indices (uniqueness is the alignment gate).
    by_norm = {}
    for i, p in enumerate(paras):
        by_norm.setdefault(norm(p.strip()), []).append(i)

    # --- Learn: which styles does THIS document use for headings, and at what level? ---------
    # A PDF candidate whose text matches an existing markdown heading (with or without its
    # printed number) confirms that style, and hands us the level the OCR chose for it.
    style_levels = {}                       # style tuple -> [(page, level)]
    heading_paras = {}                      # para index -> (hashes, text)
    for i, p in enumerate(paras):
        m = _MD_HEADING_RE.match(p.strip())
        if m and '\n' not in p.strip():
            heading_paras[i] = (m.group(1), m.group(2))
    heading_by_norm = {}
    for i, (_h, text) in heading_paras.items():
        heading_by_norm.setdefault(norm(text), []).append(i)

    matched_pdf = set()
    renumber = []                           # (para_idx, number, pdf_text)
    for li, line in enumerate(lines):
        key = norm(line['text'])
        stripped_key = norm(_LEADING_NUMBER_RE.sub('', line['text'], count=1))
        hit = heading_by_norm.get(key) or heading_by_norm.get(stripped_key)
        if not hit or len(hit) != 1:
            continue
        idx = hit[0]
        matched_pdf.add(li)
        hashes, text = heading_paras[idx]
        style_levels.setdefault(tuple(line['style']), []).append((line['page'], len(hashes)))
        # The printed number the markdown heading lacks.
        num = _LEADING_NUMBER_RE.match(line['text'])
        if num and key != norm(text) and not _LEADING_NUMBER_RE.match(text):
            renumber.append((idx, num.group(1), text))

    renumbered = []
    for idx, number, text in renumber:
        hashes, _t = heading_paras[idx]
        number = number if number.endswith(('.', ')')) else number + '.'
        paras[idx] = f'{hashes} {number} {text}'
        renumbered.append(f'{number} {text}')

    # --- Promote: a plain paragraph set in a confirmed heading style ------------------------
    promoted = []
    for li, line in enumerate(lines):
        if li in matched_pdf:
            continue
        style = tuple(line['style'])
        seen = style_levels.get(style)
        if not seen:
            continue                        # unconfirmed style — never guess
        # Match on the line as printed, then on the line minus its section number: a heading the
        # OCR dropped BOTH the mark and the number from ("3.The Policy and Industry Perspective:
        # Gold Open Access as New Business Model" — ffbb3ac7) is a plain paragraph carrying only
        # the title, so the numbered key can never match it. Restore the number with the mark.
        num_m = _LEADING_NUMBER_RE.match(line['text'])
        keys = [(norm(line['text']), None)]
        if num_m:
            keys.append((norm(_LEADING_NUMBER_RE.sub('', line['text'], count=1)), num_m.group(1)))
        hit = number = None
        for key, number in keys:
            candidate = by_norm.get(key)
            if candidate and len(candidate) == 1:
                hit = candidate
                break
        if not hit:
            continue                        # absent, or ambiguous — leave it alone
        idx = hit[0]
        para = paras[idx].strip()
        if (not para or '\n' in para or para.startswith(_NOT_A_HEADING_PARA)
                or len(para) > MAX_HEADING_CHARS or idx in heading_paras
                or idx < FRONT_MATTER_PARAS or _CHROME_LABEL_RE.match(para)):
            continue
        # Level: the nearest confirmed heading of the SAME style, by page — locality tracks the
        # document's own nesting better than a document-wide majority.
        level = min(seen, key=lambda pl: (abs(pl[0] - line['page']), pl[0]))[1]
        if number:
            number = number if number.endswith(('.', ')')) else number + '.'
            para = f'{number} {para}'
        paras[idx] = '#' * level + ' ' + para
        promoted.append(para)

    if not renumbered and not promoted:
        return md, [], []
    return '\n\n'.join(paras), renumbered, promoted

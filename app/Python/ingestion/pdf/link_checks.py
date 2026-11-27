"""Checks a count cannot make: does each marker open the note the PDF prints for it, and did
every page's text reach the converted document?

Every other footnote check in the pipeline counts — markers against definitions, gaps in a
sequence. A marker that opens the WRONG note passes all of them (08a2e7a9: the OCR lost markers
8 and 9, the next page's 10-13 were counted on as 8-11, and marker "10" opened note 8 with every
total in balance). So does a paragraph that never arrived. The PDF's own text layer can see
both, independently of any number the converter assigned:

  wrong_note      the layer prints one number at the marker's place in the body and another in
                  front of the note that marker opens
  far_from_note   in a document that sets its notes at the foot of the page, a marker whose
                  note is printed on some other page
  out_of_order    a marker numbered lower than the one before it in reading order
  lost_text       a run of a page's text that is nowhere in the converted document

Each is a FLAG for a person, read by the conversion lint, and nothing here changes the
document: a finding is evidence that the CONVERTER has a fault to fix, and a pass that rewrote
links on the strength of it turned its own misreadings into damage (it read "(p.161)." as
marker 161 and unlinked correct markers on that reading). All four are silent where the layer
cannot witness (no layer, a note the layer does not hold, words that occur twice): nothing is
reported on evidence that is not there.
"""

import difflib
import html
import re
import unicodedata

from .recovery import extract_pypdf_footnote_defs, extract_pypdf_page_texts

_DEF_LINE_RE = re.compile(r'(?m)^\[\^(\d+)\]:[ \t]*(.*)$')
_MARKER_RE = re.compile(r'\[\^(\d+)\]')
# Images and inline tags. Stripped BEFORE entities are unescaped, and never across a line: an
# escaped "&lt;" in the prose is a less-than sign, and read as a tag's opening it swallowed
# everything up to the next ">" — paragraphs of it.
_MD_NOISE_RE = re.compile(r'!\[[^\]]*\]\([^)\n]*\)|</?[a-zA-Z][^<>\n]{0,200}>')

# The letters before a marker that must be found once, and only once, in the layer.
_SITE_PREFIX_CHARS = 32
_SITE_PREFIX_MIN = 18
# The superscript as the layer renders it straight after those words: glued on, with at most
# the sentence's own punctuation between…
_GLUED_NUMBER_RE = re.compile(r'^([.,;:!?)\]"\'”’»]{0,3})(\d{1,3})(?![\d.,]?\d)')
# …or standing alone at the end of its line.
_LINE_END_NUMBER_RE = re.compile(r'^[.,;:!?)\]"\'”’»]{0,3} ?\n? ?(\d{1,3}) *\n')

# A note is identified in the layer by this much of its text, this closely, with no other note
# coming near.
_NOTE_IDENTITY_CHARS = 60
_NOTE_IDENTITY_MIN = 0.92
_NOTE_IDENTITY_RUNNER_UP = 0.8

# Lost text is measured in windows of folded letters. A window is three chunks, and counts as
# present when ANY of them is in the document: a layer that drops its ligatures or misreads a
# letter breaks a long exact match every line, and a paragraph that is really gone has no
# chunk anywhere. This many missing windows in a row is a run worth a look (about sixty words
# — a paragraph, not a caption or a running header).
_CHUNK = 16
_WINDOW = 3 * _CHUNK
_LOST_RUN_WINDOWS = 6
_MAX_REPORTED = 12
# A run is reported only when it reads as PROSE. The text inside a figure or a table is in the
# layer and legitimately not in the document (it is an image there, or cells in another
# order), and it is lists of labels: almost no function words.
_FUNCTION_WORDS = frozenset(
    'the of and to in a is that for as with by on are this be it or from at which an was not '
    'de la le les des et en du que un une est dans pour qui par sur au '
    'der die das und den von zu ist mit sich des auf nicht ein eine dem im als auch '
    'el los las y del se por con una su no es al lo'.split())
_PROSE_MIN_FUNCTION_SHARE = 0.2


def _reads_as_prose(text):
    words = re.findall(r"[^\W\d_]+", text.lower())
    if len(words) < 30:
        return False
    return sum(w in _FUNCTION_WORDS for w in words) / len(words) >= _PROSE_MIN_FUNCTION_SHARE


def _fold_alnum(text):
    text = unicodedata.normalize('NFKD', text or '')
    return re.sub(r'[^a-z0-9]+', '', text.lower())


def _fold_letters(text):
    text = unicodedata.normalize('NFKD', text or '')
    return re.sub(r'[^a-z]+', '', text.lower())


def _letter_stream(text):
    """(folded letters, index of each folded letter in `text`). Letters only: the layer glues
    every OTHER marker's digit into the words too ("Forced Labour26 and Freedom of
    Association27"), and a stream that kept digits could never find the words before the
    second marker — the search then settled on the one place the phrase recurs without
    markers, pages away (d13832dc)."""
    chars, where = [], []
    for i, ch in enumerate(text):
        for c in unicodedata.normalize('NFKD', ch).lower():
            if 'a' <= c <= 'z':
                chars.append(c)
                where.append(i)
    return ''.join(chars), where


def _split(markdown):
    defs = {}
    for m in _DEF_LINE_RE.finditer(markdown or ''):
        defs.setdefault(int(m.group(1)), m.group(2).strip())
    body = _DEF_LINE_RE.sub('', markdown or '')
    return body, defs


def _marker_sites(markdown):
    """[(number, context before the marker, folded prefix, start, end)] for every marker in the
    body, in reading order. Positions are in `markdown` itself; definition lines are skipped."""
    out = []
    def_spans = [(m.start(), m.end()) for m in _DEF_LINE_RE.finditer(markdown or '')]
    k = 0
    for m in _MARKER_RE.finditer(markdown or ''):
        while k < len(def_spans) and def_spans[k][1] <= m.start():
            k += 1
        if k < len(def_spans) and def_spans[k][0] <= m.start():
            continue                                  # the definition's own label, or inside it
        before = markdown[max(0, m.start() - 200):m.start()]
        before = html.unescape(_MD_NOISE_RE.sub(' ', _MARKER_RE.sub('', before)))
        context = re.sub(r'\s+', ' ', before).strip()[-60:]
        # The digits the text itself ends on, between its last letter and the marker:
        # "(p.161)." and "Commandos 3" end on numbers that are the prose's, not the marker's.
        own_digits = re.sub(r'\D+', '', re.split(r'[^\W\d_]', before)[-1])
        out.append((int(m.group(1)), context,
                    (_fold_letters(before)[-_SITE_PREFIX_CHARS:], own_digits),
                    m.start(), m.end()))
    return out


def _witness_marker(prefix, streams):
    """Where the layer has the words before a marker, and the number it prints after them.
    (page, printed or None) — or None when those words are not there exactly once.

    `prefix` is (the letters before the marker, the digits the text ends on after its last
    letter). The words are found by their letters; the text's OWN closing digits are then
    stepped over in the layer before the marker's number is read. Reading straight on from the
    last letter took "(p.161)." for marker 161 and "(e2)." for marker 2 (c69a9641, 4cc3c696)."""
    letters, own_digits = prefix
    if len(letters) < _SITE_PREFIX_MIN:
        return None
    found = None
    for page_idx, (raw, folded, where) in streams.items():
        at = folded.find(letters)
        if at < 0:
            continue
        if found is not None or folded.find(letters, at + 1) >= 0:
            return None                              # twice in the document: no single site
        found = (page_idx, raw, where[at + len(letters) - 1] + 1)
    if found is None:
        return None
    page_idx, raw, end = found
    for digit in own_digits:
        while end < len(raw) and not raw[end].isalnum():
            end += 1
        if raw[end:end + 1] != digit:
            return page_idx, None                    # the layer's text differs here: no reading
        end += 1
    tail = raw[end:end + 12]
    m = _GLUED_NUMBER_RE.match(tail) or _LINE_END_NUMBER_RE.match(tail)
    return page_idx, (int(m.group(m.lastindex)) if m else None)


def _witness_note(text, layer_defs):
    """(page, printed number) of the one layer note that IS `text`, else None.

    Judged on the note's first sixty letters and digits, not its opening words: an article's
    notes routinely open alike ("Translation from German: „Das …" a dozen times, a run of
    YouTube links), and a note identified by its opening alone is very often its neighbour —
    which reads as a marker opening the wrong note (c4ac6610, 024de307). One clear match and
    no runner-up, or nothing."""
    mine = _fold_alnum(text)
    if len(mine) < 12:
        return None
    best, best_score, runner_up = None, 0.0, 0.0
    for page_idx, page_defs in layer_defs.items():
        for printed, layer_text in page_defs:
            theirs = _fold_alnum(layer_text)
            n = min(len(mine), len(theirs), _NOTE_IDENTITY_CHARS)
            if n < 12 or mine[:8] != theirs[:8]:
                continue
            # A short note is not the opening of a long one: "Decree 1062/98." (the layer's
            # note 28) against a note that begins with those words and runs on for a paragraph
            # (92bb4a0c). The layer's own tail may run long — it glues the next page on.
            if len(theirs) < _NOTE_IDENTITY_CHARS and len(mine) > 2 * len(theirs):
                continue
            score = difflib.SequenceMatcher(None, mine[:n], theirs[:n], autojunk=False).ratio()
            if score > best_score:
                best, best_score, runner_up = (page_idx, printed), score, best_score
            elif score > runner_up:
                runner_up = score
    if best is None or best_score < _NOTE_IDENTITY_MIN or runner_up >= _NOTE_IDENTITY_RUNNER_UP:
        return None
    return best


def _lost_runs(markdown, page_texts):
    whole = _fold_letters(html.unescape(_MD_NOISE_RE.sub(' ', markdown or '')))
    runs, windows, missing_total = [], 0, 0
    for page_idx in sorted(page_texts):
        raw = page_texts[page_idx] or ''
        chars, where = [], []
        for i, ch in enumerate(raw):
            for c in unicodedata.normalize('NFKD', ch).lower():
                if 'a' <= c <= 'z':
                    chars.append(c)
                    where.append(i)
        folded = ''.join(chars)
        missing = []
        for start in range(0, len(folded) - _WINDOW + 1, _WINDOW):
            windows += 1
            if not any(folded[c:c + _CHUNK] in whole
                       for c in range(start, start + _WINDOW, _CHUNK)):
                missing.append(start)
                missing_total += 1
        run = []
        for start in missing + [None]:
            if run and (start is None or start != run[-1] + _WINDOW):
                if len(run) >= _LOST_RUN_WINDOWS:
                    a, b = where[run[0]], where[min(run[-1] + _WINDOW, len(where)) - 1]
                    if _reads_as_prose(raw[a:b]):
                        runs.append({'page': page_idx, 'chars': b - a,
                                     # the words just before it, which DID arrive: where in
                                     # the document the gap is
                                     'before': re.sub(r'\s+', ' ', raw[max(0, a - 160):a]).strip(),
                                     'excerpt': re.sub(r'\s+', ' ', raw[a:b]).strip()[:220]})
                run = []
            if start is not None:
                run.append(start)
    coverage = round(1 - missing_total / windows, 3) if windows else None
    return runs, coverage


def _repeated_notes(defs):
    """Numbers of the notes whose text another note repeats (the same address cited twice,
    "Ibid."). The layer cannot say which of them it is holding, so they witness nothing
    (bd6cb620: notes 12 and 13 are one URL, and 12 read as "the note printed as 13")."""
    by_text = {}
    for number, text in defs.items():
        by_text.setdefault(_fold_alnum(text)[:_NOTE_IDENTITY_CHARS], []).append(number)
    return {n for nums in by_text.values() if len(nums) > 1 for n in nums}


def _witnessed_pairs(sites, defs, page_texts, layer_defs):
    """Every marker whose own place AND whose note the layer can both locate:
    [(number, context, (marker page, printed there or None), (note page, note printed), start, end)]."""
    streams = {}
    for page_idx, raw in page_texts.items():
        folded, where = _letter_stream(raw or '')
        streams[page_idx] = (raw or '', folded, where)
    out = []
    repeated = _repeated_notes(defs)
    for number, context, prefix, start, end in sites:
        if number not in defs or number in repeated:
            continue
        note = _witness_note(defs[number], layer_defs)
        marker = _witness_marker(prefix, streams)
        if note is not None and marker is not None:
            out.append((number, context, marker, note, start, end))
    return out


def assess_link_integrity(markdown, pdf_path):
    """See the module docstring. Returns a dict for footnote_meta.json `integrity`:
    {witnessed, wrong_note, far_from_note, out_of_order, lost_text, text_coverage}."""
    out = {'witnessed': 0, 'wrong_note': [], 'far_from_note': [], 'out_of_order': [],
           'lost_text': [], 'text_coverage': None}
    _body, defs = _split(markdown)
    sites = _marker_sites(markdown)

    # Reading order needs no PDF: the first appearance of each number should climb.
    seen, last = set(), None
    for number, context, _prefix, _a, _b in sites:
        if number in seen:
            continue
        seen.add(number)
        if last is not None and number < last:
            out['out_of_order'].append({'number': number, 'after': last, 'context': context})
        last = number

    try:
        page_texts = extract_pypdf_page_texts(pdf_path) if pdf_path else {}
        layer_defs = extract_pypdf_footnote_defs(pdf_path) if pdf_path else {}
    except Exception:
        return out
    if not page_texts:
        return out

    pairs = [(number, context, marker, note)
             for number, context, marker, note, _a, _b in _witnessed_pairs(sites, defs, page_texts, layer_defs)]
    for number, context, marker, note in pairs:
        if marker[1] is not None:
            out['witnessed'] += 1
            if marker[1] != note[1]:
                out['wrong_note'].append({
                    'number': number, 'context': context, 'marker_printed': marker[1],
                    'note_printed': note[1], 'note': defs[number][:120]})

    # Notes at the foot of the page: most markers share a page with their note (or sit on the
    # page before it). Only then is a marker far from its note a sign of anything.
    near = [p for p in pairs if p[3][0] - p[2][0] in (0, 1)]
    if len(pairs) >= 4 and len(near) >= 0.7 * len(pairs):
        for number, context, marker, note in pairs:
            if note[0] - marker[0] not in (0, 1):
                out['far_from_note'].append({
                    'number': number, 'context': context, 'marker_page': marker[0],
                    'note_page': note[0], 'note': defs[number][:120]})

    runs, out['text_coverage'] = _lost_runs(markdown, page_texts)
    out['lost_text'] = runs[:_MAX_REPORTED]
    return out

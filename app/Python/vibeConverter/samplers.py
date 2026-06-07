"""vibeConverter.samplers — pull ACTUAL marker/definition/reference evidence from the document (file-type aware)."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob




def _reference_section(art, span=1500):
    """The RAW region of the converted document from the References/Bibliography heading onward — the same
    place the bibliography extractor scanned (it uses these same REFERENCE_HEADERS). Lets the model COUNT
    the entries that are actually there vs `references_found`, to tell an upstream extraction miss from a
    document that genuinely has few references. Best-effort; '' if no heading or bs4 missing."""
    src = art.get('source') or ''
    if not src:
        return ''
    try:
        from bs4 import BeautifulSoup
        from digestion.bibliographyExtraction.bibliography import REFERENCE_HEADERS
        text = BeautifulSoup(src, 'html.parser').get_text('\n', strip=True)
    except Exception:
        return ''
    low = text.lower()
    pos = -1
    for kw in REFERENCE_HEADERS:
        i = low.find('\n' + kw)            # a heading line that IS the keyword
        if i != -1:
            pos = i + 1
            break
        if low.startswith(kw):
            pos = 0
            break
    return text[pos:pos + span] if pos != -1 else ''




def _markup_in_context(art):
    """Show the model the ACTUAL markup of a footnote REFERENCE and a DEFINITION inside their
    containing block (paragraph/div) — the element NESTING that a fixed line-sample or a truncated
    excerpt hides (e.g. the <sup>…<a epub:type=noteref>…</a></sup> double-detection that orphaned
    half of aarushi's footnotes). For an EPUB it also pulls from the RAW source (epub_original/*.xhtml
    or original.epub), where the pre-conversion markup the bug actually lives in is intact.
    Best-effort: never raises (returns '' if bs4 is unavailable or nothing matches)."""
    import re
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return ''
    out = []

    def _block(el):
        for anc in [el, *el.parents]:
            if getattr(anc, 'name', None) in ('p', 'div', 'li', 'aside', 'td', 'section'):
                return str(anc)[:700]
        return str(el)[:400]

    def _find_noteref(soup):
        r = soup.find('sup', class_='footnote-ref')
        return r or soup.find(lambda t: t.has_attr('epub:type') and 'noteref' in t.get('epub:type', '').lower())

    # (a) Converted main-text.html: one in-text reference in its block.
    src = art.get('source')
    if src and '<' in src:
        try:
            ref = _find_noteref(BeautifulSoup(src, 'html.parser'))
            if ref:
                out.append("In-text reference (converted main-text.html), in its block:\n" + _block(ref))
        except Exception:
            pass

    # A real footnote definition's markup (footnotes.json content).
    bd = art.get('book_dir')
    if bd:
        for cand in ('footnotes.jsonl', 'footnotes.json'):
            p = os.path.join(bd, cand)
            if not os.path.isfile(p):
                continue
            try:
                raw = open(p, encoding='utf-8').read()
                items = ([json.loads(l) for l in raw.splitlines() if l.strip()]
                         if cand.endswith('.jsonl') else json.load(open(p, encoding='utf-8')))
                if isinstance(items, list) and items:
                    out.append("A footnote definition (footnotes.json content):\n" + str(items[0].get('content', ''))[:600])
            except Exception:
                pass
            break

    # (b) RAW EPUB source: a noteref + a footnote in their blocks — shows the PRE-conversion nesting.
    raw = None
    if bd:
        epd = os.path.join(bd, 'epub_original')
        if os.path.isdir(epd):
            import glob
            for f in (glob.glob(os.path.join(epd, '**', '*.xhtml'), recursive=True)
                      + glob.glob(os.path.join(epd, '**', '*.html'), recursive=True)):
                try:
                    t = open(f, encoding='utf-8', errors='ignore').read()
                except Exception:
                    continue
                if 'noteref' in t.lower():
                    raw = t
                    break
        elif os.path.isfile(os.path.join(bd, 'original.epub')):
            try:
                import zipfile
                with zipfile.ZipFile(os.path.join(bd, 'original.epub')) as z:
                    for n in z.namelist():
                        if n.lower().endswith(('.xhtml', '.html')):
                            t = z.read(n).decode('utf-8', 'ignore')
                            if 'noteref' in t.lower():
                                raw = t
                                break
            except Exception:
                pass
    if raw:
        try:
            rs = BeautifulSoup(raw, 'html.parser')
            nref = _find_noteref(rs)
            if nref:
                out.append("RAW EPUB in-text reference, in its block (PRE-conversion — note the element nesting):\n"
                           + _block(nref))
            ndef = rs.find(lambda t: t.has_attr('epub:type')
                           and re.search(r'footnote|endnote|rearnote', t.get('epub:type', ''), re.I))
            if ndef:
                out.append("RAW EPUB footnote definition, in its block:\n" + _block(ndef))
        except Exception:
            pass
    return "\n\n".join(out)




def _footnote_samples(art, n=14):
    """Pull the document's ACTUAL footnote markers + definitions so the model sees the shapes it
    must wire up — not just aggregate counts. Markdown-aware (the [^N] / N. forms of the PDF path)
    AND HTML-aware (the <sup class="footnote-ref"> markers EPUB/HTML/docx produce + real definition
    text from footnotes.json). Without the HTML half, an EPUB case showed the model NO real markers,
    so it invented a scheme (the aarushi 'epub:type=noteref' hallucination — which doesn't exist)."""
    import re
    refs, defs = [], []
    text = art.get('markdown') or art.get('source') or ''

    # Markdown markers + definition-looking lines ("[^N]", "[N] …", "N. Text").
    for ln in text.split('\n'):
        s = ln.strip()
        if not s:
            continue
        if len(refs) < n and re.search(r'\[\^\d+\]', s):
            refs.append(s[:160])
        if len(defs) < n and re.match(r'^(\[\^?\d+\]\s*[:.]?|\d{1,3}[.\s])\s*\S', s):
            defs.append(s[:160])

    # HTML in-text markers: <sup ...footnote-ref...>N</sup> with a little leading context.
    if len(refs) < n and '<sup' in text:
        for m in re.finditer(r'(.{0,60})(<sup\b[^>]*footnote-ref[^>]*>.*?</sup>)', text, re.S):
            ctx = re.sub(r'\s+', ' ', m.group(1))[-50:]
            refs.append((ctx + m.group(2))[:200])
            if len(refs) >= n:
                break

    # HTML definitions live separately (footnotes.json/jsonl), not inline — pull a few real ones.
    if len(defs) < n and art.get('book_dir'):
        for cand in ('footnotes.jsonl', 'footnotes.json'):
            p = os.path.join(art['book_dir'], cand)
            if not os.path.isfile(p):
                continue
            try:
                raw = open(p, encoding='utf-8').read()
                items = ([json.loads(l) for l in raw.splitlines() if l.strip()]
                         if cand.endswith('.jsonl') else json.load(open(p, encoding='utf-8')))
                for it in (items if isinstance(items, list) else []):
                    c = re.sub(r'<[^>]+>', '', str(it.get('content') or it.get('text') or ''))
                    c = re.sub(r'\s+', ' ', c).strip()
                    if c:
                        defs.append(c[:160])
                    if len(defs) >= n:
                        break
            except Exception:
                pass
            break

    out = []
    if refs:
        out.append("In-text markers (what must link — note the actual element/scheme):\n"
                   + "\n".join(f"  {r}" for r in refs))
    if defs:
        out.append("Footnote definitions (a sample of what they link TO):\n"
                   + "\n".join(f"  {d}" for d in defs))
    return "\n".join(out)




def _raw_footnote_markers(art, n=8):
    """Scan the RAW source (epub_original/*.xhtml, original.epub, else main-text.html) for footnote-
    MARKER-shaped elements using a GENERIC set of schemes — NOT just the `epub:type=noteref` /
    `class=footnote-ref` the converter already recognises. Many EPUBs mark a footnote reference as a
    bare or anchored SUPERSCRIPT NUMERAL — `<sup>12</sup>` or `<a href="#fn12"><sup>12</sup></a>` — a
    scheme the existing samplers miss, so a DETECTION miss showed the model NOTHING to fix (schumpeter:
    378 `<sup>` markers, zero 'noteref', only 1 footnote detected → 'footnotes not matched' did nothing,
    yet pasting one marker's HTML by hand fixed it first try). Returns (count, [samples-with-context]) so
    the prompt can say 'N marker-shapes in the source but only M detected → the DETECTOR missed this
    scheme'. Overlapping matches (an inner <sup> inside a note anchor) are merged so the count is honest.
    Best-effort; never raises."""
    import re, glob
    bd = art.get('book_dir')
    blobs, budget = [], 4_000_000
    if bd:
        epd = os.path.join(bd, 'epub_original')
        if os.path.isdir(epd):
            for f in (glob.glob(os.path.join(epd, '**', '*.xhtml'), recursive=True)
                      + glob.glob(os.path.join(epd, '**', '*.html'), recursive=True)):
                try:
                    blobs.append(open(f, encoding='utf-8', errors='ignore').read())
                except Exception:
                    pass
                if sum(len(b) for b in blobs) > budget:
                    break
        elif os.path.isfile(os.path.join(bd, 'original.epub')):
            try:
                import zipfile
                with zipfile.ZipFile(os.path.join(bd, 'original.epub')) as z:
                    for nm in z.namelist():
                        if nm.lower().endswith(('.xhtml', '.html')):
                            blobs.append(z.read(nm).decode('utf-8', 'ignore'))
                            if sum(len(b) for b in blobs) > budget:
                                break
            except Exception:
                pass
    if not blobs and (art.get('source') or ''):
        blobs = [art['source']]
    text = '\n'.join(blobs)
    if not text:
        return 0, []
    # Footnote-marker shapes, most-specific first (so an anchor-wrapped sup is preferred over its inner sup).
    patterns = [
        r'<a\b[^>]*href="#[^"]*"[^>]*>\s*<sup\b[^>]*>\s*\d{1,4}\s*</sup>\s*</a>',      # <a href=#..><sup>N</sup></a>
        r'<sup\b[^>]*>\s*<a\b[^>]*href="#[^"]*"[^>]*>\s*\d{1,4}\s*</a>\s*</sup>',      # <sup><a href=#..>N</a></sup>
        r'<a\b[^>]*\b(?:role="doc-noteref"|epub:type="[^"]*note[^"]*")[^>]*>.*?</a>',  # semantic note anchors
        r'<sup\b[^>]*>\s*\d{1,4}\s*</sup>',                                            # bare <sup>N</sup>
    ]
    spans = []
    for pat in patterns:
        for m in re.finditer(pat, text, re.S | re.I):
            spans.append((m.start(), m.end(), m.group(0)))
    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))   # by start, longer (outer) match first
    merged, last_end, samples, seen = [], -1, [], set()
    for s, e, g in spans:
        if s < last_end:               # overlaps an already-counted marker (inner sup of a note anchor) → skip
            continue
        merged.append(g)
        last_end = e
        frag = re.sub(r'\s+', ' ', g).strip()
        if len(samples) < n and frag not in seen:
            seen.add(frag)
            lead = re.sub(r'\s+', ' ', text[max(0, s - 60):s])[-50:]
            samples.append((lead + frag)[:220])
    return len(merged), samples

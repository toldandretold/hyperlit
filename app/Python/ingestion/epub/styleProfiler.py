"""Phase ① helper — the "universal key" for cooked EPUBs: read the CSS and classify elements by their
COMPUTED TYPOGRAPHIC appearance, not by (obfuscated) class NAMES.

Heavily-obfuscated Calibre EPUBs strip semantic meaning from the markup but leave it in the stylesheet:
a heading is `<div class="class33">` where `.class33 { font-family: Arial; font-weight: bold;
font-variant: small-caps }`, a footnote marker is `<a class="class37">` where
`.class37 { vertical-align: super }`. A human reads the rendered page and classifies by *look*; this
module lets the detectors do the same.

It is a ZERO-import leaf (only tinycss2 + stdlib) — the orchestrator runs `epub_normalizer` as runpy
`__main__`, so a heading/footnote detector importing this back must NOT pull the orchestrator in.

Two pieces:
  • StyleProfiler — parse the concatenated CSS into per-class typographic fingerprints (StyleSig) and answer
    `fingerprint(el)` / `prominence(sig, baseline)`. The detector picks the body baseline + clusters styles
    into heading tiers (it needs the soup's per-style usage tally); the profiler just supplies the styles.
  • TocIndex — parse toc.ncx (every EPUB has one — the spec requires a nav document) into prefixed target
    id → nesting depth. Authoritative for WHICH blocks are headings + their LEVEL, independent of styling.

NOTHING here mutates the soup or fires unless real CSS was found (`has_css`), so it is inert on every EPUB
that carries no stylesheet — which is the whole existing regression corpus.
"""
import os
import re
from dataclasses import dataclass

try:
    import tinycss2
except Exception:  # pragma: no cover - tinycss2 is a declared dependency, but never hard-fail a conversion
    tinycss2 = None


# Font-family buckets — a serif↔sans SWITCH from the body baseline is one heading signal (publishers often
# set body in a serif and titles in a sans, or vice-versa). Lists are lowercased substrings.
_SERIF = ('georgia', 'times', 'garamond', 'baskerville', 'minion', 'palatino', 'caslon', 'serif')
_SANS = ('arial', 'helvetica', 'verdana', 'tahoma', 'calibri', 'futura', 'gill', 'frutiger', 'sans-serif')


def spine_id_prefix(file_href):
    """The per-spine-document id prefix the EPUB loader applies when combining the spine into one soup
    (`id="X"` in part0004.html → `part0004_X`). SHARED so TocIndex resolves a toc.ncx `src` to the same
    prefixed id the markers/definitions carry. Must stay byte-identical to the loader's `file_prefix`."""
    return os.path.splitext(os.path.basename(file_href))[0] + "_"


def _parse_size_em(value):
    """Normalise a CSS length to em *relative to the implicit 1em body baseline*. Publishers author heading
    sizes as `1.125em` / `175%` relative to body, so declared-em IS already the relative bucket. Returns None
    when absent / inherit / auto (== inherits the 1em baseline)."""
    if not value:
        return None
    v = value.strip().lower()
    if v in ('inherit', 'initial', 'auto', 'normal', 'unset'):
        return None
    m = re.match(r'^([\d.]+)\s*(em|rem|%|px|pt|ex)?$', v)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    unit = m.group(2) or 'em'
    if unit in ('em', 'rem', 'ex'):
        return n
    if unit == '%':
        return n / 100.0
    if unit == 'px':
        return n / 16.0          # 16px nominal body
    if unit == 'pt':
        return n / 12.0          # 12pt nominal body
    return n


@dataclass
class StyleSig:
    """A resolved typographic fingerprint for an element. Sizes are em relative to the body baseline."""
    font_size_em: float = None
    bold: bool = False
    italic: bool = False
    caps: bool = False                # small-caps OR text-transform: uppercase
    serif: bool = None                # True serif / False sans / None unknown
    font_family: str = None
    text_align: str = None            # 'center' | 'right' | 'justify' | 'left' | None
    vertical_align: str = None        # 'super' | 'sub' | None
    margin_top_em: float = None
    margin_left_em: float = None

    def key(self):
        """Hashable identity for grouping elements that share a visual style."""
        return (self.font_size_em, self.bold, self.italic, self.caps, self.serif,
                self.text_align, self.vertical_align)


def _sig_from_decls(decls):
    """Build a StyleSig from a merged {property: value} dict (already lowercased)."""
    weight = decls.get('font-weight', '')
    bold = ('bold' in weight) or weight in ('600', '700', '800', '900')
    style = decls.get('font-style', '')
    italic = ('italic' in style) or ('oblique' in style)
    variant = decls.get('font-variant', '') + ' ' + decls.get('font-variant-caps', '')
    caps = ('small-caps' in variant) or ('uppercase' in decls.get('text-transform', ''))
    family = decls.get('font-family') or None
    serif = None
    if family:
        fl = family.lower()
        # Check SANS first: 'serif' is a substring of 'sans-serif', so a serif-first test would
        # misread "Arial, sans-serif" as serif.
        if any(s in fl for s in _SANS):
            serif = False
        elif any(s in fl for s in _SERIF):
            serif = True
    align = decls.get('text-align') or None
    va = decls.get('vertical-align', '')
    vertical_align = 'super' if 'super' in va else ('sub' if 'sub' in va else None)
    return StyleSig(
        font_size_em=_parse_size_em(decls.get('font-size')),
        bold=bold, italic=italic, caps=caps, serif=serif, font_family=family,
        text_align=align, vertical_align=vertical_align,
        margin_top_em=_parse_size_em(decls.get('margin-top')),
        margin_left_em=_parse_size_em(decls.get('margin-left')),
    )


def _parse_inline(style_attr):
    """Parse an inline `style="..."` attribute into a {prop: value} dict (lowercased)."""
    decls = {}
    for chunk in style_attr.split(';'):
        if ':' not in chunk:
            continue
        k, _, v = chunk.partition(':')
        decls[k.strip().lower()] = v.strip().lower()
    return decls


# Typographic properties worth keeping (ignore colour/line-height/etc. — they're not role signals).
_KEEP_PROPS = {
    'font-size', 'font-weight', 'font-style', 'font-variant', 'font-variant-caps',
    'font-family', 'text-align', 'vertical-align', 'text-transform', 'margin-top', 'margin-left',
}


class StyleProfiler:
    """Per-class typographic style table parsed from the EPUB's concatenated CSS."""

    def __init__(self, class_rules, tag_rules):
        self._class_rules = class_rules     # {classname: {prop: value}}
        self._tag_rules = tag_rules         # {tagname: {prop: value}} (body/html/p — for a declared baseline)

    @property
    def has_css(self):
        return bool(self._class_rules or self._tag_rules)

    @classmethod
    def from_css_text(cls, css_text):
        """Parse concatenated CSS into a StyleProfiler. Returns a profiler with `has_css == False` when there
        is nothing usable (no CSS / parse failure) — the no-op switch every detector gates on."""
        if not css_text or tinycss2 is None:
            return cls({}, {})
        class_rules, tag_rules = {}, {}
        try:
            for node in tinycss2.parse_stylesheet(css_text, skip_comments=True, skip_whitespace=True):
                if getattr(node, 'type', None) != 'qualified-rule':
                    continue
                selector = tinycss2.serialize(node.prelude).strip()
                decls = {}
                for d in tinycss2.parse_declaration_list(node.content, skip_comments=True, skip_whitespace=True):
                    if getattr(d, 'type', None) != 'declaration':
                        continue
                    if d.lower_name in _KEEP_PROPS:
                        decls[d.lower_name] = tinycss2.serialize(d.value).strip().lower()
                if not decls:
                    continue
                # FLAT single-class model (matches Calibre's one-class-per-element output): every class
                # mentioned in the (possibly comma-separated) selector gets these declarations, last-wins.
                for cls_name in re.findall(r'\.([A-Za-z_][\w-]*)', selector):
                    class_rules.setdefault(cls_name, {}).update(decls)
                # Bare tag selectors (body / html / p) feed the baseline fallback.
                for part in selector.split(','):
                    p = part.strip()
                    if re.fullmatch(r'[a-zA-Z][\w]*', p):
                        tag_rules.setdefault(p.lower(), {}).update(decls)
        except Exception:
            return cls(class_rules, tag_rules)
        return cls(class_rules, tag_rules)

    def fingerprint(self, el):
        """Resolve an element's typographic StyleSig from its class(es) + inline style (inline wins).
        Returns None when the element carries no style info (treat as body baseline)."""
        if not self.has_css:
            return None
        merged = {}
        tag_rule = self._tag_rules.get(getattr(el, 'name', None))
        if tag_rule:
            merged.update(tag_rule)
        classes = el.get('class') if hasattr(el, 'get') else None
        for c in (classes or []):
            if c in self._class_rules:
                merged.update(self._class_rules[c])
        style_attr = el.get('style') if hasattr(el, 'get') else None
        if style_attr:
            merged.update({k: v for k, v in _parse_inline(style_attr).items() if k in _KEEP_PROPS})
        if not merged:
            return None
        return _sig_from_decls(merged)

    def body_baseline(self):
        """A declared body baseline from a `body`/`html`/`p` tag rule, if any (else None — the detector falls
        back to the most-used block style)."""
        for tag in ('body', 'html', 'p'):
            if tag in self._tag_rules:
                return _sig_from_decls(self._tag_rules[tag])
        return None

    @staticmethod
    def prominence(sig, baseline):
        """A composite, axis-agnostic score of how much MORE PROMINENT `sig` is than the body `baseline` —
        the comparison that builds the font hierarchy. Higher = more title-like. Every prominence axis
        contributes monotonically, and NO single axis is required, so a book that signals headings by size,
        by weight, by family-switch, or by caps all yield a usable ranking."""
        if sig is None:
            return 0.0
        b_size = (baseline.font_size_em if baseline and baseline.font_size_em is not None else 1.0)
        s_size = (sig.font_size_em if sig.font_size_em is not None else 1.0)
        score = 0.0
        if s_size > b_size:
            score += (s_size - b_size) * 4.0                       # bigger
        if sig.bold and not (baseline and baseline.bold):
            score += 1.0                                           # bolder
        if sig.caps:
            score += 1.0                                           # SMALL-CAPS / UPPERCASE
        if sig.text_align == 'center' and not (baseline and baseline.text_align == 'center'):
            score += 1.0                                           # centred
        if (sig.serif is not None and baseline is not None and baseline.serif is not None
                and sig.serif != baseline.serif):
            score += 1.0                                           # font-family switch (serif↔sans)
        if sig.italic and not (baseline and baseline.italic):
            score += 0.3
        mt = sig.margin_top_em or 0.0
        b_mt = (baseline.margin_top_em if baseline else 0.0) or 0.0
        if mt > b_mt:
            score += min((mt - b_mt) * 0.2, 0.5)                   # more space above
        return score


class TocIndex:
    """The EPUB's toc.ncx parsed into prefixed-target-id → nesting depth (1-based). Authoritative for WHICH
    blocks are headings and their LEVEL, independent of styling — every EPUB has a nav document (spec-required).
    """

    def __init__(self, depth_by_id, labels, navpoint_count, label_by_id=None):
        self._depth = depth_by_id           # {prefixed_id: depth}
        self.labels = labels                # set of navPoint label texts (lowercased) for text-match promotion
        self.navpoint_count = navpoint_count
        self._label_by_id = label_by_id or {}   # {prefixed_id: label} — validate an anchor sits on its title

    @property
    def has_toc(self):
        return self.navpoint_count > 0

    def depth_for_id(self, prefixed_id):
        return self._depth.get(prefixed_id)

    def label_for_id(self, prefixed_id):
        return self._label_by_id.get(prefixed_id)

    @classmethod
    def from_ncx(cls, ncx_xml):
        """Parse a toc.ncx string. Returns an empty index on any failure (never fatal)."""
        depth_by_id, labels, count, label_by_id = {}, set(), 0, {}
        if not ncx_xml:
            return cls(depth_by_id, labels, 0, label_by_id)
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(ncx_xml)
            for el in root.iter():
                el.tag = re.sub(r'\{.*?\}', '', el.tag)

            def walk(node, depth):
                nonlocal count
                for np in node.findall('navPoint'):
                    count += 1
                    label_el = np.find('navLabel/text')
                    label = (label_el.text or '').strip() if label_el is not None else ''
                    if label:
                        labels.add(label.lower())
                    content = np.find('content')
                    src = content.get('src') if content is not None else None
                    if src and '#' in src:
                        file_part, _, frag = src.partition('#')
                        if frag:
                            pid = spine_id_prefix(file_part) + frag
                            depth_by_id[pid] = depth
                            if label:
                                label_by_id[pid] = label.lower()
                    walk(np, depth + 1)            # nested navPoints are deeper headings

            nav_map = root.find('navMap')
            if nav_map is not None:
                walk(nav_map, 1)
        except Exception:
            return cls(depth_by_id, labels, count, label_by_id)
        return cls(depth_by_id, labels, count, label_by_id)

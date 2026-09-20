#!/usr/bin/env python3
"""
Give pandoc the headings a DOCX already declares.

Pandoc's docx reader decides "is this paragraph a heading?" from the STYLE NAME — it maps
`heading 1`..`heading 9` (Word's builtin names) and nothing else. But OOXML's actual authority
on heading level is `<w:outlineLvl>`: 0-8 mean heading levels 1-9, and 9 means body text. A
journal template that defines its own paragraph style called simply "Heading" with
`<w:outlineLvl w:val="0"/>` is, by the format's own definition, a level-1 heading — and pandoc
emits a plain <p> for every one of them.

Measured on nicholls-nieo-docx (phase2-pathways, 2026-09-18): the whole article converted with
ZERO <h1>-<h6>. Downstream, everything that reads structure from headings degraded at once —
the bibliography's heading-anchored extraction never ran (its "References" heading was a <p>,
so only the weak reverse paragraph scan was left), footnote-strategy selection saw no section
headers, and the book had no title node and no chapters for the .m4b build.

So before pandoc runs, rewrite the `w:name` of any paragraph style whose effective outline
level says "heading N" to the builtin name pandoc recognises. `w:styleId` is untouched, so
every `<w:pStyle>` reference in the document stays valid; only the human-readable style NAME
changes, to the one Word itself uses for that level.

CONSERVATIVE BY CONSTRUCTION: a style already named `heading N` is left alone, and a level
whose builtin name is ALREADY claimed by another style is skipped rather than duplicated — two
styles answering to "heading 1" is an ambiguity, and guessing which one the author meant would
be worse than the plain <p> we started with.

Usage:
    python normalize_docx_headings.py input.docx [output.docx]   # defaults to in place
"""

import os
import re
import shutil
import sys
import tempfile
import zipfile

STYLES_PART = 'word/styles.xml'

# One <w:style …>…</w:style> block. Non-greedy so blocks don't swallow each other.
_STYLE_BLOCK_RE = re.compile(r'<w:style\b[^>]*>.*?</w:style>', re.DOTALL)
_STYLE_ID_RE = re.compile(r'\bw:styleId="([^"]*)"')
_STYLE_TYPE_RE = re.compile(r'\bw:type="([^"]*)"')
_NAME_RE = re.compile(r'<w:name\s+w:val="([^"]*)"\s*/>')
_BASED_ON_RE = re.compile(r'<w:basedOn\s+w:val="([^"]*)"\s*/>')
_OUTLINE_LVL_RE = re.compile(r'<w:outlineLvl\s+w:val="(\d+)"\s*/>')
# Word's builtin heading names, as pandoc matches them (case-insensitively).
_BUILTIN_HEADING_RE = re.compile(r'^heading\s*([1-9])$', re.IGNORECASE)


def _parse_styles(styles_xml):
    """{styleId: {'block', 'type', 'name', 'based_on', 'outline'}} for every declared style."""
    styles = {}
    for match in _STYLE_BLOCK_RE.finditer(styles_xml):
        block = match.group(0)
        sid = _STYLE_ID_RE.search(block)
        if not sid:
            continue
        name = _NAME_RE.search(block)
        based = _BASED_ON_RE.search(block)
        outline = _OUTLINE_LVL_RE.search(block)
        stype = _STYLE_TYPE_RE.search(block)
        styles[sid.group(1)] = {
            'block': block,
            'type': stype.group(1) if stype else '',
            'name': name.group(1) if name else '',
            'based_on': based.group(1) if based else None,
            'outline': int(outline.group(1)) if outline else None,
        }
    return styles


def _effective_outline_level(styles, style_id, _depth=0):
    """The style's own w:outlineLvl, else the nearest one it inherits. Depth-capped: a
    self-referential or circular w:basedOn chain is malformed but must not hang a conversion."""
    style = styles.get(style_id)
    if style is None or _depth > 16:
        return None
    if style['outline'] is not None:
        return style['outline']
    if style['based_on']:
        return _effective_outline_level(styles, style['based_on'], _depth + 1)
    return None


def plan_heading_renames(styles_xml):
    """Decide which styles to rename, WITHOUT touching anything — the unit-testable half.
    Returns [(style_id, old_name, builtin_name), ...] in document order."""
    styles = _parse_styles(styles_xml)

    # Levels already spoken for, so we never mint a second "heading 1".
    claimed = set()
    for style in styles.values():
        builtin = _BUILTIN_HEADING_RE.match((style['name'] or '').strip())
        if builtin:
            claimed.add(int(builtin.group(1)))

    renames = []
    for style_id, style in styles.items():
        if style['type'] != 'paragraph':
            continue
        if _BUILTIN_HEADING_RE.match((style['name'] or '').strip()):
            continue                                   # already a heading pandoc will read
        level = _effective_outline_level(styles, style_id)
        if level is None or not 0 <= level <= 8:       # 9 is Word's "body text"
            continue
        target = level + 1
        if target in claimed:
            continue                                   # ambiguous — leave it alone
        claimed.add(target)
        renames.append((style_id, style['name'], f'heading {target}'))
    return renames


def rewrite_styles_xml(styles_xml, renames):
    """Apply `renames` to the style blocks. Only the <w:name> inside the matching block moves;
    w:styleId (what every <w:pStyle> in the document points at) is deliberately untouched."""
    styles = _parse_styles(styles_xml)
    for style_id, _old_name, builtin in renames:
        style = styles.get(style_id)
        if style is None:
            continue
        block = style['block']
        if _NAME_RE.search(block):
            new_block = _NAME_RE.sub(f'<w:name w:val="{builtin}"/>', block, count=1)
        else:
            # A style may omit w:name entirely (it then defaults to its id) — give it one.
            new_block = re.sub(r'(<w:style\b[^>]*>)', rf'\1<w:name w:val="{builtin}"/>',
                               block, count=1)
        styles_xml = styles_xml.replace(block, new_block, 1)
    return styles_xml


def normalize_headings(input_path, output_path=None):
    """Rewrite outline-level styles to pandoc-readable builtin heading names.

    Returns the list of renames applied (empty when there was nothing to do). Never raises for
    a document it cannot improve — a docx with no styles part, or one already using builtin
    heading styles, is simply left as it is.
    """
    if output_path is None:
        output_path = input_path

    if not os.path.isfile(input_path):
        print(f"Error: Input file not found: {input_path}")
        return []

    with zipfile.ZipFile(input_path) as zin:
        if STYLES_PART not in zin.namelist():
            print("No word/styles.xml — nothing to normalize")
            return []
        styles_xml = zin.read(STYLES_PART).decode('utf-8', errors='replace')

    renames = plan_heading_renames(styles_xml)
    if not renames:
        print("DOCX heading styles already pandoc-readable — no change")
        return []

    new_styles_xml = rewrite_styles_xml(styles_xml, renames)

    # Repack through a temp file so a failure mid-write can never leave a truncated docx where
    # the original was (the in-place call is the normal one).
    fd, temp_path = tempfile.mkstemp(suffix='.docx')
    os.close(fd)
    try:
        with zipfile.ZipFile(input_path) as zin, \
                zipfile.ZipFile(temp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == STYLES_PART:
                    data = new_styles_xml.encode('utf-8')
                zout.writestr(item, data)
        shutil.move(temp_path, output_path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    for style_id, old_name, builtin in renames:
        print(f"  Heading style '{old_name or style_id}' -> '{builtin}' (outline level declared "
              f"by the document)")
    print(f"Normalized {len(renames)} DOCX heading style(s) for pandoc")
    return renames


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    normalize_headings(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    sys.exit(0)


if __name__ == '__main__':
    main()

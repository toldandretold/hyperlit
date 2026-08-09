#!/usr/bin/env python3
"""
Really simple Markdown to HTML converter that treats footnotes as plain text.
No external dependencies - just basic regex-based conversion.
"""

import sys
import re
import html
import base64

def escape_html_no_double(text):
    """
    Escape HTML special characters without double-encoding existing entities.
    This prevents &amp; from becoming &amp;amp; when the input was already escaped
    (e.g., by HTMLPurifier in the PHP sanitization step).
    """
    # Match valid HTML entities: &amp; &lt; &gt; &quot; &#123; &#x1F600; etc.
    entity_pattern = r'&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);'

    placeholder = '\x00ENT_'
    entities = []

    def save_entity(m):
        entities.append(m.group(0))
        return placeholder + str(len(entities) - 1) + '\x00'

    # Temporarily protect existing entities
    protected = re.sub(entity_pattern, save_entity, text)

    # Escape HTML (only affects non-entity special chars)
    escaped = html.escape(protected)

    # Restore protected entities
    for i, entity in enumerate(entities):
        escaped = escaped.replace(placeholder + str(i) + '\x00', entity)

    return escaped

# The actual \left / \right delimiter COMMANDS — NOT \leftrightarrow / \leftarrow / \rightarrow /
# \Rightarrow etc., which merely start with those letters. A real \left/\right is followed by a
# delimiter (a non-letter), so a negative letter-lookahead separates the two.
_LEFT_CMD_RE = re.compile(r'\\left(?![a-zA-Z])')
_RIGHT_CMD_RE = re.compile(r'\\right(?![a-zA-Z])')


def repair_unbalanced_latex(latex):
    r"""Balance \left / \right so KaTeX renders instead of hard-erroring (it shows the raw LaTeX in
    red on ANY unmatched \left OR \right). Mistral produces both OCR faults:
      • a DROPPED \right — "p r (+ \left| m ^ {e} r ; T)" should end "… T\right)";
      • a STRAY \right with no \left — "pr(h \leftrightarrow e; mr(T)\right)" where the \right)
        should just be a literal ")".
    An unmatched \left is closed at its {} group end (a bare ) ] | } there → "\right<delim>"; else
    an invisible "\right."). An unmatched \right has its "\right" stripped, leaving the delimiter.

    Only \left/\right COMMANDS count — "\leftrightarrow" is text, not a delimiter (an earlier version
    miscounted it and injected spurious \right., breaking correct arrow equations). GATED on the
    command counts differing, so a balanced equation is byte-identical and can never be harmed.
    """
    if len(_LEFT_CMD_RE.findall(latex)) == len(_RIGHT_CMD_RE.findall(latex)):
        return latex

    out = []            # output tokens
    stack = []          # 'group' for {  ,  'left' for a real \left command

    def _close_left():
        j = len(out) - 1
        while j >= 0 and out[j].isspace():
            j -= 1
        if j >= 0 and out[j] in (')', ']', '|', '}'):
            out[j] = '\\right' + out[j]     # the dropped-\right sat right here
        else:
            out.append('\\right.')

    i, n = 0, len(latex)
    while i < n:
        if _LEFT_CMD_RE.match(latex, i):
            out.append('\\left'); stack.append('left'); i += 5
        elif _RIGHT_CMD_RE.match(latex, i):
            if any(s == 'left' for s in stack):
                out.append('\\right')
                for k in range(len(stack) - 1, -1, -1):
                    if stack[k] == 'left':
                        del stack[k]; break
            # else: STRAY \right — drop the command, the following delimiter stays as a literal
            i += 6
        elif latex[i] == '{':
            out.append('{'); stack.append('group'); i += 1
        elif latex[i] == '}':
            while stack and stack[-1] == 'left':   # unmatched \left inside this group
                _close_left(); stack.pop()
            if stack and stack[-1] == 'group':
                stack.pop()
            out.append('}'); i += 1
        else:
            out.append(latex[i]); i += 1

    while stack:                                   # unmatched \left at end of string
        if stack[-1] == 'left':
            _close_left()
        stack.pop()

    return ''.join(out)


def encode_math(latex_content):
    """Base64-encode LaTeX for safe embedding in data-math attribute.
    Avoids double-encoding issues when bleach/BeautifulSoup re-encodes HTML entities."""
    latex_content = repair_unbalanced_latex(latex_content)
    return base64.b64encode(latex_content.encode('utf-8')).decode('ascii')

def process_inline_formatting(text):
    """Process inline markdown formatting"""
    # Extract inline math ($...$) BEFORE any other processing to protect LaTeX from
    # being mangled by bold/italic/underscore rules.
    # The no-space rule ((?! ) and (?<! )) prevents "$5 to $10" from matching.
    # [^$] instead of . prevents matching across currency dollar signs (e.g. "$68 billion...$97 billion").
    math_placeholders = {}
    math_counter = [0]

    # Protect DISPLAY math ($$…$$) FIRST — the inline-$ rule below deliberately skips it (its (?!\$)
    # guards), so an UNprotected $$…$$ falls through to the italic/underscore pass, which mangles the
    # LaTeX subscripts ("A_1^o" → "A<em>1^o"). Display equations routinely sit INLINE mid-paragraph in
    # maths papers, not only alone on a line (the line-level $$ handler already covers that case).
    def replace_display_math(m):
        latex = html.unescape(m.group(1)).strip()
        key = f'\x00MATH{math_counter[0]}\x00'
        math_placeholders[key] = f'<latex-block data-math="{encode_math(latex)}"></latex-block>'
        math_counter[0] += 1
        return key

    text = re.sub(r'\$\$(.+?)\$\$', replace_display_math, text, flags=re.DOTALL)

    def replace_inline_math(m):
        latex = html.unescape(m.group(1))
        key = f'\x00MATH{math_counter[0]}\x00'
        math_placeholders[key] = f'<latex data-math="{encode_math(latex)}"></latex>'
        math_counter[0] += 1
        return key

    text = re.sub(
        r'(?<!\$)(?<!\\)\$(?!\$)(?! )(\S[^$]*\S|\S)(?<! )(?<!\\)\$(?!\$)(?!\d)',
        replace_inline_math,
        text
    )

    # Preserve <br>, <br/>, <br /> tags by replacing with placeholder
    br_placeholder = '\x00BR_TAG\x00'
    text = re.sub(r'<br\s*/?>', br_placeholder, text, flags=re.IGNORECASE)

    # Preserve <a class="wackSTEM*"> and <a class="pageNumber"> tags by replacing with placeholders
    stem_placeholder_map = {}
    stem_ctr = [0]
    def save_stem(m):
        key = f'\x00STEM{stem_ctr[0]}\x00'
        stem_placeholder_map[key] = m.group(0)
        stem_ctr[0] += 1
        return key
    text = re.sub(r'<a\s+class="wackSTEM[^"]*"[^>]*>.*?</a>', save_stem, text)
    text = re.sub(r'<a\s+class="pageNumber"[^>]*></a>', save_stem, text)
    text = re.sub(r'<a\s+id="[^"]*"\s+href="[^"]*">[^<]*</a>', save_stem, text)
    text = re.sub(r'<a\s+href="[^"]*"[^>]*>[^<]*</a>', save_stem, text)

    # Escape HTML without double-encoding existing entities
    text = escape_html_no_double(text)

    # Restore <br /> tags
    text = text.replace(escape_html_no_double(br_placeholder), '<br />')
    text = text.replace(br_placeholder, '<br />')

    # Process inline code first (to avoid processing formatting inside code)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)

    # Process bold (**text** or __text__)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'__([^_]+)__', r'<strong>\1</strong>', text)

    # Process italics (*text* or _text_)
    text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
    text = re.sub(r'_([^_]+)_', r'<em>\1</em>', text)

    # Process images ![alt](url) - must be before links
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img src="\2" alt="\1" />', text)

    # Process links [text](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)

    # Process strikethrough ~~text~~
    text = re.sub(r'~~([^~]+)~~', r'<del>\1</del>', text)

    # Restore math placeholders (check both raw and HTML-escaped versions of the key)
    for key, replacement in math_placeholders.items():
        text = text.replace(key, replacement)
        text = text.replace(html.escape(key), replacement)

    # Restore wackSTEM placeholders
    for key, val in stem_placeholder_map.items():
        text = text.replace(key, val)
        text = text.replace(html.escape(key), val)

    # Convert escaped dollar signs to literal dollars
    text = text.replace(r'\$', '$')

    return text

def is_table_start(line):
    """Check if a line starts a markdown table (starts and ends with |)"""
    stripped = line.strip()
    return stripped.startswith('|') and stripped.endswith('|') and len(stripped) > 2

def is_separator_row(line):
    """Check if a line is a table separator row (|---|---|)"""
    stripped = line.strip()
    if not stripped.startswith('|') or not stripped.endswith('|'):
        return False
    # Check if it only contains |, -, :, and whitespace
    inner = stripped[1:-1]
    return bool(re.match(r'^[\s|:\-]+$', inner))

def convert_table_block(lines, start_index):
    """
    Convert a markdown table to HTML.
    Returns (html_string, end_index) where end_index is the first line after the table.
    """
    table_lines = []
    i = start_index

    # Collect all contiguous table lines
    while i < len(lines) and is_table_start(lines[i]):
        table_lines.append(lines[i].strip())
        i += 1

    # Need at least 2 rows (header + separator, or header + data)
    if len(table_lines) < 2:
        return None, start_index

    # Parse header row
    header_cells = [cell.strip() for cell in table_lines[0].split('|')[1:-1]]

    # Check if second row is separator
    has_separator = is_separator_row(table_lines[1]) if len(table_lines) > 1 else False

    # Parse body rows (skip separator if present)
    body_start = 2 if has_separator else 1
    body_rows = []
    for row_line in table_lines[body_start:]:
        cells = [cell.strip() for cell in row_line.split('|')[1:-1]]
        body_rows.append(cells)

    # Build HTML table
    html_parts = ['<table>', '<thead>', '<tr>']
    for cell in header_cells:
        formatted_cell = process_inline_formatting(cell)
        html_parts.append(f'<th>{formatted_cell}</th>')
    html_parts.extend(['</tr>', '</thead>', '<tbody>'])

    for row in body_rows:
        html_parts.append('<tr>')
        for cell in row:
            formatted_cell = process_inline_formatting(cell)
            html_parts.append(f'<td>{formatted_cell}</td>')
        html_parts.append('</tr>')

    html_parts.extend(['</tbody>', '</table>'])

    return '\n'.join(html_parts), i

def convert_markdown_to_html(markdown_content):
    """Convert basic markdown to HTML, treating footnotes as plain text"""

    lines = markdown_content.split('\n')
    html_lines = []
    in_code_block = False
    code_block_lang = ''

    # Track footnote section restarts for sequential strategy
    ref_section_counter = 0
    def_section_counter = 0
    last_ref_number = None   # Track the last ref number seen
    last_def_number = None   # Track the last def number seen
    in_refs_section = False  # inside a References/Bibliography section (suppresses list conversion)

    in_math_block = False
    math_block_lines = []

    i = 0
    while i < len(lines):
        line = lines[i]

        # Handle fenced code blocks
        if line.strip().startswith('```'):
            if in_code_block:
                html_lines.append('</code></pre>')
                in_code_block = False
                code_block_lang = ''
            else:
                # Extract language if specified
                lang_match = re.search(r'```(\w+)', line.strip())
                code_block_lang = lang_match.group(1) if lang_match else ''
                html_lines.append(f'<pre><code class="language-{code_block_lang}">' if code_block_lang else '<pre><code>')
                in_code_block = True
            i += 1
            continue

        # Inside code block - just escape and continue
        if in_code_block:
            html_lines.append(html.escape(line))
            i += 1
            continue

        stripped = line.strip()

        # Handle block math ($$...$$)
        if in_math_block:
            if stripped == '$$':
                # Close multi-line math block
                latex_content = html.unescape('\n'.join(math_block_lines))
                html_lines.append(f'<p><latex-block data-math="{encode_math(latex_content)}"></latex-block></p>')
                in_math_block = False
                math_block_lines = []
            else:
                math_block_lines.append(line)
            i += 1
            continue

        # Single-line block math: $$...$$
        block_math_match = re.match(r'^\$\$(.+)\$\$$', stripped)
        if block_math_match:
            latex_content = html.unescape(block_math_match.group(1))
            html_lines.append(f'<p><latex-block data-math="{encode_math(latex_content)}"></latex-block></p>')
            i += 1
            continue

        # Multi-line block math opening: lone $$
        if stripped == '$$':
            in_math_block = True
            math_block_lines = []
            i += 1
            continue

        # Empty lines
        if not stripped:
            html_lines.append('')
            i += 1
            continue

        # Headers (# ## ### etc.)
        header_match = re.match(r'^(#{1,6})\s+(.+)$', stripped)
        if header_match:
            level = len(header_match.group(1))
            header_text = header_match.group(2)
            # Reference sections keep their "- Author (year)…" lines as PARAGRAPHS: the
            # bibliography extractor reads <p> entries, and converting them to <li> collapsed
            # extraction (128ad69a: 31 refs -> 0). Any other heading exits the section.
            in_refs_section = bool(re.match(r'(?i)(references|bibliography|works cited)\b', header_text))
            # Create simple ID from header text
            header_id = re.sub(r'[^a-zA-Z0-9\s-]', '', header_text.lower()).replace(' ', '-')
            # Process inline formatting in headers too
            formatted_header = process_inline_formatting(header_text)
            html_lines.append(f'<h{level} id="{header_id}">{formatted_header}</h{level}>')
            i += 1
            continue

        # Horizontal rules
        if stripped in ['---', '***', '___']:
            html_lines.append('<hr />')
            i += 1
            continue

        # Blockquotes (collect consecutive > lines into a single blockquote)
        if stripped.startswith('>'):
            bq_lines = []
            while i < len(lines):
                s = lines[i].strip()
                if s == '>':
                    bq_lines.append('')  # blank separator within blockquote
                    i += 1
                elif s.startswith('> '):
                    bq_lines.append(s[2:])
                    i += 1
                elif s.startswith('>'):
                    # '>text' with no space after the marker (CommonMark allows this).
                    # This branch MUST consume the line: previously such a line matched
                    # neither '> ' nor '>', so the loop broke with bq_lines empty and the
                    # outer `continue` re-ran the same line without advancing `i` — an
                    # infinite loop that appended empty <blockquote>s until the process
                    # exhausted memory (~1.6GB). Triggered by e.g. Cyber-Marx's ">. . ."
                    # quotation, which OOM-killed PHP-FPM and took the whole site down.
                    bq_lines.append(s[1:])
                    i += 1
                else:
                    break
            # Render as single blockquote with paragraphs split on blank lines
            paragraphs = []
            current = []
            for bl in bq_lines:
                if bl.strip() == '':
                    if current:
                        paragraphs.append(' '.join(current))
                        current = []
                else:
                    current.append(bl)
            if current:
                paragraphs.append(' '.join(current))
            inner = ''.join(f'<p>{process_inline_formatting(p)}</p>' for p in paragraphs)
            html_lines.append(f'<blockquote>{inner}</blockquote>')
            continue

        # Unordered lists: consecutive "- item" / "* item" / "+ item" lines become one <ul>.
        # A single blank line inside the run is tolerated when another item follows (loose list).
        # UNORDERED ONLY — a numbered "N. text" line is a footnote-definition candidate elsewhere
        # in the pipeline, so converting <ol> here would fight the footnote engine. Without this
        # branch every bullet list in every OCR'd PDF rendered as literal "<p>- text</p>".
        # Suppressed inside References/Bibliography sections (see in_refs_section at the header
        # branch) so dash-prefixed bibliography entries stay <p> for the reference extractor.
        # Needs >=2 items: a lone dash line is usually a stray (an author byline "- Nick
        # Dyer-Witheford" became a one-item <ul>), so it stays a paragraph.
        def _next_nonblank_is_item(idx):
            j = idx + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            return j < len(lines) and re.match(r'^[-*+]\s+\S', lines[j].strip())

        if (not in_refs_section and re.match(r'^[-*+]\s+\S', stripped)
                and _next_nonblank_is_item(i)):
            list_items = []
            while i < len(lines):
                s = lines[i].strip()
                m = re.match(r'^[-*+]\s+(\S.*)$', s)
                if m:
                    list_items.append(m.group(1))
                    i += 1
                elif not s:
                    # blank line: continue the list only if the next non-blank line is an item
                    j = i + 1
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and re.match(r'^[-*+]\s+\S', lines[j].strip()):
                        i = j
                    else:
                        break
                else:
                    break
            inner = ''.join(f'<li>{process_inline_formatting(it)}</li>' for it in list_items)
            html_lines.append(f'<ul>{inner}</ul>')
            continue

        # Images (standalone line)
        image_match = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', stripped)
        if image_match:
            alt_text = html.escape(image_match.group(1))
            img_url = image_match.group(2)
            html_lines.append(f'<img src="{img_url}" alt="{alt_text}" />')
            i += 1
            continue

        # Tables (GFM-style: | Header | Header |)
        if is_table_start(line):
            table_html, new_index = convert_table_block(lines, i)
            if table_html:
                html_lines.append(table_html)
                i = new_index
                continue

        # Detect footnote section boundaries for sequential strategy
        # Check for footnote definition: line starts with [^N]: pattern
        def_match = re.match(r'^\s*\[\^(\d+)\]\s*[: ]', stripped)
        if def_match:
            def_number = int(def_match.group(1))
            # A restart (back to 1, or a number <= last) means new definition section
            if last_def_number is not None and def_number <= last_def_number:
                def_section_counter += 1
                html_lines.append(f'<a class="footnoteDefinitionsStart" id="fnDefSection_{def_section_counter}"></a>')
            elif last_def_number is None:
                # First definition ever seen
                def_section_counter += 1
                html_lines.append(f'<a class="footnoteDefinitionsStart" id="fnDefSection_{def_section_counter}"></a>')
            last_def_number = def_number
        else:
            # Check for footnote reference: [^N] NOT followed by : (i.e. inline ref)
            ref_matches = re.findall(r'\[\^(\d+)\]', stripped)
            if ref_matches:
                # Use the first ref number on this line to detect restarts
                ref_number = int(ref_matches[0])
                if last_ref_number is not None and ref_number <= last_ref_number:
                    ref_section_counter += 1
                    html_lines.append(f'<a class="footnoteSectionStart" id="fnRefSection_{ref_section_counter}"></a>')
                elif last_ref_number is None:
                    # First reference ever seen
                    ref_section_counter += 1
                    html_lines.append(f'<a class="footnoteSectionStart" id="fnRefSection_{ref_section_counter}"></a>')
                last_ref_number = ref_number

        # Raw HTML blocks (SVG charts, tables with attributes, etc.) — pass through without escaping
        if stripped.startswith('<svg') or stripped.startswith('<div') or stripped.startswith('<table '):
            # Collect multi-line raw HTML block until closing tag
            tag_name = stripped.split()[0].split('>')[0].lstrip('<')
            close_tag = f'</{tag_name}>'
            block_lines = [stripped]
            if close_tag not in stripped:
                i += 1
                while i < len(lines):
                    block_lines.append(lines[i])
                    if close_tag in lines[i]:
                        break
                    i += 1
            html_lines.append('\n'.join(block_lines))
            i += 1
            continue

        # Everything else as paragraph (including footnote patterns)
        # Process inline formatting
        formatted_line = process_inline_formatting(line)
        html_lines.append(f'<p>{formatted_line}</p>')
        i += 1
    
    # Join all lines
    html_body = '\n'.join(html_lines)
    
    # Wrap in full HTML document
    html_doc = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Converted Document</title>
</head>
<body>
{html_body}
</body>
</html>"""
    
    return html_doc


# Plain-English note for the decision-tree visual + LLM report (single source; see gen_pipeline_notes.py).
convert_markdown_to_html.plain = (
    "Markdown ingestion (also the back half of the PDF path, which produces .md): convert the markdown to "
    "HTML — paragraphs, headings, lists, tables, inline formatting, and base64-encoded math. Footnotes are "
    "deliberately NOT linked here: each [^N] marker is left as plain text, but boundary anchors "
    "(footnoteDefinitionsStart / footnoteSectionStart) are injected to mark where the reference and "
    "definition sections begin. Digestion's sequential strategy reads those breadcrumbs to pair markers "
    "with definitions. So ingestion preps the structure; ALL footnote/citation linking happens in digestion. "
    "Classic failure: a footnote section boundary the markers miss → the sequential strategy mis-groups notes.")


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 simple_md_to_html.py input.md output.html")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            markdown_content = f.read()
        
        print(f"Converting {input_file} to HTML...")
        html_content = convert_markdown_to_html(markdown_content)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        print(f"Successfully converted {input_file} to {output_file}")
        
    except Exception as e:
        print(f"Error converting markdown: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
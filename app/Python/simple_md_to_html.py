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

def encode_math(latex_content):
    """Base64-encode LaTeX for safe embedding in data-math attribute.
    Avoids double-encoding issues when bleach/BeautifulSoup re-encodes HTML entities."""
    return base64.b64encode(latex_content.encode('utf-8')).decode('ascii')

def process_inline_formatting(text):
    """Process inline markdown formatting"""
    # Extract inline math ($...$) BEFORE any other processing to protect LaTeX from
    # being mangled by bold/italic/underscore rules.
    # The no-space rule ((?! ) and (?<! )) prevents "$5 to $10" from matching.
    # [^$] instead of . prevents matching across currency dollar signs (e.g. "$68 billion...$97 billion").
    math_placeholders = {}
    math_counter = [0]

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

        # Blockquotes
        if stripped.startswith('> '):
            quote_text = stripped[2:]
            formatted_quote = process_inline_formatting(quote_text)
            html_lines.append(f'<blockquote><p>{formatted_quote}</p></blockquote>')
            i += 1
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
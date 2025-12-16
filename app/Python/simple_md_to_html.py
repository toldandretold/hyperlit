#!/usr/bin/env python3
"""
Really simple Markdown to HTML converter that treats footnotes as plain text.
No external dependencies - just basic regex-based conversion.
"""

import sys
import re
import html

def process_inline_formatting(text):
    """Process inline markdown formatting"""
    # Escape HTML first
    text = html.escape(text)
    
    # Process inline code first (to avoid processing formatting inside code)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    
    # Process bold (**text** or __text__)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'__([^_]+)__', r'<strong>\1</strong>', text)
    
    # Process italics (*text* or _text_)
    text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
    text = re.sub(r'_([^_]+)_', r'<em>\1</em>', text)
    
    # Process links [text](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    
    # Process strikethrough ~~text~~
    text = re.sub(r'~~([^~]+)~~', r'<del>\1</del>', text)
    
    return text

def convert_markdown_to_html(markdown_content):
    """Convert basic markdown to HTML, treating footnotes as plain text"""
    
    lines = markdown_content.split('\n')
    html_lines = []
    in_code_block = False
    code_block_lang = ''
    
    for line in lines:
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
            continue
            
        # Inside code block - just escape and continue
        if in_code_block:
            html_lines.append(html.escape(line))
            continue
        
        stripped = line.strip()
        
        # Empty lines
        if not stripped:
            html_lines.append('')
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
            continue
        
        # Horizontal rules
        if stripped in ['---', '***', '___']:
            html_lines.append('<hr />')
            continue
            
        # Blockquotes
        if stripped.startswith('> '):
            quote_text = stripped[2:]
            formatted_quote = process_inline_formatting(quote_text)
            html_lines.append(f'<blockquote><p>{formatted_quote}</p></blockquote>')
            continue
        
        # Everything else as paragraph (including footnote patterns)
        # Process inline formatting
        formatted_line = process_inline_formatting(line)
        html_lines.append(f'<p>{formatted_line}</p>')
    
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
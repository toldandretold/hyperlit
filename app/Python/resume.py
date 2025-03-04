import markdown2
import pdfkit

def convert_markdown_to_pdf(markdown_path, output_path, options):
    # Read the Markdown content
    with open(markdown_path, 'r') as f:
        markdown_content = f.read()
    
    # Convert Markdown to HTML
    html_content = markdown2.markdown(markdown_content, extras=['fenced-code-blocks'])
    
    # Add custom styling
    styled_html = f"""
    <html>
        <head>
            <meta charset="utf-8">
            <style>
                body {{ 
                    font-family: {options['font']};
                    line-height: {options['line_height']};
                    margin: {options['margin']};
                }}
                h1, h2, h3 {{ color: {options['heading_color']}; }}
            </style>
        </head>
        <body>
            {html_content}
        </body>
    </html>
    """
    
    # Convert HTML to PDF
    pdfkit.from_string(styled_html, output_path, options=options)

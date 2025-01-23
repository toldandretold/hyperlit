from bs4 import BeautifulSoup
import html2text

def html_to_markdown_preserve_anchors(file_path, output_path):
    # Read the HTML file
    with open(file_path, 'r') as file:
        html_content = file.read()

    # Parse the HTML
    soup = BeautifulSoup(html_content, 'html.parser')

    # Replace all anchor tags with their HTML equivalent in the soup
    for a_tag in soup.find_all('a', href=True):
        a_html = str(a_tag)  # Preserve the anchor tag as HTML
        a_tag.replace_with(a_html)

    # Convert the remaining HTML to Markdown
    markdown_converter = html2text.HTML2Text()
    markdown_converter.ignore_links = True  # Ignore default link conversion
    markdown_converter.body_width = 0  # Prevent line wrapping for cleaner output
    markdown_content = markdown_converter.handle(str(soup))

    # Write the Markdown to the output file
    with open(output_path, 'w') as file:
        file.write(markdown_content)

# Specify the input HTML file and output Markdown file
file_path = "capital.html"  # Replace with your input file name
output_path = "capital.md"  # Replace with your desired output file name
html_to_markdown_preserve_anchors(file_path, output_path)

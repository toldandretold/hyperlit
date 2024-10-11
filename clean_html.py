from bs4 import BeautifulSoup
import re

# Load the HTML file
with open("nicholls2024non.html", "r", encoding="utf-8") as file:
    soup = BeautifulSoup(file, "html.parser")

# Remove specific sections or elements based on class or ID
unwanted_sections = ['authors', 'affiliations', 'article-notes', 'core-license', 'logo']
for section in unwanted_sections:
    for tag in soup.find_all(class_=section):
        tag.decompose()  # This removes the entire section

# Keep <a> tags with href attribute
for link in soup.find_all('a'):
    href = link.get('href')  # Get the href attribute
    link.attrs = {'href': href}  # Keep only the href attribute

# Convert <h1> and <h2> tags into Markdown-style headings
for h1 in soup.find_all('h1'):
    h1.insert_before('# ')  # Add Markdown heading syntax before the content
    h1.unwrap()  # Remove the <h1> tag but keep its content
for h2 in soup.find_all('h2'):
    h2.insert_before('## ')  # Add Markdown heading syntax before the content
    h2.unwrap()  # Remove the <h2> tag but keep its content

# Strip other unwanted attributes but keep divs and their content
for tag in soup.find_all(True):
    if tag.name != 'a':  # We already handled <a> tags
        if tag.name not in ['div']:  # Keep div tags as they are
            tag.attrs = {}  # Remove other attributes but keep the content

# Get cleaned text
cleaned_text = str(soup)

# 1. Remove premature line breaks within paragraphs (but not between paragraphs)
# Preserve line breaks between paragraphs (double newlines), but join single newlines within paragraphs
cleaned_text = re.sub(r'(?<!\n)\n(?!\n)', ' ', cleaned_text)

# 2. Ensure a single line break between paragraphs
# Remove excessive blank lines between paragraphs (reduce multiple line breaks to one)
cleaned_text = re.sub(r'\n\s*\n+', '\n\n', cleaned_text)

# Write the cleaned output to a Markdown file
with open("cleaned_output.md", "w", encoding="utf-8") as output_file:
    output_file.write(cleaned_text)

print("Cleaning completed.")
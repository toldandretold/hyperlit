import os
from bs4 import BeautifulSoup
import shutil

# Define potential folder paths for the original and parsed files
text_folders = ['epub_original/text', 'epub_original/OEBPS']

# Define keywords to look for in class names
heading_keywords = ['title', 'heading', 'chapter', 'header', 'h1', 'h2']

# Function to check if standard headings (h1, h2, h3) exist near the start
def has_standard_headings(soup):
    headings = soup.find_all(['h1', 'h2', 'h3'])
    return len(headings) > 0

# Function to replace class-based elements with appropriate heading tags
def replace_classes_with_headings(soup):
    heading_order = ['h1', 'h2', 'h3']  # Track which headings to apply
    used_classes = {}  # Store classes that have already been converted
    current_heading_level = 0  # Start with h1, move to h2, h3, etc.

    for tag in soup.find_all(True):  # Iterate over all tags
        tag_classes = tag.get('class', None)  # Get the class attribute

        if tag_classes:
            # Check if any of the class values contain keywords like 'title', 'heading', etc.
            for class_name in tag_classes:
                if any(keyword in class_name.lower() for keyword in heading_keywords):
                    if class_name in used_classes:
                        # If this class has been used before, use the same heading level
                        tag.name = used_classes[class_name]
                    else:
                        # If this class hasn't been used before, assign the next heading level
                        tag.name = heading_order[current_heading_level]
                        used_classes[class_name] = heading_order[current_heading_level]

                        # Move to the next heading level for subsequent headings
                        if current_heading_level < len(heading_order) - 1:
                            current_heading_level += 1

                    # Remove class attribute after conversion
                    del tag['class']
                    break  # Exit the loop after the first match

    return soup

# Function to parse each file, wrap content, and convert headings if needed
def parse_html_file(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

        # Find the <body> tag and extract its contents
        body = soup.find('body')
        if body:
            body_content = list(body.children)
            content_wrapper = soup.new_tag('div', attrs={'class': 'delete'})
            for element in body_content:
                content_wrapper.append(element)
            first_div = content_wrapper.find('div', recursive=False)
            if first_div:
                first_div.unwrap()  # This removes the outer <div> but keeps the contents
            final_content = content_wrapper
        else:
            final_content = soup  # If no <body>, treat entire content as soup object

        # Step 1: Check for standard headings near the start of the document
        if not has_standard_headings(soup):
            # Step 2: If no standard headings, check and convert class-based headings
            final_content = replace_classes_with_headings(final_content)

        # Append a <br class="end-page"/> tag manually
        final_content.append(soup.new_tag('br', attrs={'class': 'end-page'}))

        # Create the old folder and move the original file there
        old_folder = os.path.join(os.path.dirname(file_path), 'old')
        os.makedirs(old_folder, exist_ok=True)

        # Move the original file to the 'old' folder
        old_file_path = os.path.join(old_folder, os.path.basename(file_path))
        shutil.move(file_path, old_file_path)

        # Save the cleaned file back in the original location
        with open(file_path, 'w', encoding='utf-8') as new_file:
            new_file.write(str(final_content))

# Find the correct folder (text or OEBPS) and parse through the files
for folder in text_folders:
    if os.path.exists(folder):
        print(f"Parsing files from: {folder}")
        for file_name in os.listdir(folder):
            if file_name.endswith(('.html', '.xhtml', '.xml')):  # Process only content-related file types
                file_path = os.path.join(folder, file_name)
                parse_html_file(file_path)
        break  # Exit after processing the first found folder

# Provide confirmation that the files were processed
print("Files processed and saved in their original locations.")

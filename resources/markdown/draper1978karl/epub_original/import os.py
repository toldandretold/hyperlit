import os
import re

# Temporary record of old-to-new file names
file_name_mapping = {}

# Function to remove <head> and <html> tags, keeping only content inside <body>
def strip_html_tags(file_content):
    body_content = re.search(r'<body.*?>(.*)</body>', file_content, re.DOTALL)
    if body_content:
        return body_content.group(1).strip()  # Return content within <body> tags
    return file_content  # If no <body> tags, return the full content (unusual case)

# Function to classify files based on filename or content patterns
def classify_file(file_name, file_content):
    # Pre-content patterns
    if re.search(r'publisher|series', file_content, re.IGNORECASE):
        return "1.html"  # Publisher information

    if re.search(r'<h1>|<h2>|title', file_content, re.IGNORECASE):
        return "A01_TitlePage.html"  # Title page

    if re.search(r'copyright|isbn|published by', file_content, re.IGNORECASE):
        return "A02_Copyright.html"  # Copyright page

    if re.search(r'dedicated to|acknowledgments', file_content, re.IGNORECASE) or file_content.strip().count(' ') < 50:
        return "A03_Dedication.html"  # Dedication

    if re.search(r'table of contents|toc', file_content, re.IGNORECASE) or re.search(r'<a href=".+">', file_content):
        return "A04_TOC.html"  # Table of Contents

    # Main content patterns (chapters)
    if re.search(r'\bchapter\b|\d+', file_name.lower()):
        chapter_number = re.findall(r'\d+', file_name)
        if chapter_number:
            return f"B0{chapter_number[0]}_Chapter{chapter_number[0]}.html"  # Chapter file

    # Post-content patterns (deepnotes, index)
    if re.search(r'endnotes|references|bibliography', file_content, re.IGNORECASE):
        return "C01_Deepnotes1.html"  # Deepnotes/footnotes page

    if re.search(r'index', file_content, re.IGNORECASE):
        return "C02_Index.html"  # Index page

    # Default fallback for random files
    return None  # Unidentified, needs further checks

# Function to rename and organize files based on classification
def rename_and_classify_files(input_directory):
    pre_content, main_content, post_content = [], [], []
    random_counter = 1

    files = [f for f in os.listdir(input_directory) if f.endswith('.html')]

    for file_name in sorted(files):
        file_path = os.path.join(input_directory, file_name)

        # Read and strip the <head> tags and anything before <body>
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        body_content = strip_html_tags(content)  # Strip <html> and <head> tags

        # Classify the file
        new_name = classify_file(file_name, body_content)
        
        # If the file is not identified, mark it as Random
        if not new_name:
            new_name = f"C03_Random{random_counter}.html"
            random_counter += 1

        file_name_mapping[file_name] = new_name
        os.rename(file_path, os.path.join(input_directory, new_name))
        print(f"Renamed {file_name} to {new_name}")

# Function to update href links based on new file names
def update_internal_links(input_directory):
    files = [f for f in os.listdir(input_directory) if f.endswith('.html')]

    for file_name in files:
        file_path = os.path.join(input_directory, file_name)
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Update href links
        for old_name, new_name in file_name_mapping.items():
            content = re.sub(f'href="{old_name}#', f'href="{new_name}#', content)
            content = re.sub(f'href="{old_name}"', f'href="{new_name}"', content)

        # Write the updated content back to the file
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated links in {file_name}")

# Main function
def process_book(input_directory):
    print("Step 1: Stripping HTML tags and classifying files...")
    rename_and_classify_files(input_directory)
    print("\nStep 2: Updating internal links...")
    update_internal_links(input_directory)
    print("\nProcess completed.")

# Run the script
if __name__ == "__main__":
    input_directory = "epub_original/text"  # Update this path to match your folder
    process_book(input_directory)

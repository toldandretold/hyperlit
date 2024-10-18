import os
import re
import shutil

# Temporary record of old-to-new file names to prevent duplicates
file_name_mapping = {}

# Ensure the output directory exists
def ensure_output_directory(output_directory):
    if not os.path.exists(output_directory):
        os.makedirs(output_directory)

# Function to remove <head> and <html> tags, keeping only content inside <body>
def strip_html_tags(file_content):
    body_content = re.search(r'<body.*?>(.*)</body>', file_content, re.DOTALL)
    if body_content:
        return body_content.group(1).strip()  # Return content within <body> tags
    return file_content  # If no <body> tags, return the full content (unusual case)

# Function to classify files based on filename or content patterns
def classify_file(file_name, file_content):
    # Pre-content patterns
    if re.search(r'publisher|series', file_content, re.IGNORECASE) and "1.html" not in file_name_mapping.values():
        return "1.html"  # Publisher information

    if re.search(r'<h1>|<h2>|title', file_content, re.IGNORECASE) and "A01_TitlePage.html" not in file_name_mapping.values():
        return "A01_TitlePage.html"  # Title page

    if re.search(r'copyright|isbn|published by', file_content, re.IGNORECASE) and "A02_Copyright.html" not in file_name_mapping.values():
        return "A02_Copyright.html"  # Copyright page

    if re.search(r'dedicated to|acknowledgments', file_content, re.IGNORECASE) or file_content.strip().count(' ') < 50 and "A03_Dedication.html" not in file_name_mapping.values():
        return "A03_Dedication.html"  # Dedication

    if re.search(r'table of contents|toc', file_content, re.IGNORECASE) or re.search(r'<a href=".+">', file_content) and "A04_TOC.html" not in file_name_mapping.values():
        return "A04_TOC.html"  # Table of Contents

    # Main content patterns (chapters)
    if re.search(r'\bchapter\b|\d+', file_name.lower()):
        chapter_number = re.findall(r'\d+', file_name)
        if chapter_number:
            new_name = f"B0{chapter_number[0]}_Chapter{chapter_number[0]}.html"
            if new_name not in file_name_mapping.values():
                return new_name  # Chapter file

    # Post-content patterns (deepnotes, index)
    if re.search(r'endnotes|references|bibliography', file_content, re.IGNORECASE) and "C01_Deepnotes1.html" not in file_name_mapping.values():
        return "C01_Deepnotes1.html"  # Deepnotes/footnotes page

    if re.search(r'index', file_content, re.IGNORECASE) and "C02_Index.html" not in file_name_mapping.values():
        return "C02_Index.html"  # Index page

    # Default fallback for random files
    return None  # Unidentified, needs further checks

# Function to rename and classify files based on content
def rename_and_classify_files(input_directory, output_directory):
    pre_content, main_content, post_content = [], [], []
    random_counter = 1

    # Get files and sort them in strict numerical order (1, 2, 3... then a1, a2...)
    files = sorted([f for f in os.listdir(input_directory) if f.endswith('.html')],
                   key=lambda x: (int(re.search(r'\d+', x).group()) if re.search(r'\d+', x) else float('inf'), x))

    for file_name in files:
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

        # Save to the output directory and record mapping
        new_file_path = os.path.join(output_directory, new_name)
        file_name_mapping[file_name] = new_name

        with open(new_file_path, 'w', encoding='utf-8') as f:
            f.write(body_content)
        print(f"Processed {file_name} and saved as {new_name}")

# Function to update href links based on new file names
def update_internal_links(output_directory):
    files = [f for f in os.listdir(output_directory) if f.endswith('.html')]

    for file_name in files:
        file_path = os.path.join(output_directory, file_name)
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
def process_book(input_directory, output_directory):
    print("Step 1: Ensuring output directory exists...")
    ensure_output_directory(output_directory)
    
    print("Step 2: Stripping HTML tags and classifying files...")
    rename_and_classify_files(input_directory, output_directory)
    
    print("\nStep 3: Updating internal links...")
    update_internal_links(output_directory)
    
    print("\nProcess completed.")

# Run the script
if __name__ == "__main__":
    input_directory = "epub_original/text"  # Folder containing original files
    output_directory = "epub_original/parsed_text"  # Folder for parsed/renamed files

    process_book(input_directory, output_directory)

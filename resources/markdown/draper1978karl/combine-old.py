import os
from bs4 import BeautifulSoup

# Define the root folder where the search will begin
root_folder = 'epub_original'
parsed_folder = 'epub_original/parsed_html'
output_file = 'epub_original/main-text.html'

# Function to search for the TOC.ncx file recursively
def find_toc_file(root_folder):
    for dirpath, _, filenames in os.walk(root_folder):
        for filename in filenames:
            if filename.lower() == 'toc.ncx':  # Case-insensitive search
                return os.path.join(dirpath, filename)
    return None

# Function to parse the TOC.ncx file and return the ordered list of file names
def get_ordered_filenames_from_toc(toc_file):
    with open(toc_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'xml')  # Parse as XML because ncx is an XML file
        nav_points = soup.find_all('navPoint')

        # Extract the file names and play order
        ordered_filenames = []
        for nav_point in nav_points:
            content_tag = nav_point.find('content')
            if content_tag:
                src_file = content_tag['src']  # Extract the file path from 'src'
                
                # If the path contains a fragment (e.g., #fm03), remove it
                if '#' in src_file:
                    src_file = src_file.split('#', 1)[0]  # Ignore fragment identifiers

                # Get only the base filename, ignoring the original folder structure
                file_name = os.path.basename(src_file)  # Get just the filename (no folder paths)

                # Force the path to point to the parsed_html folder
                parsed_file = os.path.join(parsed_folder, file_name)

                # Check if the parsed file exists
                if os.path.exists(parsed_file):
                    ordered_filenames.append(parsed_file)
                else:
                    print(f"Parsed file not found: {parsed_file}")

        return ordered_filenames

# Function to combine files into a single file based on the order from TOC
def combine_files_into_main_text(ordered_filenames, output_file):
    with open(output_file, 'w', encoding='utf-8') as outfile:
        # Loop through each ordered file and append its content to the output file
        for filename in ordered_filenames:
            if os.path.exists(filename):  # Check if the file exists
                with open(filename, 'r', encoding='utf-8') as infile:
                    content = infile.read()
                    outfile.write(content)
                    outfile.write("\n\n")  # Add some spacing between chapters

# Find the TOC.ncx file and combine files
toc_file = find_toc_file(root_folder)

if toc_file:
    print(f"TOC.ncx found at: {toc_file}")
    ordered_filenames = get_ordered_filenames_from_toc(toc_file)
    combine_files_into_main_text(ordered_filenames, output_file)
    print(f"Main text compiled into {output_file}")
else:
    print("TOC.ncx file not found.")

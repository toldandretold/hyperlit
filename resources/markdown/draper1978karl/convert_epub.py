import re
import os
from bs4 import BeautifulSoup

# Function to replace all <div> tags based on their class
def replace_all_div_tags(soup):
    all_divs = soup.find_all('div')
    
    for div in all_divs:
        class_attr = div.get('class', [])
        try:
            if any(cls.startswith('blockquote') or cls.startswith('bq') for cls in class_attr):
                new_tag = soup.new_tag('blockquote')
            else:
                new_tag = soup.new_tag('p')

            # Preserve internal content of the div
            new_tag.extend(div.contents)
            div.replace_with(new_tag)

        except Exception as e:
            print(f"Error processing div: {div}, error: {e}")

# Function to modify all <a> tags and track file renaming
def modify_all_a_tags(soup, file_rename_map, deepnotes_counter, current_file, in_deepnote=False):
    all_links = soup.find_all('a')

    for link in all_links:
        try:
            # Check if the href attribute exists
            if link.has_attr('href'):
                href = link['href']
                
                if "#" in href:
                    # Split the href into the part before and after the "#"
                    before_hash, after_hash = href.split("#", 1)
                    
                    if in_deepnote:
                        # When in a deepnote file, change the href to main-text
                        link['href'] = f"/main-text#{after_hash}"
                    else:
                        # Only rename files that have a filename part before the "#"
                        if before_hash not in file_rename_map:
                            # Rename this specific file to "deepnotesX.html" if not already renamed
                            new_file_name = f"deepnotes{deepnotes_counter[0]}.html"
                            file_rename_map[before_hash] = new_file_name
                            deepnotes_counter[0] += 1  # Increment the counter for the next file

                        # Update the link href to "/deepnotes#ref-..."
                        link['href'] = f"/deepnotes#{after_hash}"

                # If no "#" in href, leave the link unchanged
        except Exception as e:
            print(f"Error processing link: {link}, error: {e}")

# Function to rename files based on the file_rename_map
def rename_files(output_directory, file_rename_map):
    for old_name, new_name in file_rename_map.items():
        old_file_path = os.path.join(output_directory, old_name)
        new_file_path = os.path.join(output_directory, new_name)
        
        # Check if the old file exists, then rename it
        if os.path.exists(old_file_path):
            os.rename(old_file_path, new_file_path)
            print(f"Renamed {old_file_path} to {new_file_path}")

# Function to process HTML files
def process_html_file(input_file_path, output_file_path, file_rename_map, deepnotes_counter, is_deepnote=False):
    with open(input_file_path, 'r', encoding='utf-8') as file:
        content = file.read()

    # Parse the content with BeautifulSoup using the html.parser
    soup = BeautifulSoup(content, 'html.parser')

    # Replace all <div> tags
    replace_all_div_tags(soup)

    # Modify all <a> tags and populate the file_rename_map
    modify_all_a_tags(soup, file_rename_map, deepnotes_counter, input_file_path, in_deepnote=is_deepnote)

    # Save the modified content to the output file
    with open(output_file_path, 'w', encoding='utf-8') as file:
        file.write(str(soup.prettify()))

# Updated sorting function to ensure numerical order
def sorted_files(files):
    def file_sort_key(filename):
        # Extract numbers from the filename and return the numeric value
        match = re.search(r"(\d+)", filename)
        return int(match.group(1)) if match else float('inf')  # Non-numbered files go last
    return sorted(files, key=file_sort_key)

# Function to process all HTML files in the input directory and save to the output directory
def process_epub_directory(input_directory, output_directory):
    if not os.path.exists(output_directory):
        os.makedirs(output_directory)

    # This map will store which files need to be renamed to "deepnotes1.html", "deepnotes2.html", etc.
    file_rename_map = {}
    deepnotes_counter = [1]  # Initialize counter for deepnotes files

    # First pass: process numbered files in the correct order
    for subdir, _, files in os.walk(input_directory):
        files_sorted = sorted_files(files)  # Ensure files are sorted numerically
        for file in files_sorted:
            if file.endswith(".html") or file.endswith(".xhtml"):
                input_file_path = os.path.join(subdir, file)
                
                if file.startswith('deepnotes'):
                    continue  # Skip deepnote files in this first pass

                # Create output file name without appending "_converted"
                output_file_path = os.path.join(output_directory, file)

                print(f"Processing {input_file_path} (main numbered files)...")
                process_html_file(input_file_path, output_file_path, file_rename_map, deepnotes_counter, is_deepnote=False)
                print(f"Finished processing {output_file_path}")

    # Second pass: process deepnotes files and change links to main-text
    for subdir, _, files in os.walk(input_directory):
        for file in files:
            if file.startswith('deepnotes'):
                input_file_path = os.path.join(subdir, file)
                output_file_path = os.path.join(output_directory, file)

                print(f"Processing {input_file_path} (deepnotes)...")
                process_html_file(input_file_path, output_file_path, file_rename_map, deepnotes_counter, is_deepnote=True)
                print(f"Finished processing {output_file_path}")

    # Rename files based on the collected map (only files that were mentioned in hrefs with #)
    rename_files(output_directory, file_rename_map)

# Main function to process the EPUB folder structure
if __name__ == "__main__":
    input_directory = "epub_original/text"
    output_directory = "epub_original/converted-text"

    process_epub_directory(input_directory, output_directory)
    print("EPUB conversion completed.")

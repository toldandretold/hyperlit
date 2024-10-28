import sys
import os
from bs4 import BeautifulSoup

# Get the base folder path from the command-line argument
base_path = sys.argv[1]  # This should be the path to /{book-name}/epub_original

# Define the book folder as the base path without 'epub_original'
book_folder = os.path.dirname(base_path)  # This will now point to /{book-name}/

# Define the output file path
output_file = os.path.join(book_folder, 'main-text.html')  # Save in the parent folder of 'epub_original'

# Function to search for the TOC.ncx file recursively
def find_toc_file(folder):
    for dirpath, _, filenames in os.walk(folder):
        for filename in filenames:
            if filename.lower() == 'toc.ncx':  # Case-insensitive search
                return os.path.join(dirpath, filename)
    return None

# Function to parse the TOC.ncx file and return the ordered list of file names
def get_ordered_filenames_from_toc(toc_file):
    with open(toc_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'xml')  # Parse as XML because ncx is an XML file
        nav_points = soup.find_all('navPoint')

        # Extract the base directory of the TOC file
        base_dir = os.path.dirname(toc_file)

        # Extract the file names and play order
        ordered_filenames = []
        for nav_point in nav_points:
            content_tag = nav_point.find('content')
            if content_tag:
                src_file = content_tag['src']  # Extract the file path from 'src'

                # If the path contains a fragment (e.g., #fm03), remove it
                if '#' in src_file:
                    src_file = src_file.split('#', 1)[0]  # Ignore fragment identifiers

                # Rebuild the full path based on the original TOC.ncx directory
                full_file_path = os.path.join(base_dir, src_file)

                # Check if the file exists in its original location
                if os.path.exists(full_file_path):
                    ordered_filenames.append(full_file_path)
                else:
                    print(f"File not found: {full_file_path}")

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

# Function to search for the correct image file and update the src attribute
def update_image_paths(output_file, search_directory):
    with open(output_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

    # Find all <img> tags and update the src attribute
    for img_tag in soup.find_all('img'):
        src = img_tag.get('src')

        if src:
            image_name = os.path.basename(src)  # Get the image filename only
            new_path = find_image(search_directory, image_name)
            if new_path:
                # Compute the new relative path and update the src attribute
                relative_path = os.path.relpath(new_path, os.path.dirname(output_file))
                img_tag['src'] = relative_path
                print(f"Updated src for {image_name} to {relative_path}")
            else:
                print(f"Image not found: {image_name}")

    # Save the updated HTML back to the file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(str(soup))

# Function to search for an image in subdirectories
def find_image(search_directory, image_name):
    # Walk through all subdirectories to find the image
    for dirpath, _, filenames in os.walk(search_directory):
        if image_name in filenames:
            return os.path.join(dirpath, image_name)
    return None  # Return None if the image isn't found

def clean_html(output_file):
    with open(output_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

        # Step 1: Remove <div class="delete"> tags by unwrapping them
        for div_tag in soup.find_all('div', class_='delete'):
            div_tag.unwrap()  # Remove the tag but keep the content

        # Step 2: Convert remaining <div> tags to <p> and handle id attributes
        for div_tag in soup.find_all('div'):
            # Check if the div has an 'id' attribute
            if 'id' in div_tag.attrs:
                div_id = div_tag['id']  # Store the div's id

                # Find any existing <a> tags inside the div
                anchor_tag = div_tag.find('a')

                if anchor_tag:
                    if 'id' not in anchor_tag.attrs:
                        # If the <a> tag doesn't have an id, add the div's id to it
                        anchor_tag['id'] = div_id
                    else:
                        # If the <a> tag already has an id, create a new <a> tag with the div's id
                        new_anchor = soup.new_tag('a', id=div_id)
                        # Insert the new <a> tag at the start of the div's content
                        div_tag.insert(0, new_anchor)
                else:
                    # If no <a> tag exists, create a new <a> tag with the div's id
                    new_anchor = soup.new_tag('a', id=div_id)
                    div_tag.insert(0, new_anchor)

            # Change the tag name from <div> to <p>
            div_tag.name = 'p'

            # Remove class and id attributes from the new <p> tag
            if 'class' in div_tag.attrs:
                del div_tag['class']
            if 'id' in div_tag.attrs:
                del div_tag['id']

        # Step 3: Modify <a> tags that have a "#" in their href
        for a_tag in soup.find_all('a', href=True):
            href = a_tag['href']
            if '#' in href:
                # Remove everything before the "#"
                a_tag['href'] = '#' + href.split('#', 1)[1]

        # Step 4: Remove nested <p> tags and empty <p> tags (but ignore <img> tags)
        for p_tag in soup.find_all('p'):
            # If the <p> tag contains another <p> tag, unwrap the outer <p> tag
            inner_p = p_tag.find('p')
            if inner_p:
                p_tag.unwrap()  # Remove the outer <p> tag but keep the content

            # Remove empty <p> tags, but keep those with <img> tags
            if not p_tag.get_text(strip=True) and not p_tag.find('img'):
                p_tag.decompose()  # Remove the empty tag completely

        # Step 5: Remove all class attributes from all remaining tags, except <img> and <a>
        for tag in soup.find_all(True):  # True matches all tags
            if 'class' in tag.attrs and tag.name not in ['img', 'a']:  # Skip <img> and <a>
                del tag['class']  # Remove class attributes from all other tags

        # Save the cleaned-up content back to the file
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(str(soup))


# Combine the functions
def process_toc(output_file):
    toc_start_parent = remove_old_toc(output_file)
    if toc_start_parent:
        generate_new_toc(output_file)

# Search for the TOC.ncx file
toc_file = find_toc_file(book_folder)  # Use book_folder instead of root_folder

# Get the ordered list of file names from the TOC.ncx and process
if toc_file:
    print(f"TOC.ncx found at: {toc_file}")
    # Combine the content of the parsed files into "main-text.html"
    ordered_filenames = get_ordered_filenames_from_toc(toc_file)
    combine_files_into_main_text(ordered_filenames, output_file)

    # Clean the HTML by handling <div>, <a>, <p> tags, and removing all class attributes
    clean_html(output_file)

    # Update image paths to the correct relative paths
    update_image_paths(output_file, base_path)

    # Process the TOC: remove the old one and insert a new one
    process_toc(output_file)

    print(f"Main text compiled, cleaned, modified, and TOC processed in {output_file}")
else:
    print("TOC.ncx file not found.")

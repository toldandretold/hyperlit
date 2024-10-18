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
                # Modify the path from its current location to parsed_html folder
                filename = os.path.join(parsed_folder, os.path.basename(src_file))
                ordered_filenames.append(filename)

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

# Function to clean HTML by handling <div>, <a>, and <p> tags, and removing all class attributes
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

        # Step 4: Remove nested <p> tags and empty <p> tags
        for p_tag in soup.find_all('p'):
            # If the <p> tag contains another <p> tag, unwrap the outer <p> tag
            inner_p = p_tag.find('p')
            if inner_p:
                p_tag.unwrap()  # Remove the outer <p> tag but keep the content
            
            # Remove empty <p> tags (those that contain only whitespace or no content)
            if not p_tag.get_text(strip=True):  # Check if the <p> has no visible text
                p_tag.decompose()  # Remove the empty tag completely

        # Step 5: Remove all class attributes from all remaining tags
        for tag in soup.find_all(True):  # True matches all tags
            if 'class' in tag.attrs:
                del tag['class']  # Remove class attributes from all tags

        # Save the cleaned-up content back to the file
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(str(soup))

# Function to remove the old TOC and place a placeholder marker for new TOC
def remove_old_toc(output_file):
    with open(output_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

    toc_start = None
    for header in soup.find_all(['h1', 'h2']):
        if "contents" in header.get_text(strip=True).lower():
            toc_start = header
            break

    if toc_start:
        siblings_to_remove = []
        found_end = None
        for element in toc_start.find_all_next():
            if element.name is None:
                continue
            if (element.name == 'br' and 'end-page' in element.get('class', [])) or element.name in ['h1', 'h2', 'h3']:
                found_end = element
                break
            siblings_to_remove.append(element)
        placeholder_tag = soup.new_tag('a', id='TOC')
        toc_start.insert_before(placeholder_tag)
        toc_start.decompose()
        for sibling in siblings_to_remove:
            try:
                sibling.decompose()
            except Exception as e:
                print(f"Error while removing: {sibling} - {e}")

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(str(soup))

    return toc_start

# Function to generate a new Table of Contents (TOC), and indent headings correctly
def generate_new_toc(output_file):
    with open(output_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

    toc_placeholder = soup.find('a', id="TOC")

    if toc_placeholder:
        toc_container = soup.new_tag('div')
        toc_heading = soup.new_tag('h1')
        toc_heading.string = "Contents"
        toc_container.append(toc_heading)

        toc_list = soup.new_tag('ul')
        toc_container.append(toc_list)

        current_ul = toc_list
        h2_ul = None
        h3_ul = None

        for header in toc_placeholder.find_next_siblings(['h1', 'h2', 'h3']):
            header_id = header.get_text(strip=True).replace(' ', '-').lower()
            header['id'] = header_id

            toc_entry = soup.new_tag('li')
            toc_link = soup.new_tag('a', href=f"#{header_id}")
            toc_link.string = header.get_text()
            toc_entry.append(toc_link)

            if header.name == 'h1':
                toc_list.append(toc_entry)
                h2_ul = soup.new_tag('ul')
                toc_entry.append(h2_ul)
                current_ul = h2_ul
                h3_ul = None
            elif header.name == 'h2':
                if h2_ul is not None:
                    h2_ul.append(toc_entry)
                else:
                    toc_list.append(toc_entry)
                h3_ul = soup.new_tag('ul')
                toc_entry.append(h3_ul)
                current_ul = h3_ul
            elif header.name == 'h3' and h3_ul:
                h3_ul.append(toc_entry)

        toc_placeholder.insert_after(toc_container)
        toc_container.insert_after(soup.new_tag('br'))

        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(str(soup))

# Combine the functions
def process_toc(output_file):
    toc_start_parent = remove_old_toc(output_file)
    if toc_start_parent:
        generate_new_toc(output_file)

# Search for the TOC.ncx file
toc_file = find_toc_file(root_folder)

# Get the ordered list of file names from the TOC.ncx and process
if toc_file:
    print(f"TOC.ncx found at: {toc_file}")
    # Combine the content of the parsed files into "main-text.html"
    ordered_filenames = get_ordered_filenames_from_toc(toc_file)
    combine_files_into_main_text(ordered_filenames, output_file)

    # Clean the HTML by handling <div>, <a>, <p> tags, and removing all class attributes
    clean_html(output_file)

    # Process the TOC: remove the old one and insert a new one
    process_toc(output_file)

    print(f"Main text compiled, cleaned, modified, and TOC processed in {output_file}")
else:
    print("TOC.ncx file not found.")

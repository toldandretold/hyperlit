import os
from bs4 import BeautifulSoup

# Define paths for the TOC file and the parsed files folder
toc_file = 'epub_original/TOC.ncx'
parsed_folder = 'epub_original/parsed_html'
output_file = 'epub_original/main-text.html'

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
                # Modify the path from "Text/27.html" to "parsed_html/27.html"
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
# Function to remove the old TOC and place a placeholder marker for new TOC
def remove_old_toc(output_file):
    with open(output_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

    # Step 1: Find the first <h1> or <h2> that contains "Contents"
    toc_start = None
    for header in soup.find_all(['h1', 'h2']):
        if "contents" in header.get_text(strip=True).lower():
            toc_start = header
            break

    print(f"TOC Start Found: {toc_start}")  # Log the found TOC heading

    if toc_start:
        # Step 2: Find the next <br class="end-page"/> or title (<h1>, <h2>, etc.), whichever comes first
        siblings_to_remove = []
        found_end = None  # To store the element we stop at (next heading or <br class="end-page"/>)

        for element in toc_start.find_all_next():
            if element.name is None:
                continue

            # Stop at the next <br class="end-page"/> or header (h1, h2, h3)
            if (element.name == 'br' and 'end-page' in element.get('class', [])) or element.name in ['h1', 'h2', 'h3']:
                found_end = element  # Mark the element where we should stop
                break  # Stop before removing this element

            siblings_to_remove.append(element)  # Collect elements to remove

        print(f"Removing TOC heading and content up to (but not including): {found_end}")
        
        # Insert placeholder **before** removing the TOC heading and content
        placeholder_tag = soup.new_tag('a', id='TOC')
        toc_start.insert_before(placeholder_tag)

        # Now remove the TOC heading itself
        toc_start.decompose()

        # Remove all collected siblings, but not the found_end (next heading or <br/>)
        for sibling in siblings_to_remove:
            try:
                sibling.decompose()  # Remove each sibling
            except Exception as e:
                print(f"Error while removing: {sibling} - {e}")

        print("Old TOC and its content removed successfully, next heading retained.")
    else:
        print("No TOC heading found.")

    # Save the modified HTML back to the file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(str(soup))

    return toc_start  # Return the TOC start or None




# Function to generate a new Table of Contents (TOC), and indent headings correctly
def generate_new_toc(output_file):
    with open(output_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

    print("Generating new TOC based on headers after the placeholder...")

    # Find the TOC placeholder
    toc_placeholder = soup.find('a', id="TOC")

    if toc_placeholder:
        # Step 1: Create the new TOC container
        toc_container = soup.new_tag('div')  # Container for the TOC
        toc_heading = soup.new_tag('h1')
        toc_heading.string = "Contents"
        toc_container.append(toc_heading)

        # Create the <ul> for the TOC
        toc_list = soup.new_tag('ul')
        toc_container.append(toc_list)

        current_ul = toc_list  # Start with the top-level <ul> for h1
        h2_ul = None
        h3_ul = None
        found_headers = False

        # Collect all headers (h1, h2, h3) that come **after** the TOC placeholder
        for header in toc_placeholder.find_next_siblings(['h1', 'h2', 'h3']):
            found_headers = True
            header_id = header.get_text(strip=True).replace(' ', '-').lower()  # Create an ID from header text
            header['id'] = header_id  # Assign the ID to the header

            print(f"Found header: {header}")  # Log the headers found

            # Create the TOC entry that matches the header level
            toc_entry = soup.new_tag('li')
            toc_link = soup.new_tag('a', href=f"#{header_id}")
            toc_link.string = header.get_text()
            toc_entry.append(toc_link)

            # Handle indentation by ensuring consistent levels
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

        if not found_headers:
            print("No headers found for TOC after the placeholder.")
            return

        # Step 3: Insert the new TOC container into the document safely
        print("Inserting new TOC into document.")
        toc_placeholder.insert_after(toc_container)

        # Step 4: Add a <br/> tag after the new TOC
        toc_container.insert_after(soup.new_tag('br'))

        # Save the modified HTML back to the file
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(str(soup))

        print("New TOC generated, inserted, and <br/> tag added successfully.")
    else:
        print("TOC placeholder not found.")


# Combine the functions
def process_toc(output_file):
    toc_start_parent = remove_old_toc(output_file)
    if toc_start_parent:
        generate_new_toc(output_file)



# Get the ordered list of file names from the TOC.ncx
ordered_filenames = get_ordered_filenames_from_toc(toc_file)

# Combine the content of the parsed files into "main-text.html"
combine_files_into_main_text(ordered_filenames, output_file)

# Clean the HTML by handling <div>, <a>, <p> tags, and removing all class attributes
clean_html(output_file)

# Process the TOC: remove the old one and insert a new one
process_toc(output_file)


print(f"Main text compiled, cleaned, modified, and TOC processed in {output_file}")

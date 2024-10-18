import os
from bs4 import BeautifulSoup

# Define potential folder paths for the original and parsed files
text_folders = ['epub_original/text', 'epub_original/OEBPS']
parsed_folder = 'epub_original/parsed_html'

# Ensure the parsed_html folder exists
os.makedirs(parsed_folder, exist_ok=True)

# Function to parse each file and add class="delete" to parent div
def parse_html_file(file_path, parsed_folder):
    with open(file_path, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')

        # Find the <body> tag and extract its contents
        body = soup.find('body')
        if body:
            # Get all contents inside the <body> tag
            body_content = list(body.children)

            # Create a new tag (div) with class="delete"
            content_wrapper = soup.new_tag('div', attrs={'class': 'delete'})
            for element in body_content:
                content_wrapper.append(element)

            # Manually remove the outermost <div> if it exists
            first_div = content_wrapper.find('div', recursive=False)
            if first_div:
                first_div.unwrap()  # This removes the outer <div> but keeps the contents

            final_content = content_wrapper

        else:
            # If no <body> tag exists, treat the entire content as soup object
            final_content = soup

        # Append a <br class="end-page"/> tag manually
        final_content.append(soup.new_tag('br', attrs={'class': 'end-page'}))

        # Save the final content to a file with class="delete"
        new_file_path = os.path.join(parsed_folder, os.path.basename(file_path))
        with open(new_file_path, 'w', encoding='utf-8') as new_file:
            new_file.write(str(final_content))


# Find the correct folder (text or OEBPS) and parse through the files
for folder in text_folders:
    if os.path.exists(folder):
        print(f"Parsing files from: {folder}")
        for file_name in os.listdir(folder):
            if file_name.endswith(('.html', '.xhtml', '.xml')):  # Process only content-related file types
                file_path = os.path.join(folder, file_name)
                parse_html_file(file_path, parsed_folder)
        break  # Exit after processing the first found folder

# Provide a list of files that were saved
print("Files parsed and saved in 'parsed_html' folder:", os.listdir(parsed_folder))

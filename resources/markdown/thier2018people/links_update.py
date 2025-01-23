from bs4 import BeautifulSoup

def update_superscript_links(file_path):
    # Read the HTML file
    with open(file_path, 'r') as file:
        html_content = file.read()

    # Parse the HTML
    soup = BeautifulSoup(html_content, 'html.parser')

    # Find all anchor tags containing a <sup> tag
    for a_tag in soup.find_all('a', href=True):
        if a_tag.find('sup'):
            # Modify the href by adding 'b' after the '#'
            href_value = a_tag['href']
            if href_value.startswith('#'):
                a_tag['href'] = f"#b{href_value[1:]}"

    # Save the updated HTML back to the file
    with open(file_path, 'w') as file:
        file.write(str(soup))

# Specify the HTML file
file_path = "main-text.html"  # Replace with your file's name
update_superscript_links(file_path)
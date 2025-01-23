def update_anchor_ids(file_path):
    # Read the HTML file
    with open(file_path, 'r') as file:
        html_content = file.read()
    
    # Parse the HTML
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # Add 'b' before each id in <a> tags
    for a_tag in soup.find_all('a', id=True):
        a_tag['id'] = f"b{a_tag['id']}"
    
    # Save the updated HTML back to the file
    with open(file_path, 'w') as file:
        file.write(str(soup))

# Specify the HTML file
file_path = "notes.html"  # Replace with your file's name
update_anchor_ids(file_path)

import re

# Path to your main-text.md file
file_path = "main-text.md"

# Base URL to prepend to anchor links
base_url = "/thier2018people"

# Regular expression to match HTML anchor tags with relative hrefs
anchor_tag_pattern = re.compile(r'<a\s+([^>]*href=["\'])(#[^"\'>]+)(["\'][^>]*)>', re.IGNORECASE)

def update_anchor_tags(file_path, base_url):
    try:
        # Read the content of the file
        with open(file_path, 'r', encoding='utf-8') as file:
            content = file.read()

        # Replace relative anchor links with absolute links
        updated_content = anchor_tag_pattern.sub(
            lambda match: f'<a {match.group(1)}{base_url}{match.group(2)}{match.group(3)}>',
            content
        )

        # Write the updated content back to the file
        with open(file_path, 'w', encoding='utf-8') as file:
            file.write(updated_content)

        print("Anchor tags updated successfully.")

    except Exception as e:
        print(f"An error occurred: {e}")

# Call the function to update anchor tags
update_anchor_tags(file_path, base_url)

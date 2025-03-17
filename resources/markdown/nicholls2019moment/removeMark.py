import re

def remove_mark_tags(file_path):
    # Read the content of the markdown file
    with open(file_path, 'r', encoding='utf-8') as file:
        content = file.read()

    # Use regex to remove <mark> and </mark> tags with any attributes
    cleaned_content = re.sub(r'<mark[^>]*>|</mark>', '', content)

    # Write the cleaned content back to the file or a new file
    with open(file_path, 'w', encoding='utf-8') as file:
        file.write(cleaned_content)

if __name__ == "__main__":
    # Replace 'your_file.md' with the path to your markdown file
    remove_mark_tags('main-text.md')

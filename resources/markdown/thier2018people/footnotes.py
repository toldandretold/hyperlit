import os
import json
import re

def extract_footnotes_from_markdown(markdown_file_path):
    """
    Extract footnotes from a Markdown file and save them to a JSON file.

    Args:
        markdown_file_path (str): Path to the Markdown file.

    Returns:
        str: Path to the generated JSON file.
    """
    # Check if the file exists
    if not os.path.exists(markdown_file_path):
        raise FileNotFoundError(f"Markdown file not found: {markdown_file_path}")

    # Read the Markdown file
    with open(markdown_file_path, 'r', encoding='utf-8') as markdown_file:
        markdown_content = markdown_file.read()

    # Regex pattern to match footnotes (e.g., [^1]: Content of the footnote)
    footnote_pattern = re.compile(r'^\[\^(\d+)\]:\s*(.*)', re.MULTILINE)

    # Extract footnotes into a dictionary
    footnotes = {}
    for match in footnote_pattern.finditer(markdown_content):
        footnote_id = match.group(1)  # The number inside [^ ]
        footnote_content = match.group(2).strip()  # The content after [^ ]:
        footnotes[footnote_id] = footnote_content

    # Generate the JSON file path
    json_file_path = os.path.splitext(markdown_file_path)[0] + "-footnotes.json"

    # Save the footnotes to a JSON file
    with open(json_file_path, 'w', encoding='utf-8') as json_file:
        json.dump(footnotes, json_file, indent=4, ensure_ascii=False)

    return json_file_path

# Example usage
if __name__ == "__main__":
    # Path to your Markdown file
    markdown_path = "main-text.md"  # Update with your actual file path

    try:
        json_path = extract_footnotes_from_markdown(markdown_path)
        print(f"Footnotes extracted and saved to: {json_path}")
    except FileNotFoundError as e:
        print(e)
    except Exception as e:
        print(f"An error occurred: {e}")

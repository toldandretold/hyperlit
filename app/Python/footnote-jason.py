import os
import json
import re
import sys

def extract_footnotes_by_reference(file_path, output_file_path):
    """
    Extract footnotes from a Markdown or HTML file, grouping them by 
    the headings where the in-text references appear.

    Args:
        file_path (str): Path to the file containing footnotes.
        output_file_path (str): Path where the extracted JSON should be saved.
    
    Returns:
        str: The output file path where the JSON was written.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    # Read the file
    with open(file_path, 'r', encoding='utf-8') as file:
        file_content = file.readlines()

    # Regex patterns
    html_reference_pattern = re.compile(
        r'<a href="#(.*?)" id="(.*?)"><sup>(\d+)</sup></a>', re.MULTILINE)
    html_definition_pattern = re.compile(
        r'<a href="#(.*?)" id="(.*?)">(\d+)</a>(.*)', re.MULTILINE)
    markdown_reference_pattern = re.compile(r'\[\^(\d+)\]', re.MULTILINE)
    markdown_definition_pattern = re.compile(
        r'\[\^(\d+)\]:\s*(.*)', re.MULTILINE)
    heading_pattern = re.compile(r'^(#{1,5})\s+(.*)', re.MULTILINE)

    # Data structures
    sections = []
    current_section = {"heading": None, "footnotes": {}}
    html_definitions = {}
    markdown_definitions = {}

    # Extract HTML and Markdown definitions
    for line_number, line in enumerate(file_content, start=1):
        for match in html_definition_pattern.finditer(line):
            html_definitions[match.group(2)] = {
                "number": int(match.group(3)),
                "content": match.group(4).strip(),
                "line_number": line_number,
            }
        for match in markdown_definition_pattern.finditer(line):
            markdown_definitions[int(match.group(1))] = {
                "content": match.group(2).strip(),
                "line_number": line_number,
            }

    # Process headings and references
    for line_number, line in enumerate(file_content, start=1):
        if heading_match := heading_pattern.match(line):
            if current_section["heading"] or current_section["footnotes"]:
                sections.append(current_section)
                current_section = {"heading": None, "footnotes": {}}
            current_section["heading"] = {
                f"h{len(heading_match.group(1))}": heading_match.group(2),
                "line_number": line_number,
            }
        for match in html_reference_pattern.finditer(line):
            if match.group(1) in html_definitions:
                current_section["footnotes"][int(match.group(3))] = {
                    "content": html_definitions[match.group(1)]["content"],
                    "line_number": line_number,
                }
        for match in markdown_reference_pattern.finditer(line):
            if int(match.group(1)) in markdown_definitions:
                current_section["footnotes"][int(match.group(1))] = {
                    "content": markdown_definitions[int(match.group(1))]["content"],
                    "line_number": line_number,
                }

    if current_section["heading"] or current_section["footnotes"]:
        sections.append(current_section)

    # Unreferenced footnotes
    unreferenced = {"heading": {"h1": "Unreferenced Footnotes"}, "footnotes": {}}
    used_keys = [fn for section in sections for fn in section["footnotes"]]
    for key, value in markdown_definitions.items():
        if key not in used_keys:
            unreferenced["footnotes"][key] = value
    if unreferenced["footnotes"]:
        sections.append(unreferenced)

    # Write the JSON to the provided output file path.
    with open(output_file_path, 'w', encoding='utf-8') as json_file:
        json.dump(sections, json_file, indent=4, ensure_ascii=False)
    
    return output_file_path

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python extract_footnotes.py <markdown_file_path> <output_file_path>")
        sys.exit(1)
    markdown_file_path = sys.argv[1]
    output_file_path = sys.argv[2]
    try:
        result_path = extract_footnotes_by_reference(markdown_file_path, output_file_path)
        print(f"Footnotes extracted to: {result_path}")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

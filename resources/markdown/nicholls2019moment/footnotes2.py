import os
import json
import re
import sys

def extract_footnotes_by_reference(file_path):
    """
    Extract footnotes from a Markdown or HTML file, grouping them by headings where the in-text references appear.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    with open(file_path, 'r', encoding='utf-8') as file:
        file_content = file.readlines()

    html_reference_pattern = re.compile(r'<a href="#(.*?)" id="(.*?)"><sup>(\d+)</sup></a>', re.MULTILINE)
    html_definition_pattern = re.compile(r'<a href="#(.*?)" id="(.*?)">(\d+)</a>(.*)', re.MULTILINE)
    markdown_reference_pattern = re.compile(r'\[\^(\d+)\]', re.MULTILINE)
    markdown_definition_pattern = re.compile(r'\[\^(\d+)\]:\s*(.*)', re.MULTILINE)
    heading_pattern = re.compile(r'^(#{1,5})\s+(.*)', re.MULTILINE)

    sections = []
    current_section = {"heading": None, "footnotes": {}}
    html_definitions = {}
    markdown_definitions = {}

    for line_number, line in enumerate(file_content, start=1):
        for match in html_definition_pattern.finditer(line):
            href = match.group(1)
            id_attr = match.group(2)
            footnote_number = int(match.group(3))
            content = match.group(4).strip()
            html_definitions[id_attr] = {"number": footnote_number, "content": content, "line_number": line_number}

    for line_number, line in enumerate(file_content, start=1):
        for match in markdown_definition_pattern.finditer(line):
            footnote_number = int(match.group(1))
            content = match.group(2).strip()
            markdown_definitions[footnote_number] = {"content": content, "line_number": line_number}

    for line_number, line in enumerate(file_content, start=1):
        heading_match = heading_pattern.match(line)
        if heading_match:
            if current_section["heading"] or current_section["footnotes"]:
                sections.append(current_section)
                current_section = {"heading": None, "footnotes": {}}
            heading_level = "h" + str(len(heading_match.group(1)))
            current_section["heading"] = {
                heading_level: heading_match.group(2),
                "line_number": line_number
            }

        for match in html_reference_pattern.finditer(line):
            ref_id = match.group(1)
            footnote_number = int(match.group(3))

            if ref_id in html_definitions:
                content = html_definitions[ref_id]["content"]
                current_section["footnotes"][footnote_number] = {
                    "content": content,
                    "line_number": line_number
                }

        for match in markdown_reference_pattern.finditer(line):
            footnote_number = int(match.group(1))

            if footnote_number in markdown_definitions:
                content = markdown_definitions[footnote_number]["content"]
                current_section["footnotes"][footnote_number] = {
                    "content": content,
                    "line_number": line_number
                }

    if current_section["heading"] or current_section["footnotes"]:
        sections.append(current_section)

    unreferenced = {"heading": {"h1": "Unreferenced Footnotes"}, "footnotes": {}}
    for key, value in markdown_definitions.items():
        if key not in [fn for section in sections for fn in section["footnotes"]]:
            unreferenced["footnotes"][key] = {
                "content": value["content"],
                "line_number": value["line_number"]
            }
    if unreferenced["footnotes"]:
        sections.append(unreferenced)

    for section in sections:
        section["footnotes"] = dict(sorted(section["footnotes"].items()))

    json_file_path = os.path.splitext(file_path)[0] + "-footnotes.json"

    with open(json_file_path, 'w', encoding='utf-8') as json_file:
        json.dump(sections, json_file, indent=4, ensure_ascii=False)

    print(f"✅ Footnotes extracted and saved to: {json_file_path}")
    return json_file_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ Error: No file path provided.")
        sys.exit(1)

    markdown_path = sys.argv[1]
    try:
        extract_footnotes_by_reference(markdown_path)
    except FileNotFoundError as e:
        print(f"❌ File not found: {e}")
    except Exception as e:
        print(f"❌ Error processing file: {e}")

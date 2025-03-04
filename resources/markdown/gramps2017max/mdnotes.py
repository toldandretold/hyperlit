import re

def process_markdown(file_path):
    # Read the content of the file
    with open(file_path, 'r', encoding='utf-8') as file:
        content = file.read()

    # Replace all occurrences of "\[x\]" with "[^x]"
    content = re.sub(r'\\\[(\d+)\\\]', r'[^\1]', content)

    # Replace numbered references like '12.' with '[^12]:'
    content = re.sub(r'^(\d+)\.\s', r'[^\1]: ', content, flags=re.MULTILINE)

    # Write the modified content back to the file
    with open(file_path, 'w', encoding='utf-8') as file:
        file.write(content)

# Replace 'your_file.md' with the path to your Markdown file
process_markdown('main-text.md')



import os
import re

def process_main_body(text):
    """
    METHODOLOGY A: Processes the main prose of the chapter.
    Uses a line-by-line buffer to correctly identify paragraphs separated
    by blank lines.
    """
    def process_block(buffer):
        # Helper to format a collected block of lines
        if not buffer:
            return None
        
        full_block = " ".join(buffer)
        
        # Is it a page number?
        if len(buffer) == 1 and buffer[0].isdigit():
            return f'<a id="pp{buffer[0]}"></a>'
        
        # Is it an indented blockquote?
        if buffer[0].startswith("     "):
            # Re-join with newlines and format as a quote
            quote_lines = " ".join(buffer).split("  ") # Split by multiple spaces
            return "\n".join([f"> {line.strip()}" for line in quote_lines if line.strip()])

        # Is it a subtitle?
        if len(buffer) == 1 and buffer[0].istitle() and len(buffer[0]) < 100:
            return f"## {buffer[0]}"
            
        return full_block

    # --- Line-by-line processing logic ---
    output_blocks = []
    paragraph_buffer = []
    for line in text.splitlines():
        stripped_line = line.strip()
        if stripped_line:
            paragraph_buffer.append(stripped_line)
        else:
            formatted = process_block(paragraph_buffer)
            if formatted:
                output_blocks.append(formatted)
            paragraph_buffer = []
    
    # Process the last paragraph in the buffer
    formatted = process_block(paragraph_buffer)
    if formatted:
        output_blocks.append(formatted)
        
    return "\n\n".join(output_blocks)

def process_notes(text):
    """
    METHODOLOGY B: Processes the endnotes section.
    Splits the text based on numbered entries, not blank lines.
    """
    if not text.strip():
        return ""
        
    # Split the text before each numbered entry. The `(?=...)` is a lookahead
    # that keeps the delimiter (the number) with the following text.
    notes = re.split(r'\n(?=\d+\s)', text.strip())
    
    cleaned_notes = []
    for note in notes:
        if not note.strip():
            continue
        # Join all lines within a single note entry
        cleaned_note = note.replace('\n', ' ').strip()
        cleaned_notes.append(cleaned_note)
        
    return "\n\n".join(cleaned_notes)

def process_file_content(content):
    """
    The main controller. Splits the file into Body and Notes,
    then processes each with the correct methodology.
    """
    # --- Step 1: Split the document into main body and notes ---
    # The split is case-insensitive and looks for "Notes" on its own line.
    parts = re.split(r'^\s*Notes\s*$', content, maxsplit=1, flags=re.MULTILINE | re.IGNORECASE)
    main_body_content = parts[0]
    notes_content = parts[1] if len(parts) > 1 else ""

    # --- Step 2: Process the main chapter header separately ---
    header_pattern = re.compile(r"^\s*(\d+)\s*\n(Chapter\s+.*?)\n(.*?)\n", re.IGNORECASE)
    match = header_pattern.match(main_body_content)
    
    final_parts = []
    if match:
        page_num = match.group(1).strip()
        chapter_line = match.group(2).strip()
        title_line = match.group(3).strip()
        
        header_block = f'<a id="pp{page_num}"></a>\n\n# {chapter_line}: {title_line}'
        final_parts.append(header_block)
        main_body_content = main_body_content[match.end():]

    # --- Step 3: Process each part with its dedicated function ---
    processed_body = process_main_body(main_body_content)
    if processed_body:
        final_parts.append(processed_body)
        
    processed_notes = process_notes(notes_content)
    if processed_notes:
        final_parts.append("---\n\n# Notes")
        final_parts.append(processed_notes)
        
    return "\n\n".join(final_parts)

def main():
    """Main function to find, sort, process, and combine markdown files."""
    # ... (The main function remains the same as the previous correct versions)
    output_filename = "main-text.md"
    bibliography_filename = "bibliography.md"
    file_prefix = "main-text"
    current_dir = "."

    all_files = os.listdir(current_dir)
    main_text_files = [f for f in all_files if f.startswith(file_prefix) and f.endswith(".md")]
    try:
        main_text_files.sort(key=lambda f: int(re.search(r"(\d+)", f).group(1)))
    except (AttributeError, ValueError):
        main_text_files.sort()

    files_to_process = main_text_files
    if os.path.exists(bibliography_filename):
        files_to_process.append(bibliography_filename)
    
    if not files_to_process:
        print("No markdown files found to process. Exiting.")
        return

    print("Files will be processed in this order:")
    for f in files_to_process:
        print(f" - {f}")

    processed_parts = []
    for filename in files_to_process:
        print(f"Processing {filename}...")
        with open(filename, "r", encoding="utf-8") as infile:
            content = infile.read()
            processed_text = process_file_content(content)
            if processed_text:
                processed_parts.append(processed_text)

    final_content = "\n\n---\n\n".join(processed_parts)
    with open(output_filename, "w", encoding="utf-8") as outfile:
        outfile.write(final_content)

    print(f"\nSuccess! The document has been forged anew into {output_filename}.")

if __name__ == "__main__":
    main()
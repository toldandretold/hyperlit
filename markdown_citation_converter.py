#!/usr/bin/env python3
"""
Markdown Citation Converter
Converts citation formats in markdown files:
1. End-of-sentence citations: "sentence.1" -> "sentence.[^1]" (outside notes sections)
2. Note references: "1 text" -> "[^1]: text" (in notes sections)
"""

import re


def convert_citations(input_file, output_file):
    """Convert citations in markdown file and save to output file."""
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        print(f"Original file size: {len(content)} characters")
        
        # Split content into sections
        sections = []
        current_section = {'type': 'main', 'content': ''}
        
        lines = content.split('\n')
        
        for line in lines:
            # Check if we're starting a bibliography section
            if re.search(r'^#+\s*bibliography\s*$', line, re.IGNORECASE):
                # Save current section
                if current_section['content']:
                    sections.append(current_section)
                # Start bibliography section (no changes)
                current_section = {'type': 'bibliography', 'content': line + '\n'}
            # Check if we're starting a notes section
            elif re.search(r'^#+\s*notes\s*$', line, re.IGNORECASE):
                # Save current section
                if current_section['content']:
                    sections.append(current_section)
                # Start notes section
                current_section = {'type': 'notes', 'content': line + '\n'}
            # Check if we're ending a notes section
            elif line.strip().startswith('---') and current_section['type'] == 'notes':
                # End notes section
                sections.append(current_section)
                # Start new main section
                current_section = {'type': 'main', 'content': line + '\n'}
            else:
                current_section['content'] += line + '\n'
        
        # Don't forget the last section
        if current_section['content']:
            sections.append(current_section)
        
        # Process each section
        converted_content = ''
        for section in sections:
            if section['type'] == 'main':
                # Convert end-of-sentence citations only
                converted = convert_end_of_sentence_citations(section['content'])
                converted_content += converted
            elif section['type'] == 'notes':
                # Convert note references only
                converted = convert_note_references(section['content'])
                converted_content += converted
            else:  # bibliography section - no changes
                converted_content += section['content']
        
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(converted_content)
        
        print(f"Converted file saved to: {output_file}")
        print(f"Converted file size: {len(converted_content)} characters")
        
    except FileNotFoundError:
        print(f"Error: Input file '{input_file}' not found.")
    except Exception as e:
        print(f"Error: {e}")


def convert_end_of_sentence_citations(text):
    """Convert end-of-sentence citations to footnote format."""
    # Pattern to match digits at the end of sentences
    # Matches: .digit, ?digit, !"digit, etc.
    pattern = r'([.!?]["\']*)\s*(\d+)(\s)'
    replacement = r'\1[^\2]\3'
    return re.sub(pattern, replacement, text)


def convert_note_references(text):
    """Convert note references to footnote format in notes sections."""
    lines = text.split('\n')
    result_lines = []
    
    for line in lines:
        # If line starts with digit + space (note reference)
        if re.match(r'^\d+ ', line):
            # Convert "1 text" to "[^1]: text"
            converted_line = re.sub(r'^(\d+) ', r'[^\1]: ', line)
            result_lines.append(converted_line)
        else:
            result_lines.append(line)
    
    return '\n'.join(result_lines)


if __name__ == "__main__":
    input_file = "app/Python/cybermarx.md"
    output_file = "cybermarx2.md"
    
    convert_citations(input_file, output_file)
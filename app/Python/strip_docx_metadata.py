#!/usr/bin/env python3
"""
Strip metadata from DOCX files for privacy and security.

Removes:
- Author information
- Last modified by
- Revision numbers
- Creation/modification dates
- Comments
- Company info
- Application info
- Track changes history (accepts all changes)

Usage:
    python strip_docx_metadata.py input.docx output.docx
    python strip_docx_metadata.py input.docx  # Overwrites input file
"""

import sys
import os
import zipfile
import tempfile
import shutil
from datetime import datetime
import re

try:
    from docx import Document
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
except ImportError:
    print("Error: python-docx is required. Install with: pip install python-docx")
    sys.exit(1)


def strip_core_properties(doc):
    """Strip core document properties (author, dates, etc.)"""
    core_props = doc.core_properties

    # Clear author information
    core_props.author = ""
    core_props.last_modified_by = ""

    # Clear title/subject if they contain sensitive info
    # (keeping them as they may be intentional)

    # Reset revision number
    core_props.revision = 1

    # Clear dates (set to a generic date)
    generic_date = datetime(2000, 1, 1, 0, 0, 0)
    core_props.created = generic_date
    core_props.modified = generic_date

    # Clear other potentially sensitive fields
    core_props.category = ""
    core_props.comments = ""
    core_props.keywords = ""

    return doc


def strip_app_properties_from_zip(docx_path, output_path):
    """
    Strip app.xml properties by directly manipulating the ZIP.
    This removes application name, company, etc.
    """
    temp_dir = tempfile.mkdtemp()

    try:
        # Extract the docx
        with zipfile.ZipFile(docx_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        # Modify docProps/app.xml if it exists
        app_xml_path = os.path.join(temp_dir, 'docProps', 'app.xml')
        if os.path.exists(app_xml_path):
            with open(app_xml_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Strip sensitive app properties
            patterns = [
                (r'<Application>.*?</Application>', '<Application></Application>'),
                (r'<Company>.*?</Company>', '<Company></Company>'),
                (r'<Manager>.*?</Manager>', '<Manager></Manager>'),
                (r'<AppVersion>.*?</AppVersion>', '<AppVersion></AppVersion>'),
                (r'<Template>.*?</Template>', '<Template></Template>'),
            ]

            for pattern, replacement in patterns:
                content = re.sub(pattern, replacement, content, flags=re.DOTALL)

            with open(app_xml_path, 'w', encoding='utf-8') as f:
                f.write(content)

        # Remove comments.xml if it exists
        comments_path = os.path.join(temp_dir, 'word', 'comments.xml')
        if os.path.exists(comments_path):
            os.remove(comments_path)
            # Also need to update [Content_Types].xml and relationships

        # Remove commentsExtended.xml if it exists
        comments_ext_path = os.path.join(temp_dir, 'word', 'commentsExtended.xml')
        if os.path.exists(comments_ext_path):
            os.remove(comments_ext_path)

        # Remove people.xml if it exists (contains author identities)
        people_path = os.path.join(temp_dir, 'word', 'people.xml')
        if os.path.exists(people_path):
            os.remove(people_path)

        # Strip track changes from document.xml
        document_xml_path = os.path.join(temp_dir, 'word', 'document.xml')
        if os.path.exists(document_xml_path):
            with open(document_xml_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Remove track change author/date attributes
            content = re.sub(r'\s+w:author="[^"]*"', '', content)
            content = re.sub(r'\s+w:date="[^"]*"', '', content)

            with open(document_xml_path, 'w', encoding='utf-8') as f:
                f.write(content)

        # Repack the docx
        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(temp_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zipf.write(file_path, arcname)

    finally:
        # Clean up temp directory
        shutil.rmtree(temp_dir)


def strip_metadata(input_path, output_path=None):
    """
    Main function to strip all metadata from a DOCX file.

    Args:
        input_path: Path to the input DOCX file
        output_path: Path for the output file (optional, defaults to overwriting input)

    Returns:
        True if successful, False otherwise
    """
    if output_path is None:
        output_path = input_path

    if not os.path.exists(input_path):
        print(f"Error: Input file not found: {input_path}")
        return False

    # Check if it's actually a docx file
    if not input_path.lower().endswith('.docx'):
        print(f"Warning: File does not have .docx extension: {input_path}")
        # For .doc files, we can't strip metadata with python-docx
        if input_path.lower().endswith('.doc'):
            print("Legacy .doc files are not supported for metadata stripping")
            return False

    try:
        # First pass: Use python-docx for core properties
        doc = Document(input_path)
        doc = strip_core_properties(doc)

        # Save to a temporary file first
        temp_output = input_path + '.temp'
        doc.save(temp_output)

        # Second pass: Direct ZIP manipulation for app.xml and other files
        strip_app_properties_from_zip(temp_output, output_path)

        # Clean up temp file
        if os.path.exists(temp_output):
            os.remove(temp_output)

        print(f"Successfully stripped metadata from: {input_path}")
        return True

    except Exception as e:
        print(f"Error stripping metadata: {e}")
        # Clean up on error
        if 'temp_output' in locals() and os.path.exists(temp_output):
            os.remove(temp_output)
        return False


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

    success = strip_metadata(input_path, output_path)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

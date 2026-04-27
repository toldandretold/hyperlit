#!/usr/bin/env python3
"""
Add a new conversion regression test fixture.

Copies debug_converted.html from a source directory, runs process_document.py
to generate current outputs, and saves golden files + manifest.

Usage:
    # From a book's original_files directory
    python3 tests/conversion/add_fixture.py \\
        --name "peerreview2027" \\
        --source "peerreview2027/original_files" \\
        --description "Bracket citations, garbled OCR prefixes"

    # From resources/markdown/ (after a PDF import)
    python3 tests/conversion/add_fixture.py \\
        --name "accumulation_amin" \\
        --source "resources/markdown/SOME-UUID" \\
        --description "Numbered footnotes, em-dash repeat-author"
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.join(SCRIPT_DIR, 'fixtures')
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
PROCESS_SCRIPT = os.path.join(PROJECT_ROOT, 'app', 'Python', 'process_document.py')


def main():
    parser = argparse.ArgumentParser(description='Add a new conversion regression test fixture')
    parser.add_argument('--name', required=True, help='Fixture name (e.g. peerreview2027)')
    parser.add_argument('--source', required=True,
                        help='Path to directory containing debug_converted.html (absolute or relative to project root)')
    parser.add_argument('--description', required=True, help='Short description of this fixture')
    parser.add_argument('--book-id', help='Book ID for processing (defaults to fixture name)')
    args = parser.parse_args()

    # Resolve source path
    source_dir = args.source
    if not os.path.isabs(source_dir):
        source_dir = os.path.join(PROJECT_ROOT, source_dir)

    input_html = os.path.join(source_dir, 'debug_converted.html')
    if not os.path.isfile(input_html):
        print(f'Error: {input_html} not found')
        sys.exit(1)

    book_id = args.book_id or args.name
    fixture_dir = os.path.join(FIXTURES_DIR, args.name)
    golden_dir = os.path.join(fixture_dir, 'golden')

    if os.path.exists(fixture_dir):
        print(f'Warning: Fixture directory already exists: {fixture_dir}')
        response = input('Overwrite? [y/N] ').strip().lower()
        if response != 'y':
            print('Aborted.')
            sys.exit(0)
        shutil.rmtree(fixture_dir)

    os.makedirs(golden_dir, exist_ok=True)

    # Copy input HTML
    shutil.copy2(input_html, os.path.join(fixture_dir, 'input.html'))
    print(f'Copied input.html ({os.path.getsize(input_html)} bytes)')

    # Copy footnote_meta.json if it exists
    fn_meta = os.path.join(source_dir, 'footnote_meta.json')
    if os.path.isfile(fn_meta):
        shutil.copy2(fn_meta, os.path.join(fixture_dir, 'footnote_meta.json'))
        print('Copied footnote_meta.json')

    # Run the pipeline to generate golden outputs
    print(f'Running pipeline with book_id={book_id}...')

    with tempfile.TemporaryDirectory(prefix=f'conv_fixture_{args.name}_') as tmp_dir:
        # Copy footnote_meta.json to tmp_dir if it exists
        if os.path.isfile(fn_meta):
            shutil.copy2(fn_meta, os.path.join(tmp_dir, 'footnote_meta.json'))

        result = subprocess.run(
            [sys.executable, PROCESS_SCRIPT, os.path.join(fixture_dir, 'input.html'), tmp_dir, book_id],
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            print(f'Pipeline failed (exit code {result.returncode}):')
            print(result.stderr[-1000:] if result.stderr else result.stdout[-1000:])
            shutil.rmtree(fixture_dir)
            sys.exit(1)

        # Copy golden outputs
        for filename in ['references.json', 'audit.json']:
            src = os.path.join(tmp_dir, filename)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(golden_dir, filename))
                print(f'  golden/{filename} ({os.path.getsize(src)} bytes)')

        # Read conversion stats for manifest
        stats_path = os.path.join(tmp_dir, 'conversion_stats.json')
        if os.path.isfile(stats_path):
            stats = json.load(open(stats_path))
        else:
            stats = {}

        # Read audit for gap count
        audit_path = os.path.join(tmp_dir, 'audit.json')
        audit_gaps = 0
        if os.path.isfile(audit_path):
            audit = json.load(open(audit_path))
            audit_gaps = len(audit.get('gaps', []))

    # Create manifest
    manifest = {
        'name': args.name,
        'description': args.description,
        'book_id': book_id,
        'citation_style': stats.get('citation_style', 'unknown'),
        'footnote_strategy': stats.get('footnote_strategy', 'unknown'),
        'expected': {
            'references_count': stats.get('references_found', 0),
            'citations_linked': stats.get('citations_linked', 0),
            'citations_total': stats.get('citations_total', 0),
            'footnotes_count': stats.get('footnotes_matched', 0),
            'audit_gaps': audit_gaps,
        },
    }

    manifest_path = os.path.join(fixture_dir, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=4, ensure_ascii=False)

    print(f'\nFixture created: {fixture_dir}')
    print(f'  References: {manifest["expected"]["references_count"]}')
    print(f'  Citations: {manifest["expected"]["citations_linked"]}/{manifest["expected"]["citations_total"]}')
    print(f'  Footnotes: {manifest["expected"]["footnotes_count"]}')
    print(f'  Strategy: {manifest["footnote_strategy"]}')
    print(f'  Style: {manifest["citation_style"]}')
    print(f'\nRun tests: python3 tests/conversion/run_regression.py')


if __name__ == '__main__':
    main()

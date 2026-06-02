#!/usr/bin/env python3
"""
Enumerate resources/markdown/ book dirs, dedup by underlying SOURCE-file content
(the dir names are meaningless — many are the same book re-converted), and report
the distinct sources plus which fixture pathways are already covered.

Output JSON: {"books": [{"book": <repr-dir>, "pipeline": <type>}...], "covered": [<slug>...]}
Used as phase 0 of the fixture-harvest workflow.
"""

import hashlib
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
MARKDOWN_DIR = os.path.join(PROJECT_ROOT, 'resources', 'markdown')
FIXTURES_DIR = os.path.join(SCRIPT_DIR, 'fixtures')


def _sha1_file(fp):
    h = hashlib.sha1()
    with open(fp, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def _sha1_dir(d):
    h = hashlib.sha1()
    for root, _, files in os.walk(d):
        for fn in sorted(files):
            fp = os.path.join(root, fn)
            h.update(os.path.relpath(fp, d).encode())
            try:
                h.update(_sha1_file(fp).encode())
            except OSError:
                pass
    return h.hexdigest()


def _source(book_dir):
    if os.path.isfile(os.path.join(book_dir, 'ocr_response.json')):
        return 'pdf', _sha1_file(os.path.join(book_dir, 'ocr_response.json'))
    if os.path.isdir(os.path.join(book_dir, 'epub_original')):
        return 'epub', _sha1_dir(os.path.join(book_dir, 'epub_original'))
    for ext in ('docx', 'doc'):
        if os.path.isfile(os.path.join(book_dir, f'original.{ext}')):
            return 'docx', _sha1_file(os.path.join(book_dir, f'original.{ext}'))
    if os.path.isfile(os.path.join(book_dir, 'original.html')):
        return 'html', _sha1_file(os.path.join(book_dir, 'original.html'))
    if os.path.isfile(os.path.join(book_dir, 'original.md')):
        return 'md', _sha1_file(os.path.join(book_dir, 'original.md'))
    return None, None


def covered_slugs():
    slugs = set()
    if not os.path.isdir(FIXTURES_DIR):
        return slugs
    for root, dirs, files in os.walk(FIXTURES_DIR):
        if 'manifest.json' in files:
            dirs[:] = []
            rel = os.path.relpath(root, FIXTURES_DIR).split(os.sep)
            if len(rel) >= 2:
                slugs.add('/'.join(rel[:2]))
    return slugs


def main():
    groups = {}
    for d in sorted(os.listdir(MARKDOWN_DIR)):
        p = os.path.join(MARKDOWN_DIR, d)
        if not os.path.isdir(p):
            continue
        try:
            pipe, h = _source(p)
        except Exception:
            continue
        if not pipe:
            continue
        groups.setdefault((pipe, h), []).append(d)

    books = []
    for (pipe, _), dirs in groups.items():
        # representative: prefer a meaningfully-named dir over an auto-named book_<ts>/uuid
        rep = sorted(dirs, key=lambda b: (b.startswith('book_'), '-' in b and len(b) == 36, len(b)))[0]
        books.append({'book': rep, 'pipeline': pipe})
    books.sort(key=lambda b: (b['pipeline'], b['book']))

    print(json.dumps({'books': books, 'covered': sorted(covered_slugs())}))


if __name__ == '__main__':
    main()

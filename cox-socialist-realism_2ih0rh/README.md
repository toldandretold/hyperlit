# cox-socialist-realism_2ih0rh — Complete Export
Exported: 2026-07-10T01:45:03.768Z

## Overview
This folder contains the complete data for this book in markdown and JSON.

## `postgresql_data/`
Server-side data exported as JSON. Contains:
- **nodes** — hypertext nodes (from books, hyperlights and footnotes)
- **footnotes** — footnote meta data
- **hypercites** — cross-references between books
- **hyperlights** — hyperlight meta data
- **highlights** — user highlights and annotations
- **bibliography** — citation data

## `original_files/`
Contains the original source file (PDF) and all intermediate
conversion artifacts. These can be used locally to re-run or modify the conversion.

## `blackBox/`
Server and browser side backups. See `blackBox/README.md` for details.

## Conversion scripts
Source code for the conversion pipeline:

- [app/Python/mistral_ocr.py](https://github.com/toldandretold/hyperlit/blob/main/app/Python/mistral_ocr.py) — PDF → markdown via Mistral OCR
- [app/Python/process_document.py](https://github.com/toldandretold/hyperlit/blob/main/app/Python/process_document.py) — HTML post-processing & sanitisation
- [app/Http/Controllers/ConversionController.php](https://github.com/toldandretold/hyperlit/blob/main/app/Http/Controllers/ConversionController.php) — markdown ↔ HTML + highlight position tracking

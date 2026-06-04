"""Ingestion — read each input format and turn it into the common form the shared pipeline
(digestion) consumes (HTML, or markdown-then-HTML). One sub-package per format; each detects a
format-specific "type" (a PDF footnote LAYOUT, an EPUB footnote SCHEME) on the way. See README.md."""

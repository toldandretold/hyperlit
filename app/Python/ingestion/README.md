# ingestion/ — read a format, produce the common input

**Eat the food.** Each sub-folder reads ONE input format and turns it into the form the shared pipeline
(`digestion/`) consumes: **HTML**, or **markdown that then becomes HTML**. The split exists because the
formats are wildly different *on the way in* — but identical *once they're HTML*. So format-specific
work lives here; everything after "it's now HTML" lives in `digestion/`.

Each reader also DETECTS a format-specific "type" on the way, which drives downstream linking.

| sub-folder | reads | how it detects footnotes | produces |
|---|---|---|---|
| `pdf/` | a PDF (via Mistral OCR) | physical **LAYOUT** — co-location / clustering / resets, because OCR'd text has no markup | markdown of a footnote layout → (then `markdown_and_pdf_to_html/`) |
| `epub/` | an EPUB | semantic **SCHEME** — `epub:type` / ARIA role / CSS class / anchor-heading / table | `main-text.html` of a footnote scheme |
| `html/` | raw / arXiv HTML | (ar5iv/LaTeXML markup only; raw HTML passes straight through) | normalised HTML |
| `word/` | a `.docx` | (none here — pandoc emits footnotes; detection happens downstream) | HTML (via pandoc) |
| `markdown_and_pdf_to_html/` | markdown | `[^N]` markers → section markers | the common HTML |

## Why the sub-folders differ

- **`pdf/` is the odd one out**: a scanned/OCR'd PDF has *no semantic markup*, so it must guess the
  footnote layout from physical signals (are the marker and note on the same page? do numbers restart
  per chapter? are definitions clustered at the end?). Per-page / per-chapter **renumbering** is a
  PDF-only concern and lives here. It also carries the most machinery (OCR fetch, classify, assemble,
  three recovery layers, a fidelity self-check).
- **`epub/` detects by MARKUP, not layout** — an EPUB is structured XHTML, so it identifies footnotes
  by their tags/attributes/classes. There are no "pages", so page-bottom-vs-end-of-doc distinctions
  don't apply; the *structure* (per-chapter vs one list) is inferred later by digestion's strategy step.
- **`html/` is mostly a pass-through** — only arXiv/ar5iv HTML needs translation to Hyperlit
  conventions; ordinary HTML goes straight to digestion.
- **`word/` delegates to pandoc** — `strip_docx_metadata.py` only cleans the `.docx`; pandoc does the
  actual `.docx → HTML`. (Word's page-bottom vs endnote distinction is lost in that conversion.)
- **`markdown_and_pdf_to_html/` is a CONVERGENCE** — both the Markdown pathway *and* the PDF pathway
  (after OCR → markdown) funnel through `simple_md_to_html.py` to become the common HTML. It is not
  "markdown's" — it's the shared on-ramp for the two markdown-producing formats.

## Compatibility shims

The live backend invokes these readers by their OLD flat paths (`PdfProcessor` → `app/Python/mistral_ocr.py`,
etc.). Thin re-export **shims** remain at those old paths so the queue workflows keep working unchanged;
the real code is here. See the shim header comment in e.g. `app/Python/mistral_ocr.py`.

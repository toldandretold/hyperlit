# Pipeline structure — GENERATED from the folders

> Built by `gen_pipeline_tree.py` from the actual `app/Python/{ingestion,digestion,shared}/`
> tree + the decision registries in each module. Do NOT hand-edit — re-run the generator. A
> no-drift test pins it. (43 per-unit `plain` notes feed the LLM report + the viewer.)

## ingestion/ — read each input format → the common HTML (one folder per format)
```
epub/
  bibliographyDetection.py — Phase 3 — bibliography section DETECTION (finds the references/bibliography section in t…
  epub_base.py — Zero-import leaf — the EpubTransform base class ONLY
  epub_normalizer.py — EPUB ingestion orchestrator — runs TRANSFORM_PIPELINE to turn an .epub into main-text.html  · registries: TRANSFORM_PIPELINE
  finalNormalisation.py — Phase 4 — final normalisation
  footnoteMatching.py — Phase 2 — footnote matching
  headingMatching.py — Phase 1 — heading matching
  structuralNormalisation.py — Phase 1 — structural normalisation
html/
  ar5iv_preprocessor.py — ar5iv → Hyperlit preprocessor
markdown_and_pdf_to_html/
  simple_md_to_html.py — Really simple Markdown to HTML converter that treats footnotes as plain text
pdf/
  assembly.py — Phase ② — assemble the markdown per layout  · registries: PDF_ASSEMBLERS
  classification.py — Phase ① — decide the PDF footnote LAYOUT  · registries: PDF_CLASSIFIERS
  mistral_ocr.py — Convert a PDF to markdown using Mistral OCR
  ocrFetch.py — Phase ⓪ — Mistral OCR acquisition: fetch the OCR JSON (chunking PDFs over the 50MB API l…
  pdf_shared.py — Zero-import leaf — shared PDF substrate: superscript map, the OCR/text-normalisation hel…
  recovery.py — Phase ③ — footnote RECOVERY + fidelity: resurrect mangled/missed notes from the PDF byte…
word/
  strip_docx_metadata.py — Strip metadata from DOCX files for privacy and security
```

## digestion/ — the shared pipeline over that HTML: extract → link → audit → emit
```
process_document.py — Digestion orchestrator — runs the DOC_PASSES pipeline over the ingested HTML  · registries: DOC_PASSES
bibliographyExtraction/
  bibliography.py — Bibliography / reference-list extraction (PASS 1A)
citationLinking/
  citation_link_rules.py — Citation linking as an ordered `LinkRule` registry (Decomposition C of the LINKING-layer…  · registries: CITATION_LINK_RULES
  citations.py — Citation linking: wrap in-text references like (Author 2009) / [Author 2009] in <a class…
finalAudit/
  audit.py — Footnote-linking audit: detect gaps, duplicates, and unmatched refs/defs
footnoteExtraction/
  footnotes.py — Footnote extraction by strategy (whole-document and sequential)
footnoteLinking/
  footnote_link_rules.py — EPUB footnote LINKING as an ordered registry of LinkRule units (was the monolithic `Foot…  · registries: FOOTNOTE_LINK_RULES, MARKER_LINK_RULES
strategySelection/
  strategy.py — Footnote-strategy selection + the numbering-linkability guard + bibliography-heading det…  · registries: STRATEGY_RULES
```

## shared/ — cross-cutting helpers used by both ingestion and digestion
```
assessment.py — The conversion decision-trace collector
link_base.py — Shared base for the LINKING-stage rule registries
pipeline_base.py — Shared base for the ORCHESTRATION-stage pass registry
refkeys.py — Citation reference-key generation + bibliography-entry detection
sanitize.py — HTML sanitization + inner-HTML extraction
```

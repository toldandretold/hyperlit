# Pipeline structure — GENERATED from the folders

> Built by `gen_pipeline_tree.py` from the actual `app/Python/{ingestion,digestion,shared}/`
> tree + the decision registries in each module. Do NOT hand-edit — re-run the generator. A
> no-drift test pins it. (42 per-unit `plain` notes feed the LLM report + the viewer.)

## ingestion/ — read each input format → the common HTML (one folder per format)
```
epub/
  bibliographyDetection.py
  epub_base.py
  epub_normalizer.py   · registries: TRANSFORM_PIPELINE
  finalNormalisation.py
  footnoteMatching.py
  headingMatching.py
  structuralNormalisation.py
html/
  ar5iv_preprocessor.py
markdown_and_pdf_to_html/
  simple_md_to_html.py
pdf/
  mistral_ocr.py   · registries: PDF_CLASSIFIERS, PDF_ASSEMBLERS
word/
  strip_docx_metadata.py
```

## digestion/ — the shared pipeline over that HTML: extract → link → audit → emit
```
process_document.py   · registries: DOC_PASSES
bibliographyExtraction/
  bibliography.py
citationLinking/
  citation_link_rules.py   · registries: CITATION_LINK_RULES
  citations.py
finalAudit/
  audit.py
footnoteExtraction/
  footnotes.py
footnoteLinking/
  footnote_link_rules.py   · registries: FOOTNOTE_LINK_RULES, MARKER_LINK_RULES
strategySelection/
  strategy.py   · registries: STRATEGY_RULES
```

## shared/ — cross-cutting helpers used by both ingestion and digestion
```
assessment.py
link_base.py
pipeline_base.py
refkeys.py
sanitize.py
```

# The import-conversion decision tree

> **The folder layout IS the tree** (Phase 2 reorg): `app/Python/ingestion/<format>/` reads each format
> into common HTML; `app/Python/digestion/<stage>/` is the shared pipeline over it; `app/Python/shared/`
> is cross-cutting. The structure is therefore GENERATED from the folders —
> [`PIPELINE_STRUCTURE.generated.md`](PIPELINE_STRUCTURE.generated.md) (by `gen_pipeline_tree.py`), and
> the per-node notes from each unit's `plain` attribute ([`pipeline_notes.json`](pipeline_notes.json) by
> `gen_pipeline_tree.py`/`gen_pipeline_notes.py`). Both are drift-gated by `unit/test_pipeline_map.py`.
> The live backend still invokes the old flat script paths via thin re-export shims (see each shim's
> header). `pipeline_map.json` remains the data the completeness gate enforces; this page is the
> hand-drawn Mermaid of the decision FLOW (gates/branches), which folders alone don't capture.

**The one meta-insight (drives diagnosis):** every **frontend's** job is to produce the **backend's
input**. `process_document.py` is *HTML-in*. So `epub` / `html` / `docx` converge straight to HTML;
`pdf` / `md` take a **markdown detour** first. The *type* each frontend detects — a PDF footnote
**layout**, an EPUB footnote **scheme**, a document **strategy** — is what drives downstream linking.

> **Corollary:** if an expected artifact (a footnote, a citation) is **absent from the frontend's
> intermediate** (`main-text.md` for PDF, `main-text.html` for EPUB), the bug is **UPSTREAM in that
> frontend**. If it's **present in the intermediate but unlinked**, the bug is **downstream in the
> backend linker**. Localize before editing.

> **The PDF frontend mechanizes that corollary** via `assess_harvest_fidelity` (the `pdf.fidelity`
> node, after the assemblers). For footnotes the "absent vs present" split is three-way, and the check
> emits which one into `assessment.json` so the vibe loop routes correctly — it compares what the OCR
> captured (`page_summary` refs/defs) against what we emitted (the markdown):
>
> | verdict | meaning | whose bug | flagged? |
> |---|---|---|---|
> | `harvest_gap` | OCR captured the defs, our assembler dropped them | ours (fix harvest) | ⚑ yes |
> | `assembly_collisions` | defs emitted but global numbers aren't unique | ours (fix numbering/offset) | ⚑ yes |
> | `fidelity_loss` | OCR itself lost the defs the body references | upstream OCR ceiling | no |
> | `clean` / `no_footnotes` / `not_applicable` | nothing to fix (or non-harvesting layout) | — | no |
>
> "Demand" is anchored on the in-text **markers** (refs), not the raw def-line count — def-shaped
> lines are inflated by numbered-list noise, so a book with 0 real footnotes can show 400 `N.` lines.
> Only the two genuinely-ours buckets raise the `confidence < 0.5` flag the vibe loop chases.
>
> **`fidelity_loss` is not a dead end — it's the bucket the pypdf resurrection targets.** Before this
> verdict gives up, three layers have already tried to claw the notes back: the `.46 This`→`[^46]`
> regex (`convert_footnotes`), `scan_footnote_mojibake` (re-OCRs garbled pages via pypdf), and the
> `assemble_markdown` pypdf fallback (refs with no def → pulled from the PDF bytes). The fidelity record
> reads their outcome (`footnote_warnings`): `pypdf_unrecovered > 0` = pypdf **also** failed →
> *confirmed* upstream; `pypdf_recovery_attempted = false` = no source PDF in this run → *untested*, the
> real import may still recover some. The pypdf layers need the actual PDF, so they only run live (and
> in the opt-in `test_pdf_recovery_real.py`, `RUN_PYPDF_RECOVERY=1`); the replay harness uses
> `pdf_path=None` for determinism, which is the blind spot that test exists to cover.

---

## The live pathway

```mermaid
flowchart TD
    IMPORT([Import a file]) --> EXT{file extension?}

    subgraph CONV["① Turn the file into a common input"]
      direction TB
      EXT -->|.epub| EPUB["epub_normalizer.py<br/>footnote SCHEME · TRANSFORM_PIPELINE → FOOTNOTE_LINK_RULES<br/>→ main-text.html"]
      EXT -->|".html / .htm"| HTMLP["ar5iv_preprocessor.py<br/>arXiv only; else raw HTML"]
      EXT -->|".docx / .doc"| DOCXP["strip_docx_metadata.py + pandoc"]
      EXT -->|".md / .zip"| MDIN(["markdown input"])

      EXT -->|.pdf| OCR["mistral_ocr.py · Mistral OCR → ocr_response.json"]
      OCR --> SIG["classify_footnotes → PDF_CLASSIFIERS<br/>signals: co-location · reset-freq · def-clustering · ref-spread"]
      SIG --> G1{"any in-text refs?"}
      G1 -.->|"no ∅"| X_NONE["none → DefaultAssembler"]
      G1 -->|yes| G2{"ref-spread ≥3 · co-loc under .2 · no Notes?"}
      G2 -->|yes| X_STEM["wackSTEMbibliographyNotes → WackStemAssembler<br/>post: wrap numbered citations + definitions"]
      G2 -->|no| G3{"co-loc over .4 · resets under .1 · maxref over 10?<br/>(or co-loc over .5 · resets over .4)"}
      G3 -->|yes| X_PB["page_bottom → PageBottomAssembler<br/>per-page: renumber + split body from defs<br/>post: rejoin body + append definitions"]
      G3 -->|no| G4{"Notes header · or resets · co-loc under .3?"}
      G4 -->|yes| X_CH["chapter_endnotes → ChapterEndnotesAssembler<br/>setup: per-chapter offsets + notes transitions<br/>per-page: convert + apply offset · post: fix + rejoin"]
      G4 -->|no| G5{"co-loc under .15 · def-clustering under .1?"}
      G5 -->|yes| X_DOC["document_endnotes → DocumentEndnotesAssembler<br/>per-page: convert bracket refs · post: fix + rejoin"]
      G5 -.->|"no ✗"| X_UNK["unknown → DefaultAssembler<br/>post: normalize refs/defs + rejoin"]

      X_NONE --> REC1
      X_STEM --> REC1
      X_PB --> REC1
      X_CH --> REC1
      X_DOC --> REC1
      X_UNK --> REC1
      subgraph RECOV["footnote RECOVERY — resurrect mangled/missed notes (test_footnote_recovery.py + test_pdf_recovery_real.py)"]
        direction TB
        REC1["①markers · normalize_all_footnote_refs<br/>superscript / $^5$ / [N] / bare .46 → [^N]<br/>sequence-validated · NO pdf"]
        REC2["②mojibake defs · scan_footnote_mojibake<br/>re-OCR garbled def pages via pypdf · NEEDS pdf<br/>(runs pre-assembly) → footnote_warnings"]
        REC3["③missing defs · recover_missing_defs<br/>ref with no def → pull from pypdf · NEEDS pdf<br/>matcher = pure logic · rejects mojibake"]
        REC1 --> REC2 --> REC3
      end
      REC3 --> FID{"harvest-fidelity check<br/>assess_harvest_fidelity · whose bug is it?<br/>reads footnote_warnings → assessment.json"}
      FID -.->|"clean · no_footnotes · not_applicable"| PDFMD
      FID -->|"harvest_gap ⚑ · assembly_collisions ⚑ (OUR bug → vibe loop)"| PDFMD
      FID -.->|"fidelity_loss (only CONFIRMED once ② ③ pypdf also failed)"| PDFMD
      PDFMD(["main-text.md"]) --> M2H["simple_md_to_html.py"]
      MDIN --> M2H
    end

    EPUB -->|main-text.html| BIB
    M2H -->|intermediate.html| BIB
    HTMLP -->|html| BIB
    DOCXP -->|html| BIB

    subgraph CORE["② Shared processing — process_document.py · DOC_PASSES"]
      direction TB
      BIB["parse HTML · is_stem? · extract_bibliography · bibliography.py"]
      BIB --> STRAT{"choose strategy · STRATEGY_RULES<br/>analyze_document_structure"}
      STRAT -->|"sequential · whole_document · sectioned"| EXFN["extract footnote definitions<br/>footnotes.py + detect_footnote_sections"]
      STRAT -.->|"no_footnotes ✗ · pre_processed ∅"| EXFN
      EXFN --> GUARD{"is the numbering linkable?<br/>_footnote_numbering_is_linkable"}
      GUARD -.->|"no ∅ — extract notes, emit NO links"| EMIT
      GUARD -->|yes| LINK["link citations · CITATION_LINK_RULES<br/>link footnote markers → defs · MARKER_LINK_RULES"]
      LINK --> AUDIT["compute_footnote_audit — the verdict · audit.py"]
      AUDIT --> EMIT["nodes.jsonl · footnotes.jsonl · references.json<br/>audit.json · conversion_stats.json · assessment.json"]
    end
```

## The tree (ASCII, with dead-ends ✗ and no-ops ∅)

```
IMPORT ─ by file extension  (ProcessDocumentImportJob match)
├─ FRONTEND  (normalize → the backend's input; DETECT a "type")
│  ├─ EPUB  epub_normalizer.py        GOAL → main-text.html  (HTML of a footnote SCHEME)
│  │     TRANSFORM_PIPELINE: structural-normalise → footnote-detect
│  │       {epub3_semantic|aria_role|class_pattern|anchor_heading|notes_class|
│  │        endnote_characters|table|heuristic | pre_processed ∅ | none ✗}  → FOOTNOTE_LINK_RULES
│  ├─ PDF   mistral_ocr.py             GOAL → main-text.md   (MARKDOWN of a footnote LAYOUT)
│  │     OCR→ocr_response.json ∅replay · PDF_CLASSIFIERS {none|page_bottom|chapter_endnotes|
│  │       document_endnotes|wackSTEMbibliographyNotes | unknown ✗} · renumber[cond] · segments ·
│  │       PDF_ASSEMBLERS(per layout) ·
│  │       RECOVERY ①markers normalize_all_footnote_refs (no pdf) · ②mojibake scan_footnote_mojibake
│  │         (pypdf, needs pdf) · ③missing-def recover_missing_defs (pypdf, needs pdf) ·
│  │       assess_harvest_fidelity {clean|harvest_gap⚑|assembly_collisions⚑|fidelity_loss|
│  │         not_applicable | no_footnotes ∅}  →assessment.json  → simple_md_to_html.py
│  │     [tests: test_footnote_recovery.py · test_pdf_recovery_real.py(opt-in) · test_harvest_fidelity.py]
│  ├─ MD    simple_md_to_html.py → intermediate.html
│  ├─ HTML  ar5iv_preprocessor.py (arXiv only, else raw) → html
│  └─ DOCX  strip_docx_metadata.py + pandoc → html
└─ BACKEND  process_document.py (DOC_PASSES)  GOAL → nodes + footnotes + references + audit + assessment
   ├─ Load (+footnote_meta→is_stem) · [STEM wackSTEM branch]
   ├─ EXTRACT  bibliography.py(extract_bibliography) · strategy.py(analyze_document_structure →
   │           STRATEGY_RULES {sequential|whole_document|sectioned | no_footnotes ✗ | pre_processed ∅})
   │           · footnotes.py + strategy.py(detect_footnote_sections)
   │           · _footnote_numbering_is_linkable  [GUARD → extract-but-DON'T-link ∅]
   ├─ LINK     citations.py→CITATION_LINK_RULES · footnotes.py→MARKER_LINK_RULES
   ├─ AUDIT    audit.py(compute_footnote_audit → verdict)
   └─ EMIT     GenerateNodeChunks → sanitize.py → *.jsonl / references.json
```

## Per-pathway goal (what each frontend produces, and the type it detects)

| filetype | frontend script | invoked by | intermediate goal | type detected |
|---|---|---|---|---|
| **epub** | `epub_normalizer.py` | `EpubProcessor.php:173` | `main-text.html` | footnote **scheme** (`TRANSFORM_PIPELINE`) |
| **pdf** | `mistral_ocr.py` → `simple_md_to_html.py` | `PdfProcessor.php:61` | `main-text.md` → html | footnote **layout** (`PDF_CLASSIFIERS`) |
| **md / zip** | `simple_md_to_html.py` | `MarkdownProcessor.php:95` | `intermediate.html` | (markers → sequential strategy) |
| **html** | `ar5iv_preprocessor.py` (cond.) | `HtmlProcessor.php:75` | normalised html | ar5iv/LaTeXML vs raw |
| **docx** | `strip_docx_metadata.py` + pandoc | `PandocConversionJob.php:45` | html | — |
| **(all)** | `process_document.py` | 4 processors | nodes/footnotes/references | **strategy** (`STRATEGY_RULES`) |

## Decision registries (the open/closed extension points — `op:register` targets)

| registry | file | band | of |
|---|---|---|---|
| `TRANSFORM_PIPELINE` | `epub_normalizer.py` | frontend | EpubTransform footnote/structure detectors |
| `PDF_CLASSIFIERS` | `mistral_ocr.py` | frontend | PdfClassifier (footnote layout) |
| `PDF_ASSEMBLERS` | `mistral_ocr.py` | frontend | FootnoteAssembler (per layout) |
| `DOC_PASSES` | `process_document.py` | backend | DocPass (ordered backend passes) |
| `STRATEGY_RULES` | `conversion/strategy.py` | backend | StrategyRule (strategy decision) |
| `CITATION_LINK_RULES` | `conversion/citation_link_rules.py` | backend | LinkRule (citation linking) |
| `MARKER_LINK_RULES` | `conversion/footnote_link_rules.py` | backend | LinkRule (in-text marker linking) |
| `FOOTNOTE_LINK_RULES` | `conversion/footnote_link_rules.py` | backend/frontend | LinkRule (epub footnote linking) |

## Shared libraries (cross-cutting, every backend stage)

`conversion/refkeys.py` (citation keys) · `conversion/sanitize.py` (HTML/URL sanitise) ·
`conversion/assessment.py` (the decision trace → `assessment.json`) ·
`conversion/pipeline_base.py` (`DocPass`) · `conversion/link_base.py` (`LinkRule`).

---

## Appendix — modules NOT in the live import pathway (accounted for, flagged)

The completeness gate forces these to be classified too. They are the "dead ends" of the *codebase*.

### Other subsystems (live, but not import-conversion)
- `vibe_convert.py` · `vibe_aider.py` · `vibe_aider_gate.py` · `conversion/fix_categories.py` — the
  **vibe self-improving loop** (invoked by `VibeConversionJob.php`, not by an import).
- `footnote-jason.py` — the **footnotes-refresh** endpoint (`FootnotesController.php:50`).

### Legacy / superseded (still on disk — deletion candidates)
- `html_footnote_processor.py`, `preprocess_html.py` — the old HTML path; **superseded by
  `process_document.py`** (the "legacy pair" comment, `HtmlProcessor.php:106-116`).
- `epub_processor.py` — superseded by `epub_normalizer.py` (only named in a stale comment).
- `process_footnotes.py` ("STANDALONE") · `process_references.py` ("DEFINITIVE VERSION") — standalone
  pre-decomposition versions of `conversion/footnotes.py` / `conversion/bibliography.py`.

### Dead orphans (no references anywhere — deletion candidates)
- `extract_text.py` (hardcodes `king2019imperialism.pdf`) · `normalize_headings.py` · `resume.py`
  (a markdown→pdf PoC; `convert_markdown_to_pdf` is never called).

> Removing the 8 legacy/dead modules would de-clutter `app/Python` and stop them confusing the vibe
> loop's `code_ref` routing — a candidate follow-up, tracked here so they're never mistaken for live.

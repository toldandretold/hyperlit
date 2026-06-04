# digestion/ — the shared pipeline that processes the common HTML

**Break it down.** Once ingestion has turned any format into HTML, ONE shared, format-agnostic pipeline
does the rest. `process_document.py` is the orchestrator (an ordered list of `DocPass` steps,
`DOC_PASSES`); the stage sub-folders hold the code each step calls, in the tree's order:

| stage folder | what it decides / does |
|---|---|
| `bibliographyExtraction/` | find the reference list, give each entry an id (the targets in-text citations point at) |
| `strategySelection/` | is the footnote numbering one end-list (`whole_document`), per-section (`sectioned`), explicit (`sequential`), or none? — decides HOW markers wire to definitions |
| `footnoteExtraction/` | pull the footnote DEFINITIONS out, by the chosen strategy (this file also holds the marker→definition linker) |
| `footnoteLinking/` | the `LinkRule` registries that wire in-text markers to definitions (also used by `ingestion/epub/`) |
| `citationLinking/` | turn each `(Author Year)` into a link to its bibliography entry |
| `finalAudit/` | the verdict — did every marker find its definition, no gaps or orphans? |

(Node-chunking + sanitise + write — the EMIT tail — currently live inside `process_document.py`.)

Why this is one shared stage and not per-format: a footnote is a footnote once it's HTML. Only the
*reading* differs (that's `ingestion/`); the *linking/auditing* is identical for every format, so it is
written once here. The live backend invokes `process_document.py` by its old flat path (the processors),
so a thin re-export shim remains at `app/Python/process_document.py`.

# What to hand over for the `phase2-pathways` corpus

The study now tests the app's REAL conversions. Every book is adopted from an actual source file and tagged with the pathway it came through, so results can say "the citation review scores X via PDF, Y via markdown, Z via paste" instead of measuring one artificial round-trip.

Drop files anywhere (e.g. `~/Downloads/phase2/`) and tell me the paths — I run the adopt/import/run commands.

## 1. The A/B set — 2–3 documents, EACH in several formats

This is the valuable part: the same text through different pathways isolates conversion quality from document difficulty. For each chosen article, as many of these as you can get:

- **Paste capture** — open `resources/paste-capture.html` as a local file (`open resources/paste-capture.html`, NOT a localhost URL), copy the article from the publisher page, Cmd+V into the drop zone, Download. Hand me the `.html`. This is the same flow as the paste regression fixtures.
- **Publisher PDF** of the same article.
- **Markdown** version if you have one (a pandoc export is fine — I'll note it in provenance).

Good candidates are articles with plenty of citations and a real bibliography. Chacko is an obvious one since we know its behaviour cold, but anything comparable works.

## 2. Single-pathway documents — breadth

- **PDFs**: 2–3 more, ideally varied (a journal article, a report with footnotes, something OCR-heavy like a scan).
- **Word docs of your own work**, including **the one with the dangling citation** (cited in text, missing from the bibliography). That one is the most valuable single file in the set: a real-world defect nobody engineered. Don't fix it first.
- **HTML**: a saved publisher/news article page (`.html`, not `.htm` — the upload allowlist only takes the long form).

## 3. Optional but useful

- An EPUB with citations — the pathway is plumbed but untested for study use.
- Anything you already suspect converts badly. A known-bad conversion is a better test than a clean one.

## What happens to each file

```
citation:study:adopt phase2-pathways --file=<path> --pathway=<pdf|markdown|html|docx|epub|paste> \
    --arm=control --slug=<name> --title="…" --author="…" --year=YYYY
citation:study:corrupt phase2-pathways --book=<slug>   # builds the ground-truth skeleton
citation:study:import  phase2-pathways --book=<slug>   # runs the REAL conversion pipeline
citation:study:run     phase2-pathways --book=<slug>   # costs money — one book at a time
```

Then you adjudicate in `/maintainer/study`, which now shows each book's pathway and flags citations whose own anchor looks mislinked.

A/B documents get one slug per pathway (`smith-2024-pdf`, `smith-2024-paste`, `smith-2024-md`) sharing a `document_group` in provenance so the report can pair them.

## Notes

- **Cost**: each run bills the study user (LLM + OCR for PDFs). We do them one at a time with your go-ahead.
- **Brave Search quota**: currently **exhausted** (HTTP 402, monthly $20 cap). Web-source resolution is dark until it resets or the cap is raised, and runs made now will under-resolve web citations — worth fixing before the phase2 runs, or the numbers understate the system.
- The synthetic arm still needs markdown sources (the corruptor edits text); PDFs/docx/paste go in the control or retracted arms and get their ground truth from the imported rows.

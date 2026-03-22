# Plan: `php artisan citation:review {bookId}`

## Overview

A multi-phase command that reviews every in-text citation in a book, gathers maximum context for each, uses LLM to verify truth claims against source material, and produces a structured JSON report.

---

## Phase 1: Extract Truth Claims from Book Nodes

**Input**: All nodes for `bookId` from the `nodes` table.

**Process**:
1. Query all `PgNodeChunk` rows where `book = bookId` and `content` contains `class="in-text-citation"` (reuse regex from `CitationScanContentCommand`).
2. For each node with citations, send `plainText` + citation anchors to LLM with prompt:
   > "Given this paragraph and these citation references, identify each distinct truth claim and which citation(s) support it. Return JSON array."
3. LLM returns structured data like:
   ```json
   [
     {
       "truth_claim": "Regular exercise reduces cardiovascular mortality by 30%",
       "citation_ids": ["ref42", "ref43"]
     }
   ]
   ```

**Output**: Initial review JSON array:
```json
[
  {
    "node_id": "abc-123",
    "citation_id": "ref42",
    "truth_claim": "Regular exercise reduces cardiovascular mortality by 30%"
  }
]
```

---

## Phase 2: Resolve Citation Metadata

**Process** (for each unique `citation_id`):
1. Look up `bibliography` table: `book = bookId, referenceId = citation_id` → get `source_id` (links to `library.book`).
2. If `source_id` exists, look up `library` table → get full metadata.
3. Enrich each entry:
   ```json
   {
     "node_id": "abc-123",
     "citation_id": "ref42",
     "truth_claim": "...",
     "verified": true,          // has openalex_id or open_library key
     "has_nodes": true,         // library.has_nodes
     "library_book_id": "uuid", // library.book
     "title": "...",
     "author": "...",
     "year": "..."
   }
   ```

---

## Phase 3: Gather Source Evidence

For each citation entry, branch based on available data:

### Path A: `has_nodes = true` (source content imported)
- Query `nodes` table for `book = library_book_id`.
- Use **PostgreSQL full-text search** (`search_vector`) to find nodes matching keywords from the truth claim.
  - Extract key terms from truth claim via `to_tsquery()`.
  - Rank results with `ts_rank()`.
  - Take top 3-5 matching passages.
- Add to JSON:
  ```json
  {
    "source_book_id": "uuid",
    "source_node_ids": ["node-1", "node-2"],
    "source_passages": ["The relevant text from node-1...", "..."]
  }
  ```

### Path B: `has_nodes = false` but `abstract` exists
- Use the abstract as the only available evidence.
- Add to JSON:
  ```json
  {
    "abstract": "The full abstract text..."
  }
  ```

### Path C: No source data available
- Mark as unverifiable:
  ```json
  {
    "source_evidence": null,
    "reason": "No source content or abstract available"
  }
  ```

---

## Phase 4: LLM Verification

For each citation entry that has evidence (Path A or B):
- Send to LLM (potentially a stronger model via Fireworks config):
  > **System**: "You are a citation verification assistant. Be accurate and impartial. You have no stake in the outcome. Just assess truthfully."
  >
  > **User**: "Truth claim: '{claim}'\n\nSource evidence: '{abstract or passages}'\n\nDoes the source evidence support this truth claim? Respond with JSON: {\"supported\": true/false/\"unclear\", \"assessment\": \"one sentence on whether meaning matches\", \"reasoning\": \"one sentence why you think so\"}"

- Add LLM response to JSON:
  ```json
  {
    "supported": true,
    "assessment": "The source confirms that regular exercise reduces cardiovascular mortality.",
    "reasoning": "The abstract reports a 28-32% reduction in CV mortality with regular exercise, consistent with the 30% claim."
  }
  ```

---

## Phase 5: Generate Report

Compile the full JSON and save to `storage/app/citation-reviews/{bookId}-{timestamp}.json`.

Also output a CLI summary:
```
Citation Review for "Book Title"
================================
Total truth claims: 47
Verified citations: 38 (81%)
  - Supported:    29
  - Not supported: 5
  - Unclear:       4
Unverified citations: 6
No evidence available: 3
```

---

## Implementation Details

### New Files
1. **`app/Console/Commands/CitationReviewCommand.php`** — The artisan command (orchestrator)
2. **`app/Services/CitationReviewService.php`** — Core logic (testable, reusable)

### LLM Configuration
- Use existing `LlmService` with two new methods:
  - `extractTruthClaims(nodeText, citationAnchors)` — Phase 1
  - `verifyCitation(truthClaim, sourceEvidence)` — Phase 4
- Optionally allow a `--model` flag to use a different/stronger Fireworks model for verification (Phase 4).

### Source Search Strategy
- **Primary**: PostgreSQL `ts_rank` full-text search (already indexed on nodes table)
- **Fallback**: Keyword extraction from truth claim → `plainto_tsquery()` search
- No vector embeddings needed — the existing tsvector infrastructure is sufficient for finding relevant passages.

### Command Signature
```
citation:review {bookId : The book ID to review citations for}
                {--limit=0 : Limit number of truth claims to process}
                {--model= : Override LLM model for verification}
                {--output= : Custom output path for JSON report}
                {--dry-run : Extract claims only, skip verification}
```

### Rate Limiting / Progress
- Use Laravel's `$this->output->progressBar()` for CLI feedback.
- Batch LLM calls with small delays to respect Fireworks rate limits.
- Write intermediate JSON after each phase so work isn't lost on failure.

### Error Handling
- If LLM fails for a specific claim, mark it `"error": "LLM call failed"` and continue.
- Save partial results on interruption.

---

## Execution Flow Summary

```
citation:review {bookId}
  │
  ├─ Phase 1: Scan nodes → extract truth claims via LLM
  │    └─ Output: claims[] with node_id, citation_id, truth_claim
  │
  ├─ Phase 2: Resolve citations → bibliography → library
  │    └─ Enrich: verified, has_nodes, metadata
  │
  ├─ Phase 3: Gather evidence
  │    ├─ has_nodes? → full-text search source nodes
  │    ├─ abstract?  → use abstract
  │    └─ nothing?   → mark unverifiable
  │
  ├─ Phase 4: LLM verification (unless --dry-run)
  │    └─ Enrich: supported, assessment, reasoning
  │
  └─ Phase 5: Save JSON + print summary
```

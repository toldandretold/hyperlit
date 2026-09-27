# AI Citation Review

Text: [The Reviewed Work](/goldensnapshotbook) — Author, Test — (2020)

Date: 2026-07-01 12:00:00
Unique sources cited: 8 (0 verified, 1 canonical-verified, 2 with full text)
## Source Coverage

<table data-chart="source-coverage"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody><tr><td>Canonical-verified</td><td>0</td></tr><tr><td>Found (local match)</td><td>0</td></tr><tr><td>Source Not Found</td><td>8</td></tr></tbody></table>

> Citations are matched against: [OpenAlex](https://openalex.org), [Open Library](https://openlibrary.org), [Semantic Scholar](https://www.semanticscholar.org), and [Brave Search](https://search.brave.com). Unmatched citations may be legit sources, but are worth reviewing.

> **Canonical-verified** sources are matched to a canonical work identity (external identifiers like DOI / OpenAlex). Where a claim was checked against full text, the *content from* note says which version supplied it — an **auto version** is the work's own PDF fetched and OCR'd by the system, untampered by construction.

## Results

<table data-chart="verdict-summary"><thead><tr><th>Verdict</th><th>Count</th></tr></thead><tbody>
<tr><td>Broken Sources</td><td>1</td></tr>
<tr><td>Unverified Sources</td><td>3</td></tr>
<tr><td>Rejected</td><td>0</td></tr>
<tr><td>Unlikely</td><td>1</td></tr>
<tr><td>Plausible</td><td>1</td></tr>
<tr><td>Likely</td><td>1</td></tr>
<tr><td>Confirmed</td><td>1</td></tr>
</tbody></table>

> Truth claims are extracted by [extract-model] and verified by [verify-model]. This is designed to help triage manual citation review by humans. It is not a replacement for biological peer review.

## How this review works

<table data-chart="review-method"><thead><tr><th>The question we ask</th><th>How it is answered</th></tr></thead><tbody><tr data-band="claim" data-kind="band"><td>What does the text claim?</td><td>read the sentence, not the source — per truth claim <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationReview/Phases/TruthClaimExtractor.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="claim" data-kind="step"><td>Extract the claim, verbatim</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationReview/Phases/TruthClaimExtractor.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="claim" data-kind="step"><td>Bound the claim by the next citation</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationReview/Support/ClaimSpanExtractor.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="claim" data-kind="step"><td>Make the claim self-contained (AI)</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationReview/Phases/TruthClaimExtractor.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="claim" data-kind="step"><td>One claim per cited work</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationReview/Phases/TruthClaimExtractor.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="band"><td>What is the citation?</td><td>read the footnote itself: a work, an “Ibid.”, a pointer, an Act — or not a citation at all <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="step"><td>Is this a citation?</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="step"><td>Short forms and &quot;Ibid.&quot;</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="step"><td>Pointers into the document&#039;s own bibliography</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="step"><td>Legislation and case law</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="step"><td>Footnotes citing several works</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="step"><td>Recently tried, recently failed</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="band"><td>Which work is it?</td><td>identify the cited work, most reliable evidence first: identifiers → our shelves → indexes → the printed URL → the open web <a href="https://github.com/toldandretold/hyperlit/tree/main/app/Services/CitationPipeline/Resolution/Waves" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Read the printed DOI</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/DoiFromText.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>That DOI in the local library</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/LocalDoiLookup.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>That DOI at OpenAlex</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenAlexDoiLookup.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Local library title search</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/LocalLibraryTitle.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Closed pool from the parent work&#039;s own reference list</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/ReferencedWorksPool.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>OpenAlex title search</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenAlexTitleSearch.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Open Library title search</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenLibrarySearch.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Semantic Scholar title search</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/SemanticScholarSearch.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Shortened-title re-score of stored candidates</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/ShortenedTitleRestore.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>OpenAlex retry with shortened title</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenAlexTitleShortened.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Open Library retry with shortened title</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenLibraryShortened.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Semantic Scholar retry with shortened title</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/SemanticScholarShortened.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Fetch the URL the citation prints</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/PrintedUrlFetch.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Apply the match the printed URL outranked</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/UrlFirstFallback.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>Open web search (Brave)</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/BraveSearchFallback.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="ladder" data-kind="step"><td>No source found</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Jobs/CitationScanBibliographyJob.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="band"><td>Can we read it?</td><td>get the source’s own text — each harder method only when the easier one failed <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/WebTextAcquirer.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Have we been refused here before?</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/FetchHostHealth.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>A PDF</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/PdfSourceReader.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>A video</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/YouTubeTranscriptReader.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Fetch the page</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/ContentFetchService.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Find the article in the page</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/WebTextAcquirer.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Render it in a browser</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/ContentFetchService.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>A managed unblocker</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/UnblockerClient.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Follow a record page to its PDF</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/SourceImport/Content/LandingPagePdfLocator.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Is it at least the right page?</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/WebTextAcquirer.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="acq" data-kind="step"><td>Is this text the cited work?</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/LlmService.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="grades" data-kind="band"><td>What did we actually get?</td><td>every fetch is graded — the label is the safety mechanism <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/WebContent/WebTextAcquirer.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="join" data-kind="band"><td>Does the source support the claim?</td><td>claim meets source — a wrong source poisons every claim on the citation <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationReview/Phases/ClaimVerifier.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="claims" data-kind="meta"><td>claims</td><td>8</td></tr><tr data-band="citations" data-kind="meta"><td>citations</td><td>8</td></tr><tr data-band="identified" data-kind="meta"><td>identified</td><td>5</td></tr><tr data-band="not_found" data-kind="meta"><td>not_found</td><td>3</td></tr><tr data-band="verdict" data-kind="verdict"><td>Broken Sources</td><td>1</td></tr><tr data-band="verdict" data-kind="verdict"><td>Unverified Sources</td><td>3</td></tr><tr data-band="verdict" data-kind="verdict"><td>Rejected</td><td>0</td></tr><tr data-band="verdict" data-kind="verdict"><td>Unlikely</td><td>1</td></tr><tr data-band="verdict" data-kind="verdict"><td>Plausible</td><td>1</td></tr><tr data-band="verdict" data-kind="verdict"><td>Likely</td><td>1</td></tr><tr data-band="verdict" data-kind="verdict"><td>Confirmed</td><td>1</td></tr></tbody></table>

> Every citation below carries its own “How this was checked” — the path it actually took through this process, each step linking to the code that performed it.

---

# Broken Sources (1)

> The identifier or details printed in these citations resolve to a **different work** than the citation describes. No verdict is issued for them — a claim cannot be verified against a record that is not the cited work — so each entry below is a diagnosis of the citation itself: what it prints, what that actually resolves to, and how far apart the two are.

### “The Original Cited Study Title That Is Quite Different”

**Identifier printed in the citation:** URL http://dubious.example/paper
**Record this citation resolved to:** “Unrelated Landing Page”
**Title agreement:** 0% — the record's title shares no words with the cited title.

**What is broken:** No identifier is printed, and the closest database match (via brave_search, score 0.55) is the record above — which does not match the citation. The cited work may exist unindexed, or the printed details may be wrong.

**Impact:** 1 claim in the text cites this work. No verdict is issued — a claim cannot be verified against a record that is not the cited work. Correct the citation or its identifier and re-run the review.

---

# Unlikely

**Source:** Global Indicators Handbook
**Provenance:** Local library match — no canonical work identity yet
<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="nomatch"><td>Which work is it?</td><td>Not identified. This row predates per-step tracing, so which routes ran was not recorded. “Not found” is a fact about our search, not proof the citation is wrong.</td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

**Claim:** "The dataset covers 200 countries."
**Evidence:** Title only (no abstract or passages)
**Verdict:** Unlikely
**Reasoning:** Title alone is insufficient.

> **Source material sent to LLM:**
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> Line of source material.
> 
> (truncated)

---

# Unverified Sources

These citations reference sources that were never found in any database.

## Books (1)

> Not found in any academic database — higher priority for manual review.

<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="nomatch"><td>Which work is it?</td><td>Not identified. This row predates per-step tracing, so which routes ran was not recorded. “Not found” is a fact about our search, not proof the citation is wrong.</td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

**Claim:** "An unindexed monograph is cited."
**Evidence:** None
**Verdict:** No Evidence

---

## Journal Articles (1)

> 🚩 Not found in any academic database — **higher priority for manual review.** Journal articles are normally indexed in OpenAlex / Semantic Scholar, so absence here is a stronger signal the reference may be miscited or fabricated (unlike books, which are sometimes legitimately unindexed).

<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="nomatch"><td>Which work is it?</td><td>Not identified. This row predates per-step tracing, so which routes ran was not recorded. “Not found” is a fact about our search, not proof the citation is wrong.</td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

**Claim:** "A missing journal article is cited."
**Evidence:** None
**Verdict:** No Evidence
🚩 **Flag:** Formatted as a journal article but absent from every academic database — treat as a possible fabricated or miscited reference (higher scrutiny than a missing book).

---

## Websites (1)

> Not found — sources of this type are typically not indexed in academic databases, so absence here is expected. Verify against the publisher or issuing body if needed.

**Provenance:** Web source — content was retrieved at [https://example.net/page](https://example.net/page), but the page could not be confirmed as the cited article (no machine-readable identity to match). URL-content match is the only verification available for web sources.
<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="nomatch"><td>Which work is it?</td><td>Not identified. This row predates per-step tracing, so which routes ran was not recorded. “Not found” is a fact about our search, not proof the citation is wrong.</td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

**Claim:** "A web citation could not be confirmed."
**Evidence:** None
**Verdict:** No Evidence

---

# Plausible

**Source:** [A Brief History of Neoliberalism](/goldensnapshotbook%5FsrcC) — Harvey, David — (2005)
**Provenance:** Local library match — no canonical work identity yet
**Match:** 41% — Local library — *this was the closest match found*
⚠ Year mismatch: bibliography says 2007, matched source says 2005
<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="resolved"><td>Which work is it?</td><td>Identified — local library title search (match score 0.41). <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/LocalLibraryTitle.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

**Claim:** "Neoliberalism reshaped labour markets."
**Evidence:** Passages only
**Verdict:** Plausible

---

# Likely

**Source:** The Open Access Advantage — Smith, Jane — (2019)
**Provenance:** Web-verified — the cited title matches the live page at [https://example.org/oa_advantage](https://example.org/oa%5Fadvantage). No academic database lists this work; URL-content match is the available verification.
**Match:** 82% — Web fetch
<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="resolved"><td>Which work is it?</td><td>Identified — fetch the URL the citation prints (match score 0.82). <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/PrintedUrlFetch.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

**Claim:** "Open access improves citation counts."
**Evidence:** Web page content (partial) + passages
**Verdict:** Likely
**Summary:** Broadly consistent with the page.

---

# Confirmed

**Source:** [Capital in the Twenty-First Century](/goldensnapshotbook%5FsrcA) — Piketty, Thomas — (2014)
**Provenance:** Canonical-verified (OpenAlex, DOI) — content from the system-fetched auto version (untampered)
**Match:** 97% — DOI (OpenAlex)
<table data-chart="citation-path" data-recorded="0"><thead><tr><th>How this was checked</th><th>What happened</th></tr></thead><tbody><tr data-band="route" data-kind="routed"><td>What is the citation?</td><td>A work to identify — it entered the resolution ladder.</td></tr><tr data-band="ladder" data-kind="resolved"><td>Which work is it?</td><td>Identified — that DOI at OpenAlex (match score 0.97). <a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenAlexDoiLookup.php" target="_blank" rel="noopener">code</a></td></tr><tr data-band="route" data-kind="notrecorded"><td>Not recorded</td><td>This citation was resolved before per-step tracing existed — the path above is only what its stored record testifies to, not a claim that nothing else ran.</td></tr></tbody></table>

> Piketty, T. (2014). Capital.

**Claim:** "Capital accumulation concentrates over time." <a id="ref_HL_confirmed" href="/goldensnapshotbook#HL_confirmed">←</a>
**Contextualised:** "In the long run, capital accumulation concentrates over time."
**Evidence:** Abstract + passages
**Verdict:** Confirmed
**Summary:** Directly supported.
**Reasoning:** Passage 1 states it verbatim.

**Cited source passages:**
> **Passage 1** (`p100`, rank: 0.9):
> Wealth concentrates when r > g.
> Second line here.


---


# Appendix: Pipeline Diagnostics

## Evidence Available for Verification

| Evidence Type | Claims |
|---------------|--------|
| None | 3 |
| Abstract + passages | 1 |
| Web + passages | 1 |
| Passages only | 1 |
| Title only | 1 |
| Web only | 1 |

## Models

| Role | Model |
|------|-------|
| Metadata extraction | metadata-model |
| Claim extraction | extract-model |
| Verification | verify-model |
| Provider | api.llm.test |


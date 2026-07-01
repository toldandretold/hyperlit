# AI Citation Review

Text: [The Reviewed Work](/goldensnapshotbook) — Author, Test — (2020)

Date: 2026-07-01 12:00:00
Citations in text: 12 (across 6 paragraphs)
Unique sources cited: 5 (3 verified, 1 canonical-verified, 2 with full text)
## Known Unknown Citations 

<table data-chart="source-coverage"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody><tr><td>Canonical-verified</td><td>1</td></tr><tr><td>Found (local match)</td><td>2</td></tr><tr><td>Source Not Found</td><td>4</td></tr></tbody></table>

> Citations are matched against: [OpenAlex](https://openalex.org), [Open Library](https://openlibrary.org), [Semantic Scholar](https://www.semanticscholar.org), and [Brave Search](https://search.brave.com). Unmatched citations may be legit sources, but are worth reviewing.

> **Canonical-verified** sources are matched to a canonical work identity (external identifiers like DOI / OpenAlex). Where a claim was checked against full text, the *content from* note says which version supplied it — an **auto version** is the work's own PDF fetched and OCR'd by the system, untampered by construction.

## Results

<table data-chart="verdict-summary"><thead><tr><th>Verdict</th><th>Count</th></tr></thead><tbody>
<tr><td>Unverified Sources</td><td>3</td></tr>
<tr><td>Rejected</td><td>1</td></tr>
<tr><td>Unlikely</td><td>1</td></tr>
<tr><td>Plausible</td><td>1</td></tr>
<tr><td>Likely</td><td>1</td></tr>
<tr><td>Confirmed</td><td>1</td></tr>
</tbody></table>

> Truth claims are extracted by [extract-model] and verified by [verify-model]. This is designed to help triage manual citation review by humans. It is not a replacement for biological peer review.

---

## Rejected

**Source:** Unrelated Landing Page
**Provenance:** ⚠️ Web source — the live page at the cited URL [http://dubious.example/paper](http://dubious.example/paper) appears to be a DIFFERENT article (its declared title contradicts the citation). Treat content from this URL as untrusted.
**Match:** 55% — Brave Search — *this was the closest match found*
⚠ Title differs: bibliography has "The Original Cited Study Title That Is Quite Different" but matched source is "Unrelated Landing Page"
🚩 **Suspicious URL** (`http://dubious.example/paper`): suspicious TLD ".zzz", domain does not exist (DNS lookup failed) — possible LLM-fabricated citation
**Claim:** "A study proved the opposite conclusion."
**Evidence:** Web page content (partial)
**Verdict:** Rejected
**Summary:** Page contradicts the citation.

---

# Unlikely

**Source:** Global Indicators Handbook
**Provenance:** Local library match — no canonical work identity yet
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

**Claim:** "An unindexed monograph is cited."
**Evidence:** None
**Verdict:** No Evidence

---

## Journal Articles (1)

> Not found in any academic database — higher priority for manual review.

**Claim:** "A missing journal article is cited."
**Evidence:** None
**Verdict:** No Evidence

---

## Websites (1)

> Not found — non-academic sources are not expected in academic databases.

**Provenance:** Web source — content was retrieved at [https://example.net/page](https://example.net/page), but the page could not be confirmed as the cited article (no machine-readable identity to match). URL-content match is the only verification available for web sources.
**Claim:** "A web citation could not be confirmed."
**Evidence:** None
**Verdict:** No Evidence

---

# Plausible

**Source:** [A Brief History of Neoliberalism](/goldensnapshotbook%5FsrcC) — Harvey, David — (2005)
**Provenance:** Local library match — no canonical work identity yet
**Match:** 41% — Local library — *this was the closest match found*
⚠ Year mismatch: bibliography says 2007, matched source says 2005
**Claim:** "Neoliberalism reshaped labour markets."
**Evidence:** Passages only
**Verdict:** Plausible

---

# Likely

**Source:** The Open Access Advantage — Smith, Jane — (2019)
**Provenance:** Web-verified — the cited title matches the live page at [https://example.org/oa_advantage](https://example.org/oa%5Fadvantage). No academic database lists this work; URL-content match is the available verification.
**Match:** 82% — Web fetch
**Claim:** "Open access improves citation counts."
**Evidence:** Web page content (partial) + passages
**Verdict:** Likely
**Summary:** Broadly consistent with the page.

---

# Confirmed

**Source:** [Capital in the Twenty-First Century](/goldensnapshotbook%5FsrcA) — Piketty, Thomas — (2014)
**Provenance:** Canonical-verified (OpenAlex, DOI) — content from the system-fetched auto version (untampered)
**Match:** 97% — DOI (OpenAlex)
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


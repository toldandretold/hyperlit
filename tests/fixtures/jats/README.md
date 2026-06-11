# JATS full-text fixtures

Real **JATS / NLM XML** captures from Europe PMC, used as deterministic
regression fixtures for `App\Services\SourceImport\Content\JatsFullText`
(the authoritative journal-article path — see
`app/Services/CanonicalVersions/README.md` and the citation-pipeline memory).

## What JATS is (and why it's the easy case)

JATS is the standard journal-article XML. Unlike scraped HTML, it labels
everything explicitly: `<body>` is the article, `<ref-list>` is the
bibliography, `<xref ref-type="bibr" rid="bibN">` is an in-text citation whose
target is *declared* (no author-year guessing). So `JatsFullText::toArticle`
converts it to the app-native format with EXACT links:

- `<xref ref-type="bibr" rid="bibN">` → `<a class="in-text-citation" href="#bibN">`
- `<xref ref-type="fn" rid="...">`     → `<sup fn-count-id ...>` footnote marker
- `<ref id="bibN">`                    → `<p class="bib-entry" id="bibN">`
- `<fn id="...">`                      → footnotes `[{footnoteId, content}]`

It then persists via the shared `ContentFetchService::persistArticle` — the
same path the paste engine uses — tagged `conversion_method='jats_fulltext'`.

## Scope

JATS full text is only available for the **PMC open-access subset**
(`isOpenAccess: Y`). License-restricted papers are indexed in Europe PMC but
404 on full XML — same OA gating as PDFs. This complements, not replaces, the
PDF/browser-HTML acquisition lanes.

## How to capture a new fixture

1. Get the PMCID for a DOI (NCBI ID converter):

   ```
   curl 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=<DOI>&format=json&tool=hyperlit&email=you@example.com'
   ```

   (`JatsFullText::doiToPmcid` does this in code.) Confirm it's open access:

   ```
   curl 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=PMCID:PMC<id>&resultType=core&format=json'
   ```
   — look for `"isOpenAccess":"Y"`.

2. Download the full-text XML (this is what `fetchXmlByDoi` fetches):

   ```
   curl -A 'hyperlit/1.0 (mailto:you@example.com)' \
     'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC<id>/fullTextXML' \
     -o tests/Fixtures/jats/pmc<id>.xml
   ```

3. Sanity-check it has body + refs: `grep -c '<ref ' pmc<id>.xml` and
   `grep -c '<body>' pmc<id>.xml`.

## Current fixtures

| file | source | notes |
|------|--------|-------|
| `pmc13131419.xml` | "Pillars of Peer Review" (JACBTS, CC-BY) | 10 refs, citations clustered in the intro; short editorial, no `<fn>` |
| `pmc12967033.xml` | "…beef cows fed Kernza…" (research article) | 36 refs, 53 spread `bibr` citations, 4 `<fn>` footnotes — exercises footnote extraction |

## What the tests assert

`tests/Unit/Services/JatsFullTextTest.php` (runs without network):
- title from front matter
- body HTML with paragraphs/headings
- full reference list in `[{referenceId, content}]` shape + `bib-entry` render
- `bibr` xrefs → `in-text-citation` links (exact)
- a `footnotes` array is always present
- malformed XML degrades to empty, never throws

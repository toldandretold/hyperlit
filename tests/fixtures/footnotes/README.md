# Footnote-extraction fixtures

Real books' footnotes with their **captured LLM extractions** — the footnote
analogue of `tests/paste/fixtures/` (paste baselines) and `tests/conversion/`
(import regression). Consumed by `tests/Canonical/FootnoteRoutingRegressionTest.php`,
which runs the DETERMINISTIC half (classification + the antecedent /
bibliography-pointer matchers + legal exclusion) against exact baselines, with
no LLM in the loop.

## Why captured extractions

Extraction itself is an LLM call (`LlmService::extractFootnoteCitationsBatch`,
temperature 0 but still a model). Freezing one real extraction per corpus makes
the routing tests deterministic: if the **routing** regresses, baselines drift;
if you change the **prompt/taxonomy**, recapture deliberately and update the
baselines in the same commit (same discipline as the paste baselines).

## The styles each fixture pins

| fixture | corpus | style |
|---|---|---|
| `legal-pointer-style.json` | EU copyright-law article (142 fn, 69 bib) | author-date **pointers** into a bibliography ("Chapman (2009), p. 6") + **legislation** ("Art. 5(3)(a) ISD") + **case-law** (CJEU Painer) |
| `selfcontained-shortform-style.json` | early-modern history article (147 fn, no bib) | self-contained full citations, then **short-forms** ("Hart, Justice, pp. 66–7") + **ibid** + archival codes (CJ, TNA) |

The history fixture is captured POST-link: linked short forms carry their
antecedent's metadata + `short_form_of`. It guards the taxonomy snapshot and
**the Hart bug** ("Hart, Justice" → J. S. Hart 1991, never a confabulated
H. L. A. Hart 1955). The legal fixture is captured with pointer metadata
intact, so the matchers re-run end-to-end in the test.

## Recapturing (after a deliberate prompt/taxonomy change)

1. Clear and re-extract the source book:

   ```
   php artisan tinker --execute='DB::connection("pgsql_admin")->table("footnotes")
     ->where("book","<BOOK>")->update(["llm_metadata"=>null,"is_citation"=>false,
     "foundation_source"=>null,"source_id"=>null,"match_method"=>null,"match_score"=>null]);'
   php artisan citation:scan-bibliography <BOOK>
   ```

2. Re-run the capture (see the tinker snippets in the session memory, or copy
   the shape of the existing JSON: `footnotes[{footnoteId, marker, text, meta}]`
   + `bibliography[{referenceId, meta, resolved}]`).

3. Update the baseline numbers in `FootnoteRoutingRegressionTest.php` in the
   same commit, with a note on what changed.

Source books (dev DB): `book_1781243002465` (legal), `book_1777264888398` (history).

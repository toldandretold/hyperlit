# GROBID trial (2026-08) — results, and why we decided NOT to use it

This is the experiment record for GROBID ([grobid.readthedocs.io](https://grobid.readthedocs.io)) as the bibliography-extraction stage. Short version: **we built the full opt-in integration, ran a 17-book baseline-vs-GROBID trial on real corpus books, and decided not to host it** — on clean bibliographies it's a wash-or-slightly-worse than our regex, and on the one pathology it genuinely fixes it also loses more than it gains. The integration code stays in the tree, shipped and dormant (it is provably harmless), so this decision costs nothing to reverse if the data changes.

## Why we tried it

Book `93d34a74` ("Multidimensional Journal Evaluation") had in-text citations like "(Al-Awqati, 2007)" that could never link: its OCR'd bibliography contains RUN-ON blobs — several entries glued into one paragraph, each ending in a DOI with no terminal period ("…Al-Awqati (2007)… doi:10.1038/sj.ki.5002094 Archambault (2009)… doi:…2036-x Bar-Ilan (2008)…"). The whole blob keys to its first author, so every later entry is uncitable. This is the failure our regex splitter fundamentally cannot fix: a hand-tuned seam regex for it regressed the book from 1481 linked citations to 38 and was reverted. GROBID's CRF reference model — trained on scholarly corpora, reading PDF layout — segments exactly this correctly, which a standalone spike confirmed (Al-Awqati came back standalone, right year, DOI attached).

## What was built (still in the tree, dormant)

- `app/Python/digestion/bibliographyExtraction/grobid_client.py` — stdlib client, page-window chunked so a memory-capped server never sees a 300-page PDF at once. Gotcha discovered by this trial: GROBID answers HTTP 204/EMPTY for a window with no references — that is a valid zero-refs result, and treating it as a parse error silently aborted every big book's run (fixed).
- `extract_bibliography_via_grobid` (`bibliography.py`) — TEI → citation keys → DOM anchors; a reference that can't be located in the DOM is skipped, never dead-linked; a thin result (< half the regex candidate count) is rejected wholesale.
- The escalation gate (`bib_passes.py`) — `assess_bibliography_health` scores the read-only candidate scan (run-on entries carrying ≥2 "(year)" patterns; merged over-long blobs) and only a SUSPECT bibliography escalates, only when `GROBID_URL` is set and the source PDF is on disk. Every failure mode (env unset, server down/hung with 5s probe + 120s/300s budgets, thin result) falls back to the regex path byte-identically — verified by the default suite (93/93) and 8 server-free unit tests (`tests/conversion/unit/test_grobid_bibliography.py`).

## Method

Native-JVM GROBID 0.8.2 on a dev Mac (the amd64 Docker image under ARM emulation OOM-crashed constantly and is not a valid test rig; native setup = brew `openjdk@17`, gradle wrapper bumped 7.2→7.6.4, `./gradlew :grobid-service:run` — the `mac_arm-64` Wapiti CRF libs ship in-tree). Driver: `deploy/experiments/grobid_trial.py` — 17 PDF-bearing books (12 fixture books + 5 pulled prod cases), each converted twice from the same cached OCR: baseline (regex) and `GROBID_ALWAYS=1` (health gate bypassed so every book exercises GROBID). Metrics per run: citations linked/total, reference entries anchored, residual multi-year ("glued") entries, engaged-vs-fallback, wall seconds. Raw output: `tests/conversion/fixtures-local/grobid_trial_results_2026-08-08.json` (git-ignored tree, alongside the licensed-local fixtures).

## Results

**Clean-bibliography books (the majority): wash to slightly WORSE.** Links moved ±1–2 either way, and GROBID consistently anchored FEWER reference targets than the regex — its raw-string DOM probing drops entries the regex keeps:

- 433d423b: 8/8 linked both ways; refs 25 → 24.
- 78516d0d: 29/39 → 30/41 (+1 link); refs 23 → 21.
- d4c0b31e: 19/20 → 18/22 (−1 link); refs 19 → 15.
- 1313c1a2: 53/57 → 51/57 (−2 links); refs 40 → 37.
- 128ad69a, 514e27a5, native-engine, 304249a7: effectively unchanged.

**The flagship pathology (93d34a74): genuinely fixed, at a cost that outweighs it.** "(Al-Awqati, 2007)" links to the correct `#alawqati2007` at full 300-page scale — the thing regex cannot do — and links rose 1481 → 1495. BUT the wholesale takeover anchored only 459 reference targets vs the regex's 590 (−131 link targets gone), and the overall link RATE fell 89.6% → 78.6%. GROBID traded one pathology (glued entries) for another (dropped entries).

**Guards behaved perfectly, which is why the dormant code is safe.** bedjaoui: GROBID anchored 5 entries vs 14 required → rejected, regex kept. Every server failure fell back cleanly mid-pipeline with byte-identical output.

**`GROBID_ALWAYS` exposed a hazard the health gate prevents.** On footnote-style books with no author-year bibliography (21696c70, ad752a46, 9045b32e, 1abb31d5), GROBID mines "references" out of FOOTNOTE DEFINITIONS and opens a citation layer the book never had (21696c70: 0 → 51 links of unvetted quality). In the real health-gated flow these books have zero reference candidates, score not-suspect, and never escalate — but it rules out ever running GROBID unconditionally.

## The decision

**Do not host GROBID** — not on the app droplet (its ~0.5–1 GB resident JVM doesn't fit the measured RAM budget anyway, see `deploy/grobid.md`), and not on a side droplet, because the trial doesn't justify ANY hosting: a service that is neutral-or-negative on most books and lossy on its best case isn't worth an always-on JVM plus an ops dependency. The regex path remains the extractor everywhere. What we keep for free: the health scorer still flags suspect bibliographies into `assessment.json` for humans/the vibe loop, and the whole escalation stays one env var away if the data ever changes.

## Round 3 — the surgical merge (built + trialed same day; it works)

The wholesale trial pointed at a better design, so we built it: **surgical merge** — the regex extraction ALWAYS runs and always stands; GROBID's segmentation is folded in ADDITIVELY, only for references whose keys the regex map cannot reach at all AND whose text probe-locates inside a health-flagged suspect paragraph. Nothing regex found can be removed or overwritten, by construction (`merge_grobid_refs` in `bibliography.py`; the seam in `bib_passes.py` now merges instead of replacing).

Re-running the same 17-book trial against the merge design:

- **Every clean and footnote-style book: byte-identical to baseline** — even under `GROBID_ALWAYS=1`, because no suspect paragraphs = no merge scope. The round-2 hazards (dropped targets on clean books, invented citation layers on footnote books) are gone structurally, not statistically.
- **93d34a74 (the flagship): strictly better.** refs 590 → 594 (+4 hidden entries, zero lost), links 1481 → 1486, link rate 89.6% → 89.9%, and "(Al-Awqati, 2007)" links to the correct `#alawqati2007`. The wholesale run's −131 target loss is gone; it recovers about a third of wholesale's raw link gain at none of its cost.
- **304249a7: bonus win** — +1 entry recovered from its one glued blob, links 24/31 → 25/31.
- **bedjaoui: honest no-op** — merge engaged, added 0 (GROBID's refs for its messy scan didn't clear the all-keys-absent + in-suspect-blob bar), extraction unchanged. ~20s spent on a 300-page PDF, only ever on suspect books.

Guarantees carried over: default suite 93/93 byte-identical with env unset; 9 server-free unit tests including the merge semantics (adds the hidden Al-Awqati-shaped entry, never touches an existing key, ignores refs probing outside the suspect set).

## The REVISED decision

The surgical merge makes GROBID **strictly-positive but modest**: a handful of recovered citations per pathological book, zero risk anywhere else. That's not enough to justify standing up a server TODAY on a RAM-constrained droplet — but it changes the hosting question from a trade-off to pure upside. Standing plan: leave the merge shipped-and-dormant; when the droplet gets resized (already the documented step 1 for import concurrency in `deploy/supervisor/README.md`), flip GROBID on per `deploy/grobid.md` and the suspect books simply get better. The `bibliography_health` assessment records remain the evidence stream — if glued-bibliography books pile up faster than expected, that's the signal to host sooner (option B side-droplet).

## Rerunning the trial

Start a GROBID server (native: grobid source + JDK 17 + `./gradlew :grobid-service:run`; or on native amd64 hardware the `lfoppiano/grobid:0.8.0` container), then `python3 deploy/experiments/grobid_trial.py`. The driver expects the PDF-bearing fixtures in `tests/conversion/fixtures[-local]/` and the pulled books' PDFs in `resources/markdown/<book>/original.pdf`; it prints per-book baseline-vs-GROBID lines and writes `grobid_trial_results.json` next to itself.

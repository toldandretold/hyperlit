# Conversion pipeline — decision-trace, tests & vibe-conversion

This directory is the test + diagnostics home for the document-conversion pipeline (the code
that turns an uploaded PDF / EPUB / Word / Markdown / HTML into linked Hyperlit nodes,
footnotes and references). It also documents the **self-improving "vibe conversion"** loop that
sits on top of that pipeline.

If you only remember one thing: **the folder tree under `fixtures/` *is* the coverage map**, and
every conversion now emits a **falsifiable decision-trace** (`assessment.json`) explaining *what
it decided, in which module, and why* — which is what makes both human debugging and the LLM
"vibe conversion" possible.

---

## 1. The pipeline is modular

The conversion core lives in `app/Python/`:

- **`process_document.py`** — the orchestrator. Parses the (already-OCR'd / pandoc'd / md'd)
  HTML and runs the passes: extract bibliography → extract footnotes → link citations → link
  footnotes → audit → chunk into nodes.
- **`conversion/`** — a package of small, single-responsibility, unit-testable modules the
  orchestrator imports:
  | module | responsibility |
  |---|---|
  | `strategy.py` | choose the footnote strategy (whole_document / sequential / sectioned / no_footnotes); the **link-vs-suppress guard** `_footnote_numbering_is_linkable` |
  | `refkeys.py` | citation-key generation + `is_likely_reference` |
  | `bibliography.py` | find the references section, key each entry, resolve author+year collisions |
  | `citations.py` | wrap `(Author Year)` / `[Author Year]` in `<a class="in-text-citation">` |
  | `footnotes.py` | extract footnote definitions (incl. multi-paragraph) + link markers to defs |
  | `audit.py` | the verdict: gaps / unmatched refs / unmatched defs |
  | `sanitize.py` | HTML/URL sanitisation |
  | `assessment.py` | the shared decision-trace collector (`ASSESSMENT`) |

- **Per-filetype front-ends** (run *before* `process_document`, all converge on it):
  `epub_normalizer.py` (EPUB → ~22 `detect()/transform()` footnote detectors),
  `mistral_ocr.py` (PDF: replays cached OCR JSON → assembles markdown, classifies footnote
  layout), `simple_md_to_html.py` (Markdown), `ar5iv_preprocessor.py` (arXiv HTML),
  `strip_docx_metadata.py` (Word, then pandoc → core).

---

## 2. Every conversion emits three artifacts (three audiences)

Written into the book's `resources/markdown/<bookId>/` dir:

| artifact | audience | what it is |
|---|---|---|
| **`conversion_stats.json`** | human / email | the headline: references_found, citations_linked/total, footnotes_matched, strategy, style |
| **`audit.json`** | the verdict | did the chosen path work — gaps, unmatched_refs/defs, duplicates |
| **`assessment.json`** | the LLM / debugger | the **decision trace** — an ordered list of fork-records |

### The fork-record (the key idea)

Each real decision is recorded so it can be **re-litigated**:

```jsonc
{ "module": "footnote_strategy", "code_ref": "strategy.py:analyze_document_structure",
  "question": "Which footnote strategy for this document?",
  "decision": "whole_document",
  "considered": [                                   // the roads NOT taken
    { "option": "sectioned", "rejected_because": "no per-chapter resets",
      "would_need": "duplicate footnote numbers + HR/Notes separators" }, … ],
  "evidence": { "position_ratio": 0.75, "resets": 0, … },
  "confidence": 0.9,
  "margin": "def position_ratio 0.75 vs 0.65 gate; refs avg 0.25 (gap 0.50)" }
```

`considered[].would_need` names *the evidence that would have flipped the branch* — so a human or
an LLM can ask "is that evidence really absent, or did the detector miss it?". `margin` flags a
**near-miss**; a `FALL-THROUGH` margin + low `confidence` marks a default/unknown branch — *where
silent failures hide*. The instrumented forks:

`strategy_selection` · `pdf_footnote_classification` · `footnote_linking_guard` ·
`citation_linking` · `bibliography_extraction` · `epub_footnote_detection` — plus the
`footnote_audit` **verdict**.

The PDF front-end (`mistral_ocr.py`) writes its fork records first; `process_document.py`'s
`ASSESSMENT.reset(output_dir)` seeds from that file so the final trace spans both stages.

---

## 3. The regression suite (`run_regression.py`)

End-to-end: each fixture runs through its **real** conversion chain (selected by which input
file it contains) and its outputs are byte-compared to golden files + asserted against a
manifest.

```sh
python3 tests/conversion/run_regression.py                 # run all
python3 tests/conversion/run_regression.py --fixture epub/ # subset (substring match on path)
python3 tests/conversion/run_regression.py --coverage      # which registered pathways have NO test
python3 tests/conversion/run_regression.py --update-golden --fixture <case>
```

- **Structure = coverage map.** Fixtures live at `fixtures/<filetype>/<pathway>/<case>/`. The
  tree mirrors the pipeline's branches; `--coverage` diffs it against `pathways.json`.
- **Pipelines** auto-detected by the input file present: `ocr_response.json` → pdf (replays the
  **cached** OCR — no API, no PDF), `epub_original/` → epub, `input.docx` → docx (pandoc),
  `input.md` → md, `input.html` → html.
- **Assertions** (manifest `expected{}`): counts, `footnote_strategy`/`citation_style`,
  **`footnote_links: [{marker, content_contains}]`** (a marker opens the *correct* note —
  catches confident-wrong-link bugs that count-only checks miss), `suppressed_footnotes`,
  `detectors_fired`, plus golden byte-compare.
- **Determinism:** subprocesses run with `PYTHONHASHSEED=0`; random `Fn…` ids are normalised to
  `FN0001…` in first-appearance order before any golden diff.
- **Committed fixtures are 100% synthetic** (no copyrighted content). Real harvested books live
  in the git-ignored `fixtures-local/` (still discovered + run locally, tagged `[local]`).

## 4. Unit tests (`unit/`, pytest)

```sh
python3 -m pytest                         # all unit tests
python3 -m pytest tests/conversion/unit/test_strategy.py
```

Fast, isolated tests that pinpoint a regression to one module: `test_strategy.py` (incl. the
suppression guard), `test_refkeys/_sanitize/_audit/_citations/_bibliography/_linking/`
`_footnote_extraction.py`, `test_epub_detectors.py` (each detector: fires / no-false-positive /
extracts), `test_mistral_ocr.py` (the PDF text transforms + the layout classifier),
`test_simple_md_to_html.py`, `test_ar5iv.py`, `test_strip_docx_metadata.py`, and
`test_impact_map.py`.

> Setup: `pip install -r requirements-dev.txt` (pytest). `conftest.py` puts `app/Python` on the
> path and provides a `soup` fixture.

## 5. `impact_map.py` — changed files → the minimal test set

```sh
python3 tests/conversion/impact_map.py                       # vs HEAD (git diff)
python3 tests/conversion/impact_map.py app/Python/conversion/citations.py
python3 tests/conversion/impact_map.py --json | --run        # plan as JSON / execute it
```

Maps each changed file to the unit tests + `--fixture` filters that actually exercise it
(e.g. `citations.py` → `test_citations` + author_year/bibliography fixtures; `process_document.py`
or a harness file → everything). The speed core for the vibe-conversion loop.

---

## 6. Vibe conversion — the self-improving loop

When a user's document converts badly, **"✨ Vibe convert"** asks an LLM (DeepSeek V4 Pro via
Fireworks) to fix the *pipeline* for **that one document**, validated against the document
itself — production code is never touched.

### Engine: `app/Python/vibe_convert.py`

1. Read the book's `assessment.json` (the flagged forks) + `audit.json` + stats + source.
2. **`code_ref` → which module to send.** Each flagged fork names its responsible file, so the
   prompt ships only the relevant module(s) — *this is why the falsifiable fork-records matter.*
3. Ask the LLM for **full-function replacements** (`{file, name, code}`, not a brittle diff) —
   spliced in by name via `ast`.
4. **Validate**: path-allowlist (`conversion/*.py` + named front-ends only) + a **dangerous-code
   scan** (rejects `os.system`/`subprocess`/`socket`/`eval`/`os.environ`/…).
5. Apply in a **throwaway sandbox** (structure-preserving copy) with a **scrubbed env** (no
   secrets reach the patched code), then **re-convert THIS document** — pathway-aware (for PDFs
   it replays the cached OCR through the patched assembly; the OCR call itself can't be changed).
6. **The 3-tier gate (`evaluate`)** — *the patch only ever touches this doc, so there is no
   regression suite here*:
   - **clean** — the flagged problem resolved, no new flags/faults → offer confidently.
   - **improved** — a user-visible metric went up (more footnotes/citations linked) *and* fewer
     than `MISALIGNED_REJECT_RATIO` (0.5) of the new links are flagged misaligned → offer **with
     a caveat** for the user to judge.
   - **reject** — crashed / regressed a good metric / no gain / **mostly-misaligned** (a wrong
     link is worse than a missing one).
7. Bounded retry (default 3): each failure feeds the new stats/traceback back to the model; the
   best "improved" candidate is kept if no clean fix lands. Writes `vibe_report.json` (the
   journal) + `vibe_patch.json` (the winning replacement).

### Backend (PHP)

- **`app/Jobs/VibeConversionJob.php`** — runs the loop on the **queue worker** (so the user can
  close the toast / be emailed when done). Writes `vibe_progress.json` (polled), honours
  `vibe_cancel`, bills on a real result, opens a GitHub issue on an unfixed run, emails the
  outcome.
- **`app/Http/Controllers/VibeConvertController.php`** — `start` (dispatch) · `progress/{book}`
  (poll the beats) · `cancel/{book}` · `notify/{book}` ("email me when done") · `accept`.
- **`app/Services/ConversionArtifactSaver.php`** — "Use this conversion": loads the regenerated
  artifacts into the DB. Replacing the nodes fires the **`nodes_versioning_trigger`** → the prior
  conversion is archived to **`nodes_history`**, so accept is **non-destructive** and the reader
  can revert via the existing version-history UX (`NodeHistoryController`, `sourceButton.js`).
- **`app/Mail/VibeOutcomeMail.php`** + `resources/views/emails/vibe-outcome.blade.php` →
  `fml@hyperlit.io` (and the user, if they asked). The toast UI is in
  `resources/js/conversion/feedbackToast.js`.

### GitHub issue on an unfixed run

`vibe_convert.py --github` files a GitHub issue (REST API + `GITHUB_TOKEN` from `.env` — no `gh`
binary, so it works on the headless prod box) with the full diagnosis: baseline, the uncertain
decisions, and a per-attempt table of *what it tried → why it was rejected*. Attribution is
whoever owns the token — use a **`hyperlit-bot`** machine-user PAT so issues read "hyperlit-bot
opened this," not you. Issues go to the **code repo** (so they link to fixing PRs); filter the
noise with the `vibe-conversion` / `conversion-bug` labels.

---

## 7. Co-evolution harness — improving the code **and** the prompt

The vibe loop fixing one doc is downstream of a bigger question: *when DeepSeek can't fix a
document, why not — and what would make it able to?* The co-evolution harness runs a **corpus** of
problem files, then **Claude (in-session)** diagnoses each failure and improves **both** the
conversion code **and** the report+prompt we hand the model. Re-running the corpus *measures*
whether DeepSeek's success rate rose.

### The living fix-category registry — `fix_categories.json` (+ `conversion/fix_categories.py`)

An append-only catalogue of the **shapes a fix can take** (tune-threshold, add-an-EPUB-detector,
add-a-strategy-fork, add-a-pipeline-pass, fix-keygen, fix-segmentation, …). Each entry carries
`scope` (model | harness | disposition), `expressible` (replace | additive), and a per-module
`recipe`. It is consumed two ways:

- **`build_prompt` renders the model-scope categories into DeepSeek's prompt** — a menu of
  fix-shapes + the op vocabulary, ★-marking the shapes most likely for the modules being sent.
- **Post-mortems tag each failure with a category id** — and when a failure's shape isn't on the
  list yet, Claude **appends a new category** (`fix_categories.append_category(...)`). The list
  grows through use; its convergence is a signal the corpus is well-covered.

### Additive patch ops — DeepSeek can now ADD code, not just replace it

The patch format gained an `op` per edit (`{file, name, code, op, category}`):

- `op:"replace"` (default) — swap the full body of an **existing** function (as before).
- `op:"add"` — introduce a **new** top-level function/class (e.g. a new `EpubTransform` detector).
- `op:"register"` — append to an allow-listed module-level registry (`TRANSFORM_PIPELINE`,
  `_ALL_STRATEGIES`). An added class is placed **before** the list that registers it.

This makes the highest-value fix-shapes expressible — previously, even a correct "add a detector"
fix could not be applied. Every op still passes the path-allowlist + dangerous-code scan + an
`ast` re-parse gate, inside the same sandbox/Docker isolation as §6.

### The corpus runner — `vibe_eval.py`

```sh
python3 tests/conversion/vibe_eval.py            # convert + vibe loop per corpus case (cached LLM)
python3 tests/conversion/vibe_eval.py --no-vibe  # convert + scaffold only (no tokens) — first look
python3 tests/conversion/vibe_eval.py --no-llm   # re-score from the prompt-hash cache (free)
```

For each `corpus/<case>/` (drop-zone; **git-ignored**, see `corpus/README.md`) it converts via the
reused `run_regression` pathway runners, runs the loop (responses **cached by prompt-hash**, so a
non-prompt re-run is free and a prompt change re-calls), and writes:

- `corpus/<case>/converted/` — the fresh artifacts,
- `corpus/<case>/postmortem.md` — an auto-scaffolded stub (symptom · flagged forks · what DeepSeek
  tried, incl. the `op`/`category` it reached for and an `inexpressible` flag) with a `## Judgement`
  section **Claude fills in-session** (preserved across re-runs),
- `vibe_eval_report.{md,json}` — the **scoreboard** across all cases.

### The operating model + attribution

There is **no automated LLM-judge**. The harness does the mechanical work; **Claude, with you in
the CLI**, reads each run and writes the post-mortem: `defect` · `ultimate_solution` ·
**`attribution`** · `fix_category` · `action`. Attribution routes the work:

| attribution | meaning | fix lands in |
|-------------|---------|--------------|
| **signal-gap** | the report never surfaced the real defect | conversion code / `assessment.py` |
| **prompt-gap** | signal present, prompt lacked the vocab/recipe | `build_prompt` / `fix_categories.json` |
| **inexpressible** | the format couldn't apply the fix | the patch ops (`vibe_convert.py`) |
| **capability-gap** | everything adequate, model still failed | effort / decompose / accept |
| **not-fixable** | needs human structural judgement | path-B (GitHub issue) |

A solved case is **promoted to `fixtures-local/`** with a manifest (`expected.footnote_links`) — the
win freezes into a permanent objective regression test.

### Edit-gen engines: `deepseek` (default) vs `aider`

The vibe loop has two interchangeable **edit-gen engines** (`--engine`, default `deepseek`); the rest
of the scaffold (assessment routing, the gate, corpus runner, taxonomy, cost meter) is shared:

- **`deepseek`** — our `propose_patch` (full-function JSON) + `apply_function_replacements` (op:
  replace/add/register/edit). Tight JSON contract + path-allowlist + dangerous-scan *before* apply.
- **`aider`** — [aider](https://aider.chat) (Apache-2.0) edits the sandbox via **repo-map +
  search/replace + a test-driven retry loop**, where **our `_reconvert` + `evaluate` gate is its
  `--test-cmd`** (`app/Python/vibe_aider_gate.py`). Better at coordinated multi-edit structural fixes
  that the full-function format clobbers. `app/Python/vibe_aider.py`: make_sandbox + `git init` →
  diagnostic message (reuses the flagged forks + `_markup_in_context`) → run aider headless (config
  baked in: `--edit-format diff`, `--reasoning-effort low`, `app/Python/aider_model_metadata.json`)
  → capture the `git diff` → **path-allowlist + dangerous-scan it** → evaluate. The patch is a
  `vibe_patch.diff`; `apply_patch_to_book` autodetects diff vs JSON on accept.

```bash
python3 tests/conversion/vibe_eval.py --case <broken> --engine aider   # A/B vs --engine deepseek
```

**Security:** aider runs on the **host** (it needs network for the model) editing a throwaway sandbox
(text edits only). The only place model code *executes* is the gate's reconvert, which stays in the
locked container via `--docker $VIBE_SANDBOX_IMAGE` (the gate reads `VIBE_GATE_DOCKER`). The final diff
is path-allowlisted + `_DANGEROUS`-scanned before accept.

**Setup:** `aider-chat` in a venv; point `VIBE_AIDER_BIN` at its `aider`. On prod set
`VIBE_ENGINE=aider` + `VIBE_AIDER_BIN` in `.env` (the queue worker runs aider on the host;
`VIBE_SANDBOX_IMAGE` keeps the reconvert containerised).

---

## 8. Running it locally / on prod

```sh
# unit + regression
python3 -m pytest
python3 tests/conversion/run_regression.py

# vibe conversion on one book (CLI; LLM_API_KEY read from .env)
python3 app/Python/vibe_convert.py resources/markdown/<bookId> --max-attempts 5
python3 app/Python/vibe_convert.py resources/markdown/<bookId> --print-prompt   # see the prompt
```

The user-facing button runs via the queue worker; make sure it's up (`php artisan queue:work`
locally; Supervisor on prod). The toast JS needs `npm run build` after changes.

## 9. Prod / security checklist

- **`GITHUB_TOKEN`** in prod `.env` (a `hyperlit-bot` PAT) — else issue-filing dry-runs.
- **`LLM_API_KEY`** / `LLM_BASE_URL` (already used by AiBrain) drive the DeepSeek call.
- **⚠️ The sandbox executes LLM-generated Python.** On dev it's guarded by the path-allowlist +
  dangerous-code scan + scrubbed env + temp copy + timeouts. **On prod, run the re-conversion in
  a container** — the model call stays on the host, but the code-execution part is isolated:

  ```sh
  # on the droplet, once:
  docker build -t hyperlit-vibe-sandbox docker/vibe-sandbox
  # then in prod .env:
  VIBE_SANDBOX_IMAGE=hyperlit-vibe-sandbox
  ```

  When `VIBE_SANDBOX_IMAGE` is set, `VibeConversionJob` passes `--docker <image>` and the
  re-conversion runs via `docker run --network none --read-only --tmpfs /tmp --user <uid>
  --memory 1g --cpus 1 --pids-limit 256 --security-opt no-new-privileges` with **no host env**
  (so secrets are unreachable) and only the sandbox/book/output dirs bind-mounted at identical
  paths. The image carries just the Python conversion deps — no pandoc, no network libs. Leave
  `VIBE_SANDBOX_IMAGE` unset in dev to run the re-conversion as a plain (scrubbed-env) subprocess.

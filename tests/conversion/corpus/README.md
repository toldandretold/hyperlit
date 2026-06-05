# Co-evolution corpus

Drop problem documents here, run the eval, then Claude diagnoses each failure with you. This
directory is **git-ignored** (only this README is tracked) — the files are your local material.

## Add a case

Create a directory per document: `corpus/<case>/`, containing the conversion **input** in the same
form a fixture uses — one of:

- `ocr_response.json` (a PDF's cached OCR — no Mistral call is made)
- `input.epub` **or** an `epub_original/` directory
- `input.md` · `input.html` · `input.docx`

The easiest source is a book that converted badly on the site: copy its
`resources/markdown/<bookId>/` directory into `corpus/<case>/` — it already contains the input
(`ocr_response.json` or `epub_original/`). A raw `*.epub/*.md/*.html/*.docx` is auto-aliased to the
`input.<ext>` name.

Optional, alongside the input:
- `note.txt` — what you (the reader) think is wrong; fed to the model as a strong hint.
- `truth.json` — known-correct expectations, when you know them.

## Run

```bash
python3 tests/conversion/vibe_eval.py                 # convert + vibe loop per case (real LLM, cached)
python3 tests/conversion/vibe_eval.py --no-vibe       # convert + scaffold only (no tokens) — first look
python3 tests/conversion/vibe_eval.py --no-llm        # re-score from cache (free) after a code-only change
python3 tests/conversion/vibe_eval.py --case <substr> # subset
# A/B the edit-gen strategy (see ../README.md §6-7 for the full matrix + the --model gotcha):
python3 tests/conversion/vibe_eval.py --case <substr> --model accounts/fireworks/models/gpt-oss-120b
python3 tests/conversion/vibe_eval.py --case <substr> --engine aider --model accounts/fireworks/models/gpt-oss-120b
```

> **aider is installed** (at `/tmp/aider-venv/bin/aider`, a venv NOT on `$PATH`) and the model key is
> `LLM_API_KEY` in `.env` (not an env var). `which aider` / `printenv` will lie — check via the code:
> `python3 -c "import sys;sys.path.insert(0,'app/Python');import vibe_aider as a;print(a._aider_bin())"`.
> See `../README.md` (the 🛑 callout in the run-modes section) for the full why.

> The import pathway each case runs through is mapped in [`../PIPELINE_MAP.md`](../PIPELINE_MAP.md) —
> use it to locate which stage a flagged fork belongs to before writing the judgement.

Outputs:
- `corpus/<case>/converted/` — the freshly-converted artifacts (assessment/audit/stats/…).
- `corpus/<case>/postmortem.md` — the **post-mortem stub**: auto symptom + flagged forks + what
  DeepSeek tried. The `## Judgement` section is where **Claude (in-session)** writes the diagnosis
  (defect · ultimate_solution · attribution · fix_category). It is preserved across re-runs.
- `tests/conversion/vibe_eval_report.md` / `.json` — the scoreboard across all cases.

## The loop

1. You drop files + run the eval.
2. You ask Claude (in our session) to "diagnose the failures."
3. Claude reads each `converted/` + `postmortem.md` stub, writes the judgement, and — when a fix
   shape isn't yet in `tests/conversion/fix_categories.json` — appends a new category to it.
4. Attribution routes the work: **signal-gap** → conversion code / assessment · **prompt-gap** →
   the prompt / `fix_categories.json` · **inexpressible** → the patch-format · **capability-gap** →
   effort/decompose · **not-fixable** → path-B (human).
5. Apply the improvement (code and/or prompt), re-run — the scoreboard movement measures whether
   DeepSeek got better. Promote solved cases to `fixtures-local/` as permanent regression tests.

See `tests/conversion/README.md` §Co-evolution harness and the plan
`~/.claude/plans/okay-now-for-the-luminous-ritchie.md`.

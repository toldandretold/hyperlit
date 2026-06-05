#!/usr/bin/env python3
"""Co-evolution corpus runner — the mechanical half of the vibe-conversion eval loop.

For every case under tests/conversion/corpus/<case>/ this:
  1. CONVERTS the supplied source through the real pipeline (reusing run_regression's pathway
     runners — PDF replays cached OCR, no Mistral call) to produce assessment/audit/stats,
  2. runs the vibe loop (vibe_convert.run_loop) — the model proposes a pipeline fix, validated in
     an isolated sandbox against THIS document, with responses cached by prompt-hash,
  3. writes a per-case **post-mortem stub** (auto-filled symptom + flagged forks + what the model
     tried) — Claude fills the JUDGEMENT section in-session,
  4. emits a **scoreboard** (vibe_eval_report.{md,json}) aggregating outcomes.

It does NOT judge — that's Claude in-session (see the plan / README §Co-evolution). There is NO
automated LLM-judge here. The post-mortem's auto sections are refreshed on every run; the
JUDGEMENT section you (Claude) write is PRESERVED across re-runs.

A corpus case is a directory holding the conversion INPUT in the same form a fixture does — one of
ocr_response.json / input.epub / epub_original/ / input.md / input.html / input.docx (copying a
book's resources/markdown/<id>/ dir works, it already has these). A raw *.epub/*.md/*.html/*.docx
is auto-aliased to the input.<ext> name. Optional note.txt (the reader's complaint, fed to the
model) and truth.json (known-correct expectations) may sit alongside.

Usage:
    python3 tests/conversion/vibe_eval.py                 # run every corpus case (real LLM, cached)
    python3 tests/conversion/vibe_eval.py --case aarushi  # just matching cases
    python3 tests/conversion/vibe_eval.py --no-vibe       # convert + scaffold only (no tokens)
    python3 tests/conversion/vibe_eval.py --no-llm        # re-score from cache only (free)
    python3 tests/conversion/vibe_eval.py --max-attempts 5 --model <id>
"""

import argparse
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))            # tests/conversion
REPO_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PY_DIR = os.path.join(REPO_ROOT, 'app', 'Python')
CORPUS_DIR = os.path.join(HERE, 'corpus')
CACHE_DIR = os.path.join(CORPUS_DIR, '.llm_cache')
REPORT_MD = os.path.join(HERE, 'vibe_eval_report.md')
REPORT_JSON = os.path.join(HERE, 'vibe_eval_report.json')

sys.path.insert(0, HERE)        # run_regression (pathway runners)
sys.path.insert(0, PY_DIR)      # vibe_convert + the conversion package
import run_regression as rr     # noqa: E402
import vibe_convert as vc       # noqa: E402
from conversion import fix_categories  # noqa: E402

# Raw source files get aliased to the input name the runners expect.
EXT_TO_INPUT = {'.epub': 'input.epub', '.md': 'input.md', '.html': 'input.html',
                '.htm': 'input.html', '.docx': 'input.docx'}

# Preservation boundary: ANY line starting with this prefix (so Claude can rename the rest of the
# header — "## Judgement — Claude, <date>" — without the next run wiping the analysis).
JUDGEMENT_MARKER = "## Judgement"
DEFAULT_JUDGEMENT = f"""{JUDGEMENT_MARKER} — Claude fills this in-session
> The harness scaffolded everything above. Claude (in our session) reasons about the run and fills
> these. Attribution routes the work: signal-gap → conversion code / assessment · prompt-gap →
> prompt / fix_categories.json · inexpressible → patch-format · capability-gap → effort/decompose ·
> not-fixable → path-B. A `fix_category` of `NEW: <name>` means: append it to fix_categories.json.

- **defect**: <what actually went wrong in the conversion>
- **ultimate_solution**: <the ideal patch that WOULD have fixed it>
- **attribution**: <signal-gap | prompt-gap | inexpressible | capability-gap | not-fixable>
- **fix_category**: <id from fix_categories.json, or `NEW: <name>`>
- **action**: <code-backlog and/or prompt-backlog item>
"""


# ---------------------------------------------------------------------------
# Discovery + conversion
# ---------------------------------------------------------------------------
_CONVERTIBLE_EXTS = {'.pdf', '.epub', '.md', '.html', '.htm', '.docx'}


def _ingest_loose_files():
    """A convertible file dropped DIRECTLY in corpus/ becomes its own case dir — so you can 'just
    drop a file' and the harness imports it (matching the normal import flow). Moves it into
    corpus/<slug>/. README.md (the tracked contract) is left alone."""
    if not os.path.isdir(CORPUS_DIR):
        return
    for fn in sorted(os.listdir(CORPUS_DIR)):
        full = os.path.join(CORPUS_DIR, fn)
        if (not os.path.isfile(full) or fn.startswith('.') or fn.lower() == 'readme.md'
                or os.path.splitext(fn)[1].lower() not in _CONVERTIBLE_EXTS):
            continue
        slug = re.sub(r'[^a-z0-9]+', '_', os.path.splitext(fn)[0].lower()).strip('_')[:48] or 'case'
        case = os.path.join(CORPUS_DIR, slug)
        os.makedirs(case, exist_ok=True)
        shutil.move(full, os.path.join(case, fn))
        print(f"  ingested loose file → corpus/{slug}/{fn}")


def discover_cases(case_filter=None):
    if not os.path.isdir(CORPUS_DIR):
        return []
    _ingest_loose_files()
    cases = []
    for name in sorted(os.listdir(CORPUS_DIR)):
        d = os.path.join(CORPUS_DIR, name)
        if not os.path.isdir(d) or name.startswith('.'):
            continue
        if case_filter and case_filter not in name:
            continue
        cases.append(d)
    return cases


# Harness files that live in a case dir but are NEVER the source document (so a `.md` post-mortem
# / readme is not mistaken for an input.md).
_RESERVED_NAMES = {'note.txt', 'truth.json', 'postmortem.md', 'readme.md'}


def _alias_inputs(case_dir):
    """Copy a raw *.epub/*.md/*.html/*.docx to the input.<ext> name the runners expect (idempotent).
    Skips harness files (note.txt/postmortem.md/…) and the generated converted/ dir."""
    for fn in os.listdir(case_dir):
        if fn.lower() in _RESERVED_NAMES or fn.startswith('input.') or fn == 'converted':
            continue
        full = os.path.join(case_dir, fn)
        if not os.path.isfile(full):
            continue
        target = EXT_TO_INPUT.get(os.path.splitext(fn)[1].lower())
        if target and not os.path.isfile(os.path.join(case_dir, target)):
            shutil.copy2(full, os.path.join(case_dir, target))


def _ensure_pdf_ocr(case_dir):
    """A raw *.pdf needs OCR before the pipeline can replay it. Run Mistral OCR ONCE and cache
    ocr_response.json in the case dir (exactly like the normal import) — reused on every later run.
    Returns an error string or None."""
    if os.path.isfile(os.path.join(case_dir, 'ocr_response.json')):
        return None  # already imported — reuse the cache (no OCR cost)
    pdf = next((os.path.join(case_dir, f) for f in sorted(os.listdir(case_dir))
                if f.lower().endswith('.pdf')), None)
    if not pdf:
        return None
    key = os.environ.get('MISTRAL_OCR_API_KEY') or vc._dotenv('MISTRAL_OCR_API_KEY')
    if not key:
        return "raw PDF needs OCR but MISTRAL_OCR_API_KEY is not set (add it to .env)"
    print(f"  OCR'ing {os.path.basename(pdf)} via Mistral (one-time — caches ocr_response.json)…")
    r = rr._run([sys.executable, rr.MISTRAL_OCR_SCRIPT, pdf, case_dir, '--api-key', key], timeout=1800)
    if r.returncode != 0 or not os.path.isfile(os.path.join(case_dir, 'ocr_response.json')):
        return f"OCR failed: {(r.stderr or '')[-300:]}"
    return None


def convert_case(case_dir, out_dir):
    """Run the real pipeline into out_dir. Returns (pipeline, error_message)."""
    _alias_inputs(case_dir)
    ocr_err = _ensure_pdf_ocr(case_dir)
    if ocr_err:
        return None, ocr_err
    pipeline = rr._detect_pipeline(case_dir)
    if pipeline == 'none':
        return None, ("no convertible input — drop one of ocr_response.json / input.epub / "
                      "epub_original/ / input.md / input.html / input.docx into the case dir")
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)
    fixture = {'name': os.path.basename(case_dir), 'dir': case_dir,
               'manifest': {'book_id': os.path.basename(case_dir)}, 'pipeline': pipeline}
    err = rr.RUNNERS[pipeline](fixture, out_dir)
    if err == 'skipped':
        return None, f"{pipeline} pipeline skipped (a tool like pandoc is unavailable)"
    if err:
        return None, f"conversion failed at {err.get('stage')}: {(err.get('stderr') or '')[:200]}"
    # The vibe loop's reconvert (vibe_convert._pipeline_into) replays the pathway from the SOURCE
    # inside the book_dir (so a patch is actually exercised). The pdf runner already drops
    # ocr_response.json; copy the other pathways' inputs in (prod book_dirs already carry them).
    for name in ('epub_original', 'original.epub', 'input.epub', 'input.html', 'input.md', 'input.docx',
                 'footnote_meta.json'):
        s = os.path.join(case_dir, name)
        d = os.path.join(out_dir, name)
        if os.path.exists(s) and not os.path.exists(d):
            (shutil.copytree if os.path.isdir(s) else shutil.copy2)(s, d)
    return pipeline, None


# ---------------------------------------------------------------------------
# Post-mortem scaffold
# ---------------------------------------------------------------------------
def _auto_markdown(case, pipeline, art, report, note):
    """The AUTO half of the post-mortem — refreshed every run."""
    stats = art.get('stats', {})
    audit = art.get('audit', {})
    flagged = vc.flagged_forks(art.get('assessment', []))
    lines = [
        f"# Post-mortem — {case}",
        "_Auto-generated by vibe_eval.py. Everything above '## Judgement' is refreshed each run;",
        "the Judgement section is preserved._",
        "",
        "## Symptom (auto)",
        f"- pipeline: **{pipeline}**",
        f"- baseline: {vc._stat_summary(stats)}",
        f"- audit: refs {audit.get('total_refs', '?')} / defs {audit.get('total_defs', '?')}; "
        f"gaps {len(audit.get('gaps', []))}, unmatched_refs {len(audit.get('unmatched_refs', []))}, "
        f"unmatched_defs {len(audit.get('unmatched_defs', []))}",
        f"- outcome: **{report.get('outcome', 'not-run')}**"
        + (f" (best: {report.get('best')})" if report.get('best') else ""),
    ]
    if note:
        lines += ["", "## Reader's note (auto)", note.strip()[:1000]]
    lines += ["", "## Flagged forks (auto)"]
    if flagged:
        for r in flagged:
            lines.append(f"- **{r.get('module')}** (conf {r.get('confidence')}) — "
                         f"{r.get('decision')} · {r.get('margin') or ''}")
    else:
        lines.append("- (none flagged — if the conversion is faulty, that's a signal-gap: the "
                     "assessment didn't surface it)")

    lines += ["", "## What the model tried (auto)"]
    attempts = report.get('attempts', [])
    if attempts:
        for a in attempts:
            tag = []
            if a.get('categories') and a['categories'] != ['?']:
                tag.append("cats=" + ",".join(a['categories']))
            if a.get('ops'):
                tag.append("ops=" + ",".join(a['ops']))
            if a.get('inexpressible'):
                tag.append("INEXPRESSIBLE")
            lines.append(f"- attempt {a.get('attempt')} [{a.get('tier')}] "
                         f"{' '.join(tag)} touched={a.get('touches')}\n"
                         f"    why: {a.get('why')}")
            if a.get('diagnosis'):
                lines.append(f"    diagnosis: {a['diagnosis'][:240]}")
    else:
        lines.append("- (the loop did not run — use without --no-vibe to attempt a fix)")
    lines += ["", f"_fix-category registry: {len(fix_categories.model_categories())} model-scope "
                  f"shapes available; tag this case with one (or coin a NEW one)._", ""]
    return "\n".join(lines)


def write_postmortem(case_dir, auto_md):
    """Write the post-mortem, PRESERVING any Judgement section Claude already wrote."""
    path = os.path.join(case_dir, 'postmortem.md')
    judgement = DEFAULT_JUDGEMENT
    if os.path.isfile(path):
        existing = open(path, encoding='utf-8').read()
        m = re.search(r'(?m)^## Judgement.*$', existing)  # first '## Judgement…' line onward
        if m:
            judgement = existing[m.start():]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(auto_md + "\n" + judgement)
    return path


# ---------------------------------------------------------------------------
# Per-case run + scoreboard
# ---------------------------------------------------------------------------
def run_case(case_dir, args):
    case = os.path.basename(case_dir)
    out_dir = os.path.join(case_dir, 'converted')
    note_path = os.path.join(case_dir, 'note.txt')
    note = open(note_path, encoding='utf-8').read() if os.path.isfile(note_path) else None

    print(f"\n=== {case} ===")
    pipeline, err = convert_case(case_dir, out_dir)
    if err:
        print(f"  ! {err}")
        write_postmortem(case_dir, f"# Post-mortem — {case}\n\n## Symptom (auto)\n- ERROR: {err}\n")
        return {'case': case, 'pipeline': None, 'outcome': 'convert-error', 'error': err,
                'attempts': [], 'categories': [], 'inexpressible': False}
    print(f"  converted via {pipeline}")

    report = {}
    if args.no_vibe:
        report = {'outcome': 'not-run'}
    else:
        os.environ['VIBE_LLM_CACHE'] = CACHE_DIR
        if args.no_llm:
            os.environ['VIBE_LLM_CACHE_ONLY'] = '1'
        else:
            os.environ.pop('VIBE_LLM_CACHE_ONLY', None)
        try:
            if getattr(args, 'engine', 'native') == 'aider':
                import vibe_aider
                vibe_aider.run_aider_loop(out_dir, max_attempts=args.max_attempts, model=args.model,
                                          user_note=note, file_issue=False)
            else:
                vc.run_loop(out_dir, max_attempts=args.max_attempts, model=args.model,
                            user_note=note, file_issue=False)
        except SystemExit as e:
            print(f"  ! vibe loop aborted: {e}")
        rp = os.path.join(out_dir, 'vibe_report.json')
        if os.path.isfile(rp):
            report = json.load(open(rp, encoding='utf-8'))

    art = vc.load_artifacts(out_dir)
    write_postmortem(case_dir, _auto_markdown(case, pipeline, art, report, note))

    attempts = report.get('attempts', [])
    cats = sorted({c for a in attempts for c in (a.get('categories') or []) if c != '?'})
    return {'case': case, 'pipeline': pipeline, 'outcome': report.get('outcome', 'not-run'),
            'engine': report.get('engine', 'native'), 'prompt_variant': report.get('prompt_variant', 'full'),
            'baseline': vc._stat_summary(art.get('stats', {})), 'best': report.get('best'),
            'flagged': sorted(report.get('flagged', [])), 'attempts': attempts,
            'categories': cats, 'inexpressible': any(a.get('inexpressible') for a in attempts),
            'usage': report.get('usage')}


def _fmt_cost(usage):
    if not usage:
        return '—'
    tot = usage.get('total_tokens', 0)
    cost = usage.get('cost_usd')
    money = f"${cost:.4f}" if cost is not None else "set rate"
    return f"{tot:,} tok / {money}"


def write_scoreboard(results):
    from collections import Counter
    outcomes = Counter(r['outcome'] for r in results)
    n = len(results)
    fixed = outcomes.get('clean', 0)
    improved = outcomes.get('improved', 0)
    # Aggregate spend across cases (cached calls cost nothing).
    tot_in = sum((r.get('usage') or {}).get('prompt_tokens', 0) for r in results)
    tot_out = sum((r.get('usage') or {}).get('completion_tokens', 0) for r in results)
    costs = [(r.get('usage') or {}).get('cost_usd') for r in results]
    tot_cost = round(sum(c for c in costs if c is not None), 4) if any(c is not None for c in costs) else None
    calls = sum((r.get('usage') or {}).get('calls', 0) for r in results)
    cached = sum((r.get('usage') or {}).get('cached_calls', 0) for r in results)
    cost_line = (f"**${tot_cost:.4f}**" if tot_cost is not None
                 else "_(set LLM_PRICE_PER_MTOK_IN/_OUT in env for $)_")
    md = ["# Vibe-eval scoreboard", "",
          f"{n} case(s) — **{fixed} clean**, {improved} improved, "
          f"{outcomes.get('exhausted', 0)} exhausted, {outcomes.get('convert-error', 0)} convert-error, "
          f"{outcomes.get('not-run', 0)} not-run.",
          "",
          f"**Spend:** {calls} live call(s) ({cached} cached, $0) — "
          f"{tot_in:,} in + {tot_out:,} out = {tot_in + tot_out:,} tokens → {cost_line}.",
          "", "| case | pipeline | engine/variant | outcome | baseline → best | fix-categories tried | inexpr | tokens / cost |",
          "|------|----------|----------------|---------|-----------------|----------------------|--------|---------------|"]
    for r in results:
        best = r.get('best') or '—'
        md.append(f"| {r['case']} | {r.get('pipeline') or '—'} | {r.get('engine','native')}/{r.get('prompt_variant','full')} | "
                  f"**{r['outcome']}** | {r.get('baseline','?')} → {best} | "
                  f"{', '.join(r.get('categories') or []) or '—'} | "
                  f"{'⚠️' if r.get('inexpressible') else '—'} | {_fmt_cost(r.get('usage'))} |")
    md += ["", "_Each case has a postmortem.md awaiting Claude's JUDGEMENT (defect · ultimate_solution ·",
           "attribution · fix_category). Attribution drives the two backlogs (code vs prompt)._", ""]
    with open(REPORT_MD, 'w', encoding='utf-8') as f:
        f.write("\n".join(md))
    with open(REPORT_JSON, 'w', encoding='utf-8') as f:
        json.dump({'summary': dict(outcomes), 'cases': results}, f, ensure_ascii=False, indent=2)
    print("\n" + "\n".join(md[:4]))
    print(f"\nwrote {os.path.relpath(REPORT_MD, REPO_ROOT)} + .json")


def main():
    ap = argparse.ArgumentParser(description="Co-evolution corpus runner for the vibe loop.")
    ap.add_argument('--case', help="only run corpus cases whose name contains this substring")
    ap.add_argument('--max-attempts', type=int, default=3)
    ap.add_argument('--model', default=None,
                    help="LLM id (Fireworks). Unset → each engine's default (deepseek V4 Pro / aider "
                         "gpt-oss-120b). Pass it to run the SAME model on both engines (all-else-equal A/B).")
    ap.add_argument('--no-vibe', action='store_true', help="convert + scaffold only; don't run the loop (no tokens)")
    ap.add_argument('--no-llm', action='store_true', help="re-score from the response cache only (no API calls)")
    ap.add_argument('--engine', choices=['native', 'aider'], default='native',
                    help="edit-gen engine to A/B — a MECHANISM, not a model (default native; aider needs "
                         "VIBE_AIDER_BIN). Pair with --model to vary the LLM independently.")
    ap.add_argument('--prompt-variant', choices=['full', 'lean'], default=None,
                    help="prompt CONTENT to A/B: 'full' (default, with the fix-category menu) or 'lean' "
                         "(no menu — relies on the self-describing pipeline tree).")
    args = ap.parse_args()
    if args.prompt_variant:
        os.environ['VIBE_PROMPT_VARIANT'] = args.prompt_variant   # read by vibe_convert.build_diagnostic_context

    cases = discover_cases(args.case)
    if not cases:
        print(f"No corpus cases found under {os.path.relpath(CORPUS_DIR, REPO_ROOT)}/ "
              f"(create <case>/ dirs with a conversion input). Nothing to do.")
        return 0
    os.makedirs(CACHE_DIR, exist_ok=True)
    results = [run_case(c, args) for c in cases]
    write_scoreboard(results)
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""The 'aider' edit-gen engine for the vibe loop (opt-in: vibe_convert.py --engine aider).

Our home-grown propose_patch (full-function JSON) clobbers large methods and can't INVESTIGATE the
document. aider (Apache-2.0) edits a repo via repo-map + search/replace + a test-driven retry loop —
and slots in because it's test-driven: our `_reconvert` + `evaluate` gate becomes its `--test-cmd`.

This module owns ONLY the inner edit step. Everything else is reused from vibe_convert: the sandbox,
the gate, the assessment-derived diagnostic, the finalize/report/GitHub-issue path, the cost meter.

Flow: make_sandbox + git-init → write the diagnostic task message → run aider headless (the spike
config: --edit-format diff, --reasoning-effort low, the model-metadata file) with our gate as
--test-cmd → capture the resulting `git diff` → path-allowlist + dangerous-scan it → evaluate the
final reconvert → write vibe_patch.diff + vibe_report.json. aider runs on the HOST (it needs network
for the model); the only place model code RUNS is the gate's reconvert, which stays Dockerised on prod.
"""
import json
import os
import re
import shutil
import subprocess

import vibe_convert as vc
from conversion import fix_categories

DEFAULT_MODEL = 'accounts/fireworks/models/deepseek-v4-pro'
# aider's strength is FAST iteration (repo-map + a 3-reflection retry loop), NOT one heavy reasoning
# pass — so it defaults to a FAST model (gpt-oss-120b: seconds/call, not the minutes a reasoning model
# takes ×4 calls → the 25-min runs). Override with VIBE_AIDER_MODEL.
DEFAULT_AIDER_MODEL = 'accounts/fireworks/models/gpt-oss-120b'
_META = os.path.join(vc.PY_DIR, 'aider_model_metadata.json')


def _aider_bin():
    """The aider executable: VIBE_AIDER_BIN, else on PATH, else a common dev venv. None if absent."""
    cand = os.environ.get('VIBE_AIDER_BIN') or shutil.which('aider')
    if cand and os.path.isfile(cand):
        return cand
    for p in ('/tmp/aider-venv/bin/aider', os.path.expanduser('~/.aider-venv/bin/aider')):
        if os.path.isfile(p):
            return p
    return cand if (cand and shutil.which(cand)) else None


def _git(sandbox, *args):
    return subprocess.run(['git', '-C', sandbox, *args], capture_output=True, text=True)


def _git_init(sandbox):
    _git(sandbox, 'init', '-q')
    _git(sandbox, 'add', '-A')
    _git(sandbox, '-c', 'user.email=vibe@hyperlit', '-c', 'user.name=vibe', 'commit', '-qm', 'baseline')


def _git_diff(sandbox):
    return _git(sandbox, 'diff').stdout or ''


# ---------------------------------------------------------------------------
# The diagnostic task message (reuses vibe_convert's helpers; no op/JSON contract — aider edits)
# ---------------------------------------------------------------------------
def build_aider_message(art, modules, user_note=None):
    flagged = vc.flagged_forks(art['assessment'])
    st = art['stats']
    parts = [
        "A document converted badly and you are fixing the conversion PIPELINE so it converts THIS "
        "document correctly. A test command (--test-cmd) re-converts this exact document and checks "
        "the result; iterate until it PASSES. Modus operandi: correct where determinable, NO link "
        "where ambiguous — a wrong/misaligned link is WORSE than a missing one. Make the MINIMAL "
        "change that makes the test pass; don't rewrite whole functions to change a few lines.",
    ]
    if art.get('is_pdf'):
        parts.append("This is a PDF: the OCR is replayed from cache — do NOT change the OCR fetch "
                     "(fetch_ocr/extract_footer/extract_header); fix only the assembly/linking stages.")
    if user_note:
        parts.append("## What the reader says is wrong (weigh heavily)\n" + user_note.strip()[:1500])
    parts.append("## Conversion stats (the symptom)\n" + json.dumps(
        {k: st.get(k) for k in ('references_found', 'citations_total', 'citations_linked',
         'footnotes_matched', 'footnote_strategy', 'citation_style')}, ensure_ascii=False))
    if flagged:
        parts.append("## Flagged decisions (assessment.json — where the pipeline was unsure or a step dropped work)")
        for r in flagged:
            parts.append(json.dumps({k: r.get(k) for k in
                         ('module', 'code_ref', 'decision', 'rationale', 'margin', 'considered')},
                         ensure_ascii=False, indent=2))
    parts.append("## Audit verdict\n" + json.dumps({k: art['audit'].get(k) for k in
                 ('total_refs', 'total_defs', 'gaps', 'unmatched_refs', 'unmatched_defs')},
                 ensure_ascii=False, default=str)[:2000])
    samples = vc._footnote_samples(art)
    if samples:
        parts.append("## Actual footnote ref/definition lines from THIS document\n" + samples)
    ctx = vc._markup_in_context(art)
    if ctx:
        parts.append("## Markup in context (the element nesting a fixed excerpt hides; for an EPUB "
                     "also the RAW pre-conversion markup)\n" + ctx)
    parts.append(fix_categories.render_prompt_block(modules))
    parts.append("## Where the responsible code lives\n" + "\n".join(f"- {m}" for m in modules)
                 + "\nThese files are in the chat; read whatever else you need via the repo map.")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Validate aider's diff (same guarantees as validate_replacements: path-allowlist + dangerous scan)
# ---------------------------------------------------------------------------
def _validate_diff(diff):
    if not diff.strip():
        return False, "aider made no changes"
    touched = set(re.findall(r'^\+\+\+ b/(.+)$', diff, re.M)) | set(re.findall(r'^diff --git a/\S+ b/(\S+)$', diff, re.M))
    for path in touched:
        p = path.strip()
        if p in ('/dev/null',):
            continue
        allowed = p in vc.ALLOWED_FILES or any(p.startswith(pre) for pre in vc.ALLOWED_PREFIXES)
        if not allowed:
            return False, f"edited a disallowed path: {p}"
    added = '\n'.join(ln[1:] for ln in diff.split('\n') if ln.startswith('+') and not ln.startswith('+++'))
    for rx, label in vc._DANGEROUS:
        if rx.search(added):
            return False, f"the change uses '{label}', which conversion logic must never do — refused"
    return True, "ok"


def _parse_usage(log):
    """Best-effort: pull aider's reported tokens/cost from its stdout for the scoreboard. Handles
    abbreviated tokens ('2.6k sent', '57,714 sent') and the 'Cost: $x message, $y session' line
    (the SESSION figure is the running total — don't double-count message+session)."""
    def _tok(pat):
        t = 0.0
        for m in re.finditer(r'([\d.,]+)\s*([kKmM]?)\s+' + pat, log):
            t += float(m.group(1).replace(',', '')) * {'k': 1e3, 'm': 1e6}.get(m.group(2).lower(), 1.0)
        return int(t)
    session = re.findall(r'\$([0-9.]+)\s+session', log)
    cost = (float(session[-1]) if session
            else max((float(c) for c in re.findall(r'\$([0-9.]+)', log)), default=None))
    pt, ct = _tok('sent'), _tok('received')
    return {'prompt_tokens': pt, 'completion_tokens': ct, 'total_tokens': pt + ct,
            'calls': max(len(re.findall(r'Tokens:', log)), 1), 'cached_calls': 0,
            'cost_usd': (round(cost, 4) if cost is not None else None),
            'model': 'aider/' + DEFAULT_MODEL}


def _journal_from(log, diff, touched_summary):
    """A coarse journal (aider runs its own retry loop internally; we summarise its trace)."""
    gates = re.findall(r'GATE \[(\w+)\] (.+)', log)
    entries = []
    for i, (tier, why) in enumerate(gates, 1):
        entries.append({'attempt': i, 'tier': tier, 'why': why[:200], 'touches': touched_summary,
                        'diagnosis': '', 'stats': None, 'categories': ['aider'], 'ops': ['diff']})
    if not entries:
        entries.append({'attempt': 1, 'tier': 'apply_failed', 'why': 'aider produced no testable edit',
                        'touches': touched_summary, 'diagnosis': '', 'stats': None,
                        'categories': ['aider'], 'ops': ['diff']})
    return entries


# ---------------------------------------------------------------------------
# The engine entry point — mirrors run_loop's contract
# ---------------------------------------------------------------------------
def run_aider_loop(book_dir, max_attempts=3, model=DEFAULT_MODEL, user_note=None, file_issue=False):
    vc.reset_usage()
    # aider runs its own retry loop → use a FAST model (the passed `model` is the deepseek-loop default).
    model = os.environ.get('VIBE_AIDER_MODEL') or DEFAULT_AIDER_MODEL
    art = vc.load_artifacts(book_dir)
    flagged = vc.flagged_forks(art['assessment'])
    modules = vc.modules_for(flagged, art) or vc.modules_for(art['assessment'], art)
    phrase = vc._flagged_phrase(flagged)

    aider = _aider_bin()
    if not aider:
        vc.emit('error', "aider engine selected but aider isn't installed (set VIBE_AIDER_BIN).")
        return 1, None

    vc.emit('start',
            f"Your document converted as: {vc._stat_summary(art['stats'])} — aider (DeepSeek V4) will "
            f"investigate {phrase}, edit the pipeline, and re-test on THIS document until it passes. "
            f"This can take a few minutes.",
            baseline=vc._stat_summary(art['stats']), modules=modules)

    sandbox = vc.make_sandbox()
    try:
        _git_init(sandbox)
        msg_path = os.path.join(sandbox, '_vibe_task.md')
        with open(msg_path, 'w', encoding='utf-8') as f:
            f.write(build_aider_message(art, modules, user_note))

        env = dict(os.environ)
        env['FIREWORKS_AI_API_KEY'] = vc._dotenv('LLM_API_KEY') or env.get('FIREWORKS_AI_API_KEY', '')
        env['VIBE_GATE_BOOK'] = os.path.abspath(book_dir)
        if vc._DOCKER_IMAGE:
            env['VIBE_GATE_DOCKER'] = vc._DOCKER_IMAGE

        cmd = [aider,
               '--model', f'fireworks_ai/{model}',
               '--model-metadata-file', os.path.join(sandbox, 'app', 'Python', 'aider_model_metadata.json'),
               '--edit-format', 'diff', '--map-tokens', '2048',
               '--timeout', '600',  # per-API-call cap so a single hung call can't block the loop
               '--test-cmd', 'python3 app/Python/vibe_aider_gate.py', '--auto-test',
               '--no-auto-commits', '--yes-always', '--no-stream', '--no-pretty', '--no-check-update',
               '--message-file', msg_path]
        # Only reasoning models (e.g. deepseek) take reasoning_effort; gpt-oss etc. would error on it.
        if 'deepseek' in model or 'r1' in model.lower():
            cmd += ['--reasoning-effort', 'low']
        cmd += modules

        vc.emit('attempt', f"aider (DeepSeek V4) is investigating {phrase} and editing the pipeline…")
        if vc._cancelled():
            vc.emit('cancelled', "Cancelled — your original conversion is unchanged.")
            return 1, None
        try:
            # aider runs its own edit→test→reflect loop (hardcoded ~3 reflections); with a heavy
            # reasoning model each cycle is minutes, so give the whole thing generous headroom.
            proc = subprocess.run(cmd, cwd=sandbox, env=env, capture_output=True, text=True, timeout=2400)
            log = (proc.stdout or '') + '\n' + (proc.stderr or '')
        except subprocess.TimeoutExpired as e:
            log = ((e.stdout or '') if isinstance(e.stdout, str) else (e.stdout or b'').decode('utf-8', 'ignore')) \
                + "\n[aider hit the 40-min wall — consider a faster model (e.g. gpt-oss-120b) for aider]"

        try:  # keep aider's full transcript for debugging (cost/edit decisions)
            with open(os.path.join(book_dir, 'vibe_aider.log'), 'w', encoding='utf-8') as f:
                f.write(log)
        except Exception:
            pass
        diff = _git_diff(sandbox)
        touched = sorted(set(re.findall(r'^\+\+\+ b/(.+)$', diff, re.M)))
        journal = _journal_from(log, diff, [t.split('/')[-1] for t in touched])

        ok_diff, reason = _validate_diff(diff)
        if not ok_diff:
            vc.emit('exhausted', f"aider couldn't produce a usable fix ({reason}); kept your original.")
            _finalize_aider(book_dir, art, journal, 'exhausted', None, file_issue, log)
            return 1, None

        after = vc._reconvert(sandbox, book_dir)
        tier, why = ('reject', 'the edited code crashed converting the document') if not after['ok'] \
            else vc.evaluate(art, after)

        if tier in ('clean', 'improved'):
            _persist_diff(book_dir, diff)
            best = vc._stat_summary(after['stats']) if tier == 'improved' else None
            _finalize_aider(book_dir, art, journal, tier, best, False, log)
            vc.emit('success',
                    f"{'Fixed it cleanly' if tier == 'clean' else 'Improved'} — {vc._stat_summary(after['stats'])}.",
                    tier=tier, before=vc._stat_summary(art['stats']), after=vc._stat_summary(after['stats']))
            return 0, diff

        vc.emit('exhausted', f"aider tried but couldn't improve this document ({why}); kept your original "
                             f"and logged it for a human to review.")
        _finalize_aider(book_dir, art, journal, 'exhausted', None, file_issue, log)
        return 1, None
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def _persist_diff(book_dir, diff):
    with open(os.path.join(book_dir, 'vibe_patch.diff'), 'w', encoding='utf-8') as f:
        f.write(diff)


def _finalize_aider(book_dir, art, journal, outcome, best, file_issue, log):
    """Reuse vc._finalize, then overwrite usage with aider's own parsed cost (it makes the calls)."""
    vc._finalize(book_dir, art, journal, outcome, best=best, file_issue=file_issue)
    try:
        rp = os.path.join(book_dir, 'vibe_report.json')
        report = json.load(open(rp, encoding='utf-8'))
        report['engine'] = 'aider'
        report['usage'] = _parse_usage(log)
        with open(rp, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

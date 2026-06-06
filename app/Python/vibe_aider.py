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
import threading

import vibe_convert as vc
from conversion import fix_categories

DEFAULT_MODEL = 'accounts/fireworks/models/deepseek-v4-pro'
# aider wants a FAST model, NOT a heavy reasoning one. deepseek-v4-pro emits ~34k of reasoning per turn —
# it overflows its own 32k output limit (truncating the edit) AND accumulates across aider's reflect loop
# until it blows the 131k context (measured: gpt-oss = 53k flat, deepseek = 156k on the same input). So
# aider defaults to gpt-oss-120b. (The NATIVE engine is where deepseek belongs — see run_loop.)
DEFAULT_AIDER_MODEL = 'accounts/fireworks/models/gpt-oss-120b'
_META = os.path.join(vc.PY_DIR, 'aider_model_metadata.json')


def _model_label(model):
    """Short display name for the ACTUAL model in use (e.g. 'gpt-oss-120b') — so progress/usage never
    mislabel the run (it used to hardcode 'DeepSeek V4' even on a gpt-oss run)."""
    return (model or DEFAULT_AIDER_MODEL).rsplit('/', 1)[-1]


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
def build_aider_message(art, modules, user_note=None, issue_types=None):
    """aider engine prompt = the SHARED diagnostic context (vc.build_diagnostic_context — IDENTICAL to
    what the native engine sends) + a repo-map pointer instead of inlined source (aider reads files
    itself) and NO op contract (aider edits via diff, driven by `--test-cmd`). So native-vs-aider is a
    controlled A/B: same diagnosis, different edit mechanism. Edit a diagnostic section in
    build_diagnostic_context, NOT here — here is only aider's mechanism framing."""
    parts = ["A document's conversion was flagged for review and you are fixing the conversion PIPELINE "
             "so it converts THIS document correctly. Each item below is a SUSPICION to CONFIRM against the "
             "evidence first — fix only what is genuinely wrong. A test command (--test-cmd) re-converts "
             "this exact document and checks the result; iterate until it PASSES."]
    parts += vc.build_diagnostic_context(art, modules, user_note, issue_types)
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


def _parse_usage(log, model):
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
            'model': 'aider/' + (model or DEFAULT_AIDER_MODEL)}


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
# Stream aider's stdout into live progress beats (so the toast shows what aider is THINKING + doing in
# real time, instead of a frozen box). aider runs EXACTLY as before — this only changes how we read its
# pipe (line-by-line vs all-at-once), with zero effect on its edits, speed, or the resulting patch.
# ---------------------------------------------------------------------------
def _aider_beat(raw, state):
    """Translate ONE aider stdout line into a live beat (or accumulate a THINKING block). Mutates state."""
    s = raw.strip()

    # THINKING block — accumulate the model's reasoning, flush a condensed beat when the block ends.
    if '**THINKING**' in s or s.rstrip('*') .endswith('THINKING'):
        state['in_think'] = True
        state['think'] = []
        return
    if state.get('in_think'):
        if s == '' and not state['think']:
            return   # skip the blank line(s) right after the marker, before any reasoning
        ended = (s == '' or s.startswith('```') or '<<<<<<< SEARCH' in s)
        if not ended:
            state['think'].append(s)
            return
        text = ' '.join(state['think']).strip()
        state['in_think'] = False
        state['think'] = []
        if len(text) >= 12:
            beat = text if len(text) <= 280 else (text[:280].rsplit(' ', 1)[0] + '…')
            vc.emit('attempt', '💭 ' + beat)
        # fall through so a SEARCH/``` line that ended the block is still handled below

    if s.startswith('Added ') and 'to the chat' in s:
        if not state.get('read_done'):
            state['read_done'] = True
            vc.emit('attempt', 'Reading the pipeline modules it needs…')
        return
    if '<<<<<<< SEARCH' in s:
        if not state.get('edit_done'):
            state['edit_done'] = True
            vc.emit('attempt', 'Editing the pipeline code…')
        return
    if 'vibe_aider_gate.py' in s and not s.startswith('GATE'):
        if not state.get('test_done'):
            state['test_done'] = True
            vc.emit('attempt', 'Re-converting and testing the fix on your document…')
        return
    if s.startswith('GATE ['):
        vc.emit('attempt', 'Tested → ' + s[5:])
        # a new edit→test cycle may follow (aider reflects up to ~3x) — re-arm the per-cycle beats.
        state['edit_done'] = state['test_done'] = False
        return


def _run_aider_streaming(cmd, cwd, env, timeout):
    """Run aider, forwarding live beats from its stdout while collecting the full transcript (returned)."""
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    killed = {'v': False}
    done = threading.Event()

    def _watchdog():
        if not done.wait(timeout):
            killed['v'] = True
            try:
                proc.kill()
            except Exception:
                pass
    threading.Thread(target=_watchdog, daemon=True).start()

    lines, state = [], {}
    try:
        for raw in proc.stdout:
            lines.append(raw)
            try:
                _aider_beat(raw, state)
            except Exception:
                pass   # a beat translation must never break the run
    finally:
        done.set()
        try:
            proc.wait()
        except Exception:
            pass
    log = ''.join(lines)
    if killed['v']:
        log += "\n[aider hit the 40-min wall — consider a faster model (e.g. gpt-oss-120b) for aider]"
    return log


# ---------------------------------------------------------------------------
# The engine entry point — mirrors run_loop's contract
# ---------------------------------------------------------------------------
def run_aider_loop(book_dir, max_attempts=3, model=None, user_note=None, file_issue=False, issue_types=None):
    vc.reset_usage()
    # Model precedence: an explicit `--model` wins (so you can A/B the SAME model on both engines),
    # then VIBE_AIDER_MODEL, then aider's fast default (gpt-oss-120b — aider runs its own retry loop).
    model = model or os.environ.get('VIBE_AIDER_MODEL') or DEFAULT_AIDER_MODEL
    art = vc.load_artifacts(book_dir)
    flagged = vc.flagged_forks(art['assessment'])
    modules = vc.modules_for(flagged, art, issue_types) or vc.modules_for(art['assessment'], art, issue_types)
    # Keep ALL the routed modules a human report / flagged forks selected (dropping them was cutting the
    # issue-type routing on multi-category reports). The real context bloat was aider's repo scan of the
    # test fixtures (now excluded from the sandbox), NOT these ~14k of module files. A high cap only guards
    # the pathological case; modules_for orders flagged-fork modules first so the most-relevant survive.
    modules = modules[:8]
    phrase = vc._flagged_phrase(flagged)

    aider = _aider_bin()
    if not aider:
        vc.emit('error', "aider engine selected but aider isn't installed (set VIBE_AIDER_BIN).")
        return 1, None

    vc.emit('start',
            f"Your document converted as: {vc._stat_summary(art['stats'])} — aider ({_model_label(model)}) will "
            f"investigate {phrase}, edit the pipeline, and re-test on THIS document until it passes. "
            f"This can take a few minutes.",
            baseline=vc._stat_summary(art['stats']), modules=modules)

    sandbox = vc.make_sandbox()
    try:
        _git_init(sandbox)
        msg_path = os.path.join(sandbox, '_vibe_task.md')
        with open(msg_path, 'w', encoding='utf-8') as f:
            f.write(build_aider_message(art, modules, user_note, issue_types))

        env = dict(os.environ)
        env['PYTHONUNBUFFERED'] = '1'   # so aider's stdout flushes line-by-line (live beats), not at the end
        env['FIREWORKS_AI_API_KEY'] = vc._dotenv('LLM_API_KEY') or env.get('FIREWORKS_AI_API_KEY', '')
        env['VIBE_GATE_BOOK'] = os.path.abspath(book_dir)
        if issue_types:
            env['VIBE_GATE_ISSUE_TYPES'] = json.dumps(issue_types)   # the gate honours the reader's report
        if vc._DOCKER_IMAGE:
            env['VIBE_GATE_DOCKER'] = vc._DOCKER_IMAGE

        cmd = [aider,
               '--model', f'fireworks_ai/{model}',
               '--model-metadata-file', os.path.join(sandbox, 'app', 'Python', 'aider_model_metadata.json'),
               '--edit-format', 'diff', '--map-tokens', '1024',
               # BOUND the chat history — a reasoning model (deepseek) emits huge thinking each turn, and
               # across aider's reflect loop it ACCUMULATES until it blows the 131k window (the real cause
               # of the "context exceeded → no usable edit" failures). Capping history keeps total in range.
               '--max-chat-history-tokens', '24000',
               '--timeout', '600',  # per-API-call cap so a single hung call can't block the loop
               '--test-cmd', 'python3 app/Python/vibe_aider_gate.py', '--auto-test',
               '--no-auto-commits', '--yes-always', '--no-stream', '--no-pretty', '--no-check-update',
               '--message-file', msg_path]
        # Only reasoning models (e.g. deepseek) take reasoning_effort; gpt-oss etc. would error on it.
        if 'deepseek' in model or 'r1' in model.lower():
            cmd += ['--reasoning-effort', 'low']
        cmd += modules

        vc.emit('attempt', f"aider ({_model_label(model)}) is investigating {phrase} and editing the pipeline…")
        if vc._cancelled():
            vc.emit('cancelled', "Cancelled — your original conversion is unchanged.")
            return 1, None
        # aider runs its own edit→test→reflect loop (hardcoded ~3 reflections); with a heavy reasoning
        # model each cycle is minutes, so give the whole thing generous headroom. We STREAM its stdout so
        # the toast keeps showing live beats (aider is otherwise a silent block) — see _aider_beats.
        log = _run_aider_streaming(cmd, sandbox, env, timeout=2400)

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
            _finalize_aider(book_dir, art, journal, 'exhausted', None, file_issue, log, model)
            return 1, None

        after = vc._reconvert(sandbox, book_dir)
        tier, why = ('reject', 'the edited code crashed converting the document') if not after['ok'] \
            else vc.evaluate(art, after)

        if tier in ('clean', 'improved'):
            _persist_diff(book_dir, diff)
            best = vc._stat_summary(after['stats']) if tier == 'improved' else None
            _finalize_aider(book_dir, art, journal, tier, best, False, log, model)
            vc.emit('success',
                    f"{'Fixed it cleanly' if tier == 'clean' else 'Improved'} — {vc._stat_summary(after['stats'])}.",
                    tier=tier, before=vc._stat_summary(art['stats']), after=vc._stat_summary(after['stats']))
            return 0, diff

        vc.emit('exhausted', f"aider tried but couldn't improve this document ({why}); kept your original "
                             f"and logged it for a human to review.")
        _finalize_aider(book_dir, art, journal, 'exhausted', None, file_issue, log, model)
        return 1, None
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def _persist_diff(book_dir, diff):
    with open(os.path.join(book_dir, 'vibe_patch.diff'), 'w', encoding='utf-8') as f:
        f.write(diff)


def _finalize_aider(book_dir, art, journal, outcome, best, file_issue, log, model=None):
    """Reuse vc._finalize, then overwrite usage with aider's own parsed cost (it makes the calls)."""
    vc._finalize(book_dir, art, journal, outcome, best=best, file_issue=file_issue)
    try:
        rp = os.path.join(book_dir, 'vibe_report.json')
        report = json.load(open(rp, encoding='utf-8'))
        report['engine'] = 'aider'
        report['usage'] = _parse_usage(log, model)
        with open(rp, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

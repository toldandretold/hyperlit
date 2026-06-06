#!/usr/bin/env python3
"""aider `--test-cmd` for the vibe loop's aider engine.

Re-converts THIS document with the CURRENT (aider-edited) conversion code in the sandbox and
evaluates it against the original (faulty) baseline — the SAME gate the DeepSeek loop uses, so
the two engines are judged identically. Exit 0 = clean/improved (aider stops); non-zero = reject
(aider reads the printed reason + retries via --auto-test). Run from the sandbox repo root (the
git repo aider edits); reuses vibe_convert._reconvert / evaluate / load_artifacts.

Env: VIBE_GATE_BOOK (the book dir) · VIBE_GATE_DOCKER (optional sandbox image → the reconvert,
the only place model code RUNS, stays containerised on prod) · VIBE_GATE_ISSUE_TYPES (JSON array of
the reader's reported problem categories, so the gate honours them — same as the native engine).
"""
import json
import os
import subprocess
import sys

_SANDBOX = os.getcwd()  # aider runs --test-cmd from the repo root
sys.path.insert(0, os.path.join(_SANDBOX, 'app', 'Python'))
import vibe_convert as v  # noqa: E402

book = os.environ.get('VIBE_GATE_BOOK')
if not book:
    print("GATE ERROR: VIBE_GATE_BOOK not set", flush=True)
    sys.exit(2)
if os.environ.get('VIBE_GATE_DOCKER'):
    v._DOCKER_IMAGE = os.environ['VIBE_GATE_DOCKER']

try:
    issue_types = json.loads(os.environ.get('VIBE_GATE_ISSUE_TYPES') or 'null')
except Exception:
    issue_types = None
# Files aider has edited so far (vs the init commit) — for the audit-gaming guard + the wrongly-matched
# check, same as the native engine passes. aider edits the working tree (--no-auto-commits).
try:
    _d = subprocess.run(['git', 'diff', '--name-only', 'HEAD'], cwd=_SANDBOX,
                        capture_output=True, text=True, timeout=30)
    patched = [ln.strip() for ln in _d.stdout.splitlines() if ln.strip()] or None
except Exception:
    patched = None

baseline = v.load_artifacts(book)
after = v._reconvert(_SANDBOX, book)
if not after['ok']:
    print("GATE [reject] the patched code crashed converting the document\n"
          + (after.get('stderr') or '')[-600:], flush=True)
    sys.exit(1)
tier, reason = v.evaluate(baseline, after, patched_files=patched, issue_types=issue_types)
print(f"GATE [{tier}] {reason} | now: {v._stat_summary(after['stats'])} "
      f"(baseline: {v._stat_summary(baseline['stats'])})", flush=True)
sys.exit(0 if tier in ('clean', 'improved') else 1)

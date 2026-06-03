#!/usr/bin/env python3
"""aider `--test-cmd` for the vibe loop's aider engine.

Re-converts THIS document with the CURRENT (aider-edited) conversion code in the sandbox and
evaluates it against the original (faulty) baseline — the SAME gate the DeepSeek loop uses, so
the two engines are judged identically. Exit 0 = clean/improved (aider stops); non-zero = reject
(aider reads the printed reason + retries via --auto-test). Run from the sandbox repo root (the
git repo aider edits); reuses vibe_convert._reconvert / evaluate / load_artifacts.

Env: VIBE_GATE_BOOK (the book dir) · VIBE_GATE_DOCKER (optional sandbox image → the reconvert,
the only place model code RUNS, stays containerised on prod).
"""
import os
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

baseline = v.load_artifacts(book)
after = v._reconvert(_SANDBOX, book)
if not after['ok']:
    print("GATE [reject] the patched code crashed converting the document\n"
          + (after.get('stderr') or '')[-600:], flush=True)
    sys.exit(1)
tier, reason = v.evaluate(baseline, after)
print(f"GATE [{tier}] {reason} | now: {v._stat_summary(after['stats'])} "
      f"(baseline: {v._stat_summary(baseline['stats'])})", flush=True)
sys.exit(0 if tier in ('clean', 'improved') else 1)

"""Guardrail: every app/Python file must PARSE on the oldest Python we deploy to.

Dev machines run 3.12+, production runs 3.11. Python 3.12's PEP 701 relaxed the
f-string grammar (backslashes inside replacement fields, quote reuse, newlines and
comments inside the braces), so a file that imports cleanly here can be a hard
SyntaxError on the server — and because it is a *syntax* error it fires at import
time, killing the whole OCR/conversion run rather than one code path. That shipped
once: `pdf_shared.py` used `f"{... re.sub(r'\\s+', ...)}"`, every PDF import on prod
died with "f-string expression part cannot include a backslash".

Two checks, belt and braces:
  * `_fstring_violations` — a tokenizer scan for the PEP 701-only constructs, so the
    gate works on any machine with no 3.11 interpreter installed.
  * a real `python3.11 -c compile(...)` pass when that binary happens to be on PATH,
    which is the ground truth and catches non-f-string grammar drift too.

If prod's floor moves, change MIN_PY (and the deploy) in one place.
"""

import io
import os
import shutil
import subprocess
import sys
import token
import tokenize

import pytest

MIN_PY = (3, 11)

APP_PYTHON = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', '..', '..', 'app', 'Python'))


def _py_files():
    out = []
    for root, dirs, files in os.walk(APP_PYTHON):
        dirs[:] = [d for d in dirs if d not in {'__pycache__', 'venv', '.venv', 'node_modules'}]
        out.extend(os.path.join(root, f) for f in files if f.endswith('.py'))
    return sorted(out)


def _quote_of(tok_string):
    """Delimiter of a string/f-string token — strips the rRbBuUfF prefix."""
    return tok_string.lstrip('rRbBuUfF')[:3] if tok_string.lstrip('rRbBuUfF')[:3] in (
        '"""', "'''") else tok_string.lstrip('rRbBuUfF')[:1]


def _fstring_violations(src):
    """PEP 701-only f-string constructs — [(line, reason)], empty when 3.11-safe."""
    if not hasattr(token, 'FSTRING_START'):
        return []                      # running ON <=3.11: compile() is the check
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return []                      # unparseable here — a different test's problem
    problems, stack = [], []
    for tok in toks:
        if tok.type == token.FSTRING_START:
            stack.append(_quote_of(tok.string))
            continue
        if tok.type == token.FSTRING_END:
            if stack:
                stack.pop()
            continue
        if not stack or tok.type == token.FSTRING_MIDDLE:
            continue                   # literal text: backslashes there are fine pre-3.12
        outer = stack[-1]
        if '\\' in tok.string:
            problems.append((tok.start[0], 'backslash inside an f-string expression'))
        if tok.type == token.STRING:
            inner = _quote_of(tok.string)
            # same quote CHARACTER reuse ends the outer literal pre-3.12; a single "
            # inside an f""" … """ is the legal old workaround, so allow that pairing.
            if outer[0] == inner[0] and (len(outer) == 1 or len(inner) == 3):
                problems.append((tok.start[0], f'nested {inner} inside an {outer} f-string'))
        if tok.type == token.COMMENT:
            problems.append((tok.start[0], 'comment inside an f-string expression'))
        if tok.type in (token.NEWLINE, token.NL) and len(outer) == 1:
            problems.append((tok.start[0], 'newline inside a single-quoted f-string'))
    return problems


def test_no_pep701_only_fstrings_in_app_python():
    failures = []
    for path in _py_files():
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        for line, why in _fstring_violations(src):
            failures.append(f'{os.path.relpath(path, APP_PYTHON)}:{line}: {why}')
    assert not failures, (
        'These need Python 3.12 syntax but prod runs %d.%d — hoist the regex/quote out '
        'of the f-string expression:\n  %s' % (*MIN_PY, '\n  '.join(failures)))


def test_scanner_flags_the_constructs_it_claims_to():
    """The gate is only worth having if it actually catches the shipped bug."""
    if not hasattr(token, 'FSTRING_START'):
        pytest.skip('running on <=3.11 — compile() is the real check there')
    shipped_bug = '''lambda m: f"{m.group(1)} {re.sub(r'\\\\s+', '', m.group(2))}"'''
    assert _fstring_violations(shipped_bug)                       # the pdf_shared.py regression
    assert _fstring_violations('f"{d["key"]}"')                   # quote reuse
    assert not _fstring_violations('f"{d[\'key\']}"')             # the 3.11-safe form
    assert not _fstring_violations(r'f"a\nb {x}"')                # backslash in LITERAL text is fine
    assert not _fstring_violations('f"""{d["key"]}"""')           # legal pre-3.12 workaround


def test_app_python_compiles_on_the_oldest_deployed_interpreter():
    exe = shutil.which('python%d.%d' % MIN_PY)
    if not exe:
        pytest.skip('python%d.%d not installed — tokenizer scan above is the gate' % MIN_PY)
    if sys.version_info[:2] == MIN_PY:
        exe = sys.executable
    script = (
        'import sys\n'
        'for p in sys.argv[1:]:\n'
        '    try:\n'
        '        compile(open(p, encoding="utf-8").read(), p, "exec")\n'
        '    except SyntaxError as e:\n'
        '        print(f"{p}:{e.lineno}: {e.msg}")\n'
    )
    proc = subprocess.run([exe, '-c', script, *_py_files()],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    assert not proc.stdout.strip(), (
        'SyntaxError(s) under Python %d.%d (production):\n%s' % (*MIN_PY, proc.stdout))

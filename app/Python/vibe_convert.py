#!/usr/bin/env python3
"""MVP-0: the offline 'vibe conversion' harness — the proving ground for Stage E.

Given a book whose conversion is faulty, this:
  1. reads its decision-trace (assessment.json) + verdict (audit.json) + source,
  2. assembles a prompt naming the FLAGGED forks and the module(s) their code_ref points to,
  3. asks an LLM for a minimal one-module unified diff (real Fireworks/DeepSeek call, or a
     --mock-diff file for offline runs),
  4. validates the diff (PATH-ALLOWLIST: only conversion modules; no new files / harness edits),
  5. applies it in a THROWAWAY structure-preserving copy of the repo,
  6. runs the gates IN THE SANDBOX with a SCRUBBED env (no secrets reach the executed patch):
        - impact_map.py --run  → impacted unit tests + regression stay green (didn't break other books)
        - (optional) re-convert THIS book → audit must be clean (the fix actually worked)
  7. reports the diff + gate results — and NEVER touches production code, no UI, no PR.

Security model (laptop MVP-0): temp copy + path-allowlist + scrubbed env. Production rollout
would swap the sandbox for an unprivileged, network-restricted container. See module docstring
discussion in the design notes.

Usage:
    # offline (feed a candidate diff, no API):
    python3 app/Python/vibe_convert.py <book_dir> --mock-diff patch.diff
    python3 app/Python/vibe_convert.py <book_dir> --mock-diff patch.diff --reconvert <book_dir>
    # show only the prompt that WOULD be sent:
    python3 app/Python/vibe_convert.py <book_dir> --print-prompt
    # real call (needs FIREWORKS_API_KEY):
    python3 app/Python/vibe_convert.py <book_dir> --reconvert <book_dir>
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

PY_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(PY_DIR, '..', '..'))

# The diff may only touch these (relative to repo root). Anything else is rejected outright —
# the LLM cannot edit the harness, add new files, or reach deploy/secret config.
# An 'improved' result is rejected if MORE than this fraction of the newly-linked items are
# flagged misaligned by the audit — past it, the fix is mostly confident-wrong-links, which the
# modus operandi says is worse than leaving them unlinked.
MISALIGNED_REJECT_RATIO = 0.5

ALLOWED_PREFIXES = ('app/Python/conversion/',)
ALLOWED_FILES = {
    'app/Python/process_document.py', 'app/Python/epub_normalizer.py',
    'app/Python/mistral_ocr.py', 'app/Python/simple_md_to_html.py',
    'app/Python/ar5iv_preprocessor.py',
}

# What gets copied into the sandbox (structure-preserving, so the harness paths resolve).
SANDBOX_PATHS = ['app/Python', 'tests/conversion', 'pytest.ini']

# A minimal env for everything we run in the sandbox — NO secrets, NO real environment.
SCRUBBED_ENV = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONHASHSEED': '0',
                'HOME': '/tmp', 'LANG': 'C.UTF-8'}

# When True, emit machine-readable `VIBE:{json}` progress lines alongside the human lines.
_JSON_PROGRESS = False
# When set, append each beat as a JSON line here — the background job writes this; the toast
# polls it (so the user can close the tab / get emailed when done, not hold an SSE open).
_PROGRESS_FILE = None
# When this file appears, the loop stops at the next attempt boundary (the Cancel button).
_CANCEL_FILE = None


def emit(phase, message, **extra):
    """One progress beat — human line + (optionally) a streamed line + (optionally) the poll file."""
    rec = {'phase': phase, 'message': message, **extra}
    print(f"  {message}")
    if _JSON_PROGRESS:
        print("VIBE:" + json.dumps(rec), flush=True)
    if _PROGRESS_FILE:
        try:
            with open(_PROGRESS_FILE, 'a', encoding='utf-8') as f:
                f.write(json.dumps(rec) + "\n")
        except Exception:
            pass


def _cancelled():
    return bool(_CANCEL_FILE) and os.path.exists(_CANCEL_FILE)


# ---------------------------------------------------------------------------
# 1. Read the failing conversion's artifacts
# ---------------------------------------------------------------------------
def load_artifacts(book_dir):
    def _read_json(name):
        p = os.path.join(book_dir, name)
        return json.load(open(p, encoding='utf-8')) if os.path.isfile(p) else None

    assessment = _read_json('assessment.json')
    source = None
    for cand in ('main-text.html', 'intermediate.html', 'input.html'):
        p = os.path.join(book_dir, cand)
        if os.path.isfile(p):
            source = open(p, encoding='utf-8').read()
            break
    return {
        'book_dir': book_dir,
        'assessment': (assessment or {}).get('records', []) if assessment else [],
        'audit': _read_json('audit.json') or {},
        'stats': _read_json('conversion_stats.json') or {},
        'source': source,
        'is_pdf': os.path.isfile(os.path.join(book_dir, 'ocr_response.json')),
        'markdown': (open(os.path.join(book_dir, 'main-text.md'), encoding='utf-8').read()
                     if os.path.isfile(os.path.join(book_dir, 'main-text.md')) else None),
    }


def _is_problem(r):
    """A fork worth sending the LLM: low confidence, a fall-through, OR a decision that
    indicates the pipeline declined to do something (skipped/suppressed/nothing detected/
    faulty) — those are exactly where a code limitation hides."""
    conf = r.get('confidence')
    if (conf is not None and conf < 0.5) or 'FALL-THROUGH' in (r.get('margin') or ''):
        return True
    dec = (r.get('decision') or '').lower()
    return any(w in dec for w in ('skipped', 'suppress', 'no footnotes detected', 'faulty'))


def flagged_forks(records):
    """The forks the pipeline was unsure about or declined — the LLM's leads."""
    return [r for r in records if _is_problem(r)]


# Human phrasing for the uncertain decision(s) — for the user-facing progress narration.
_MODULE_PHRASE = {
    'pdf_footnote_classification': "how this PDF lays out its footnotes",
    'strategy_selection': "how this document's footnotes are structured",
    'footnote_linking_guard': "whether its footnotes can be linked safely",
    'citation_linking': "how to link its in-text citations",
    'footnote_audit': "its footnote linking",
    'epub_footnote_detection': "how this EPUB marks its footnotes",
    'bibliography_extraction': "its bibliography",
}


def _flagged_phrase(flagged):
    parts = []
    for r in flagged:
        p = _MODULE_PHRASE.get(r.get('module'))
        if p and p not in parts:
            parts.append(p)
    if not parts:
        return "how to handle this file"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _code_ref_to_path(code_ref):
    """'strategy.py:foo' -> app/Python/conversion/strategy.py (or a top-level front-end)."""
    fname = (code_ref or '').split(':', 1)[0].strip()
    if not fname.endswith('.py'):
        return None
    if fname in ('process_document.py', 'epub_normalizer.py', 'mistral_ocr.py',
                 'simple_md_to_html.py', 'ar5iv_preprocessor.py'):
        return f'app/Python/{fname}'
    return f'app/Python/conversion/{fname}'


def modules_for(records):
    """Module files named by the flagged forks' code_refs (the code to send the LLM)."""
    paths = []
    for r in records:
        p = _code_ref_to_path(r.get('code_ref', ''))
        if p and p not in paths and os.path.isfile(os.path.join(REPO_ROOT, p)):
            paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# 2. Build the prompt
# ---------------------------------------------------------------------------
def build_prompt(art, module_paths, user_note=None):
    flagged = flagged_forks(art['assessment'])
    st = art['stats']
    parts = [
        "You are improving a document-conversion pipeline. A book converted badly. Below are the "
        "pipeline's own flagged decisions (low confidence, a fall-through, or a step it declined), "
        "the conversion stats, the audit verdict, the source, and the responsible module source. "
        "Propose a MINIMAL fix to the responsible module.",
    ]
    if art.get('is_pdf'):
        parts.append("\n## IMPORTANT — this is a PDF; the OCR is REPLAYED FROM CACHE")
        parts.append("The Mistral OCR output (ocr_response.json) is fixed and replayed — your fix is "
                     "validated by re-running mistral_ocr.py's ASSEMBLY (classify_footnotes, "
                     "assemble_markdown, renumber_page_footnotes, etc.) → simple_md_to_html → "
                     "process_document. Do NOT change the OCR call itself (fetch_ocr / extract_footer / "
                     "extract_header) — those only affect a fresh OCR and CANNOT be validated or applied "
                     "to this document.")
    if user_note:
        parts.append("\n## What the reader says is wrong (human-spotted — weigh this heavily)")
        parts.append(user_note.strip()[:1500])
    parts += [
        "\n## Conversion stats (the symptom)",
        json.dumps({k: st.get(k) for k in ('references_found', 'citations_total', 'citations_linked',
                    'footnotes_matched', 'footnote_strategy', 'citation_style')}, ensure_ascii=False),
        "\n## Flagged decisions (from assessment.json)",
    ]
    for r in flagged:
        parts.append(json.dumps({k: r.get(k) for k in
                     ('module', 'code_ref', 'decision', 'rationale', 'margin', 'considered')},
                     ensure_ascii=False, indent=2))
    parts.append("\n## Audit verdict (audit.json)")
    parts.append(json.dumps({k: art['audit'].get(k) for k in
                 ('total_refs', 'total_defs', 'gaps', 'unmatched_refs', 'unmatched_defs')},
                 ensure_ascii=False, default=str)[:2000])
    samples = _footnote_samples(art)
    if samples:
        parts.append("\n## Actual footnote ref/definition lines from THIS document (what must link)")
        parts.append(samples)
    if art['source']:
        parts.append("\n## Source (truncated)")
        parts.append(art['source'][:5000])
    parts.append("\n## Responsible module source (you may edit any function in these files)")
    for p in module_paths:
        parts.append(f"\n--- {p} ---")
        parts.append(open(os.path.join(REPO_ROOT, p), encoding='utf-8').read())
    parts.append(
        "\n## Your task\n"
        "Return STRICT JSON: {\"rationale\": str, \"functions\": [{\"file\": str, \"name\": str, "
        "\"code\": str}, ...]}. Instead of a diff, return the COMPLETE replacement source for each "
        "function you change — `name` is the function name, `file` is its path (only "
        "app/Python/conversion/*.py or a shown front-end module), `code` is the full `def …` body. "
        "You may replace MULTIPLE functions if the fix spans stages (e.g. classify + assembly). Keep "
        "edits minimal and self-contained; don't rename functions or change their signatures. Uphold "
        "the modus operandi: correct where determinable, NO link where ambiguous — never a confident "
        "wrong link.")
    return "\n".join(parts)


def _footnote_samples(art, n=14):
    """Pull the document's actual footnote ref + definition-looking lines so the model can see
    the shapes it must wire up (not just the aggregate signals)."""
    text = art.get('markdown') or art.get('source')
    if not text:
        return ''
    import re
    refs, defs = [], []
    for ln in text.split('\n'):
        s = ln.strip()
        if not s:
            continue
        if len(refs) < n and re.search(r'\[\^\d+\]', s):
            refs.append(s[:160])
        # definition-looking lines: "[^N]: …", "[N] …", "N. Text", "N Text"
        if len(defs) < n and re.match(r'^(\[\^?\d+\]\s*[:.]?|\d{1,3}[.\s])\s*\S', s):
            defs.append(s[:160])
    out = []
    if refs:
        out.append("In-text refs:\n" + "\n".join(f"  {r}" for r in refs))
    if defs:
        out.append("Definition-looking lines:\n" + "\n".join(f"  {d}" for d in defs))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 3. Get a candidate diff (mock file, or real Fireworks/DeepSeek)
# ---------------------------------------------------------------------------
def _dotenv(key, default=None):
    """Read KEY from os.environ, else the project .env (Laravel's gitignored secret store) —
    so the API key never has to touch argv or this transcript. Mirrors how the app reads it."""
    if key in os.environ:
        return os.environ[key]
    path = os.path.join(REPO_ROOT, '.env')
    if os.path.isfile(path):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if line.startswith(key + '='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    return default


def _parse_llm_json(content):
    """DeepSeek V4 Pro may wrap output in <think> reasoning and/or ```json fences. Strip
    those and extract the {rationale, functions} object."""
    import re
    content = re.sub(r'<think>.*?</think>', '', content, flags=re.S)
    content = re.sub(r'<think>.*', '', content, flags=re.S)
    m = re.search(r'\{.*\}', content, flags=re.S)
    raw = (m.group(0) if m else content).strip()
    raw = re.sub(r'^```(?:json)?|```$', '', raw, flags=re.M).strip()
    try:
        return json.loads(raw)
    except Exception as e:
        # Raise ValueError (transient/per-attempt) — NOT SystemExit — so the loop retries
        # rather than aborting. Most often a truncated response (hit max_tokens mid-string).
        raise ValueError(f"could not parse model JSON ({e}) — likely truncated")


def propose_patch(prompt, mock_diff=None, model='accounts/fireworks/models/deepseek-v4-pro'):
    if mock_diff:
        return json.load(open(mock_diff, encoding='utf-8'))  # {rationale, functions:[{file,name,code}]}
    key = _dotenv('LLM_API_KEY')
    base = (_dotenv('LLM_BASE_URL') or 'https://api.fireworks.ai/inference/v1').rstrip('/')
    if not key:
        raise SystemExit("No LLM_API_KEY (env or .env) and no --mock-diff given. "
                         "Add LLM_API_KEY to .env for a real call, or pass --mock-diff <file>.")
    import ssl
    import urllib.request
    # macOS Python.framework doesn't trust the system keychain — use the certifi CA bundle.
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
            # Full-function bodies are large; give ample room so the JSON isn't truncated.
            "max_tokens": 16000,
            # Bounded reasoning — V4 Pro benefits from some thinking for the diagnosis, but we
            # don't want it eating the output budget and truncating the code.
            "reasoning_effort": "low",
        }).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 # Cloudflare in front of Fireworks blocks the default Python-urllib UA (err 1010).
                 "User-Agent": "hyperlit-vibe/1.0"})
    with urllib.request.urlopen(req, timeout=240, context=ctx) as resp:
        content = json.loads(resp.read())['choices'][0]['message']['content']
    return _parse_llm_json(content)


# ---------------------------------------------------------------------------
# 4. Validate + apply FULL-FUNCTION replacements (robust vs brittle unified diffs)
# ---------------------------------------------------------------------------
# Constructs that have NO business in footnote/citation conversion logic — refuse any patch
# containing them (defense-in-depth on top of the path-allowlist + scrubbed env). Cheap guard
# against an LLM (esp. a prompt-injected one) writing OS/network/secret-access/eval code.
import re as _re
_DANGEROUS = [
    (_re.compile(r'\bos\.system\b'), 'os.system'),
    (_re.compile(r'\b(subprocess|Popen)\b'), 'subprocess'),
    (_re.compile(r'\b(socket|urllib|requests|httpx)\b'), 'network access'),
    (_re.compile(r'\bhttp\.client\b'), 'network access'),
    (_re.compile(r'(^|[^.\w])eval\s*\('), 'eval()'),
    (_re.compile(r'(^|[^.\w])exec\s*\('), 'exec()'),
    (_re.compile(r'__import__'), '__import__'),
    (_re.compile(r'\bos\.(environ|getenv)\b'), 'environment/secret access'),
    (_re.compile(r'\b(pickle|marshal)\.loads?\b'), 'pickle/marshal'),
    (_re.compile(r'\bshutil\.rmtree\b'), 'destructive filesystem op'),
]


def validate_replacements(functions):
    """Path-allowlist + dangerous-construct scan on the proposed replacements.
    Returns (ok, reason, files)."""
    if not isinstance(functions, list) or not functions:
        return False, "no function replacements returned", []
    files = []
    for fn in functions:
        path = (fn.get('file') or '').replace('\\', '/').lstrip('./')
        if not path or not fn.get('name') or not fn.get('code'):
            return False, "a replacement is missing file/name/code", []
        allowed = path in ALLOWED_FILES or any(path.startswith(p) for p in ALLOWED_PREFIXES)
        if not allowed:
            return False, f"replacement touches a disallowed path: {path}", []
        for rx, label in _DANGEROUS:
            if rx.search(fn['code']):
                return False, (f"proposed code uses '{label}', which conversion logic must never "
                               f"do — refused for safety"), []
        files.append(path)
    return True, "ok", sorted(set(files))


def _replace_function(src, name, new_code):
    """Splice `new_code` in for the def/async-def named `name` (module-level OR method) using
    ast to find its exact span — robust where unified-diff context matching is brittle. Returns
    the new source, or None if the function isn't found."""
    import ast
    import textwrap
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    target = next((nd for nd in ast.walk(tree)
                   if isinstance(nd, (ast.FunctionDef, ast.AsyncFunctionDef)) and nd.name == name), None)
    if target is None:
        return None
    lines = src.split('\n')
    start = target.lineno - 1
    if target.decorator_list:
        start = min(d.lineno for d in target.decorator_list) - 1
    end = target.end_lineno  # 1-indexed inclusive -> slice end
    indent = lines[target.lineno - 1][:len(lines[target.lineno - 1]) - len(lines[target.lineno - 1].lstrip())]
    body = textwrap.dedent(new_code).rstrip('\n').split('\n')
    reindented = [(indent + ln if ln.strip() else '') for ln in body]
    return '\n'.join(lines[:start] + reindented + lines[end:])


def apply_function_replacements(sandbox, functions):
    """Apply each {file, name, code} replacement in the sandbox. Returns (ok, message)."""
    for fn in functions:
        path = fn['file'].replace('\\', '/').lstrip('./')
        full = os.path.join(sandbox, path)
        if not os.path.isfile(full):
            return False, f"target file not in sandbox: {path}"
        src = open(full, encoding='utf-8').read()
        new_src = _replace_function(src, fn['name'], fn['code'])
        if new_src is None:
            return False, f"function '{fn['name']}' not found in {path} (or its code didn't parse)"
        # Reject if the spliced module no longer parses (a malformed replacement).
        import ast
        try:
            ast.parse(new_src)
        except SyntaxError as e:
            return False, f"replacing '{fn['name']}' broke {path}: {e}"
        open(full, 'w', encoding='utf-8').write(new_src)
    return True, "ok"


# ---------------------------------------------------------------------------
# 5/6. Sandbox + gates
# ---------------------------------------------------------------------------
def make_sandbox():
    tmp = tempfile.mkdtemp(prefix='vibe-sandbox-')
    for rel in SANDBOX_PATHS:
        src = os.path.join(REPO_ROOT, rel)
        dst = os.path.join(tmp, rel)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
                '__pycache__', '*.pyc', 'fixtures-local'))
        elif os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    return tmp


def _pipeline_into(py_dir, book_dir, out):
    """Run the PATHWAY-AWARE conversion chain (patched code in py_dir) into `out`, so a patch
    to any post-cache stage is actually exercised:
      • PDF (ocr_response.json present): replay cached OCR — mistral_ocr.py(/dev/null,cache)
        -> simple_md_to_html -> process_document. (OCR itself is replayed from cache; fixes to
        fetch_ocr can't be validated this way — the prompt tells the model not to attempt them.)
      • else: process_document on the intermediate HTML.
    Returns the final subprocess result (or None if there was nothing to convert)."""
    def _run(*cmd):
        return subprocess.run([sys.executable, *cmd], cwd=py_dir, capture_output=True,
                              text=True, env=SCRUBBED_ENV)
    if os.path.isfile(os.path.join(book_dir, 'ocr_response.json')):
        shutil.copy2(os.path.join(book_dir, 'ocr_response.json'), os.path.join(out, 'ocr_response.json'))
        r = _run(os.path.join(py_dir, 'mistral_ocr.py'), '/dev/null', out)
        md, html = os.path.join(out, 'main-text.md'), os.path.join(out, 'intermediate.html')
        if r.returncode == 0 and os.path.isfile(md):
            r = _run(os.path.join(py_dir, 'simple_md_to_html.py'), md, html)
            if r.returncode == 0 and os.path.isfile(html):
                r = _run(os.path.join(py_dir, 'process_document.py'), html, out, 'vibebook')
        return r
    src = next((os.path.join(book_dir, c) for c in ('intermediate.html', 'main-text.html', 'input.html')
                if os.path.isfile(os.path.join(book_dir, c))), None)
    return _run(os.path.join(py_dir, 'process_document.py'), src, out, 'vibebook') if src else None


def _reconvert(sandbox, book_dir):
    """Re-convert THIS doc in the sandbox and read the fresh result. Returns
    {ok, audit, stats, assessment, stderr} (stderr tail on failure → fed back to the model)."""
    out = tempfile.mkdtemp(prefix='vibe-out-')
    r = _pipeline_into(os.path.join(sandbox, 'app', 'Python'), book_dir, out)

    def _rd(name):
        p = os.path.join(out, name)
        return json.load(open(p, encoding='utf-8')) if os.path.isfile(p) else {}
    audit, stats = _rd('audit.json'), _rd('conversion_stats.json')
    assessment = (_rd('assessment.json') or {}).get('records', [])
    stderr = (r.stderr or '')[-700:] if (r and r.returncode != 0) else ''
    shutil.rmtree(out, ignore_errors=True)
    return {'ok': bool(r and r.returncode == 0), 'audit': audit, 'stats': stats,
            'assessment': assessment, 'stderr': stderr}


def _problem_set(records, audit):
    """The problems in a conversion: which modules are flagged + how many audit faults."""
    flagged = {r.get('module') for r in flagged_forks(records)}
    faults = sum(len(audit.get(k, [])) for k in ('gaps', 'unmatched_refs', 'unmatched_defs'))
    return flagged, faults


def _stat_summary(stats):
    return (f"refs {stats.get('references_found', 0)}, "
            f"citations {stats.get('citations_linked', 0)}/{stats.get('citations_total', 0)}, "
            f"footnotes {stats.get('footnotes_matched', 0)}")


def evaluate(baseline_art, after):
    """The path-A gate, THREE-TIER (the patch only ever touches THIS doc — no regression suite):
        'clean'    — the flagged problem(s) resolved with NO new flags/faults → offer confidently
        'improved' — a user-visible metric got materially better (more footnotes/citations linked)
                     even if a new audit caveat appeared → SHOW the user with the caveat, they judge
        'reject'   — crashed, regressed a previously-good metric, or no measurable improvement
    Returns (tier, reason). Accepting is non-destructive: the nodes_versioning_trigger archives the
    prior conversion to nodes_history, so the user can always revert."""
    if not after['ok']:
        return 'reject', "the patched code crashed converting the document"
    b, a = baseline_art['stats'], after['stats']
    b_fl, b_faults = _problem_set(baseline_art['assessment'], baseline_art['audit'])
    a_fl, a_faults = _problem_set(after['assessment'], after['audit'])

    # Regression guard: things that were already working must not get worse.
    if a.get('citations_linked', 0) < b.get('citations_linked', 0):
        return 'reject', (f"it linked FEWER citations ({a.get('citations_linked', 0)} vs "
                          f"{b.get('citations_linked', 0)})")
    if a.get('footnotes_matched', 0) < b.get('footnotes_matched', 0):
        return 'reject', (f"it matched FEWER footnotes ({a.get('footnotes_matched', 0)} vs "
                          f"{b.get('footnotes_matched', 0)})")

    introduced = a_fl - b_fl
    persists = a_fl & b_fl
    clean = (not introduced) and (a_faults <= b_faults) and (not persists)
    if clean:
        return 'clean', "resolved the flagged problem(s) with no new faults in this document"

    fn_gain = a.get('footnotes_matched', 0) - b.get('footnotes_matched', 0)
    cit_gain = a.get('citations_linked', 0) - b.get('citations_linked', 0)
    total_gain = max(0, fn_gain) + max(0, cit_gain)
    fault_delta = a_faults - b_faults
    if total_gain > 0:
        # QUALITY GUARD (modus operandi: a wrong link is worse than a missing one). If the new
        # audit faults are a large fraction of what was newly linked, most of those links are
        # misaligned — that's NOT an improvement, it's confident-wrong-links. Reject it.
        if fault_delta > MISALIGNED_REJECT_RATIO * total_gain:
            return 'reject', (f"it linked {total_gain} more but introduced ~{fault_delta} audit "
                              f"fault(s) — most of the new links look misaligned, which is worse "
                              f"than leaving them unlinked")
        caveats = []
        if introduced:
            caveats.append(f"new flag {sorted(introduced)}")
        if fault_delta > 0:
            caveats.append(f"~{fault_delta} of {total_gain} new link(s) may be misaligned — worth a check")
        return 'improved', ("improved this document"
                            + (" — caveat: " + "; ".join(caveats) if caveats else ""))
    return 'reject', "no measurable improvement to this document"


def run_loop(book_dir, max_attempts, model, mock_diff=None, user_note=None, file_issue=False):
    """The user-facing path: bounded retry. Each attempt asks the LLM for a patch, applies
    it in a throwaway sandbox, re-converts THIS document, and evaluates. On failure it feeds
    the new result back to the LLM and tries again — up to max_attempts. The winning diff is
    written to <book_dir>/vibe_patch.diff so an 'accept' step can apply it. Returns (rc, diff)."""
    art = load_artifacts(book_dir)
    flagged = flagged_forks(art['assessment'])
    modules = modules_for(flagged) or modules_for(art['assessment'])
    base_flagged, base_faults = _problem_set(art['assessment'], art['audit'])
    # Describe the ACTUAL uncertain decision (not a misleading "fell outside N of M pathways" —
    # the converter handles many end-results; usually only one decision was uncertain here).
    phrase = _flagged_phrase(flagged)
    emit('start',
         f"Your document converted as: {_stat_summary(art['stats'])} — but the converter wasn't "
         f"sure about {phrase}. DeepSeek V4 will reason about why, propose a pipeline fix, and "
         f"test it on THIS document. This takes a minute or two per attempt (up to "
         f"{max_attempts}) — hang tight.",
         baseline=_stat_summary(art['stats']), flagged=sorted(base_flagged),
         modules=modules, max_attempts=max_attempts, user_note=bool(user_note))

    feedback = ""
    best = None  # highest-scoring 'improved' result — offered if no fully-clean fix is found
    journal = []  # per-attempt record → vibe_report.json + the GitHub issue body
    for attempt in range(1, max_attempts + 1):
        if _cancelled():
            emit('cancelled', "Cancelled — your original conversion is unchanged.")
            _finalize(book_dir, art, journal, 'cancelled', best=best, file_issue=False)
            return 1, None
        emit('attempt',
             f"DeepSeek V4 is using deep reasoning to work out {phrase}… "
             f"(attempt {attempt} of {max_attempts})",
             attempt=attempt, max_attempts=max_attempts)
        try:
            patch = propose_patch(build_prompt(art, modules, user_note=user_note) + feedback,
                                  mock_diff=mock_diff, model=model)
        except ValueError as e:
            # Transient (e.g. truncated JSON) — retry this attempt rather than aborting.
            emit('proposed', f"Model response unusable ({e}); retrying…", attempt=attempt)
            feedback = (f"\n\n## Attempt {attempt} feedback\nYour last response {e}. Return COMPACT "
                        f"valid JSON — change as FEW / as SMALL functions as possible to keep the "
                        f"reply short enough to complete.")
            if mock_diff:
                break
            continue
        except SystemExit as e:
            emit('error', f"The model call failed: {e}")
            return 1, None
        funcs = patch.get('functions', [])
        _touch = [f"{f.get('file','?').split('/')[-1]}:{f.get('name','?')}" for f in funcs]
        emit('proposed',
             f"DeepSeek V4 is proposing an update to the conversion pipeline "
             f"({', '.join(_touch) or 'no change'}): {patch.get('rationale', '')[:160]}",
             attempt=attempt, touches=_touch)

        ok, reason, _ = validate_replacements(funcs)
        if not ok:
            journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                            'touches': _touch, 'tier': 'rejected', 'why': reason, 'stats': None})
            emit('rejected', f"Proposed change was out of bounds ({reason}); retrying…",
                 attempt=attempt)
            feedback = (f"\n\n## Attempt {attempt} feedback\nYour reply was rejected: {reason}. "
                        f"Return {{rationale, functions:[{{file,name,code}}]}} with full function "
                        f"bodies in allowed modules only.")
            if mock_diff:
                break
            continue

        sandbox = make_sandbox()
        try:
            applied, out = apply_function_replacements(sandbox, funcs)
            if not applied:
                journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                                'touches': _touch, 'tier': 'apply_failed', 'why': out[:200], 'stats': None})
                emit('apply_failed', f"The fix couldn't be applied ({out}); retrying…", attempt=attempt)
                feedback = (f"\n\n## Attempt {attempt} feedback\nCouldn't apply your replacement: "
                            f"{out}. Return the COMPLETE current function body (exact name, valid "
                            f"Python) for each function you change.")
                if mock_diff:
                    break
                continue
            emit('reconverting',
                 "Running the proposed pipeline on THIS document to confirm it actually makes "
                 "things better (and breaks nothing else here)…", attempt=attempt)
            after = _reconvert(sandbox, book_dir)
            tier, why = evaluate(art, after)
            st = after['stats']
            journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                            'touches': _touch, 'tier': tier, 'why': why, 'stats': _stat_summary(st)})
            if tier == 'clean':
                _persist_patch(book_dir, patch, funcs)
                _finalize(book_dir, art, journal, 'clean', best=None, file_issue=False)
                emit('success', f"Fixed it cleanly — {_stat_summary(st)}.",
                     tier='clean', attempt=attempt, before=_stat_summary(art['stats']),
                     after=_stat_summary(st), rationale=patch.get('rationale', '')[:300])
                return 0, funcs
            if tier == 'improved':
                score = st.get('footnotes_matched', 0) + st.get('citations_linked', 0)
                if best is None or score > best['score']:
                    best = {'funcs': funcs, 'rationale': patch.get('rationale', ''),
                            'after': _stat_summary(st), 'why': why, 'score': score}
                emit('improved_partial',
                     f"Better — {_stat_summary(st)} ({why}). Keeping it as a candidate and "
                     f"trying for a cleaner fix…", attempt=attempt)
            else:
                emit('not_yet', f"Not quite — {_stat_summary(st)} ({why}). Telling the model "
                     f"why and trying again…", attempt=attempt)
            nf, _ = _problem_set(after['assessment'], after['audit'])
            crash = (f"\nThe re-conversion crashed with:\n{after['stderr']}"
                     if after.get('stderr') else "")
            feedback = (f"\n\n## Attempt {attempt} feedback\nYour change applied, but {why}. "
                        f"New stats: {_stat_summary(st)}; flagged now: {sorted(nf)}.{crash}\n"
                        f"The footnote definitions DO exist (see the def-looking lines above) — match "
                        f"them to the [^N] refs and emit [^N]: definitions, WITHOUT introducing "
                        f"numbering gaps or unmatched refs. Try a more complete fix.")
        finally:
            shutil.rmtree(sandbox, ignore_errors=True)
        if mock_diff:
            break

    if best is not None:
        # No fully-clean fix, but a genuine net improvement — offer it to the user WITH the
        # caveat; accepting is non-destructive (nodes_history archives the original to revert).
        _persist_patch(book_dir, {'rationale': best['rationale']}, best['funcs'])
        _finalize(book_dir, art, journal, 'improved', best=best, file_issue=False)
        emit('success', f"Improved your document — {best['after']}. {best['why']}",
             tier='improved', before=_stat_summary(art['stats']), after=best['after'],
             caveat=best['why'], rationale=best['rationale'][:300])
        return 0, best['funcs']

    report = _finalize(book_dir, art, journal, 'exhausted', best=None, file_issue=file_issue)
    suffix = (f" Opened GitHub issue: {report['issue_url']}" if report.get('issue_url') else "")
    emit('exhausted',
         f"DeepSeek V4 tried {max_attempts} different fixes but couldn't improve this document, "
         f"so we've kept your original and logged it for a human to review.{suffix}",
         issue_url=report.get('issue_url'))
    return 1, None


def _persist_patch(book_dir, patch, funcs):
    try:
        with open(os.path.join(book_dir, 'vibe_patch.json'), 'w', encoding='utf-8') as f:
            json.dump({'rationale': patch.get('rationale', ''), 'functions': funcs}, f)
    except Exception:
        pass


def _finalize(book_dir, art, journal, outcome, best=None, file_issue=False):
    """Write vibe_report.json (consumed by the fml@ email + the UI) and — for an UNFIXED run —
    optionally open a GitHub issue with the full diagnosis. Returns the report dict."""
    book_id = os.path.basename(os.path.normpath(book_dir))
    report = {
        'book': book_id,
        'outcome': outcome,  # clean | improved | exhausted
        'baseline': _stat_summary(art['stats']),
        'best': best['after'] if best else None,
        'flagged': sorted({r.get('module') for r in flagged_forks(art['assessment'])}),
        'attempts': journal,
        'issue_url': None,
    }
    if file_issue and outcome == 'exhausted':
        url = file_github_issue(report)
        if url:
            report['issue_url'] = url
    try:
        with open(os.path.join(book_dir, 'vibe_report.json'), 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return report


def _github_repo():
    """owner/repo from the git origin (so it works on prod without hardcoding)."""
    try:
        url = subprocess.run(['git', 'config', '--get', 'remote.origin.url'],
                             cwd=REPO_ROOT, capture_output=True, text=True).stdout.strip()
        m = re.search(r'github\.com[:/]([^/]+/[^/.]+)', url)
        return m.group(1) if m else None
    except Exception:
        return None


def _report_markdown(report):
    lines = [
        f"**Book:** `{report['book']}`  ",
        f"**Outcome:** the vibe-conversion loop could not cleanly fix this document.  ",
        f"**Baseline conversion:** {report['baseline']}  ",
        f"**Uncertain decision(s):** {', '.join(report['flagged']) or 'n/a'}",
        "",
        "DeepSeek V4 reasoned about the failure and tried the following — each was validated by "
        "re-converting THIS document and rejected by the gate. This is a real conversion gap for a "
        "human to finish.",
        "",
        "| # | touched | result | why rejected |",
        "|---|---|---|---|",
    ]
    for a in report['attempts']:
        lines.append(f"| {a['attempt']} | {', '.join(a.get('touches') or []) or '—'} | "
                     f"{a.get('tier')} ({a.get('stats') or 'n/a'}) | {a.get('why', '')} |")
    lines.append("\n### Diagnoses (per attempt)")
    for a in report['attempts']:
        if a.get('diagnosis'):
            lines.append(f"- **Attempt {a['attempt']}:** {a['diagnosis']}")
    lines.append("\n_Filed automatically by the vibe-conversion loop (path B)._")
    return "\n".join(lines)


def file_github_issue(report):
    """Open a GitHub issue via the REST API (token from .env GITHUB_TOKEN — no `gh` binary, so it
    works on the headless prod droplet). Returns the issue URL, or None (dry-run / no token)."""
    repo = _github_repo()
    token = _dotenv('GITHUB_TOKEN')
    title = f"Vibe conversion couldn't fix {report['book']}: {', '.join(report['flagged']) or 'conversion gap'}"
    body = _report_markdown(report)
    if not token or not repo:
        print(f"[github] dry-run (no GITHUB_TOKEN/repo) — would open issue: {title}")
        return None
    import ssl
    import urllib.request
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    data = json.dumps({'title': title[:250], 'body': body,
                       'labels': ['vibe-conversion', 'conversion-bug']}).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/issues", data=data,
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'hyperlit-vibe', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
            return json.loads(resp.read()).get('html_url')
    except Exception as e:
        print(f"[github] could not open issue: {e}")
        return None


def apply_patch_to_book(book_dir, patch_path=None):
    """'Use this conversion': apply the validated function replacements in a sandbox, re-convert
    THIS book, and copy the fresh artifacts into book_dir — regenerating this one book's output.
    Production code is never touched (the patch lives only in the sandbox)."""
    patch_path = patch_path or os.path.join(book_dir, 'vibe_patch.json')
    if not os.path.isfile(patch_path):
        print(f"No vibe patch found at {patch_path}")
        return 1
    funcs = json.load(open(patch_path, encoding='utf-8')).get('functions', [])
    sandbox = make_sandbox()
    try:
        ok, out = apply_function_replacements(sandbox, funcs)
        if not ok:
            print("Patch failed to apply:", out)
            return 1
        outdir = tempfile.mkdtemp(prefix='vibe-apply-')
        r = _pipeline_into(os.path.join(sandbox, 'app', 'Python'), book_dir, outdir)
        if r is None or r.returncode != 0:
            print("Re-convert failed:", (r.stderr[-300:] if r else 'no source'))
            shutil.rmtree(outdir, ignore_errors=True)
            return 1
        for fn in ('main-text.md', 'intermediate.html', 'nodes.jsonl', 'footnotes.jsonl',
                   'references.json', 'audit.json', 'conversion_stats.json', 'assessment.json'):
            p = os.path.join(outdir, fn)
            if os.path.isfile(p):
                shutil.copy2(p, os.path.join(book_dir, fn))
        shutil.rmtree(outdir, ignore_errors=True)
        print("Applied — this book's artifacts regenerated from the patched conversion.")
        return 0
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="LLM vibe-conversion harness — the user path "
                                             "(bounded retry, this-document success gate).")
    ap.add_argument('book_dir', help="Directory holding the faulty conversion's artifacts.")
    ap.add_argument('--max-attempts', type=int, default=3, help="Retry cutoff (default 3).")
    ap.add_argument('--mock-diff', help="Use this diff file instead of the LLM (single attempt).")
    ap.add_argument('--print-prompt', action='store_true', help="Print the prompt and exit.")
    ap.add_argument('--model', default='accounts/fireworks/models/deepseek-v4-pro',
                    help="LLM model id (default: DeepSeek V4 Pro via Fireworks).")
    ap.add_argument('--user-note', help="The reader's own description of what's wrong (fed to the model).")
    ap.add_argument('--json-progress', action='store_true',
                    help="Emit VIBE:{json} progress lines for the SSE controller to stream.")
    ap.add_argument('--progress-file', help="Append each progress beat (JSON line) here for polling.")
    ap.add_argument('--cancel-file', help="Stop at the next attempt boundary if this file appears.")
    ap.add_argument('--github', action='store_true',
                    help="On an UNFIXED run, open a GitHub issue with the full diagnosis "
                         "(uses GITHUB_TOKEN from .env; dry-runs if absent).")
    ap.add_argument('--apply', metavar='PATCH',
                    help="'Use this conversion': apply PATCH + regenerate this book's artifacts.")
    args = ap.parse_args()

    global _JSON_PROGRESS, _PROGRESS_FILE, _CANCEL_FILE
    _JSON_PROGRESS = args.json_progress
    _PROGRESS_FILE = args.progress_file
    _CANCEL_FILE = args.cancel_file

    if args.apply:
        sys.exit(apply_patch_to_book(args.book_dir, args.apply))

    if args.print_prompt:
        art = load_artifacts(args.book_dir)
        modules = modules_for(flagged_forks(art['assessment'])) or modules_for(art['assessment'])
        print(build_prompt(art, modules, user_note=args.user_note))
        return

    rc, _ = run_loop(args.book_dir, args.max_attempts, args.model,
                     mock_diff=args.mock_diff, user_note=args.user_note, file_issue=args.github)
    sys.exit(rc)


if __name__ == '__main__':
    main()

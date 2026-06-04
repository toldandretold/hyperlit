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

# Importable whether vibe_convert is run as a script (sys.path[0] == PY_DIR already) or imported
# by the eval harness (tests/conversion/vibe_eval.py) from elsewhere.
if PY_DIR not in sys.path:
    sys.path.insert(0, PY_DIR)
from conversion import fix_categories  # the living fix-category registry (prompt menu + op vocab)

# The diff may only touch these (relative to repo root). Anything else is rejected outright —
# the LLM cannot edit the harness, add new files, or reach deploy/secret config.
# An 'improved' result is rejected if MORE than this fraction of the newly-linked items are
# flagged misaligned by the audit — past it, the fix is mostly confident-wrong-links, which the
# modus operandi says is worse than leaving them unlinked.
MISALIGNED_REJECT_RATIO = 0.5

# LLM spend tracking. Fireworks returns exact token usage per call; the $ comes from the SAME
# pricing table the app uses (config/services.php → services.llm.pricing, read by
# AiBrainController::calculateCost), so there's one source of truth. Env LLM_PRICE_PER_MTOK_IN/_OUT
# override it. Cached calls cost nothing (counted separately). run_loop resets this per case; the
# report snapshots it.
_USAGE = {'prompt_tokens': 0, 'completion_tokens': 0, 'calls': 0, 'cached': 0, 'model': None}


def reset_usage():
    _USAGE.update(prompt_tokens=0, completion_tokens=0, calls=0, cached=0, model=None)


def _model_price(model):
    """($/1M input, $/1M output) for `model`. Env LLM_PRICE_PER_MTOK_IN/_OUT override; else parse
    config/services.php (the app's source of truth); else (None, None)."""
    import re
    env_in = os.environ.get('LLM_PRICE_PER_MTOK_IN')
    if env_in not in (None, ''):
        try:
            ein = float(env_in)
            eout = os.environ.get('LLM_PRICE_PER_MTOK_OUT')
            return ein, (float(eout) if eout not in (None, '') else ein)
        except ValueError:
            pass
    path = os.path.join(REPO_ROOT, 'config', 'services.php')
    if model and os.path.isfile(path):
        m = re.search(r"'" + re.escape(model) + r"'\s*=>\s*\[\s*'input'\s*=>\s*([\d.]+)\s*,"
                      r"\s*'output'\s*=>\s*([\d.]+)", open(path, encoding='utf-8').read())
        if m:
            return float(m.group(1)), float(m.group(2))
    return None, None


def usage_summary():
    """{prompt_tokens, completion_tokens, total_tokens, calls, cached_calls, cost_usd, model} —
    cost in USD from config/services.php pricing for the model used (None if the rate isn't known)."""
    pt, ct = _USAGE['prompt_tokens'], _USAGE['completion_tokens']
    pin, pout = _model_price(_USAGE.get('model'))
    cost = round(pt / 1e6 * pin + ct / 1e6 * pout, 4) if pin is not None else None
    return {'prompt_tokens': pt, 'completion_tokens': ct, 'total_tokens': pt + ct,
            'calls': _USAGE['calls'], 'cached_calls': _USAGE['cached'], 'cost_usd': cost,
            'model': _USAGE.get('model')}


ALLOWED_PREFIXES = ('app/Python/conversion/',)
ALLOWED_FILES = {
    'app/Python/process_document.py', 'app/Python/epub_normalizer.py',
    'app/Python/mistral_ocr.py', 'app/Python/simple_md_to_html.py',
    'app/Python/ar5iv_preprocessor.py',
}

# Module-level registries an op:register edit may append to (a tight allowlist — registering
# elsewhere could run arbitrary module-load code). Extend deliberately as new forks appear.
REGISTERABLE_LISTS = {'TRANSFORM_PIPELINE', '_ALL_STRATEGIES',
                      'FOOTNOTE_LINK_RULES', 'MARKER_LINK_RULES', 'CITATION_LINK_RULES',
                      'DOC_PASSES', 'PDF_CLASSIFIERS', 'STRATEGY_RULES'}

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
# When set (--docker <image>), the RE-CONVERSION (which executes model-written code) runs inside
# a locked-down container instead of a host subprocess. The LLM call itself stays on the host.
_DOCKER_IMAGE = None


def _docker_cmd(image, ro_mounts, rw_mounts, run):
    """Wrap `run` (e.g. ['python', '/abs/script', '/abs/arg', …]) in a locked-down `docker run`:
    no network, no host env (so no secrets), read-only rootfs, unprivileged, resource-capped. Host
    dirs are bind-mounted at IDENTICAL paths, so the absolute paths in `run` need no translation."""
    cmd = ['docker', 'run', '--rm', '--network', 'none', '--read-only',
           '--tmpfs', '/tmp:exec', '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
           '--security-opt', 'no-new-privileges',
           '-e', 'PYTHONHASHSEED=0', '-e', 'PYTHONDONTWRITEBYTECODE=1']
    if hasattr(os, 'getuid'):
        cmd += ['--user', f'{os.getuid()}:{os.getgid()}']  # keep the worker's ownership on outputs
    for m in dict.fromkeys(ro_mounts):
        cmd += ['-v', f'{m}:{m}:ro']
    for m in dict.fromkeys(rw_mounts):
        cmd += ['-v', f'{m}:{m}']
    return cmd + [image, *run]


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
        # Detect EPUB from the source OR from epub_normalizer's footprint — the latter matters when
        # book_dir is a freshly-CONVERTED dir (the eval harness) that doesn't carry the .epub source,
        # else is_epub=False mis-routes the footnote fork away from epub_normalizer.py.
        'is_epub': (os.path.isfile(os.path.join(book_dir, 'original.epub'))
                    or os.path.isdir(os.path.join(book_dir, 'epub_original'))
                    or os.path.isfile(os.path.join(book_dir, 'epub_normalizer_debug.txt'))),
        'markdown': (open(os.path.join(book_dir, 'main-text.md'), encoding='utf-8').read()
                     if os.path.isfile(os.path.join(book_dir, 'main-text.md')) else None),
    }


def _is_problem(r):
    """A fork worth sending the LLM: low confidence, a fall-through, an audit verdict that
    found real linking faults, or a step the pipeline declined while UNSURE. A high-confidence
    deliberate skip is NOT a problem — e.g. 'citation scan skipped — no bibliography entries'
    at confidence 1.0 is a correct non-action; flagging it sends the model chasing a non-bug."""
    conf = r.get('confidence')
    if (conf is not None and conf < 0.5) or 'FALL-THROUGH' in (r.get('margin') or ''):
        return True
    dec = (r.get('decision') or '').lower()
    if 'faulty' in dec:
        return True
    # The footnote audit can read 'clean' yet still have many orphaned definitions —
    # audit.py's verdict only tests unmatched *refs*, not unmatched *defs* (see the
    # aarushi2025attention case: 239 refs / 477 defs / 238 orphans, stamped 'clean').
    # Catch it on the evidence: any broken ref/gap, or a large unmatched-def share.
    if r.get('module') == 'footnote_audit':
        ev = r.get('evidence') or {}
        if ev.get('gaps') or ev.get('unmatched_refs'):
            return True
        udef, defs = ev.get('unmatched_defs', 0), ev.get('total_defs', 0)
        return bool(defs) and udef / defs >= 0.15
    # The EPUB linking outcome (FootnoteConverter): definitions DETECTED but never linked. This is
    # the signal that was missing — it routes a fixer to the LINKER, not the detectors. Flag on a
    # meaningful orphan share (catastrophic cases are already caught by the conf<0.5 check above).
    if r.get('module') == 'footnote_linking':
        ev = r.get('evidence') or {}
        od, tot = ev.get('orphaned_defs', 0), ev.get('detected_footnotes', 0)
        return bool(tot) and od / tot >= 0.15
    # A declined step is a lead ONLY when the pipeline wasn't sure. A confident, deliberate
    # skip (conf >= 0.8) is a correct non-action, not a code limitation.
    if conf is not None and conf >= 0.8:
        return False
    return any(w in dec for w in ('skipped', 'suppress', 'no footnotes detected'))


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


# A module that was decomposed into a sibling rule/pass registry: sending the original (now often a
# thin shell or front-end orchestrator) must ALSO send the module that now holds the real logic, or
# the loop can't see — let alone op:add into — the rules/passes it's meant to extend. Keyed by repo
# path; values are extra repo paths to include alongside it.
_DECOMPOSITION_SIBLINGS = {
    'app/Python/conversion/citations.py': ['app/Python/conversion/citation_link_rules.py'],
    'app/Python/conversion/footnotes.py': ['app/Python/conversion/footnote_link_rules.py'],
    # EPUB + the shared front-end both route footnote linking through footnote_link_rules.py now.
    'app/Python/epub_normalizer.py': ['app/Python/conversion/footnote_link_rules.py'],
    'app/Python/process_document.py': ['app/Python/conversion/footnote_link_rules.py'],
}


def _with_siblings(paths):
    """Expand each path with its decomposition siblings (see _DECOMPOSITION_SIBLINGS), preserving
    order and dropping duplicates — so a fix always sees the module that holds the real logic."""
    out = []
    for p in paths:
        for q in [p] + _DECOMPOSITION_SIBLINGS.get(p, []):
            if q not in out:
                out.append(q)
    return out


def _footnote_fix_modules(art):
    """A failing footnote_audit names audit.py — but audit.py only MEASURES the orphans;
    they're created upstream in the detector/linker. Send the code that can actually fix it,
    chosen by pathway (epub vs the shared markdown/docx/html/pdf path)."""
    front = 'app/Python/epub_normalizer.py' if (art and art.get('is_epub')) else 'app/Python/process_document.py'
    return _with_siblings([front, 'app/Python/conversion/footnotes.py'])


def _citation_fix_modules(art):
    """A citation_linking fork ("linked 0 of N") is usually NOT the linker's fault — a citation can
    only link if a matching bibliography entry exists. So the CAUSE is upstream: bibliography
    extraction (the link targets) or the citation-style detection. Send those alongside the linker so
    the model can fix the cause, not just the symptom (the Soviet-Marxism run wasted all 3 attempts on
    the orchestrator because bibliography.py — where references_found=1 came from — was never sent)."""
    return _with_siblings(['app/Python/conversion/citations.py',
                           'app/Python/conversion/bibliography.py'])


def modules_for(records, art=None):
    """Module files named by the flagged forks' code_refs (the code to send the LLM).
    A flagged footnote_audit is redirected to the detector/linker (see _footnote_fix_modules)."""
    paths = []

    def _add(p):
        if p and p not in paths and os.path.isfile(os.path.join(REPO_ROOT, p)):
            paths.append(p)

    for r in records:
        if r.get('module') == 'footnote_audit':
            for p in _footnote_fix_modules(art):
                _add(p)
            continue
        if r.get('module') == 'citation_linking':
            # Route the CAUSE (bibliography extraction = the link targets), not just the linker.
            for p in _citation_fix_modules(art):
                _add(p)
            continue
        # Send the code_ref's file AND any decomposition sibling that now holds the real logic
        # (e.g. citations.py is a thin shell over citation_link_rules.py).
        for p in _with_siblings([_code_ref_to_path(r.get('code_ref', ''))] if _code_ref_to_path(r.get('code_ref', '')) else []):
            _add(p)
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
        "\n## How to localize the cause — read the stats as a CAUSAL CHAIN and fix the EARLIEST cause",
        "- `citations_linked` is DOWNSTREAM of `references_found`: a citation links ONLY if a matching "
        "bibliography entry exists. So `citations 0/158` with `references_found 1` means the link "
        "TARGETS are missing — the cause is bibliography extraction (bibliography.py) or a mis-detected "
        "citation_style, NOT the citation linker. Editing the linker cannot link to entries that were "
        "never extracted. (And `style=author-year-bracket` on a numbered-footnote book is likely a "
        "mis-detection — then `0/N` is NOISE, not a bug: prefer NO change over 'fixing' a non-problem.)\n"
        "- footnotes: a marker links only if its definition was DETECTED and the marker SURVIVED. A "
        "definition absent from the input/markdown can never be linked downstream — look upstream.\n"
        + ("- [PDF] the pipeline is OCR(cached) → main-text.md → simple_md_to_html → process_document. "
           "ASK: is the missing artifact ABSENT from the assembled markdown (→ cause is UPSTREAM in "
           "mistral_ocr ASSEMBLY: classify_footnotes / assemble_markdown) or PRESENT-but-unlinked (→ "
           "cause is the downstream linker)? Localize before editing.\n" if art.get('is_pdf') else "")
        + "- Prefer the SMALLEST edit to the responsible DECISION function (op:edit). Adding a new "
        "DocPass to DOC_PASSES is high-blast-radius and frequently crashes — reserve op:add for a "
        "genuinely new phase, never as a way to patch a linking/extraction symptom.",
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
        parts.append(
            "Linking principle: if a marker carries an EXPLICIT target — href=\"#id\", or a definition "
            "that back-links to the marker's id — pair them by that id correspondence, NOT by number. "
            "Number-based pairing mis-aligns whenever numbering restarts or is offset across segments "
            "(the orphaned defs here are numbered on a different base than the detected markers). A "
            "mis-aligned link is worse than no link.")
    ctx = _markup_in_context(art)
    if ctx:
        parts.append("\n## Markup in context (a reference + a definition INSIDE their block — the "
                     "element nesting a fixed excerpt hides; for an EPUB also the RAW pre-conversion markup)")
        parts.append(ctx)
    if art['source']:
        parts.append("\n## Source (truncated)")
        parts.append(art['source'][:5000])
    parts.append("\n## Responsible module source (you may edit any function in these files)")
    for p in module_paths:
        parts.append(f"\n--- {p} ---")
        parts.append(open(os.path.join(REPO_ROOT, p), encoding='utf-8').read())
    parts.append("\n" + fix_categories.render_prompt_block(module_paths))
    parts.append(
        "\n## Your task\n"
        "Return STRICT JSON: {\"rationale\": str, \"functions\": [<edit>, ...]} where each <edit> is "
        "ONE change carrying an \"op\" (and an optional \"category\" = the fix-category id you used):\n"
        "  • op=\"edit\" — PREFER THIS for modifying existing code. {file, search, replace, name?}: "
        "replaces the first occurrence of `search` with `replace`. Copy `search` VERBATIM from the "
        "source shown above — a few UNIQUE lines with their exact indentation. Optional `name` "
        "(\"func\" or \"Class.method\") scopes the search to one function so an identical line "
        "elsewhere isn't matched. Change ONLY the lines that differ — do NOT resend the whole function.\n"
        "  • op=\"replace\" — {file, name, code}: full-body swap of an EXISTING function. Use ONLY for a "
        "SMALL function; for a big method use op:edit (resending 100 lines to change 3 keeps breaking it).\n"
        "  • op=\"add\" — {file, name, code}: a NEW top-level function or class (e.g. a new EpubTransform).\n"
        "  • op=\"register\" — {file, name, code}: append to a module-level list/tuple — `name` is the "
        f"LIST name (only {sorted(REGISTERABLE_LISTS)}), `code` is the expression to append (e.g. \"MyDetector()\").\n"
        "`file` may only be app/Python/conversion/*.py or a shown front-end module. Combine edits if the "
        "fix spans stages (op:add a detector + op:register it). Keep edits minimal. Uphold the modus "
        "operandi: correct where determinable, NO link where ambiguous — never a confident wrong link.")
    return "\n".join(parts)


def _markup_in_context(art):
    """Show the model the ACTUAL markup of a footnote REFERENCE and a DEFINITION inside their
    containing block (paragraph/div) — the element NESTING that a fixed line-sample or a truncated
    excerpt hides (e.g. the <sup>…<a epub:type=noteref>…</a></sup> double-detection that orphaned
    half of aarushi's footnotes). For an EPUB it also pulls from the RAW source (epub_original/*.xhtml
    or original.epub), where the pre-conversion markup the bug actually lives in is intact.
    Best-effort: never raises (returns '' if bs4 is unavailable or nothing matches)."""
    import re
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return ''
    out = []

    def _block(el):
        for anc in [el, *el.parents]:
            if getattr(anc, 'name', None) in ('p', 'div', 'li', 'aside', 'td', 'section'):
                return str(anc)[:700]
        return str(el)[:400]

    def _find_noteref(soup):
        r = soup.find('sup', class_='footnote-ref')
        return r or soup.find(lambda t: t.has_attr('epub:type') and 'noteref' in t.get('epub:type', '').lower())

    # (a) Converted main-text.html: one in-text reference in its block.
    src = art.get('source')
    if src and '<' in src:
        try:
            ref = _find_noteref(BeautifulSoup(src, 'html.parser'))
            if ref:
                out.append("In-text reference (converted main-text.html), in its block:\n" + _block(ref))
        except Exception:
            pass

    # A real footnote definition's markup (footnotes.json content).
    bd = art.get('book_dir')
    if bd:
        for cand in ('footnotes.jsonl', 'footnotes.json'):
            p = os.path.join(bd, cand)
            if not os.path.isfile(p):
                continue
            try:
                raw = open(p, encoding='utf-8').read()
                items = ([json.loads(l) for l in raw.splitlines() if l.strip()]
                         if cand.endswith('.jsonl') else json.load(open(p, encoding='utf-8')))
                if isinstance(items, list) and items:
                    out.append("A footnote definition (footnotes.json content):\n" + str(items[0].get('content', ''))[:600])
            except Exception:
                pass
            break

    # (b) RAW EPUB source: a noteref + a footnote in their blocks — shows the PRE-conversion nesting.
    raw = None
    if bd:
        epd = os.path.join(bd, 'epub_original')
        if os.path.isdir(epd):
            import glob
            for f in (glob.glob(os.path.join(epd, '**', '*.xhtml'), recursive=True)
                      + glob.glob(os.path.join(epd, '**', '*.html'), recursive=True)):
                try:
                    t = open(f, encoding='utf-8', errors='ignore').read()
                except Exception:
                    continue
                if 'noteref' in t.lower():
                    raw = t
                    break
        elif os.path.isfile(os.path.join(bd, 'original.epub')):
            try:
                import zipfile
                with zipfile.ZipFile(os.path.join(bd, 'original.epub')) as z:
                    for n in z.namelist():
                        if n.lower().endswith(('.xhtml', '.html')):
                            t = z.read(n).decode('utf-8', 'ignore')
                            if 'noteref' in t.lower():
                                raw = t
                                break
            except Exception:
                pass
    if raw:
        try:
            rs = BeautifulSoup(raw, 'html.parser')
            nref = _find_noteref(rs)
            if nref:
                out.append("RAW EPUB in-text reference, in its block (PRE-conversion — note the element nesting):\n"
                           + _block(nref))
            ndef = rs.find(lambda t: t.has_attr('epub:type')
                           and re.search(r'footnote|endnote|rearnote', t.get('epub:type', ''), re.I))
            if ndef:
                out.append("RAW EPUB footnote definition, in its block:\n" + _block(ndef))
        except Exception:
            pass
    return "\n\n".join(out)


def _footnote_samples(art, n=14):
    """Pull the document's ACTUAL footnote markers + definitions so the model sees the shapes it
    must wire up — not just aggregate counts. Markdown-aware (the [^N] / N. forms of the PDF path)
    AND HTML-aware (the <sup class="footnote-ref"> markers EPUB/HTML/docx produce + real definition
    text from footnotes.json). Without the HTML half, an EPUB case showed the model NO real markers,
    so it invented a scheme (the aarushi 'epub:type=noteref' hallucination — which doesn't exist)."""
    import re
    refs, defs = [], []
    text = art.get('markdown') or art.get('source') or ''

    # Markdown markers + definition-looking lines ("[^N]", "[N] …", "N. Text").
    for ln in text.split('\n'):
        s = ln.strip()
        if not s:
            continue
        if len(refs) < n and re.search(r'\[\^\d+\]', s):
            refs.append(s[:160])
        if len(defs) < n and re.match(r'^(\[\^?\d+\]\s*[:.]?|\d{1,3}[.\s])\s*\S', s):
            defs.append(s[:160])

    # HTML in-text markers: <sup ...footnote-ref...>N</sup> with a little leading context.
    if len(refs) < n and '<sup' in text:
        for m in re.finditer(r'(.{0,60})(<sup\b[^>]*footnote-ref[^>]*>.*?</sup>)', text, re.S):
            ctx = re.sub(r'\s+', ' ', m.group(1))[-50:]
            refs.append((ctx + m.group(2))[:200])
            if len(refs) >= n:
                break

    # HTML definitions live separately (footnotes.json/jsonl), not inline — pull a few real ones.
    if len(defs) < n and art.get('book_dir'):
        for cand in ('footnotes.jsonl', 'footnotes.json'):
            p = os.path.join(art['book_dir'], cand)
            if not os.path.isfile(p):
                continue
            try:
                raw = open(p, encoding='utf-8').read()
                items = ([json.loads(l) for l in raw.splitlines() if l.strip()]
                         if cand.endswith('.jsonl') else json.load(open(p, encoding='utf-8')))
                for it in (items if isinstance(items, list) else []):
                    c = re.sub(r'<[^>]+>', '', str(it.get('content') or it.get('text') or ''))
                    c = re.sub(r'\s+', ' ', c).strip()
                    if c:
                        defs.append(c[:160])
                    if len(defs) >= n:
                        break
            except Exception:
                pass
            break

    out = []
    if refs:
        out.append("In-text markers (what must link — note the actual element/scheme):\n"
                   + "\n".join(f"  {r}" for r in refs))
    if defs:
        out.append("Footnote definitions (a sample of what they link TO):\n"
                   + "\n".join(f"  {d}" for d in defs))
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
    # Optional response cache (the co-evolution harness sets VIBE_LLM_CACHE): keyed on
    # model+prompt, so re-running the corpus after a NON-prompt change is free, while a prompt or
    # registry change busts the key and re-calls — exactly what we want to measure. Cache-only mode
    # (VIBE_LLM_CACHE_ONLY) raises on a miss so re-scoring never silently spends tokens.
    import hashlib
    cache_dir = os.environ.get('VIBE_LLM_CACHE')
    cpath = None
    if cache_dir:
        ckey = hashlib.sha256((model + '\n' + prompt).encode('utf-8')).hexdigest()[:20]
        cpath = os.path.join(cache_dir, ckey + '.json')
        if os.path.isfile(cpath):
            _USAGE['cached'] += 1
            return json.load(open(cpath, encoding='utf-8'))
        if os.environ.get('VIBE_LLM_CACHE_ONLY'):
            raise ValueError("no cached LLM response for this prompt (cache-only mode)")
    key = _dotenv('LLM_API_KEY')
    base = (_dotenv('LLM_BASE_URL') or 'https://api.fireworks.ai/inference/v1').rstrip('/')
    if not key:
        raise SystemExit("No LLM_API_KEY (env or .env) and no --mock-diff given. "
                         "Add LLM_API_KEY to .env for a real call, or pass --mock-diff <file>.")
    import ssl
    import urllib.error
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
    try:
        # 600s: a big prompt (full process_document.py + footnotes.py) + V4 Pro reasoning can run
        # well past 4 min. A network/read timeout is TRANSIENT — raise ValueError so the loop retries
        # this attempt instead of crashing the whole run (it isn't a SystemExit).
        with urllib.request.urlopen(req, timeout=600, context=ctx) as resp:
            raw = json.loads(resp.read())
    except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
        raise ValueError(f"model call failed/timed out ({e}) — retrying")
    content = raw['choices'][0]['message']['content']
    # Record exact token spend BEFORE parsing — a truncated response still cost us those tokens.
    u = raw.get('usage') or {}
    _USAGE['prompt_tokens'] += u.get('prompt_tokens', 0)
    _USAGE['completion_tokens'] += u.get('completion_tokens', 0)
    _USAGE['calls'] += 1
    _USAGE['model'] = model
    parsed = _parse_llm_json(content)  # raises ValueError on truncation → caller retries (uncached)
    if cpath:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cpath, 'w', encoding='utf-8') as f:
            json.dump(parsed, f, ensure_ascii=False)
    return parsed


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
    """Path-allowlist + dangerous-construct scan on the proposed edits, across all ops
    (edit / replace / add / register). Returns (ok, reason, files)."""
    if not isinstance(functions, list) or not functions:
        return False, "no edits returned", []
    files = []
    for fn in functions:
        op = fn.get('op') or 'replace'
        if op not in ('edit', 'replace', 'add', 'register'):
            return False, f"unknown op {op!r} (use edit/replace/add/register)", []
        path = (fn.get('file') or '').replace('\\', '/').lstrip('./')
        if not path:
            return False, "an edit is missing 'file'", []
        allowed = path in ALLOWED_FILES or any(path.startswith(p) for p in ALLOWED_PREFIXES)
        if not allowed:
            return False, f"edit touches a disallowed path: {path}", []
        if op == 'edit':
            # surgical search/replace — needs a non-empty search; replace may be '' (a deletion)
            if not fn.get('search') or fn.get('replace') is None:
                return False, "an op:edit needs a non-empty 'search' and a 'replace'", []
            scan = fn.get('replace') or ''
        else:
            if not fn.get('name') or not fn.get('code'):
                return False, "an op:replace/add/register needs 'name' and 'code'", []
            if op == 'register' and fn['name'] not in REGISTERABLE_LISTS:
                return False, (f"op=register may only append to {sorted(REGISTERABLE_LISTS)}, "
                               f"not {fn['name']!r}"), []
            scan = fn['code']
        for rx, label in _DANGEROUS:
            if rx.search(scan):
                return False, (f"proposed code uses '{label}', which conversion logic must never "
                               f"do — refused for safety"), []
        files.append(path)
    return True, "ok", sorted(set(files))


def _offset(src, lineno, col):
    """Absolute char index in src for a 1-based lineno + 0-based col (ast coordinates)."""
    lines = src.split('\n')
    return sum(len(l) + 1 for l in lines[:lineno - 1]) + col


def _replace_function(src, name, new_code):
    """Splice `new_code` in for the def/async-def named `name` using ast to find its exact span
    — robust where unified-diff context matching is brittle. `name` may be a bare function name
    OR a qualified `ClassName.method` (the natural way to name a method — and necessary to
    disambiguate when many classes share a method name, e.g. the EPUB detectors' `transform`).
    Returns the new source, or None if the target isn't found."""
    import ast
    import textwrap
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    _FDEF = (ast.FunctionDef, ast.AsyncFunctionDef)
    if '.' in name:
        cls_name, meth = name.rsplit('.', 1)
        cls = next((n for n in ast.walk(tree)
                    if isinstance(n, ast.ClassDef) and n.name == cls_name), None)
        target = next((n for n in cls.body if isinstance(n, _FDEF) and n.name == meth), None) if cls else None
    else:
        target = next((nd for nd in ast.walk(tree) if isinstance(nd, _FDEF) and nd.name == name), None)
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


def _add_definition(src, name, new_code, before_name=None):
    """Insert a NEW top-level function/class `name` (op:add). `new_code` must parse and define
    `name` at top level; refuses to clobber an existing top-level `name` (use replace for that).
    Inserts before the module-level `before_name` (def/class/assignment) when given — so a new
    detector lands BEFORE the TRANSFORM_PIPELINE list that registers it — else at end of file.
    Returns the new source, or None if it can't be added safely."""
    import ast
    import textwrap
    block = textwrap.dedent(new_code).strip('\n')
    try:
        newmod = ast.parse(block)
    except SyntaxError:
        return None
    defined = {n.name for n in newmod.body
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    if name not in defined:
        return None  # `code` must actually define `name`
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    existing = {n.name for n in tree.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    if name in existing:
        return None  # don't silently shadow — the model should have used op:replace
    lines = src.split('\n')
    if before_name:
        for n in tree.body:
            names = ([t.id for t in n.targets if isinstance(t, ast.Name)]
                     if isinstance(n, ast.Assign)
                     else [n.name] if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                     else [])
            if before_name in names:
                at = (min(d.lineno for d in n.decorator_list)
                      if getattr(n, 'decorator_list', None) else n.lineno) - 1
                return '\n'.join(lines[:at] + [block, '', ''] + lines[at:])
    return src.rstrip('\n') + '\n\n\n' + block + '\n'


def _register_in_list(src, list_name, item_expr):
    """Append `item_expr` to the module-level list/tuple assigned to `list_name` (op:register).
    Rebuilds the literal from ast source-segments so it always re-parses; preserves multi-line
    layout. Returns the new source, or None if no such module-level list/tuple exists."""
    import ast
    import re as _re
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    node = None
    for n in tree.body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == list_name
                                             for t in n.targets) and isinstance(n.value, (ast.List, ast.Tuple)):
            node = n.value
            break
    if node is None:
        return None
    segs = [ast.get_source_segment(src, e) for e in node.elts]
    if any(s is None for s in segs):
        return None
    segs.append(item_expr.strip())
    ob, cb = ('[', ']') if isinstance(node, ast.List) else ('(', ')')
    start = _offset(src, node.lineno, node.col_offset)
    end = _offset(src, node.end_lineno, node.end_col_offset)
    orig = src[start:end]
    if '\n' in orig:
        first_el_line = src.split('\n')[node.elts[0].lineno - 1] if node.elts else ''
        indent = _re.match(r'\s*', first_el_line).group(0) or '    '
        close_indent = _re.match(r'\s*', src.split('\n')[node.end_lineno - 1]).group(0)
        body = (',\n' + indent).join(segs)
        new = f"{ob}\n{indent}{body},\n{close_indent}{cb}"
    else:
        tail = ',' if (isinstance(node, ast.Tuple) and len(segs) == 1) else ''
        new = ob + ', '.join(segs) + tail + cb
    return src[:start] + new + src[end:]


def _scope_span(src, name):
    """Char span (start, end) of function/method `name` (bare or Class.method) in src, or None.
    Lets op:edit scope its search to one function (disambiguating identical snippets across methods)."""
    import ast
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    _F = (ast.FunctionDef, ast.AsyncFunctionDef)
    if '.' in name:
        cn, mn = name.rsplit('.', 1)
        cls = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == cn), None)
        node = next((n for n in cls.body if isinstance(n, _F) and n.name == mn), None) if cls else None
    else:
        # A bare name may be a function OR a class — scoping to a class lets op:edit change
        # class-level code (e.g. a detector's ID_PATTERNS list) without dumping the whole class.
        node = next((n for n in ast.walk(tree)
                     if isinstance(n, _F + (ast.ClassDef,)) and n.name == name), None)
    if node is None:
        return None
    start_line = min([d.lineno for d in node.decorator_list], default=node.lineno)
    lines = src.split('\n')
    return _offset(src, start_line, 0), _offset(src, node.end_lineno, len(lines[node.end_lineno - 1]))


def _flex_find(hay, needle):
    """Locate `needle` in `hay`: exact substring first (must be UNIQUE), else a whitespace-flexible
    match (compares the sequence of stripped non-blank lines, tolerating indentation drift). Returns
    (start, end) char offsets, the string 'ambiguous' (>1 exact hit), or None (no match)."""
    c = hay.count(needle)
    if c == 1:
        i = hay.index(needle)
        return (i, i + len(needle))
    if c > 1:
        return 'ambiguous'
    nlines = needle.split('\n')
    while nlines and not nlines[0].strip():
        nlines.pop(0)
    while nlines and not nlines[-1].strip():
        nlines.pop()
    if not nlines:
        return None
    target = [l.strip() for l in nlines]
    hlines = hay.split('\n')
    for i in range(len(hlines) - len(target) + 1):
        if [hlines[i + j].strip() for j in range(len(target))] == target:
            start = sum(len(l) + 1 for l in hlines[:i])
            end = sum(len(l) + 1 for l in hlines[:i + len(target)]) - 1
            return (start, end)
    return None


def _apply_edit(src, search, replace, scope_name=None):
    """Surgical search/replace (op:edit) — the scalpel that lets the model change a few lines of a
    big method instead of resending the whole body (which kept clobbering working logic). Optionally
    scoped to function `scope_name`. Returns (new_src, None) or (None, reason)."""
    rs, re_ = 0, len(src)
    if scope_name:
        span = _scope_span(src, scope_name)
        if span is None:
            return None, f"scope function '{scope_name}' not found"
        rs, re_ = span
    region = src[rs:re_]
    found = _flex_find(region, search)
    if found is None:
        return None, ("search text not found — copy it VERBATIM from the source shown above "
                      "(including indentation), or set name to scope it")
    if found == 'ambiguous':
        return None, "search text appears more than once — include more surrounding lines, or set name to scope it"
    s, e = found
    matched = region[s:e]
    if matched != search:
        # Flexible (indentation-drifted) match: realign `replace` to the matched region's indent so
        # it doesn't land at the wrong column (the exact-match path needs no shift).
        def _indent(t):
            for ln in t.split('\n'):
                if ln.strip():
                    return len(ln) - len(ln.lstrip())
            return 0
        delta = _indent(matched) - _indent(search)
        if delta > 0:
            replace = '\n'.join((' ' * delta + ln) if ln.strip() else ln for ln in replace.split('\n'))
        elif delta < 0:
            replace = '\n'.join(ln[-delta:] if ln[:-delta].strip() == '' else ln.lstrip()
                                for ln in replace.split('\n'))
    return src[:rs] + region[:s] + replace + region[e:] + src[re_:], None


def apply_function_replacements(sandbox, functions):
    """Apply each edit ({file, op, ...}) in the sandbox, grouped per file and ordered
    replace → edit → add → register (so a surgical edit hits the original body, and an added
    detector exists before it's registered). Every file ends with an ast re-parse gate.
    Returns (ok, message)."""
    import ast
    by_file = {}
    for fn in functions:
        by_file.setdefault(fn['file'].replace('\\', '/').lstrip('./'), []).append(fn)
    for path, fns in by_file.items():
        full = os.path.join(sandbox, path)
        if not os.path.isfile(full):
            return False, f"target file not in sandbox: {path}"
        src = open(full, encoding='utf-8').read()
        # An added def is placed just before the list that registers it (when both are present).
        anchor = next((f['name'] for f in fns if (f.get('op') == 'register')), None)
        for fn in [f for f in fns if (f.get('op') or 'replace') == 'replace']:
            new = _replace_function(src, fn['name'], fn['code'])
            if new is None:
                return False, (f"function '{fn['name']}' not found in {path} (or its code didn't "
                               f"parse) — if it's NEW, use op:add")
            src = new
        for fn in [f for f in fns if f.get('op') == 'edit']:
            new, reason = _apply_edit(src, fn['search'], fn.get('replace') or '', scope_name=fn.get('name'))
            if new is None:
                return False, f"op:edit on {path}: {reason}"
            src = new
        for fn in [f for f in fns if f.get('op') == 'add']:
            new = _add_definition(src, fn['name'], fn['code'], before_name=anchor)
            if new is None:
                return False, (f"could not add '{fn['name']}' to {path} (didn't parse, name "
                               f"mismatch, or already exists — use op:replace to change it)")
            src = new
        for fn in [f for f in fns if f.get('op') == 'register']:
            new = _register_in_list(src, fn['name'], fn['code'])
            if new is None:
                return False, f"could not register into '{fn['name']}' in {path} (no such module-level list/tuple)"
            src = new
        try:
            ast.parse(src)
        except SyntaxError as e:
            return False, f"edits broke {path}: {e}"
        open(full, 'w', encoding='utf-8').write(src)
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
                '__pycache__', '*.pyc', 'fixtures-local', 'corpus'))
        elif os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    return tmp


def _pipeline_into(py_dir, book_dir, out):
    """Run the PATHWAY-AWARE conversion chain (patched code in py_dir) into `out`, so a patch
    to ANY post-cache stage is actually exercised:
      • PDF (ocr_response.json present): replay cached OCR — mistral_ocr.py(/dev/null,cache)
        -> simple_md_to_html -> process_document. (OCR itself is replayed from cache; fixes to
        fetch_ocr can't be validated this way — the prompt tells the model not to attempt them.)
      • EPUB (epub_original/ or *.epub present): epub_normalizer -> process_document, so a patch to
        epub_normalizer.py is REALLY exercised. (Without this the reconvert re-ran process_document on
        the already-linked main-text.html → 0 footnotes → every epub fix wrongly rejected.)
      • else (md/html/docx): process_document on the intermediate HTML.
    Returns the final subprocess result (or None if there was nothing to convert)."""
    def _run(*cmd):
        if _DOCKER_IMAGE:
            # Mount the sandbox (patched code) + book source read-only and the out dir writable,
            # at identical paths. The container has no network and no host env → secrets are
            # unreachable to the model-written code it runs.
            sandbox_root = os.path.dirname(os.path.dirname(py_dir))
            full = _docker_cmd(_DOCKER_IMAGE, [sandbox_root, book_dir], [out], ['python', *cmd])
            return subprocess.run(full, capture_output=True, text=True)
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
    epub = next((os.path.join(book_dir, c) for c in ('epub_original', 'original.epub', 'input.epub')
                 if os.path.exists(os.path.join(book_dir, c))), None)
    if epub:
        r = _run(os.path.join(py_dir, 'epub_normalizer.py'), epub, out, 'vibebook')
        mh = os.path.join(out, 'main-text.html')
        if r.returncode == 0 and os.path.isfile(mh):
            r = _run(os.path.join(py_dir, 'process_document.py'), mh, out, 'vibebook')
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


def evaluate(baseline_art, after, patched_files=None):
    """The path-A gate, THREE-TIER (the patch only ever touches THIS doc — no regression suite):
        'clean'    — the flagged problem(s) resolved with NO new flags/faults → offer confidently
        'improved' — got materially better, either MORE links OR FEWER audit faults (a wrong link is
                     worse than a missing one, so reducing orphans/gaps at equal links is a real win)
                     → SHOW the user with the caveat, they judge
        'reject'   — crashed, regressed a previously-good metric, or no measurable improvement
    Returns (tier, reason). Accepting is non-destructive: the nodes_versioning_trigger archives the
    prior conversion to nodes_history, so the user can always revert.

    `patched_files` (repo paths the patch edited) guards against the model GAMING the gate by editing
    the AUDIT to report fewer faults — audit faults come from audit.py:compute_footnote_audit, so a
    patch touching audit.py forfeits fault-reduction credit (it must fix the conversion, not the ruler)."""
    if not after['ok']:
        return 'reject', "the patched code crashed converting the document"
    b, a = baseline_art['stats'], after['stats']
    b_fl, b_faults = _problem_set(baseline_art['assessment'], baseline_art['audit'])
    a_fl, a_faults = _problem_set(after['assessment'], after['audit'])
    fault_drop = b_faults - a_faults                       # >0 = fewer audit faults (good)
    # Did the patch edit the AUDIT itself? Then a fault drop is suspect — don't credit it.
    gamed_audit = bool(patched_files) and any((p or '').endswith('audit.py') for p in patched_files)
    creditable_fault_drop = fault_drop > 0 and not gamed_audit

    # Regression guard: things that were already working must not get worse.
    if a.get('citations_linked', 0) < b.get('citations_linked', 0):
        return 'reject', (f"it linked FEWER citations ({a.get('citations_linked', 0)} vs "
                          f"{b.get('citations_linked', 0)})")
    # A footnote-count DROP is a regression ONLY if it didn't also remove faults — i.e. REAL footnotes
    # were lost, not noise defs (e.g. bibliography entries mis-counted as footnote definitions). A drop
    # that simultaneously cuts audit faults (and didn't game the audit) is removing garbage = good.
    if a.get('footnotes_matched', 0) < b.get('footnotes_matched', 0) and not creditable_fault_drop:
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

    # CORRECTNESS WIN with no link-count gain: the conversion linked the same but has FEWER audit
    # faults (e.g. stopped mis-counting bibliography entries as orphaned footnote definitions), with
    # no new flag introduced and without editing the audit. Reducing orphans/gaps IS an improvement
    # (a wrong/orphan link is worse than a clean omission) — credit it so the loop stops rejecting
    # correct fixes that don't happen to raise the link COUNT.
    if creditable_fault_drop and not introduced:
        return 'improved', (f"reduced audit faults {b_faults}→{a_faults} (e.g. fewer orphaned "
                            f"definitions / numbering gaps) with no new faults — a correctness win "
                            f"even though the link count didn't rise")
    return 'reject', "no measurable improvement to this document"


def run_loop(book_dir, max_attempts, model, mock_diff=None, user_note=None, file_issue=False):
    """The user-facing path: bounded retry. Each attempt asks the LLM for a patch, applies
    it in a throwaway sandbox, re-converts THIS document, and evaluates. On failure it feeds
    the new result back to the LLM and tries again — up to max_attempts. The winning diff is
    written to <book_dir>/vibe_patch.diff so an 'accept' step can apply it. Returns (rc, diff)."""
    reset_usage()  # per-case token/cost accounting → snapshotted into the report by _finalize
    art = load_artifacts(book_dir)
    flagged = flagged_forks(art['assessment'])
    modules = modules_for(flagged, art) or modules_for(art['assessment'], art)
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
        # Co-evolution signal for the post-mortem: which fix-categories + ops the model reached for.
        _meta = {'categories': sorted({(f.get('category') or '?') for f in funcs}),
                 'ops': sorted({(f.get('op') or 'replace') for f in funcs})}
        emit('proposed',
             f"DeepSeek V4 is proposing an update to the conversion pipeline "
             f"({', '.join(_touch) or 'no change'}): {patch.get('rationale', '')[:160]}",
             attempt=attempt, touches=_touch)

        ok, reason, _ = validate_replacements(funcs)
        if not ok:
            journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                            'touches': _touch, 'tier': 'rejected', 'why': reason, 'stats': None, **_meta})
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
                # Structural apply-fails (a needed shape the format couldn't represent) are the
                # 'inexpressible' signal the post-mortem uses to route work to the patch-format.
                inexpressible = ('use op:add' in out or 'no such module-level' in out
                                 or 'already exists' in out)
                journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                                'touches': _touch, 'tier': 'apply_failed', 'why': out[:200],
                                'stats': None, 'inexpressible': inexpressible, **_meta})
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
            tier, why = evaluate(art, after, patched_files=[f.get('file') for f in funcs])
            st = after['stats']
            journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                            'touches': _touch, 'tier': tier, 'why': why, 'stats': _stat_summary(st), **_meta})
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
        'usage': usage_summary(),  # exact tokens + $ (when LLM_PRICE_PER_MTOK_IN/_OUT set) for this case
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
    """owner/repo (from the git origin) for auto-filed issues — the CODE repo, so issues sit with
    the code and link to fixing PRs. Filter the noise with the issue labels, not a separate repo."""
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


def _apply_diff(sandbox, diff_path):
    """Apply an aider git diff in the sandbox (git apply, then a -p1 fallback). Returns (ok, msg)."""
    r = subprocess.run(['git', '-C', sandbox, 'apply', '--whitespace=nowarn', diff_path],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return True, "ok"
    r2 = subprocess.run(['patch', '-p1', '-d', sandbox, '-i', diff_path], capture_output=True, text=True)
    return (r2.returncode == 0), (r.stderr or r2.stderr or 'git apply failed')[-300:]


def apply_patch_to_book(book_dir, patch_path=None):
    """'Use this conversion': apply the validated patch in a sandbox, re-convert THIS book, and copy
    the fresh artifacts into book_dir — regenerating this one book's output. Production code is never
    touched. Autodetects the patch format: a git DIFF (vibe_patch.diff, the aider engine) or
    full-function JSON (vibe_patch.json, the deepseek engine)."""
    if not patch_path:
        for cand in ('vibe_patch.diff', 'vibe_patch.json'):
            p = os.path.join(book_dir, cand)
            if os.path.isfile(p):
                patch_path = p
                break
    if not patch_path or not os.path.isfile(patch_path):
        print(f"No vibe patch found in {book_dir}")
        return 1
    is_diff = patch_path.endswith('.diff')
    sandbox = make_sandbox()
    try:
        if is_diff:
            ok, out = _apply_diff(sandbox, os.path.abspath(patch_path))
        else:
            funcs = json.load(open(patch_path, encoding='utf-8')).get('functions', [])
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
    ap.add_argument('--docker', metavar='IMAGE',
                    help="Run the re-conversion (model code) in this locked-down container image "
                         "(no network/secrets). Recommended on prod, e.g. hyperlit-vibe-sandbox.")
    ap.add_argument('--github', action='store_true',
                    help="On an UNFIXED run, open a GitHub issue with the full diagnosis "
                         "(uses GITHUB_TOKEN from .env; dry-runs if absent).")
    ap.add_argument('--apply', metavar='PATCH',
                    help="'Use this conversion': apply PATCH + regenerate this book's artifacts.")
    ap.add_argument('--engine', choices=['deepseek', 'aider'], default='deepseek',
                    help="Edit-gen engine: 'deepseek' (our full-function loop, default) or 'aider' "
                         "(repo-map + search/replace + test-driven retry; needs VIBE_AIDER_BIN).")
    args = ap.parse_args()

    global _JSON_PROGRESS, _PROGRESS_FILE, _CANCEL_FILE, _DOCKER_IMAGE
    _JSON_PROGRESS = args.json_progress
    _PROGRESS_FILE = args.progress_file
    _CANCEL_FILE = args.cancel_file
    _DOCKER_IMAGE = args.docker

    if args.apply:
        sys.exit(apply_patch_to_book(args.book_dir, args.apply))

    if args.print_prompt:
        art = load_artifacts(args.book_dir)
        modules = modules_for(flagged_forks(art['assessment']), art) or modules_for(art['assessment'], art)
        print(build_prompt(art, modules, user_note=args.user_note))
        return

    if args.engine == 'aider':
        import vibe_aider  # lazy — only the aider path needs it
        rc, _ = vibe_aider.run_aider_loop(args.book_dir, args.max_attempts, args.model,
                                          user_note=args.user_note, file_issue=args.github)
        sys.exit(rc)

    rc, _ = run_loop(args.book_dir, args.max_attempts, args.model,
                     mock_diff=args.mock_diff, user_note=args.user_note, file_issue=args.github)
    sys.exit(rc)


if __name__ == '__main__':
    main()

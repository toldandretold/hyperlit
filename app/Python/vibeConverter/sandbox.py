"""vibeConverter.sandbox — throwaway repo copy + pathway-aware re-conversion."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter import runtime
from vibeConverter.gate import (_count_headings, _ref_key_stats)
from vibeConverter.runtime import (REPO_ROOT, SANDBOX_PATHS, SCRUBBED_ENV, _docker_cmd)




# ---------------------------------------------------------------------------
# 5/6. Sandbox + gates
# ---------------------------------------------------------------------------
def make_sandbox():
    tmp = tempfile.mkdtemp(prefix='vibe-sandbox-')
    for rel in SANDBOX_PATHS:
        src = os.path.join(REPO_ROOT, rel)
        dst = os.path.join(tmp, rel)
        if os.path.isdir(src):
            # The sandbox needs only the CODE (the gate imports vibe_convert from app/Python). Exclude
            # heavy non-code so aider's repo scan doesn't ingest it and blow the model context window:
            #   • test fixtures/goldens/import-samples (the gate never uses them),
            #   • STRAY conversion artifacts (a leftover main-text.md/ocr_response.json etc. in app/Python
            #     is ~200k tokens of book text — it exhausted aider every run).
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
                '__pycache__', '*.pyc', 'fixtures-local', 'fixtures', 'corpus', 'import-samples',
                'main-text.md', 'main-text.html', 'ocr_response.json', '*.jsonl'))
        elif os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    return tmp




def _pipeline_into(py_dir, book_dir, out, book_id='vibebook', extra_env=None):
    """Run the PATHWAY-AWARE conversion chain (patched code in py_dir) into `out`, so a patch
    to ANY post-cache stage is actually exercised:

      `book_id` is the id handed to the converters — it becomes the image folder in every rewritten
      `<img src="/storage/books/<book_id>/images/...">`. The GATE leaves it 'vibebook' (its output is
      measured then discarded). The APPLY path passes the REAL book id so the regenerated nodes point
      at /storage/books/<realId>/images/, which already exists on disk — otherwise the images 404.

      • PDF (ocr_response.json present): replay cached OCR — mistral_ocr.py(/dev/null,cache)
        -> simple_md_to_html -> process_document. (OCR itself is replayed from cache; fixes to
        fetch_ocr can't be validated this way — the prompt tells the model not to attempt them.)
      • EPUB (epub_original/ or *.epub present): epub_normalizer -> process_document, so a patch to
        epub_normalizer.py is REALLY exercised. (Without this the reconvert re-ran process_document on
        the already-linked main-text.html → 0 footnotes → every epub fix wrongly rejected.)
      • else (md/html/docx): process_document on the intermediate HTML.
    Returns the final subprocess result (or None if there was nothing to convert)."""
    def _run(*cmd):
        if runtime._DOCKER_IMAGE:
            # Mount the sandbox (patched code) + book source read-only and the out dir writable,
            # at identical paths. The container has no network and no host env → secrets are
            # unreachable to the model-written code it runs.
            sandbox_root = os.path.dirname(os.path.dirname(py_dir))
            # ImageProcessor writes into {out}/media (already writable) — no live
            # /storage mount needed. apply.py copies that media dir back to the
            # book for the PHP store ingest.
            rw = [out]
            full = _docker_cmd(runtime._DOCKER_IMAGE, [sandbox_root, book_dir], rw, ['python', *cmd],
                               env=extra_env)
            return subprocess.run(full, capture_output=True, text=True)
        env = SCRUBBED_ENV if not extra_env else {**SCRUBBED_ENV, **extra_env}
        return subprocess.run([sys.executable, *cmd], cwd=py_dir, capture_output=True, text=True, env=env)
    if os.path.isfile(os.path.join(book_dir, 'ocr_response.json')):
        shutil.copy2(os.path.join(book_dir, 'ocr_response.json'), os.path.join(out, 'ocr_response.json'))
        r = _run(os.path.join(py_dir, 'mistral_ocr.py'), '/dev/null', out)
        md, html = os.path.join(out, 'main-text.md'), os.path.join(out, 'intermediate.html')
        if r.returncode == 0 and os.path.isfile(md):
            r = _run(os.path.join(py_dir, 'simple_md_to_html.py'), md, html)
            if r.returncode == 0 and os.path.isfile(html):
                r = _run(os.path.join(py_dir, 'process_document.py'), html, out, book_id)
        return r
    epub = next((os.path.join(book_dir, c) for c in ('epub_original', 'original.epub', 'input.epub')
                 if os.path.exists(os.path.join(book_dir, c))), None)
    if epub:
        r = _run(os.path.join(py_dir, 'epub_normalizer.py'), epub, out, book_id)
        mh = os.path.join(out, 'main-text.html')
        if r.returncode == 0 and os.path.isfile(mh):
            r = _run(os.path.join(py_dir, 'process_document.py'), mh, out, book_id)
        return r
    src = next((os.path.join(book_dir, c) for c in ('intermediate.html', 'main-text.html', 'input.html')
                if os.path.isfile(os.path.join(book_dir, c))), None)
    return _run(os.path.join(py_dir, 'process_document.py'), src, out, book_id) if src else None




def _reconvert(sandbox, book_dir):
    """Re-convert THIS doc in the sandbox and read the fresh result. Returns
    {ok, audit, stats, assessment, headings, refs, stderr} (stderr tail on failure → fed back to the model)."""
    out = tempfile.mkdtemp(prefix='vibe-out-')
    r = _pipeline_into(os.path.join(sandbox, 'app', 'Python'), book_dir, out)

    def _rd(name):
        p = os.path.join(out, name)
        return json.load(open(p, encoding='utf-8')) if os.path.isfile(p) else {}
    audit, stats = _rd('audit.json'), _rd('conversion_stats.json')
    assessment = (_rd('assessment.json') or {}).get('records', [])
    headings = _count_headings(os.path.join(out, 'nodes.jsonl'))   # count BEFORE the temp dir is wiped
    refs = _ref_key_stats(os.path.join(out, 'references.json'))
    stats['headings_total'] = headings['total']   # so _stat_summary can SHOW headings in every beat
    # On a CRASH, send the model the stderr tail. On a guarded SUCCESS, still surface any
    # `[detector-error]` (a detector that threw was skipped, not fatal) so the model can fix its detector.
    raw_err = (r.stderr or '') if r else ''
    if r and r.returncode != 0:
        stderr = raw_err[-700:]
    else:
        stderr = raw_err[-700:] if '[detector-error]' in raw_err else ''
    shutil.rmtree(out, ignore_errors=True)
    return {'ok': bool(r and r.returncode == 0), 'audit': audit, 'stats': stats,
            'assessment': assessment, 'headings': headings, 'refs': refs, 'stderr': stderr}

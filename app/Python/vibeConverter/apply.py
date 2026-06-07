"""vibeConverter.apply — "use this conversion": apply the patch + regenerate THIS book's artifacts."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.patch import (_apply_diff, apply_function_replacements)
from vibeConverter.runtime import (REPO_ROOT)
from vibeConverter.sandbox import (_pipeline_into, make_sandbox)




def _regenerate_json_array(outdir, book_dir, stem):
    """Build book_dir/<stem>.json (a JSON array) from the freshly-converted <stem>.jsonl (one object per
    line). The Python pipeline only writes the .jsonl; the .json array is normally produced by the Laravel
    IMPORT, and ConversionArtifactSaver reads the .json (saveNodes → nodes.json, saveFootnotes →
    footnotes.json). Without regenerating it the apply persists a STALE .json — markers/refs convert in the
    nodes but their DEFINITIONS (footnote sub-books) never reach the DB, so footnotes do nothing in the
    reader. No-op (leaves any existing file) if the fresh .jsonl is absent."""
    jl = os.path.join(outdir, stem + '.jsonl')
    if not os.path.isfile(jl):
        return
    rows = []
    with open(jl, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    with open(os.path.join(book_dir, stem + '.json'), 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)




def apply_patch_to_book(book_dir, patch_path=None):
    """'Use this conversion': apply the validated patch in a sandbox, re-convert THIS book, and copy
    the fresh artifacts into book_dir — regenerating this one book's output. Production code is never
    touched. Autodetects the patch format: a git DIFF (vibe_patch.diff, the aider engine) or
    full-function JSON (vibe_patch.json, the native engine)."""
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
        # APPLY path: re-convert under the REAL book id so the regenerated <img src> paths resolve to
        # /storage/books/<realId>/images/ (which already exists). The gate uses the default 'vibebook'.
        real_book_id = os.path.basename(book_dir.rstrip('/'))
        # Tell the sandboxed ImageProcessor the REAL repo root so it writes this book's images to the LIVE
        # storage (storage/app/public/books/<id>/images) + rewrites <img src> to /storage/... — the sandbox
        # has no `artisan` to walk to, so without this images break (raw epub_original paths, no live files).
        r = _pipeline_into(os.path.join(sandbox, 'app', 'Python'), book_dir, outdir, book_id=real_book_id,
                           extra_env={'HYPERLIT_PROJECT_ROOT': REPO_ROOT,
                                      'HYPERLIT_SOURCE_ROOT': os.path.abspath(book_dir)})
        if r is None or r.returncode != 0:
            print("Re-convert failed:", (r.stderr[-300:] if r else 'no source'))
            shutil.rmtree(outdir, ignore_errors=True)
            return 1
        for fn in ('main-text.md', 'main-text.html', 'intermediate.html', 'nodes.jsonl',
                   'footnotes.jsonl', 'references.json', 'audit.json', 'conversion_stats.json',
                   'assessment.json'):
            p = os.path.join(outdir, fn)
            if os.path.isfile(p):
                shutil.copy2(p, os.path.join(book_dir, fn))
        # Regenerate the ARRAY forms (nodes.json, footnotes.json) from the fresh .jsonl. The pipeline only
        # writes the .jsonl; the .json is normally produced by the Laravel import — but ConversionArtifactSaver
        # reads the .json. Without this, apply copied the converted .jsonl yet the saver persisted the STALE
        # .json → citations stayed unlinked (nodes.json) AND footnote definitions never reached the DB
        # (footnotes.json), so footnotes did nothing in the reader.
        _regenerate_json_array(outdir, book_dir, 'nodes')
        _regenerate_json_array(outdir, book_dir, 'footnotes')
        shutil.rmtree(outdir, ignore_errors=True)
        print("Applied — this book's artifacts regenerated from the patched conversion.")
        return 0
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

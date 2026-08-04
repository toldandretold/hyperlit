"""The OCR cache is GROUND TRUTH — the pipeline must never write ocr_response.json back.

Mistral's response is the source every conversion derives from; all transforms
(chunk renumbering included) happen on the in-memory copy, re-derived
deterministically each run from the cached `_chunk_boundaries` fetch provenance.
A previous version persisted the renumbered markdown over the cache "so re-runs
see the new IDs" — that permanently vandalised the source of truth (Sci-Hub
case: refs 1–129 rewritten to 321–449 on disk, unrecoverable without a pristine
copy from a fixture/bundle). This gate replays a fixture through the real
mistral_ocr entrypoint and byte-compares the cache before and after.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONV = os.path.abspath(os.path.join(_HERE, '..'))
_SCRIPT = os.path.abspath(os.path.join(_CONV, '..', '..', 'app', 'Python', 'mistral_ocr.py'))

# One fixture where the chunk-renumber pass RUNS (sequential/unknown class) —
# the class that historically triggered the write-back.
_FIXTURE = os.path.join(_CONV, 'fixtures', 'pdf', 'sequential', 'synthetic', 'ocr_response.json')


def _sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def test_pipeline_never_writes_ocr_response_back():
    assert os.path.isfile(_FIXTURE), f'fixture missing: {_FIXTURE}'
    tmp = tempfile.mkdtemp(prefix='ocr_immut_')
    try:
        cache = os.path.join(tmp, 'ocr_response.json')
        shutil.copy(_FIXTURE, cache)
        before = _sha(cache)

        env = dict(os.environ, PYTHONHASHSEED='0')
        r = subprocess.run([sys.executable, _SCRIPT, '/dev/null', tmp],
                           capture_output=True, text=True, timeout=300, env=env)
        assert r.returncode == 0, f'pipeline failed: {r.stderr[-400:]}'

        assert _sha(cache) == before, (
            'ocr_response.json was MODIFIED by the pipeline — the OCR cache is '
            'ground truth and must never be written back (transforms belong on '
            'the in-memory copy only)'
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

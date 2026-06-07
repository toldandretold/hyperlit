"""vibeConverter.runtime — zero-import leaf: shared constants, env helpers, and the loop MUTABLE run state.

emit()/_cancelled() read THIS module's own globals, so cli.configure() writing them here is seen by every importer. Imports only stdlib."""
import json
import os
import re
import re as _re
import sys
import subprocess

PY_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))  # = app/Python
REPO_ROOT = os.path.abspath(os.path.join(PY_DIR, '..', '..'))
if PY_DIR not in sys.path:
    sys.path.insert(0, PY_DIR)



# The diff may only touch these (relative to repo root). Anything else is rejected outright —
# the LLM cannot edit the harness, add new files, or reach deploy/secret config.
# An 'improved' result is rejected if MORE than this fraction of the newly-linked items are
# flagged misaligned by the audit — past it, the fix is mostly confident-wrong-links, which the
# modus operandi says is worse than leaving them unlinked.
MISALIGNED_REJECT_RATIO = 0.5



# Over-extraction guards (a bibliography "fix" that over-matches reads as 'improved' on raw ref count
# while actually producing junk). Both are FALSIFIABLE: a 100+-char reference key is provably not an
# author-year slug, and halving the in-text citations the converter even RECOGNISES is a detection regression.
MAX_SANE_REF_KEY = 100        # referenceId longer than this = concatenated garbage, not 'adornotheodor2003'


CITATION_COLLAPSE_RATIO = 0.5  # after.citations_total below this × baseline = citation DETECTION regressed



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




# The reorg moved the conversion code into ingestion/<format>/ + digestion/<stage>/ + shared/; allow the
# vibe loop to edit anything under those package roots (plus the legacy conversion/ during migration).
ALLOWED_PREFIXES = ('app/Python/conversion/', 'app/Python/ingestion/',
                    'app/Python/digestion/', 'app/Python/shared/')


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



# Per-engine model defaults. `--model` defaults to None so it cleanly overrides EITHER engine (a true
# all-else-equal LLM A/B); when unset each engine fills its own default. The native loop reasons in one
# pass (a heavy model earns its keep); aider runs its own ~3-reflection retry loop, so it wants a FAST one.
DEFAULT_DEEPSEEK_MODEL = 'accounts/fireworks/models/deepseek-v4-pro'




def _model_label(model):
    """Short display name of the ACTUAL model in use (e.g. 'deepseek-v4-pro', 'gpt-oss-120b'). The
    ENGINE ('native' / 'aider') is NOT a model — the native engine runs whatever `--model` it's given —
    so all user-facing progress must show the real model, never a hardcoded one."""
    return (model or DEFAULT_DEEPSEEK_MODEL).rsplit('/', 1)[-1]




def _prompt_variant():
    """Which prompt VARIANT to build: `full` (default) or `lean` (drops the fix-category menu, to A/B
    whether the self-describing pipeline tree makes the menu unnecessary). Set via env
    VIBE_PROMPT_VARIANT (the `--prompt-variant` CLI flag sets it); recorded into the report."""
    v = (os.environ.get('VIBE_PROMPT_VARIANT') or 'full').strip().lower()
    return v if v in ('full', 'lean') else 'full'



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


# When this file appears, the loop stops at the next attempt boundary AND APPLIES the best fix found so
# far (the mid-loop "Use this one" button) — distinct from cancel, which abandons. The loop docker-
# revalidates the chosen fix before applying.
_USE_NOW_FILE = None


# When set (--docker <image>), the RE-CONVERSION (which executes model-written code) runs inside
# a locked-down container instead of a host subprocess. The LLM call itself stays on the host.
_DOCKER_IMAGE = None




def _docker_cmd(image, ro_mounts, rw_mounts, run, env=None):
    """Wrap `run` (e.g. ['python', '/abs/script', '/abs/arg', …]) in a locked-down `docker run`:
    no network, no host env (so no secrets), read-only rootfs, unprivileged, resource-capped. Host
    dirs are bind-mounted at IDENTICAL paths, so the absolute paths in `run` need no translation.
    `env` is an optional {KEY: VALUE} of EXPLICIT, non-secret vars to pass in (e.g. the apply's
    HYPERLIT_PROJECT_ROOT so ImageProcessor can write to the mounted live storage)."""
    cmd = ['docker', 'run', '--rm', '--network', 'none', '--read-only',
           '--tmpfs', '/tmp:exec', '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
           '--security-opt', 'no-new-privileges',
           '-e', 'PYTHONHASHSEED=0', '-e', 'PYTHONDONTWRITEBYTECODE=1']
    for _k, _v in (env or {}).items():
        cmd += ['-e', f'{_k}={_v}']
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


def _use_now():
    """True once the reader hit "Use this one" — apply the best fix found so far (see _USE_NOW_FILE)."""
    return bool(_USE_NOW_FILE) and os.path.exists(_USE_NOW_FILE)




# ---------------------------------------------------------------------------
# 3. Get a candidate diff (mock file, or a real Fireworks API call)
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


def configure(progress_file=None, cancel_file=None, json_progress=False, docker=None, use_now_file=None):
    """Set the CLI-controlled run state in ONE place (replaces the old cross-module mirror
    hack). emit()/_cancelled()/_use_now()/_pipeline_into read these via THIS module, so every
    importer sees the same values."""
    global _PROGRESS_FILE, _CANCEL_FILE, _JSON_PROGRESS, _DOCKER_IMAGE, _USE_NOW_FILE
    _PROGRESS_FILE = progress_file
    _CANCEL_FILE = cancel_file
    _JSON_PROGRESS = json_progress
    _DOCKER_IMAGE = docker
    _USE_NOW_FILE = use_now_file

"""vibeConverter.propose — get a candidate patch from the LLM."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.runtime import (_USAGE, _dotenv)




def _parse_llm_json(content):
    """Reasoning models (e.g. DeepSeek V4 Pro) may wrap output in <think> reasoning and/or ```json
    fences. Strip those and extract the {rationale, functions} object."""
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

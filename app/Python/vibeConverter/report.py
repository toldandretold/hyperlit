"""vibeConverter.report — persist the winning patch, finalise the run report, file a GitHub issue."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.artifacts import (_stat_summary)
from vibeConverter.diagnosis import (flagged_forks)
from vibeConverter.runtime import (REPO_ROOT, _dotenv, _prompt_variant, usage_summary)




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
        'engine': 'native',  # the native (full-function-JSON) engine; the aider engine overwrites this
        'prompt_variant': _prompt_variant(),  # full | lean — which prompt content was sent (for A/B)
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
        "The model reasoned about the failure and tried the following — each was validated by "
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

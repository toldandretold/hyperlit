#!/usr/bin/env python3
"""GROBID adoption trial: baseline (regex) vs GROBID_ALWAYS across every PDF-bearing book.
Verdict data: if regex ≈ GROBID on real books, GROBID isn't worth hosting."""
import json, os, re, shutil, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
S = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(S, 'trial')
GROBID = 'http://localhost:8070'

FIX = os.path.join(ROOT, 'tests/conversion/fixtures')
FIXL = os.path.join(ROOT, 'tests/conversion/fixtures-local')
RM = os.path.join(ROOT, 'resources/markdown')

BOOKS = [
    # (label, ocr_dir, pdf_path)
    ('433d423b aut-yr', f'{FIXL}/pdf/author_year_bracket/433d423b-9a1c-487a-ba86-39657bf34509', None),
    ('78516d0d aut-yr', f'{FIXL}/pdf/author_year_bracket/78516d0d-be54-4aa3-abbb-26b69e9d6433', None),
    ('128ad69a aut-yr', f'{FIXL}/pdf/author_year_bracket/128ad69a-b2a5-471e-84bd-2037e02b3791', None),
    ('native-engine', f'{FIX}/pdf/sequential/native-engine', None),
    ('bedjaoui', f'{FIXL}/pdf/sequential/bedjaoui0000towards', None),
    ('79394f2a', f'{FIXL}/pdf/sequential/79394f2a-f063-46fa-a140-76ef22c650af', None),
    ('1ee13ed9 legal', f'{FIXL}/pdf/sequential/1ee13ed9-49e7-4c42-aefd-ce04107064a1', None),
    ('9045b32e', f'{FIXL}/pdf/sequential/9045b32e-33f4-4793-92d2-0e3efb7e31c4', None),
    ('013dfc18', f'{FIXL}/pdf/sequential/013dfc18-cfc5-4eb1-b79a-b3886fbc544d', None),
    ('d4c0b31e', f'{FIXL}/pdf/sequential/d4c0b31e-3c47-4abc-8e2a-d24851bfda1e', None),
    ('1abb31d5', f'{FIXL}/pdf/sequential/1abb31d5-9f74-4451-80c8-aea19c135b1a', None),
    ('514e27a5', f'{FIXL}/pdf/sequential/514e27a5-4028-4599-9ac4-5c88ba1d25db', None),
    ('1313c1a2 pulled', f'{FIX}/1313c1a2-de77-4fa8-9f77-6c44e8ae7e83', f'{RM}/1313c1a2-de77-4fa8-9f77-6c44e8ae7e83/original.pdf'),
    ('93d34a74 GLUED', f'{FIXL}/93d34a74-72b3-4ec1-8f0b-7f9e9bac0add', f'{RM}/93d34a74-72b3-4ec1-8f0b-7f9e9bac0add/original.pdf'),
    ('21696c70 pulled', f'{FIXL}/21696c70-8d66-4e97-b627-15ea2724c107', f'{RM}/21696c70-8d66-4e97-b627-15ea2724c107/original.pdf'),
    ('ad752a46 pulled', f'{FIXL}/ad752a46-1245-4773-886d-47fa1bac0496', f'{RM}/ad752a46-1245-4773-886d-47fa1bac0496/original.pdf'),
    ('304249a7 pulled', f'{FIXL}/304249a7-c7bd-4c5b-ba51-8e9c8d364edc', f'{RM}/304249a7-c7bd-4c5b-ba51-8e9c8d364edc/original.pdf'),
]

YEAR_RE = re.compile(r'\((?:19|20)\d{2}[a-z]?\)')

def run(cmd, cwd=ROOT, env=None, timeout=1800):
    e = dict(os.environ); e['PYTHONHASHSEED'] = '0'
    e.pop('GROBID_URL', None); e.pop('GROBID_ALWAYS', None)
    if env: e.update(env)
    return subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True, timeout=timeout)

def metrics(d, stdout):
    out = {'linked': None, 'total': None, 'refs': None, 'glued': None, 'method': 'regex'}
    try:
        s = json.load(open(f'{d}/conversion_stats.json'))
        out['linked'] = s.get('citations_linked'); out['total'] = s.get('citations_total')
        out['refs'] = s.get('references_found')
    except Exception: pass
    try:
        refs = json.load(open(f'{d}/references.json'))
        out['refs'] = len(refs)
        out['glued'] = sum(1 for e in refs
                           if len(YEAR_RE.findall(re.sub('<[^>]+>', '', e.get('content', '')))) > 1)
    except Exception: pass
    if 'via grobid' in stdout or 'GROBID bibliography:' in stdout:
        out['method'] = 'grobid'
    elif '⚠️ GROBID' in stdout:
        out['method'] = 'fallback'
    return out

def one_book(label, ocr_dir, pdf_path):
    base = os.path.join(WORK, re.sub(r'\W+', '_', label))
    shutil.rmtree(base, ignore_errors=True)
    prep = os.path.join(base, 'prep'); os.makedirs(prep)
    shutil.copy2(f'{ocr_dir}/ocr_response.json', prep)
    r = run([sys.executable, 'app/Python/mistral_ocr.py', '/dev/null', prep])
    if r.returncode != 0 or not os.path.isfile(f'{prep}/main-text.md'):
        return {'label': label, 'error': 'ocr replay failed'}
    run([sys.executable, 'app/Python/simple_md_to_html.py', f'{prep}/main-text.md', f'{prep}/intermediate.html'])

    pdf = pdf_path or (f'{ocr_dir}/source.pdf' if os.path.isfile(f'{ocr_dir}/source.pdf') else None)
    row = {'label': label}
    for mode in ('baseline', 'grobid'):
        d = os.path.join(base, mode); os.makedirs(d)
        for f in ('ocr_response.json', 'main-text.md', 'intermediate.html'):
            shutil.copy2(f'{prep}/{f}', d)
        env = {}
        if mode == 'grobid':
            if not pdf: row['grobid'] = {'method': 'no-pdf'}; continue
            shutil.copy2(pdf, f'{d}/source.pdf')
            env = {'GROBID_URL': GROBID, 'GROBID_ALWAYS': '1',
                   'GROBID_TOTAL_DEADLINE': '900', 'GROBID_REQUEST_TIMEOUT': '300'}
        t0 = time.time()
        r = run([sys.executable, 'app/Python/process_document.py', f'{d}/intermediate.html', d, 'trial'], env=env)
        m = metrics(d, r.stdout)
        m['secs'] = round(time.time() - t0, 1)
        row[mode] = m
    return row

os.makedirs(WORK, exist_ok=True)
results = []
for label, ocr_dir, pdf in BOOKS:
    print(f'── {label}', flush=True)
    try:
        row = one_book(label, ocr_dir, pdf)
    except Exception as e:
        row = {'label': label, 'error': f'{e.__class__.__name__}: {e}'}
    results.append(row)
    b, g = row.get('baseline', {}), row.get('grobid', {})
    print(f"   base : linked {b.get('linked')}/{b.get('total')} refs {b.get('refs')} glued {b.get('glued')} ({b.get('secs')}s)", flush=True)
    print(f"   grobid[{g.get('method')}]: linked {g.get('linked')}/{g.get('total')} refs {g.get('refs')} glued {g.get('glued')} ({g.get('secs')}s)", flush=True)

json.dump(results, open(os.path.join(S, 'grobid_trial_results.json'), 'w'), indent=2)
print('\nTRIAL COMPLETE → grobid_trial_results.json')

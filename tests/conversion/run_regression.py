#!/usr/bin/env python3
"""
Conversion Pipeline Regression Tests

Runs each fixture through its REAL conversion chain (selected by which input file
the fixture contains) and compares outputs to golden files + manifest expectations.

Pipelines (auto-detected per fixture by input file present):
    ocr_response.json   -> pdf   : mistral_ocr.py(cache) -> simple_md_to_html.py -> process_document.py
    epub_original/ |.epub-> epub  : epub_normalizer.py -> process_document.py(main-text.html)
    input.docx          -> docx  : strip_docx_metadata.py -> pandoc -> process_document.py
    input.md            -> md    : simple_md_to_html.py -> process_document.py
    input.html          -> html  : [ar5iv_preprocessor.py] -> process_document.py

The PDF path replays the CACHED ocr_response.json — it never re-OCRs a PDF and makes
no API call, so iterating on process_document.py logic is instant.

Fixtures live under fixtures/<filetype>/<pathway>/<case>/ ; the folder tree is the
coverage map. `--coverage` reports which registered pathways have no test.

Determinism: subprocesses run with PYTHONHASHSEED=0 (stabilises reference dedup), and
the random "Fn<ts>_<rand>" footnote ids are normalised to stable FN0001.. tokens in
first-appearance order before any golden comparison (so goldens diff cleanly AND the
ordering itself is asserted).

Usage:
    python3 tests/conversion/run_regression.py
    python3 tests/conversion/run_regression.py --fixture anchor_heading
    python3 tests/conversion/run_regression.py --coverage
    python3 tests/conversion/run_regression.py --update-golden [--fixture X]
    python3 tests/conversion/run_regression.py --verbose | --json
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.join(SCRIPT_DIR, 'fixtures')
# Optional, git-ignored tree of real-content fixtures kept for richer LOCAL testing
# (proprietary books we can't host on a public repo). Discovered if present.
FIXTURES_LOCAL_DIR = os.path.join(SCRIPT_DIR, 'fixtures-local')
PATHWAYS_JSON = os.path.join(SCRIPT_DIR, 'pathways.json')
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
PY_DIR = os.path.join(PROJECT_ROOT, 'app', 'Python')
PROCESS_SCRIPT = os.path.join(PY_DIR, 'process_document.py')
MISTRAL_OCR_SCRIPT = os.path.join(PY_DIR, 'mistral_ocr.py')
MD_TO_HTML_SCRIPT = os.path.join(PY_DIR, 'simple_md_to_html.py')
EPUB_NORMALIZER_SCRIPT = os.path.join(PY_DIR, 'epub_normalizer.py')
AR5IV_SCRIPT = os.path.join(PY_DIR, 'ar5iv_preprocessor.py')
STRIP_DOCX_SCRIPT = os.path.join(PY_DIR, 'strip_docx_metadata.py')

# Exact flags the Swift PandocConversionJob uses (keep in sync).
PANDOC_BASE_FLAGS = ['--track-changes=accept']

# Matches the generated footnote ids: Fn<digits> optionally _<alnum> (and seq/s prefixes).
GENERATED_ID_RE = re.compile(r'(?:s(?:eq)?\d+_)?Fn\d+(?:_[A-Za-z0-9]+)?')

# Normalised golden artifacts that get byte-compared.
GOLDEN_FILES = ['footnotes.normalized.jsonl', 'nodes.summary.json', 'references.json']


# ---------------------------------------------------------------------------
# Subprocess helper (always with PYTHONHASHSEED=0)
# ---------------------------------------------------------------------------

def _run(cmd, timeout=300):
    env = dict(os.environ)
    env['PYTHONHASHSEED'] = '0'
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def _err(stage, result):
    return {'stage': stage, 'returncode': result.returncode,
            'stderr': (result.stderr or '')[-500:], 'stdout': (result.stdout or '')[-500:]}


# ---------------------------------------------------------------------------
# Fixture discovery
# ---------------------------------------------------------------------------

def _detect_pipeline(case_dir):
    """Select the pipeline by which input file the fixture contains."""
    if os.path.isfile(os.path.join(case_dir, 'ocr_response.json')):
        return 'pdf'
    if os.path.isfile(os.path.join(case_dir, 'input.epub')) or os.path.isdir(os.path.join(case_dir, 'epub_original')):
        return 'epub'
    if os.path.isfile(os.path.join(case_dir, 'input.docx')):
        return 'docx'
    if os.path.isfile(os.path.join(case_dir, 'input.md')):
        return 'md'
    if os.path.isfile(os.path.join(case_dir, 'input.html')):
        return 'html'
    return 'none'


def discover_fixtures(filter_name=None):
    """Recursively find every dir containing a manifest.json. The fixture `name`
    is its path relative to fixtures/ (e.g. 'epub/anchor_heading/eric2001the')."""
    fixtures = []
    for base in (FIXTURES_DIR, FIXTURES_LOCAL_DIR):
        if not os.path.isdir(base):
            continue
        local = base == FIXTURES_LOCAL_DIR
        for root, dirs, files in os.walk(base):
            if 'manifest.json' not in files:
                continue
            dirs[:] = []  # a fixture is a leaf; don't descend into golden/ or epub_original/
            name = os.path.relpath(root, base)
            if filter_name and filter_name not in name:
                continue
            with open(os.path.join(root, 'manifest.json')) as f:
                manifest = json.load(f)
            fixtures.append({
                'name': name + (' [local]' if local else ''),
                'dir': root,
                'manifest': manifest,
                'pipeline': _detect_pipeline(root),
            })
    fixtures.sort(key=lambda x: x['name'])
    return fixtures


# ---------------------------------------------------------------------------
# Pipeline runners (return None on success, an error dict on failure, or
# the string 'skipped' when a tool is unavailable)
# ---------------------------------------------------------------------------

def run_pdf_pipeline(fixture, tmp_dir):
    """Replay cached OCR: ocr_response.json -> md -> html -> process_document."""
    book_id = fixture['manifest'].get('book_id', fixture['name'])
    shutil.copy2(os.path.join(fixture['dir'], 'ocr_response.json'),
                 os.path.join(tmp_dir, 'ocr_response.json'))

    r = _run([sys.executable, MISTRAL_OCR_SCRIPT, '/dev/null', tmp_dir])
    if r.returncode != 0:
        return _err('mistral_ocr', r)

    md_path = os.path.join(tmp_dir, 'main-text.md')
    html_path = os.path.join(tmp_dir, 'intermediate.html')
    if not os.path.isfile(md_path):
        return {'stage': 'mistral_ocr', 'returncode': -1, 'stderr': 'main-text.md not produced', 'stdout': ''}

    r = _run([sys.executable, MD_TO_HTML_SCRIPT, md_path, html_path])
    if r.returncode != 0:
        return _err('md_to_html', r)
    if not os.path.isfile(html_path):
        return {'stage': 'md_to_html', 'returncode': -1, 'stderr': 'intermediate.html not produced', 'stdout': ''}

    r = _run([sys.executable, PROCESS_SCRIPT, html_path, tmp_dir, book_id])
    if r.returncode != 0:
        return _err('process_document', r)
    return None


def run_html_pipeline(fixture, tmp_dir):
    """input.html -> [ar5iv_preprocessor] -> process_document."""
    book_id = fixture['manifest'].get('book_id', fixture['name'])

    fn_meta = os.path.join(fixture['dir'], 'footnote_meta.json')
    if os.path.isfile(fn_meta):
        shutil.copy2(fn_meta, os.path.join(tmp_dir, 'footnote_meta.json'))

    src_html = os.path.join(fixture['dir'], 'input.html')
    if fixture['manifest'].get('preprocessor') == 'ar5iv':
        work = os.path.join(tmp_dir, 'input.html')
        shutil.copy2(src_html, work)
        r = _run([sys.executable, AR5IV_SCRIPT, work, tmp_dir])
        if r.returncode != 0:
            return _err('ar5iv', r)
        src_html = work

    r = _run([sys.executable, PROCESS_SCRIPT, src_html, tmp_dir, book_id])
    if r.returncode != 0:
        return _err('process_document', r)
    return None


def run_md_pipeline(fixture, tmp_dir):
    """input.md -> simple_md_to_html -> process_document."""
    book_id = fixture['manifest'].get('book_id', fixture['name'])
    md_path = os.path.join(fixture['dir'], 'input.md')
    html_path = os.path.join(tmp_dir, 'intermediate.html')

    r = _run([sys.executable, MD_TO_HTML_SCRIPT, md_path, html_path])
    if r.returncode != 0:
        return _err('md_to_html', r)
    if not os.path.isfile(html_path):
        return {'stage': 'md_to_html', 'returncode': -1, 'stderr': 'intermediate.html not produced', 'stdout': ''}

    r = _run([sys.executable, PROCESS_SCRIPT, html_path, tmp_dir, book_id])
    if r.returncode != 0:
        return _err('process_document', r)
    return None


def run_epub_pipeline(fixture, tmp_dir):
    """epub_original/ (or input.epub) -> epub_normalizer -> process_document(main-text.html)."""
    book_id = fixture['manifest'].get('book_id', fixture['name'])
    epub_dir = os.path.join(fixture['dir'], 'epub_original')
    epub_input = epub_dir if os.path.isdir(epub_dir) else os.path.join(fixture['dir'], 'input.epub')

    r = _run([sys.executable, EPUB_NORMALIZER_SCRIPT, epub_input, tmp_dir, book_id])
    if r.returncode != 0:
        return _err('epub_normalizer', r)

    main_html = os.path.join(tmp_dir, 'main-text.html')
    if not os.path.isfile(main_html):
        return {'stage': 'epub_normalizer', 'returncode': -1, 'stderr': 'main-text.html not produced', 'stdout': ''}

    r = _run([sys.executable, PROCESS_SCRIPT, main_html, tmp_dir, book_id])
    if r.returncode != 0:
        return _err('process_document', r)
    return None


def run_docx_pipeline(fixture, tmp_dir):
    """input.docx -> strip_docx_metadata -> pandoc -> process_document. Skips if no pandoc."""
    if not shutil.which('pandoc'):
        return 'skipped'
    book_id = fixture['manifest'].get('book_id', fixture['name'])
    work_docx = os.path.join(tmp_dir, 'input.docx')
    shutil.copy2(os.path.join(fixture['dir'], 'input.docx'), work_docx)

    _run([sys.executable, STRIP_DOCX_SCRIPT, work_docx], timeout=60)  # non-fatal

    html_path = os.path.join(tmp_dir, 'intermediate.html')
    media = os.path.join(tmp_dir, 'media')
    r = _run(['pandoc', work_docx, '-o', html_path, *PANDOC_BASE_FLAGS, f'--extract-media={media}'])
    if r.returncode != 0:
        return _err('pandoc', r)

    r = _run([sys.executable, PROCESS_SCRIPT, html_path, tmp_dir, book_id])
    if r.returncode != 0:
        return _err('process_document', r)
    return None


RUNNERS = {
    'pdf': run_pdf_pipeline,
    'html': run_html_pipeline,
    'md': run_md_pipeline,
    'epub': run_epub_pipeline,
    'docx': run_docx_pipeline,
}


# ---------------------------------------------------------------------------
# Determinism: id normalization
# ---------------------------------------------------------------------------

def _read_jsonl(path):
    rows = []
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    return rows


def normalize_outputs(tmp_dir):
    """Remap random Fn ids to stable FN0001.. tokens in first-appearance (document)
    order and emit footnotes.normalized.jsonl + nodes.summary.json. Returns id_map.

    First-appearance order is deterministic (only the id *string* is random, not the
    sequence), so the remap doubles as an ordering assertion: if footnotes ever emit
    in a different order, the golden diff fails."""
    nodes = _read_jsonl(os.path.join(tmp_dir, 'nodes.jsonl'))
    footnotes = _read_jsonl(os.path.join(tmp_dir, 'footnotes.jsonl'))

    id_map = {}

    def assign(real):
        if real and real not in id_map:
            id_map[real] = f'FN{len(id_map) + 1:04d}'

    # 1) in-text references in document order, 2) any remaining definition ids.
    for node in nodes:
        for fn in (node.get('footnotes') or []):
            if isinstance(fn, dict):
                assign(fn.get('id'))
    for fn in footnotes:
        assign(fn.get('footnoteId'))

    def remap(text):
        if not isinstance(text, str):
            return text
        return GENERATED_ID_RE.sub(lambda m: id_map.get(m.group(0), m.group(0)), text)

    norm_footnotes = [{
        'footnoteId': id_map.get(fn.get('footnoteId'), fn.get('footnoteId')),
        'content': remap(fn.get('content', '')),
    } for fn in footnotes]

    type_hist = {}
    linked_nodes = []
    for i, node in enumerate(nodes):
        ntype = node.get('type', '?')
        type_hist[ntype] = type_hist.get(ntype, 0) + 1
        node_fns = node.get('footnotes') or []
        node_refs = node.get('references') or []
        if node_fns or node_refs:
            linked_nodes.append({
                'i': node.get('startLine', i),
                'type': ntype,
                'footnotes': [{'id': id_map.get(f.get('id'), f.get('id')), 'marker': f.get('marker')}
                              for f in node_fns if isinstance(f, dict)],
                'references': node_refs,
            })

    summary = {
        'node_count': len(nodes),
        'type_histogram': dict(sorted(type_hist.items())),
        'linked_nodes': linked_nodes,
    }

    with open(os.path.join(tmp_dir, 'footnotes.normalized.jsonl'), 'w', encoding='utf-8') as f:
        for fn in norm_footnotes:
            f.write(json.dumps(fn, ensure_ascii=False, sort_keys=True) + '\n')
    with open(os.path.join(tmp_dir, 'nodes.summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2, sort_keys=True)
    return id_map


# ---------------------------------------------------------------------------
# Comparators. Each returns (passed, message) or None when not applicable
# (manifest key absent) so existing fixtures stay green.
# ---------------------------------------------------------------------------

def compare_stats(fixture, tmp_dir):
    stats_path = os.path.join(tmp_dir, 'conversion_stats.json')
    expected = fixture['manifest'].get('expected', {})
    if not os.path.isfile(stats_path):
        return False, 'conversion_stats.json not produced'
    stats = json.load(open(stats_path))
    failures = []
    for expected_key, stats_key in [
        ('references_count', 'references_found'),
        ('citations_linked', 'citations_linked'),
        ('citations_total', 'citations_total'),
        ('footnotes_count', 'footnotes_matched'),
    ]:
        if expected_key in expected and stats.get(stats_key) != expected[expected_key]:
            failures.append(f'{expected_key}: expected {expected[expected_key]}, got {stats.get(stats_key)}')
    if failures:
        return False, '; '.join(failures)
    return True, 'all counts match'


def compare_reference_count(fixture, tmp_dir):
    expected = fixture['manifest'].get('expected', {})
    if 'references_count' not in expected:
        return None
    path = os.path.join(tmp_dir, 'references.json')
    if not os.path.isfile(path):
        return False, 'references.json not produced'
    actual = len(json.load(open(path)))
    if actual == expected['references_count']:
        return True, f'{actual} entries'
    return False, f'expected {expected["references_count"]}, got {actual}'


def compare_audit(fixture, tmp_dir):
    expected = fixture['manifest'].get('expected', {})
    if 'audit_gaps' not in expected:
        return None
    path = os.path.join(tmp_dir, 'audit.json')
    if not os.path.isfile(path):
        return False, 'audit.json not produced'
    gaps = len(json.load(open(path)).get('gaps', []))
    if gaps == expected['audit_gaps']:
        return True, f'{gaps} gaps'
    return False, f'expected {expected["audit_gaps"]} gaps, got {gaps}'


def compare_orphans(fixture, tmp_dir):
    """Semantic correctness gate: footnote definitions left with NO in-text link (audit.unmatched_defs).
    A golden suite only freezes whatever the converter emits, so it happily certifies a conversion
    that DETECTS notes but never LINKS them (the nested-noteref duplication bug hid 238 orphans behind
    green tests). This asserts the real thing. Default ceiling 0; a fixture with a known, accepted
    residual declares `expected.max_unmatched_defs` (documented + visible, never silent)."""
    path = os.path.join(tmp_dir, 'audit.json')
    if not os.path.isfile(path):
        return None
    ceiling = fixture['manifest'].get('expected', {}).get('max_unmatched_defs', 0)
    n = len(json.load(open(path)).get('unmatched_defs', []))
    if n <= ceiling:
        return True, f'{n} orphaned def(s)' + (f' (<= {ceiling} allowed)' if ceiling else '')
    return False, (f'{n} footnote definition(s) have NO in-text link (orphaned), max allowed '
                   f'{ceiling} — detection succeeded but linking dropped them')


def compare_strategy(fixture, tmp_dir):
    expected = fixture['manifest'].get('expected', {})
    want_strat = expected.get('footnote_strategy')
    want_style = expected.get('citation_style')
    if not want_strat and not want_style:
        return None
    path = os.path.join(tmp_dir, 'conversion_stats.json')
    if not os.path.isfile(path):
        return False, 'conversion_stats.json not produced'
    stats = json.load(open(path))
    failures = []
    if want_strat and stats.get('footnote_strategy') != want_strat:
        failures.append(f'strategy: expected {want_strat}, got {stats.get("footnote_strategy")}')
    if want_style and stats.get('citation_style') != want_style:
        failures.append(f'citation_style: expected {want_style}, got {stats.get("citation_style")}')
    if failures:
        return False, '; '.join(failures)
    return True, 'strategy/style match'


def compare_footnote_links(fixture, tmp_dir):
    """The headline check: verify SPECIFIC marker -> definition pairings, or suppression.
    Robust to random ids (uses normalized footnotes + nodes.summary)."""
    expected = fixture['manifest'].get('expected', {})
    links = expected.get('footnote_links')
    suppressed = expected.get('suppressed_footnotes')
    if not links and not suppressed:
        return None

    summary_path = os.path.join(tmp_dir, 'nodes.summary.json')
    if not os.path.isfile(summary_path):
        return False, 'nodes.summary.json not produced'
    summary = json.load(open(summary_path))

    marker_ids = {}
    total_links = 0
    for node in summary.get('linked_nodes', []):
        for fn in node.get('footnotes', []):
            total_links += 1
            marker_ids.setdefault(str(fn.get('marker')), []).append(fn.get('id'))

    if suppressed:
        if total_links == 0:
            return True, 'footnotes suppressed (0 in-text links), as expected'
        return False, f'expected suppression but found {total_links} in-text footnote links'

    # Normalise note content to plain text (strip tags, collapse whitespace) so a
    # content_contains substring matches even when it spans inline markup like <i>.
    def _plain(s):
        return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s or '')).strip()

    content = {}
    for fn in _read_jsonl(os.path.join(tmp_dir, 'footnotes.normalized.jsonl')):
        content[fn['footnoteId']] = _plain(fn['content'])

    failures = []
    for exp in links:
        marker = str(exp['marker'])
        want = exp['content_contains']
        ids = marker_ids.get(marker, [])
        if not ids:
            failures.append(f'marker {marker!r}: no in-text link found')
            continue
        if not any(want in content.get(i, '') for i in ids):
            got = (content.get(ids[0], '') or '')[:60]
            failures.append(f'marker {marker!r}: want note containing {want!r}, got {got!r}...')
    if failures:
        return False, '; '.join(failures)
    return True, f'{len(links)} footnote link(s) correct'


def detectors_that_fired(debug_text):
    """Names of epub_normalizer footnote detectors that actually FOUND something.
    A detector's section in epub_normalizer_debug.txt is bracketed [Name]; it fired
    if its section logs a 'Found footnote/endnote' line or a non-zero Total. (Just
    running — e.g. HeuristicFootnoteDetector always does — does not count.)"""
    fired = []
    marks = list(re.finditer(r'^\[([A-Za-z0-9_]+Detector)\]', debug_text, re.M))
    for i, m in enumerate(marks):
        section = debug_text[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(debug_text))]
        if re.search(r'Found (?:footnote|endnote)', section) or re.search(r'Total:\s*[1-9]', section):
            fired.append(m.group(1))
    return fired


def compare_detectors(fixture, tmp_dir):
    """EPUB only: assert the expected epub_normalizer detector(s) actually fired."""
    want = fixture['manifest'].get('expected', {}).get('detectors_fired')
    if not want:
        return None
    dbg = os.path.join(tmp_dir, 'epub_normalizer_debug.txt')
    if not os.path.isfile(dbg):
        return False, 'epub_normalizer_debug.txt not produced (not an epub run?)'
    fired = set(detectors_that_fired(open(dbg, encoding='utf-8', errors='replace').read()))
    missing = [d for d in want if d not in fired]
    if missing:
        return False, f'detectors not fired: {missing} (fired: {sorted(fired)})'
    return True, f'{len(want)} detector(s) fired'


def compare_golden_files(fixture, tmp_dir):
    """Byte-compare normalized artifacts against committed goldens (catch-all).
    No-op until a fixture has been migrated to the new model (signalled by the
    presence of golden/nodes.summary.json), so legacy fixtures stay green."""
    golden_dir = os.path.join(fixture['dir'], 'golden')
    if not os.path.isfile(os.path.join(golden_dir, 'nodes.summary.json')):
        return None
    failures = []
    any_golden = False
    for fname in GOLDEN_FILES:
        gpath = os.path.join(golden_dir, fname)
        if not os.path.isfile(gpath):
            continue
        any_golden = True
        apath = os.path.join(tmp_dir, fname)
        if not os.path.isfile(apath):
            failures.append(f'{fname}: not produced')
            continue
        if open(gpath, encoding='utf-8').read() != open(apath, encoding='utf-8').read():
            failures.append(f'{fname}: differs from golden')
    if not any_golden:
        return None
    if failures:
        return False, '; '.join(failures)
    return True, 'golden files match'


COMPARATORS = [
    ('stats', compare_stats),
    ('references', compare_reference_count),
    ('audit', compare_audit),
    ('orphans', compare_orphans),
    ('strategy', compare_strategy),
    ('footnote_links', compare_footnote_links),
    ('detectors', compare_detectors),
    ('golden', compare_golden_files),
]


def write_goldens(fixture, tmp_dir):
    """Copy normalized artifacts into the fixture's golden/ dir (--update-golden)."""
    golden_dir = os.path.join(fixture['dir'], 'golden')
    os.makedirs(golden_dir, exist_ok=True)
    written = []
    for fname in GOLDEN_FILES:
        src = os.path.join(tmp_dir, fname)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(golden_dir, fname))
            written.append(fname)
    return written


# ---------------------------------------------------------------------------
# Run a fixture
# ---------------------------------------------------------------------------

def run_fixture(fixture, verbose=False, update_golden=False):
    """Returns (status, results, pipeline) where status is 'pass'|'fail'|'skip'."""
    results = []
    pipeline = fixture['pipeline']
    runner = RUNNERS.get(pipeline)

    if runner is None:
        return 'fail', [('pipeline', False, 'no recognised input file (ocr_response.json / input.{html,md,docx,epub} / epub_original/)')], pipeline

    with tempfile.TemporaryDirectory(prefix=f'conv_test_{fixture["name"].replace(os.sep, "_")}_') as tmp_dir:
        error = runner(fixture, tmp_dir)

        if error == 'skipped':
            return 'skip', [('pipeline', True, f'{pipeline}: tool unavailable (pandoc) — skipped')], pipeline

        if error:
            results.append(('pipeline', False,
                            f'{error["stage"]} failed (exit {error["returncode"]}): {error.get("stderr", "")[:200]}'))
            if verbose and error.get('stdout'):
                results.append(('stdout', False, error['stdout'][-300:]))
            return 'fail', results, pipeline

        normalize_outputs(tmp_dir)

        if update_golden:
            written = write_goldens(fixture, tmp_dir)
            return 'pass', [('golden', True, f'wrote {", ".join(written)}')], pipeline

        all_passed = True
        for label, fn in COMPARATORS:
            outcome = fn(fixture, tmp_dir)
            if outcome is None:
                continue
            passed, msg = outcome
            results.append((label, passed, msg))
            if not passed:
                all_passed = False

    return ('pass' if all_passed else 'fail'), results, pipeline


# ---------------------------------------------------------------------------
# Coverage report
# ---------------------------------------------------------------------------

def cmd_coverage():
    if not os.path.isfile(PATHWAYS_JSON):
        print(f'No pathway registry at {PATHWAYS_JSON}')
        return 1
    registry = json.load(open(PATHWAYS_JSON))
    expected = registry.get('pathways', [])

    have = {}
    for fx in discover_fixtures():
        parts = fx['name'].split(os.sep)
        key = '/'.join(parts[:2]) if len(parts) >= 2 else parts[0]
        have.setdefault(key, []).append(fx['name'])

    print()
    print('Conversion Pathway Coverage')
    print('=' * 40)
    covered = [p for p in expected if p in have]
    missing = [p for p in expected if p not in have]
    for p in expected:
        if p in have:
            print(f'  [x] {p}  ({len(have[p])} case{"s" if len(have[p]) != 1 else ""})')
        else:
            print(f'  [ ] {p}  -- NO TEST FILE')
    extra = sorted(k for k in have if k not in expected)
    for p in extra:
        print(f'  [?] {p}  (not in registry)')
    print()
    print('=' * 40)
    print(f'{len(covered)}/{len(expected)} registered pathways covered'
          + (f'; {len(missing)} missing' if missing else ''))
    return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Run conversion pipeline regression tests')
    parser.add_argument('--fixture', help='Run only fixtures whose path contains this substring')
    parser.add_argument('--verbose', '-v', action='store_true', help='Show detailed output')
    parser.add_argument('--json', action='store_true', help='Output results as JSON')
    parser.add_argument('--coverage', action='store_true', help='Report pathway coverage and exit')
    parser.add_argument('--update-golden', action='store_true', help='Regenerate golden files instead of comparing')
    args = parser.parse_args()

    if args.coverage:
        sys.exit(cmd_coverage())

    fixtures = discover_fixtures(args.fixture)
    if not fixtures:
        if args.json:
            print(json.dumps({'error': 'No fixtures found', 'fixtures': []}))
        else:
            print('No fixtures found.')
        sys.exit(1)

    json_results = []
    if not args.json:
        print()
        print('Conversion Pipeline Regression Tests' + (' (updating goldens)' if args.update_golden else ''))
        print('=' * 40)

    n_pass = n_fail = n_skip = 0
    for fixture in fixtures:
        manifest = fixture['manifest']
        style = manifest.get('citation_style', '?')
        strategy = manifest.get('footnote_strategy', '?')

        status, results, pipeline = run_fixture(fixture, verbose=args.verbose, update_golden=args.update_golden)

        if args.json:
            json_results.append({
                'name': fixture['name'], 'pipeline': pipeline, 'status': status,
                'citation_style': style, 'footnote_strategy': strategy,
                'checks': [{'name': n, 'passed': p, 'message': m} for n, p, m in results],
            })
        else:
            print(f'\n{fixture["name"]} ({style}, {strategy}) [{pipeline}]')
            for check_name, passed, msg in results:
                mark = 'PASS' if passed else 'FAIL'
                if status == 'skip':
                    mark = 'SKIP'
                print(f'  {check_name} {"." * max(1, 16 - len(check_name))} {mark} ({msg})')

        n_pass += status == 'pass'
        n_fail += status == 'fail'
        n_skip += status == 'skip'

    if args.json:
        print(json.dumps({'total': len(fixtures), 'passed': n_pass, 'failed': n_fail,
                          'skipped': n_skip, 'fixtures': json_results}, indent=2))
    else:
        print()
        print('=' * 40)
        tail = f'{n_pass} passed, {n_fail} failed' + (f', {n_skip} skipped' if n_skip else '')
        print(('ALL PASS — ' if n_fail == 0 else '') + tail + f' ({len(fixtures)} total)')

    sys.exit(1 if n_fail > 0 else 0)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Conversion Pipeline Regression Tests

Runs the full conversion pipeline (or partial) against each fixture
and compares outputs to expected values in the manifest.

Full pipeline (fixture has ocr_response.json):
    ocr_response.json → mistral_ocr.py → main-text.md
    → simple_md_to_html.py → HTML → process_document.py → compare

HTML-only (fixture has input.html but no ocr_response.json):
    input.html → process_document.py → compare

Usage:
    python3 tests/conversion/run_regression.py
    python3 tests/conversion/run_regression.py --fixture peerreview2027
    python3 tests/conversion/run_regression.py --verbose
    python3 tests/conversion/run_regression.py --json   # machine-readable output
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.join(SCRIPT_DIR, 'fixtures')
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
PROCESS_SCRIPT = os.path.join(PROJECT_ROOT, 'app', 'Python', 'process_document.py')
MISTRAL_OCR_SCRIPT = os.path.join(PROJECT_ROOT, 'app', 'Python', 'mistral_ocr.py')
MD_TO_HTML_SCRIPT = os.path.join(PROJECT_ROOT, 'app', 'Python', 'simple_md_to_html.py')


def discover_fixtures(filter_name=None):
    """Find all fixture directories containing a manifest.json."""
    fixtures = []
    if not os.path.isdir(FIXTURES_DIR):
        return fixtures
    for name in sorted(os.listdir(FIXTURES_DIR)):
        manifest_path = os.path.join(FIXTURES_DIR, name, 'manifest.json')
        if os.path.isfile(manifest_path):
            if filter_name and name != filter_name:
                continue
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)

            has_ocr = os.path.isfile(os.path.join(FIXTURES_DIR, name, 'ocr_response.json'))
            has_html = os.path.isfile(os.path.join(FIXTURES_DIR, name, 'input.html'))

            fixtures.append({
                'name': name,
                'dir': os.path.join(FIXTURES_DIR, name),
                'manifest': manifest,
                'has_ocr': has_ocr,
                'has_html': has_html,
                'pipeline': 'full' if has_ocr else ('html' if has_html else 'none'),
            })
    return fixtures


def run_full_pipeline(fixture, tmp_dir):
    """Run full pipeline: ocr_response.json → md → html → process_document.py"""
    book_id = fixture['manifest'].get('book_id', fixture['name'])

    # Copy ocr_response.json to tmp_dir (mistral_ocr.py reads from output dir)
    shutil.copy2(
        os.path.join(fixture['dir'], 'ocr_response.json'),
        os.path.join(tmp_dir, 'ocr_response.json')
    )

    # Stage 1: mistral_ocr.py (uses cached OCR, no API key needed)
    # Needs a dummy pdf_path — it won't be read since cache exists
    result = subprocess.run(
        [sys.executable, MISTRAL_OCR_SCRIPT, '/dev/null', tmp_dir],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        return {'stage': 'mistral_ocr', 'returncode': result.returncode,
                'stderr': result.stderr[-500:], 'stdout': result.stdout[-500:]}

    # Stage 2: simple_md_to_html.py
    md_path = os.path.join(tmp_dir, 'main-text.md')
    html_path = os.path.join(tmp_dir, 'intermediate.html')
    if not os.path.isfile(md_path):
        return {'stage': 'mistral_ocr', 'returncode': -1,
                'stderr': 'main-text.md not produced', 'stdout': ''}

    result = subprocess.run(
        [sys.executable, MD_TO_HTML_SCRIPT, md_path, html_path],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        return {'stage': 'md_to_html', 'returncode': result.returncode,
                'stderr': result.stderr[-500:], 'stdout': result.stdout[-500:]}

    if not os.path.isfile(html_path):
        return {'stage': 'md_to_html', 'returncode': -1,
                'stderr': 'intermediate.html not produced', 'stdout': ''}

    # Stage 3: process_document.py
    result = subprocess.run(
        [sys.executable, PROCESS_SCRIPT, html_path, tmp_dir, book_id],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        return {'stage': 'process_document', 'returncode': result.returncode,
                'stderr': result.stderr[-500:], 'stdout': result.stdout[-500:]}

    return None  # success


def run_html_pipeline(fixture, tmp_dir):
    """Run HTML-only pipeline: input.html → process_document.py"""
    book_id = fixture['manifest'].get('book_id', fixture['name'])

    # Copy footnote_meta.json if it exists
    fn_meta = os.path.join(fixture['dir'], 'footnote_meta.json')
    if os.path.isfile(fn_meta):
        shutil.copy2(fn_meta, os.path.join(tmp_dir, 'footnote_meta.json'))

    input_html = os.path.join(fixture['dir'], 'input.html')
    result = subprocess.run(
        [sys.executable, PROCESS_SCRIPT, input_html, tmp_dir, book_id],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        return {'stage': 'process_document', 'returncode': result.returncode,
                'stderr': result.stderr[-500:], 'stdout': result.stdout[-500:]}

    return None  # success


def compare_stats(fixture, tmp_dir):
    """Compare conversion_stats.json against manifest expected values."""
    stats_path = os.path.join(tmp_dir, 'conversion_stats.json')
    expected = fixture['manifest'].get('expected', {})

    if not os.path.isfile(stats_path):
        return False, 'conversion_stats.json not produced'

    stats = json.load(open(stats_path))
    failures = []

    checks = [
        ('references_count', 'references_found'),
        ('citations_linked', 'citations_linked'),
        ('citations_total', 'citations_total'),
        ('footnotes_count', 'footnotes_matched'),
    ]

    for expected_key, stats_key in checks:
        if expected_key in expected:
            exp_val = expected[expected_key]
            got_val = stats.get(stats_key, None)
            if got_val != exp_val:
                failures.append(f'{expected_key}: expected {exp_val}, got {got_val}')

    if failures:
        return False, '; '.join(failures)
    return True, 'all counts match'


def compare_reference_count(fixture, tmp_dir):
    """Compare reference count from actual output against expected."""
    actual_path = os.path.join(tmp_dir, 'references.json')
    expected = fixture['manifest'].get('expected', {})

    if 'references_count' not in expected:
        return True, 'no references_count expected (skipped)'

    if not os.path.isfile(actual_path):
        return False, 'references.json not produced'

    actual = json.load(open(actual_path))
    actual_count = len(actual)
    expected_count = expected['references_count']

    if actual_count == expected_count:
        return True, f'{actual_count} entries'
    return False, f'expected {expected_count}, got {actual_count}'


def compare_audit(fixture, tmp_dir):
    """Compare audit gaps count against expected."""
    audit_path = os.path.join(tmp_dir, 'audit.json')
    expected = fixture['manifest'].get('expected', {})

    if 'audit_gaps' not in expected:
        return True, 'no audit_gaps expected (skipped)'

    if not os.path.isfile(audit_path):
        return False, 'audit.json not produced'

    audit = json.load(open(audit_path))
    actual_gaps = len(audit.get('gaps', []))
    expected_gaps = expected['audit_gaps']

    if actual_gaps == expected_gaps:
        return True, f'{actual_gaps} gaps'
    return False, f'expected {expected_gaps} gaps, got {actual_gaps}'


def run_fixture(fixture, verbose=False):
    """Run all checks for a single fixture. Returns (passed, results, pipeline_used)."""
    results = []
    all_passed = True

    with tempfile.TemporaryDirectory(prefix=f'conv_test_{fixture["name"]}_') as tmp_dir:
        # Run the appropriate pipeline
        if fixture['pipeline'] == 'full':
            error = run_full_pipeline(fixture, tmp_dir)
            pipeline_label = 'full'
        elif fixture['pipeline'] == 'html':
            error = run_html_pipeline(fixture, tmp_dir)
            pipeline_label = 'html-only'
        else:
            return False, [('pipeline', False, 'no input file (need ocr_response.json or input.html)')], 'none'

        if error:
            results.append(('pipeline', False,
                f'{error["stage"]} failed (exit {error["returncode"]}): {error.get("stderr", "")[:200]}'))
            if verbose and error.get('stdout'):
                results.append(('stdout', False, error['stdout'][-300:]))
            return False, results, pipeline_label

        # Check stats
        passed, msg = compare_stats(fixture, tmp_dir)
        results.append(('stats', passed, msg))
        if not passed:
            all_passed = False

        # Check reference count
        passed, msg = compare_reference_count(fixture, tmp_dir)
        results.append(('references', passed, msg))
        if not passed:
            all_passed = False

        # Check audit
        passed, msg = compare_audit(fixture, tmp_dir)
        results.append(('audit', passed, msg))
        if not passed:
            all_passed = False

    return all_passed, results, pipeline_label


def main():
    parser = argparse.ArgumentParser(description='Run conversion pipeline regression tests')
    parser.add_argument('--fixture', help='Run only this fixture')
    parser.add_argument('--verbose', '-v', action='store_true', help='Show detailed output')
    parser.add_argument('--json', action='store_true', help='Output results as JSON')
    args = parser.parse_args()

    fixtures = discover_fixtures(args.fixture)

    if not fixtures:
        if args.json:
            print(json.dumps({'error': 'No fixtures found', 'fixtures': []}))
        else:
            print('No fixtures found.')
            if args.fixture:
                print(f'Looked for: {os.path.join(FIXTURES_DIR, args.fixture, "manifest.json")}')
        sys.exit(1)

    json_results = []

    if not args.json:
        print()
        print('Conversion Pipeline Regression Tests')
        print('=' * 40)

    total_pass = 0
    total_fail = 0

    for fixture in fixtures:
        manifest = fixture['manifest']
        style = manifest.get('citation_style', '?')
        strategy = manifest.get('footnote_strategy', '?')

        all_passed, results, pipeline_label = run_fixture(fixture, verbose=args.verbose)

        if args.json:
            json_results.append({
                'name': fixture['name'],
                'description': manifest.get('description', ''),
                'citation_style': style,
                'footnote_strategy': strategy,
                'pipeline': pipeline_label,
                'passed': all_passed,
                'checks': [{'name': n, 'passed': p, 'message': m} for n, p, m in results],
            })
        else:
            print(f'\n{fixture["name"]} ({style}, {strategy}) [{pipeline_label}]')
            for check_name, passed, msg in results:
                status = 'PASS' if passed else 'FAIL'
                padding = '.' * max(1, 16 - len(check_name))
                print(f'  {check_name} {padding} {status} ({msg})')

        if all_passed:
            total_pass += 1
        else:
            total_fail += 1

    if args.json:
        print(json.dumps({
            'total': total_pass + total_fail,
            'passed': total_pass,
            'failed': total_fail,
            'fixtures': json_results,
        }, indent=2))
    else:
        print()
        print('=' * 40)
        if total_fail == 0:
            print(f'ALL PASS ({total_pass} fixture{"s" if total_pass != 1 else ""})')
        else:
            print(f'{total_fail} FAILED, {total_pass} passed ({total_pass + total_fail} total)')

    sys.exit(1 if total_fail > 0 else 0)


if __name__ == '__main__':
    main()

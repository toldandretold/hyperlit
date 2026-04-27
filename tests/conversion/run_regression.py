#!/usr/bin/env python3
"""
Conversion Pipeline Regression Tests

Runs process_document.py against each fixture and compares outputs
to golden files. Any deviation in reference counts, citation stats,
or audit results is reported as a failure.

Usage:
    python3 tests/conversion/run_regression.py
    python3 tests/conversion/run_regression.py --fixture peerreview2027
    python3 tests/conversion/run_regression.py --verbose
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
            fixtures.append({
                'name': name,
                'dir': os.path.join(FIXTURES_DIR, name),
                'manifest': manifest,
            })
    return fixtures


def run_pipeline(fixture, tmp_dir):
    """Run process_document.py on the fixture input and return outputs."""
    input_html = os.path.join(fixture['dir'], 'input.html')
    book_id = fixture['manifest'].get('book_id', fixture['name'])

    # Copy footnote_meta.json to tmp_dir if it exists (process_document.py reads it)
    fn_meta = os.path.join(fixture['dir'], 'footnote_meta.json')
    if os.path.isfile(fn_meta):
        shutil.copy2(fn_meta, os.path.join(tmp_dir, 'footnote_meta.json'))

    result = subprocess.run(
        [sys.executable, PROCESS_SCRIPT, input_html, tmp_dir, book_id],
        capture_output=True,
        text=True,
        timeout=120,
    )

    return {
        'returncode': result.returncode,
        'stdout': result.stdout,
        'stderr': result.stderr,
    }


def compare_reference_ids(fixture, tmp_dir):
    """Compare reference IDs from golden vs actual output."""
    golden_path = os.path.join(fixture['dir'], 'golden', 'references.json')
    actual_path = os.path.join(tmp_dir, 'references.json')

    if not os.path.isfile(golden_path):
        return True, 'no golden references.json (skipped)'

    if not os.path.isfile(actual_path):
        return False, 'references.json not produced'

    golden = json.load(open(golden_path))
    actual = json.load(open(actual_path))

    golden_ids = set(r['referenceId'] for r in golden)
    actual_ids = set(r['referenceId'] for r in actual)

    if golden_ids == actual_ids:
        return True, f'{len(actual_ids)} IDs match'

    missing = golden_ids - actual_ids
    extra = actual_ids - golden_ids
    parts = []
    if missing:
        parts.append(f'missing {len(missing)}: {sorted(missing)[:5]}{"..." if len(missing) > 5 else ""}')
    if extra:
        parts.append(f'extra {len(extra)}: {sorted(extra)[:5]}{"..." if len(extra) > 5 else ""}')
    return False, '; '.join(parts)


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
    """Run all checks for a single fixture. Returns (passed, results)."""
    results = []
    all_passed = True

    with tempfile.TemporaryDirectory(prefix=f'conv_test_{fixture["name"]}_') as tmp_dir:
        # Run the pipeline
        run_result = run_pipeline(fixture, tmp_dir)

        if run_result['returncode'] != 0:
            results.append(('pipeline', False, f'exit code {run_result["returncode"]}'))
            if verbose:
                results.append(('stdout', False, run_result['stdout'][-500:]))
                results.append(('stderr', False, run_result['stderr'][-500:]))
            return False, results

        # Check stats
        passed, msg = compare_stats(fixture, tmp_dir)
        results.append(('stats', passed, msg))
        if not passed:
            all_passed = False

        # Check reference IDs
        passed, msg = compare_reference_ids(fixture, tmp_dir)
        results.append(('references', passed, msg))
        if not passed:
            all_passed = False

        # Check audit
        passed, msg = compare_audit(fixture, tmp_dir)
        results.append(('audit', passed, msg))
        if not passed:
            all_passed = False

    return all_passed, results


def main():
    parser = argparse.ArgumentParser(description='Run conversion pipeline regression tests')
    parser.add_argument('--fixture', help='Run only this fixture')
    parser.add_argument('--verbose', '-v', action='store_true', help='Show detailed output')
    args = parser.parse_args()

    fixtures = discover_fixtures(args.fixture)

    if not fixtures:
        print('No fixtures found.')
        if args.fixture:
            print(f'Looked for: {os.path.join(FIXTURES_DIR, args.fixture, "manifest.json")}')
        sys.exit(1)

    print()
    print('Conversion Pipeline Regression Tests')
    print('=' * 40)

    total_pass = 0
    total_fail = 0

    for fixture in fixtures:
        manifest = fixture['manifest']
        style = manifest.get('citation_style', '?')
        print(f'\n{fixture["name"]} ({style})')

        all_passed, results = run_fixture(fixture, verbose=args.verbose)

        for check_name, passed, msg in results:
            status = 'PASS' if passed else 'FAIL'
            padding = '.' * max(1, 16 - len(check_name))
            print(f'  {check_name} {padding} {status} ({msg})')

        if all_passed:
            total_pass += 1
        else:
            total_fail += 1

    print()
    print('=' * 40)

    if total_fail == 0:
        print(f'ALL PASS ({total_pass} fixture{"s" if total_pass != 1 else ""})')
        sys.exit(0)
    else:
        print(f'{total_fail} FAILED, {total_pass} passed ({total_pass + total_fail} total)')
        sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Changed files -> the MINIMAL test set that exercises them.

The speed core for fast iteration and the LLM vibe-conversion loop: instead of running
the whole suite after every edit, map each changed file to (a) the unit-test files and
(b) the run_regression.py --fixture filters that actually cover it, then print — or run —
that minimal plan.

The test tree is already the COVERAGE map (fixtures/<filetype>/<pathway>/<case>); this
makes it the IMPACT map too.

Usage:
    python3 tests/conversion/impact_map.py                  # vs HEAD (git diff)
    python3 tests/conversion/impact_map.py --base origin/main
    python3 tests/conversion/impact_map.py app/Python/conversion/citations.py ...
    python3 tests/conversion/impact_map.py --json           # machine-readable plan
    python3 tests/conversion/impact_map.py --run            # execute the minimal plan

Mapping (per changed file):
    process_document.py (orchestrator) ...... ALL unit tests + ALL fixtures
    conversion/strategy|footnotes|audit.py .. their unit test + ALL fixtures (shared core)
    conversion/citations|bibliography|refkeys  their unit test + citation/bibliography fixtures
    conversion/sanitize|assessment.py ....... their unit test only (no fixture impact)
    epub_normalizer.py ...................... test_epub_detectors + epub/ fixtures
    mistral_ocr.py .......................... test_mistral_ocr + pdf/ fixtures
    simple_md_to_html.py .................... test_simple_md_to_html + md/ + pdf/ fixtures
    ar5iv_preprocessor.py ................... test_ar5iv + html/ar5iv fixtures
    strip_docx_metadata.py .................. test_strip_docx_metadata + docx/ fixtures
    a unit test file ........................ run just that test file
    a fixture file .......................... run just that fixture case
    the harness (run_regression/conftest/...) ALL
"""

import argparse
import json
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
FIXTURES_DIR = os.path.join(SCRIPT_DIR, 'fixtures')
FIXTURES_LOCAL_DIR = os.path.join(SCRIPT_DIR, 'fixtures-local')
UNIT_DIR = 'tests/conversion/unit'

ALL = 'ALL'  # sentinel: run everything in that dimension

# Source file (matched by path suffix) -> (unit_tests, fixture_filters).
#   unit_tests:      list of test_*.py basenames, or ALL
#   fixture_filters: list of --fixture substrings, or [ALL], or [] (no fixture impact)
RULES = {
    'app/Python/digestion/process_document.py':                       (ALL, [ALL]),
    'app/Python/digestion/strategySelection/strategy.py':             (['test_strategy.py'], [ALL]),
    'app/Python/digestion/footnoteExtraction/footnotes.py':           (['test_footnote_extraction.py', 'test_linking.py'], [ALL]),
    'app/Python/digestion/footnoteLinking/footnote_link_rules.py':    (['test_footnote_link_rules.py', 'test_marker_link_rules.py'], [ALL]),
    'app/Python/digestion/finalAudit/audit.py':                       (['test_audit.py'], [ALL]),
    'app/Python/digestion/citationLinking/citations.py':              (['test_citations.py'], ['author_year', 'bibliography']),
    'app/Python/digestion/citationLinking/citation_link_rules.py':    (['test_citation_link_rules.py'], ['author_year', 'bibliography']),
    'app/Python/digestion/bibliographyExtraction/bibliography.py':    (['test_bibliography.py'], ['bibliography', 'author_year']),
    'app/Python/shared/refkeys.py':            (['test_refkeys.py'], ['author_year', 'bibliography']),
    'app/Python/shared/sanitize.py':           (['test_sanitize.py'], []),
    'app/Python/shared/assessment.py':         ([], []),   # recording only — no conversion behaviour
    'app/Python/ingestion/epub/epub_normalizer.py':                   (['test_epub_detectors.py'], ['epub/']),
    'app/Python/ingestion/pdf/mistral_ocr.py':                        (['test_mistral_ocr.py'], ['pdf/']),
    'app/Python/ingestion/markdown_and_pdf_to_html/simple_md_to_html.py': (['test_simple_md_to_html.py'], ['md/', 'pdf/']),
    'app/Python/ingestion/html/ar5iv_preprocessor.py':                (['test_ar5iv.py'], ['html/ar5iv']),
    'app/Python/ingestion/word/strip_docx_metadata.py':               (['test_strip_docx_metadata.py'], ['docx/']),
}

# Touch any of these and correctness of the whole harness is in question -> run everything.
HARNESS = {
    'tests/conversion/run_regression.py',
    'tests/conversion/unit/conftest.py',
    'tests/conversion/impact_map.py',
    'tests/conversion/harvest.py',
    'tests/conversion/classify_book.py',
    'pytest.ini',
}


def _norm(path):
    return path.replace('\\', '/').lstrip('./')


def _fixture_case_for(path):
    """A changed file under fixtures/ -> the --fixture filter for its case (the dir holding
    manifest.json), e.g. fixtures/epub/aria_role/synthetic/epub_original/x.xhtml -> epub/aria_role/synthetic."""
    abspath = os.path.join(REPO_ROOT, path)
    for base in (FIXTURES_DIR, FIXTURES_LOCAL_DIR):
        base_rel = _norm(os.path.relpath(base, REPO_ROOT))
        if not path.startswith(base_rel + '/'):
            continue
        d = os.path.dirname(abspath)
        while d and os.path.commonpath([d, base]) == base:
            if os.path.isfile(os.path.join(d, 'manifest.json')):
                return _norm(os.path.relpath(d, base))
            if d == base:
                break
            d = os.path.dirname(d)
        # fallback: first two path components under fixtures/ (filetype/pathway)
        rest = path[len(base_rel) + 1:].split('/')
        return '/'.join(rest[:3]) if rest else None
    return None


def impact_for(path):
    """Return (unit, fixtures) for one changed file. unit: set|ALL, fixtures: set|{ALL}."""
    p = _norm(path)

    if p in HARNESS:
        return ALL, {ALL}

    # A changed unit-test file -> run exactly that file (no fixture impact).
    if p.startswith(UNIT_DIR + '/') and os.path.basename(p).startswith('test_'):
        return {os.path.basename(p)}, set()

    # A changed fixture file -> run exactly that fixture case (no unit impact).
    if '/fixtures/' in '/' + p or '/fixtures-local/' in '/' + p:
        case = _fixture_case_for(p)
        return set(), ({case} if case else {ALL})

    # Known source modules.
    for suffix, (unit, fixtures) in RULES.items():
        if p == suffix or p.endswith('/' + suffix):
            u = ALL if unit == ALL else set(unit)
            fx = {ALL} if fixtures == [ALL] else set(fixtures)
            return u, fx

    # Any other Python file under the conversion tree we don't have a rule for:
    # be conservative and run everything (a new/unmapped pipeline module).
    if p.startswith('app/Python/') and p.endswith('.py'):
        return ALL, {ALL}

    # Unrelated file (docs, JS, PHP, etc.) -> no conversion-test impact.
    return set(), set()


def _collapse_fixture_filters(filters):
    """Drop a filter if a broader one already covers it (e.g. 'epub/aria_role' when 'epub/'
    is present). Keeps the run minimal."""
    fs = sorted(filters)
    kept = []
    for f in fs:
        if any(f != other and other in f for other in fs):
            continue  # some other filter is a substring of f -> f is already covered
        kept.append(f)
    return kept


def build_plan(changed_files):
    unit, fixtures = set(), set()
    unit_all = fixtures_all = False
    reasons = {}
    for path in changed_files:
        u, fx = impact_for(path)
        reasons[_norm(path)] = {
            'unit': 'ALL' if u == ALL else sorted(u),
            'fixtures': 'ALL' if ALL in fx else sorted(fx),
        }
        if u == ALL:
            unit_all = True
        else:
            unit |= u
        if ALL in fx:
            fixtures_all = True
        else:
            fixtures |= fx

    if unit_all:
        pytest_targets = [UNIT_DIR]
    else:
        pytest_targets = sorted(f'{UNIT_DIR}/{t}' for t in unit)

    if fixtures_all:
        regression_filters = None  # run the whole regression suite
    else:
        regression_filters = _collapse_fixture_filters(fixtures)

    return {
        'changed': [_norm(p) for p in changed_files],
        'reasons': reasons,
        'pytest_targets': pytest_targets,
        'regression_filters': regression_filters,  # None = all; [] = none; [..]=filters
        'runs_everything': unit_all and fixtures_all,
    }


def git_changed(base):
    """Files changed vs `base` (tracked diff) plus staged + untracked, deduped."""
    out = set()
    for cmd in (['git', 'diff', '--name-only', base],
                ['git', 'diff', '--name-only', '--cached'],
                ['git', 'ls-files', '--others', '--exclude-standard']):
        try:
            r = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True, check=True)
            out.update(line.strip() for line in r.stdout.splitlines() if line.strip())
        except subprocess.CalledProcessError:
            pass
    return sorted(out)


def run_plan(plan):
    """Execute the minimal plan. Returns an exit code (0 = all green)."""
    rc = 0
    if plan['pytest_targets']:
        cmd = [sys.executable, '-m', 'pytest', '-q', *plan['pytest_targets']]
        print(f"\n$ {' '.join(cmd)}")
        rc |= subprocess.run(cmd, cwd=REPO_ROOT).returncode
    else:
        print("\n(no unit tests impacted)")

    rr = 'tests/conversion/run_regression.py'
    if plan['regression_filters'] is None:
        cmd = [sys.executable, rr]
        print(f"\n$ {' '.join(cmd)}")
        rc |= subprocess.run(cmd, cwd=REPO_ROOT).returncode
    elif plan['regression_filters']:
        for filt in plan['regression_filters']:
            cmd = [sys.executable, rr, '--fixture', filt]
            print(f"\n$ {' '.join(cmd)}")
            rc |= subprocess.run(cmd, cwd=REPO_ROOT).returncode
    else:
        print("(no regression fixtures impacted)")
    return rc


def print_plan(plan):
    print("Impact map — minimal test set for the changed files\n" + "=" * 52)
    if not plan['changed']:
        print("  (no changed files detected)")
        return
    for f in plan['changed']:
        r = plan['reasons'][f]
        print(f"  {f}\n      unit: {r['unit']}   fixtures: {r['fixtures']}")
    print("\nRun:")
    if plan['pytest_targets']:
        print(f"  python3 -m pytest {' '.join(plan['pytest_targets'])}")
    if plan['regression_filters'] is None:
        print("  python3 tests/conversion/run_regression.py")
    else:
        for filt in plan['regression_filters']:
            print(f"  python3 tests/conversion/run_regression.py --fixture {filt}")
    if plan['runs_everything']:
        print("\n  ⚠️ this change touches an orchestrator/harness file — running the FULL suite.")


def main():
    ap = argparse.ArgumentParser(description="Map changed files to the minimal conversion test set.")
    ap.add_argument('files', nargs='*', help="Explicit changed files (default: git diff vs --base).")
    ap.add_argument('--base', default='HEAD', help="git ref to diff against (default: HEAD).")
    ap.add_argument('--json', action='store_true', help="Emit the plan as JSON.")
    ap.add_argument('--run', action='store_true', help="Execute the minimal plan; exit non-zero on failure.")
    args = ap.parse_args()

    changed = args.files if args.files else git_changed(args.base)
    plan = build_plan(changed)

    if args.json:
        print(json.dumps(plan, indent=2))
    else:
        print_plan(plan)

    if args.run:
        sys.exit(run_plan(plan))


if __name__ == '__main__':
    main()

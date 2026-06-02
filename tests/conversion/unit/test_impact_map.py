"""Unit tests for tests/conversion/impact_map.py — the changed-file -> minimal-test-set map.
Pins the rules so a wrong narrowing (which would let a regression slip past the LLM loop)
fails loudly."""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import impact_map as im


def test_shared_core_runs_all_fixtures():
    unit, fx = im.impact_for('app/Python/conversion/strategy.py')
    assert unit == {'test_strategy.py'}
    assert fx == {im.ALL}


def test_citations_narrows_to_citation_fixtures():
    unit, fx = im.impact_for('app/Python/conversion/citations.py')
    assert unit == {'test_citations.py'}
    assert fx == {'author_year', 'bibliography'}


def test_orchestrator_runs_everything():
    assert im.impact_for('app/Python/process_document.py') == (im.ALL, {im.ALL})


def test_epub_maps_to_epub_fixtures_only():
    unit, fx = im.impact_for('app/Python/epub_normalizer.py')
    assert unit == {'test_epub_detectors.py'} and fx == {'epub/'}


def test_sanitize_has_no_fixture_impact():
    unit, fx = im.impact_for('app/Python/conversion/sanitize.py')
    assert unit == {'test_sanitize.py'} and fx == set()


def test_changed_unit_test_runs_only_itself():
    unit, fx = im.impact_for('tests/conversion/unit/test_audit.py')
    assert unit == {'test_audit.py'} and fx == set()


def test_changed_fixture_runs_only_its_case():
    unit, fx = im.impact_for(
        'tests/conversion/fixtures/epub/aria_role/synthetic/epub_original/body.xhtml')
    assert unit == set()
    assert fx == {'epub/aria_role/synthetic'}


def test_harness_change_runs_everything():
    assert im.impact_for('tests/conversion/run_regression.py') == (im.ALL, {im.ALL})


def test_unrelated_file_has_no_impact():
    assert im.impact_for('resources/views/emails/conversion-feedback.blade.php') == (set(), set())


def test_unmapped_pipeline_module_is_conservative():
    # a new app/Python module with no rule -> run everything (safe default)
    assert im.impact_for('app/Python/some_new_module.py') == (im.ALL, {im.ALL})


def test_collapse_drops_covered_filters():
    assert im._collapse_fixture_filters({'epub/', 'epub/aria_role', 'pdf/'}) == ['epub/', 'pdf/']


def test_build_plan_unions_and_minimises():
    plan = im.build_plan(['app/Python/conversion/sanitize.py', 'app/Python/mistral_ocr.py'])
    assert sorted(plan['pytest_targets']) == [
        'tests/conversion/unit/test_mistral_ocr.py', 'tests/conversion/unit/test_sanitize.py']
    assert plan['regression_filters'] == ['pdf/']   # sanitize adds no fixtures
    assert plan['runs_everything'] is False


def test_build_plan_orchestrator_runs_everything():
    plan = im.build_plan(['app/Python/process_document.py'])
    assert plan['pytest_targets'] == ['tests/conversion/unit']
    assert plan['regression_filters'] is None   # None = full regression
    assert plan['runs_everything'] is True

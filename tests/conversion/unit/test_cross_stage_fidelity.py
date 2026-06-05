"""Cross-stage 'whose bug is it' signals — the digestion analogue of PDF's assess_harvest_fidelity.

These pin the two things that matter: it FIRES when a late symptom clearly implies an upstream cause
(so the fix-loop is routed upstream), and it stays SILENT on clean conversions / deliberate guard
suppression (so it never over-flags a non-problem — the modus operandi).
"""
import sys

from digestion.finalAudit.audit import assess_link_fidelity

import vibe_convert as v  # noqa: E402  (for _real_path: the fork's code_ref must resolve)


def _rec(records, module):
    return next((r for r in records if r['module'] == module), None)


# --- the shared digestion cross-stage signal -----------------------------------------------------
def test_citation_target_gap_flags_bibliography_upstream():
    forks = assess_link_fidelity(
        {'references_found': 8, 'citations_total': 24, 'citations_linked': 0,
         'citation_style': 'author-year-bracket', 'footnote_strategy': 'whole_document'},
        {'total_defs': 30, 'total_refs': 0, 'unmatched_defs': [{}] * 30},
        [{'module': 'footnote_linking_guard', 'decision': 'suppress whole-document footnote links'},
         {'module': 'bibliography_extraction', 'evidence': {'detection': 'reverse_scan'}},
         {'module': 'citation_link_audit', 'evidence': {'unlinked_sample': [{'citation': '(Smith 2019)'}]}}])
    f = _rec(forks, 'citation_target_fidelity')
    assert f, "should flag the citation→bibliography upstream gap"
    assert f['code_ref'].startswith('bibliography.py')           # routed UPSTREAM, not the linker
    assert f['confidence'] < 0.5                                  # flagged
    assert f['evidence']['unlinked_sample']                       # carries the evidence
    # the footnote side must NOT fire — the guard deliberately suppressed (honest missing link, not a bug)
    assert _rec(forks, 'footnote_link_fidelity') is None


def test_clean_conversion_flags_nothing():
    forks = assess_link_fidelity(
        {'references_found': 40, 'citations_total': 12, 'citations_linked': 12,
         'citation_style': 'author-year-bracket', 'footnote_strategy': 'sequential'},
        {'total_defs': 20, 'total_refs': 20, 'unmatched_defs': []}, [])
    assert forks == [], "a clean conversion must never be flagged (no over-flagging)"


def test_footnote_link_gap_flags_detection_when_not_suppressed():
    forks = assess_link_fidelity(
        {'references_found': 0, 'citations_total': 0, 'citations_linked': 0, 'footnote_strategy': 'whole_document'},
        {'total_defs': 30, 'total_refs': 0, 'unmatched_defs': [{}] * 30},
        [{'module': 'epub_footnote_detection'}])              # no guard-suppress record → genuine gap
    f = _rec(forks, 'footnote_link_fidelity')
    assert f and 'footnoteMatching.py' in f['code_ref']       # EPUB → the detector/converter file


def test_suppressed_footnotes_are_not_flagged():
    forks = assess_link_fidelity(
        {'references_found': 0, 'citations_total': 0, 'citations_linked': 0, 'footnote_strategy': 'whole_document'},
        {'total_defs': 30, 'total_refs': 0, 'unmatched_defs': [{}] * 30},
        [{'module': 'footnote_linking_guard', 'decision': 'suppress whole-document footnote links'}])
    assert _rec(forks, 'footnote_link_fidelity') is None      # deliberate suppression is not a bug


def test_fork_code_refs_resolve_to_real_files():
    forks = assess_link_fidelity(
        {'references_found': 8, 'citations_total': 24, 'citations_linked': 0, 'citation_style': 'author-year-bracket'},
        {'total_defs': 0, 'total_refs': 0, 'unmatched_defs': []}, [])
    import os
    _repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    for f in forks:
        base = f['code_ref'].split(':', 1)[0]
        assert os.path.isfile(os.path.join(_repo, v._real_path(base))), f"{f['code_ref']} doesn't resolve"


# --- the EPUB structural-transform fidelity marker counter ---------------------------------------
def test_count_footnote_markers_excludes_nav_links():
    from bs4 import BeautifulSoup
    import epub_normalizer as E
    soup = BeautifulSoup('<a href="#fn1">1</a><a href="#note2">2</a><sup epub:type="noteref">3</sup>'
                         '<a href="#chapter2">ch2</a><a href="http://x">ext</a>', 'html.parser')
    assert E._count_footnote_markers(soup) == 3   # the 3 footnote-ish; NOT the nav/external links

"""Unit tests for vibe_convert's fork-flagging + module routing — the logic that decides
which conversion decisions are real problems worth sending the LLM, and which code to send.

Regression guard for the aarushi2025attention case (an EPUB: 239 refs / 477 defs / 238 orphaned
footnote definitions). The audit verdict reads 'clean' (audit.py only tests unmatched *refs*),
yet half the footnotes are orphaned — the flagger must catch that on the evidence. And a
confident, correct skip ('no bibliography → nothing to link', confidence 1.0) must NOT be flagged:
on prod it sent DeepSeek chasing a non-existent citation bug in citations.py.
"""

import vibe_convert as v


# --- _is_problem: what counts as a lead worth sending the model ---------------

def test_confident_skip_is_not_a_problem():
    # The prod false-positive: a certain, correct non-action.
    r = {'module': 'citation_linking', 'confidence': 1.0,
         'decision': 'citation scan skipped — no bibliography entries',
         'margin': 'no bibliography to link against — nothing to do'}
    assert v._is_problem(r) is False


def test_unsure_skip_is_a_problem():
    r = {'module': 'citation_linking', 'confidence': 0.6,
         'decision': 'citation scan skipped — no parenthesized (Author YEAR) patterns'}
    assert v._is_problem(r) is True


def test_low_confidence_is_a_problem():
    assert v._is_problem({'module': 'pdf_footnote_classification',
                          'decision': 'unknown', 'confidence': 0.0}) is True


def test_fall_through_margin_is_a_problem():
    assert v._is_problem({'module': 'strategy_selection', 'decision': 'whole_document',
                          'confidence': 0.9, 'margin': 'FALL-THROUGH: no signal matched'}) is True


def test_faulty_audit_verdict_is_a_problem():
    assert v._is_problem({'module': 'footnote_audit', 'decision': 'faulty', 'confidence': 0.4,
                          'evidence': {'unmatched_refs': 3, 'unmatched_defs': 0,
                                       'gaps': 0, 'total_defs': 10}}) is True


def test_clean_audit_with_many_orphans_is_a_problem():
    # The real aarushi bug: verdict 'clean', but 238/477 definitions orphaned.
    assert v._is_problem({'module': 'footnote_audit', 'decision': 'clean', 'confidence': 0.67,
                          'evidence': {'unmatched_refs': 0, 'unmatched_defs': 238,
                                       'gaps': 0, 'total_defs': 477}}) is True


def test_clean_audit_with_few_orphans_is_not_a_problem():
    # A handful of genuine orphan endnotes (< 15% share) is benign, not a defect to chase.
    assert v._is_problem({'module': 'footnote_audit', 'decision': 'clean', 'confidence': 0.99,
                          'evidence': {'unmatched_refs': 0, 'unmatched_defs': 2,
                                       'gaps': 0, 'total_defs': 400}}) is False


def test_audit_with_a_gap_is_a_problem():
    assert v._is_problem({'module': 'footnote_audit', 'decision': 'clean', 'confidence': 0.9,
                          'evidence': {'unmatched_refs': 0, 'unmatched_defs': 0,
                                       'gaps': 2, 'total_defs': 50}}) is True


def test_footnote_linking_orphans_are_flagged_and_route_to_the_linker():
    # The signal that was missing: definitions DETECTED but never LINKED (FootnoteConverter, which lives
    # in footnoteMatching.py after the phase-split — the code_ref points there).
    rec = {'module': 'footnote_linking', 'code_ref': 'footnoteMatching.py:FootnoteConverter.convert',
           'decision': '239 linked; 238 ORPHANED', 'confidence': 0.0,
           'evidence': {'detected_footnotes': 239, 'orphaned_defs': 238, 'linked': 239}}
    assert v._is_problem(rec) is True
    mods = v.modules_for([rec], {'is_epub': True})
    assert v._real_path('footnoteMatching.py') in mods   # routed to where FootnoteConverter lives
    assert v._real_path('footnote_link_rules.py') in mods  # + the linker (decomposition sibling)


def test_footnote_linking_moderate_orphan_share_is_flagged():
    rec = {'module': 'footnote_linking', 'confidence': 0.8,  # not catastrophic conf, but real orphaning
           'evidence': {'detected_footnotes': 500, 'orphaned_defs': 100, 'linked': 400}}
    assert v._is_problem(rec) is True  # 20% orphaned


def test_footnote_linking_clean_is_not_flagged():
    rec = {'module': 'footnote_linking', 'confidence': 1.0,
           'evidence': {'detected_footnotes': 239, 'orphaned_defs': 0, 'linked': 239}}
    assert v._is_problem(rec) is False


def test_confident_bibliography_skip_is_not_a_problem():
    assert v._is_problem({'module': 'bibliography_extraction', 'confidence': 0.9,
                          'decision': 'extraction skipped — no reference section'}) is False


# --- modules_for: route a flagged footnote_audit to the DETECTOR, not audit.py ---

def test_footnote_audit_routes_to_epub_detector():
    rec = {'module': 'footnote_audit', 'code_ref': 'audit.py:compute_footnote_audit'}
    mods = v.modules_for([rec], {'is_epub': True, 'is_pdf': False})
    assert v._real_path('epub_normalizer.py') in mods
    assert v._real_path('footnotes.py') in mods
    assert v._real_path('audit.py') not in mods  # audit only measures, never the fix


def test_footnote_audit_routes_to_shared_path_when_not_epub():
    rec = {'module': 'footnote_audit', 'code_ref': 'audit.py:compute_footnote_audit'}
    mods = v.modules_for([rec], {'is_epub': False, 'is_pdf': True})
    assert v._real_path('process_document.py') in mods
    assert v._real_path('footnotes.py') in mods
    assert v._real_path('epub_normalizer.py') not in mods


def test_non_audit_records_use_their_code_ref():
    rec = {'module': 'strategy_selection', 'code_ref': 'strategy.py:analyze_document_structure'}
    mods = v.modules_for([rec], {'is_epub': False})
    assert mods == [v._real_path('strategy.py')]     # follows the reorg (digestion/strategySelection/)

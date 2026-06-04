"""Unit tests for the path-A gate (vibe_convert.evaluate) — the scorer that decides whether a
proposed fix is clean / improved / reject. The gate used to credit ONLY link-count gains, so it
rejected correct fixes that reduce audit faults without raising counts (e.g. stop mis-counting
bibliography entries as orphaned footnote definitions). These pin the fault-reduction credit + the
anti-gaming guard (editing audit.py forfeits fault credit).
"""

import vibe_convert as v


def _audit(gaps=0, unmatched_refs=0, unmatched_defs=0):
    return {'gaps': list(range(gaps)), 'unmatched_refs': list(range(unmatched_refs)),
            'unmatched_defs': list(range(unmatched_defs)), 'total_refs': 0, 'total_defs': 0}


def _fn_audit_record(gaps, unmatched_defs):
    # a footnote_audit fork that _is_problem flags via 'faulty' (so it persists across baseline/after)
    return {'module': 'footnote_audit', 'code_ref': 'audit.py:compute_footnote_audit',
            'decision': 'faulty', 'confidence': 0.9,
            'evidence': {'gaps': gaps, 'unmatched_refs': 0, 'unmatched_defs': unmatched_defs,
                         'total_defs': 505}}


def _art(footnotes=505, citations=651, gaps=0, urefs=0, udefs=0, records=None):
    return {'ok': True,
            'stats': {'footnotes_matched': footnotes, 'citations_linked': citations,
                      'citations_total': 947, 'references_found': 422},
            'assessment': records if records is not None else [],
            'audit': _audit(gaps, urefs, udefs)}


# ---------------------------------------------------------------------------
# The new behaviour: fewer audit faults at equal link counts = a correctness win
# ---------------------------------------------------------------------------
def test_fault_reduction_credited_as_improved():
    # baseline: 34 gaps + 44 orphaned defs (footnote_audit flagged 'faulty').
    base = _art(footnotes=505, gaps=34, udefs=44, records=[_fn_audit_record(34, 44)])
    # after: orphans removed (the bib-as-footnote miscount fixed) → faults drop, count unchanged.
    after = _art(footnotes=505, gaps=34, udefs=0, records=[_fn_audit_record(34, 0)])
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/footnotes.py'])
    assert tier == 'improved', why
    assert 'reduced audit faults' in why


def test_footnote_drop_with_fault_reduction_not_rejected():
    # removing 44 NOISE defs lowers footnotes_matched 505→461 AND faults 44→0 — that's good, not a loss.
    base = _art(footnotes=505, udefs=44, records=[_fn_audit_record(0, 44)])
    after = _art(footnotes=461, udefs=0, records=[_fn_audit_record(0, 0)])
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/footnotes.py'])
    assert tier in ('improved', 'clean'), why   # not rejected for "fewer footnotes"


# ---------------------------------------------------------------------------
# Anti-gaming: editing audit.py forfeits fault-reduction credit
# ---------------------------------------------------------------------------
def test_fault_reduction_via_audit_edit_not_credited():
    base = _art(footnotes=505, gaps=34, udefs=44, records=[_fn_audit_record(34, 44)])
    after = _art(footnotes=505, gaps=34, udefs=0, records=[_fn_audit_record(34, 0)])
    # same drop, but the patch edited the AUDIT itself → not a real conversion fix.
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/audit.py'])
    assert tier == 'reject', why
    assert 'no measurable improvement' in why


def test_footnote_drop_via_audit_edit_still_rejected_as_regression():
    # dropping footnotes_matched while gaming the audit must still read as a regression.
    base = _art(footnotes=505, udefs=44, records=[_fn_audit_record(0, 44)])
    after = _art(footnotes=461, udefs=0, records=[_fn_audit_record(0, 0)])
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/audit.py'])
    assert tier == 'reject' and 'FEWER footnotes' in why


# ---------------------------------------------------------------------------
# Existing behaviour preserved
# ---------------------------------------------------------------------------
def test_count_gain_still_improved():
    base = _art(citations=600, records=[_fn_audit_record(0, 0)])
    after = _art(citations=650, records=[_fn_audit_record(0, 0)])
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/citations.py'])
    assert tier == 'improved'


def test_real_footnote_loss_rejected():
    # fewer footnotes with NO fault reduction = real loss → reject
    base = _art(footnotes=505, udefs=0, records=[_fn_audit_record(0, 0)])
    after = _art(footnotes=400, udefs=0, records=[_fn_audit_record(0, 0)])
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/footnotes.py'])
    assert tier == 'reject' and 'FEWER footnotes' in why


def test_no_change_rejected():
    base = _art(records=[_fn_audit_record(34, 0)])
    after = _art(records=[_fn_audit_record(34, 0)])
    tier, why = v.evaluate(base, after, patched_files=['app/Python/conversion/footnotes.py'])
    assert tier == 'reject' and 'no measurable improvement' in why


def test_crash_rejected():
    base = _art()
    after = {'ok': False, 'stats': {}, 'assessment': [], 'audit': _audit()}
    tier, why = v.evaluate(base, after, patched_files=[])
    assert tier == 'reject' and 'crashed' in why

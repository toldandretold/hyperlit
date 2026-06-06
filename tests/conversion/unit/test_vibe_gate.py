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


def _art(footnotes=505, citations=651, gaps=0, urefs=0, udefs=0, records=None, headings=None,
         citations_total=947, refs=None):
    return {'ok': True,
            'stats': {'footnotes_matched': footnotes, 'citations_linked': citations,
                      'citations_total': citations_total, 'references_found': 422},
            'assessment': records if records is not None else [],
            'audit': _audit(gaps, urefs, udefs),
            'headings': headings if headings is not None else {'total': 0, 'h1': 0, 'gaps': 0},
            'refs': refs if refs is not None else {'count': 422, 'max_key_len': 20, 'overlong_keys': 0}}


# a persisting low-confidence fork → clean=False, so the heading / wrongly-matched branches are reachable
# (a real flagged conversion always has one; without it the gate short-circuits to 'clean').
def _unsure_record(module='headings_detection'):
    return {'module': module, 'confidence': 0.3, 'decision': 'unsure'}


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


# ---------------------------------------------------------------------------
# _count_headings — the objective heading metric (h1–h6 nodes in nodes.jsonl)
# ---------------------------------------------------------------------------
def test_count_headings(tmp_path):
    p = tmp_path / 'nodes.jsonl'
    # h1, h2, then a jump to h4 (a >1-level gap), a body <p>, and a malformed line.
    lines = [{'type': 'h1'}, {'type': 'H2'}, {'type': 'h4'}, {'type': 'p'}, {'type': 'h6'}]
    p.write_text('\n'.join(__import__('json').dumps(x) for x in lines) + '\n\n', encoding='utf-8')
    h = v._count_headings(str(p))
    assert h['total'] == 4          # h1, h2, h4, h6 (case-insensitive); the <p> excluded
    assert h['h1'] == 1
    assert h['gaps'] == 2           # h2→h4 (+2) and h4→h6 (+2) are both >1-level jumps


def test_count_headings_missing_file():
    assert v._count_headings('/no/such/file.jsonl') == {'total': 0, 'h1': 0, 'gaps': 0}


# ---------------------------------------------------------------------------
# Headings are a measured dimension: recovering them = improved; losing them = reject
# ---------------------------------------------------------------------------
def test_headings_recovered_is_improved():
    # 0 headings (publisher headings stuck as <p>) → 47 with an h1 title, links unchanged.
    base = _art(records=[_unsure_record()], headings={'total': 0, 'h1': 0, 'gaps': 0})
    after = _art(records=[_unsure_record()], headings={'total': 47, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/headings.py'])
    assert tier == 'improved', why
    assert 'recovered document headings' in why


def test_h1_title_appearing_is_improved():
    # same heading count, but the top-level title (h1) now exists where there was none.
    base = _art(records=[_unsure_record()], headings={'total': 5, 'h1': 0, 'gaps': 0})
    after = _art(records=[_unsure_record()], headings={'total': 5, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/headings.py'])
    assert tier == 'improved' and 'h1 0→1' in why


def test_heading_loss_rejected():
    # losing document structure (fewer h1–h6 nodes) is a regression even if links are fine.
    base = _art(records=[_unsure_record()], headings={'total': 47, 'h1': 1, 'gaps': 0})
    after = _art(records=[_unsure_record()], headings={'total': 10, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/headings.py'])
    assert tier == 'reject' and 'FEWER headings' in why


# ---------------------------------------------------------------------------
# Reader-reported "wrongly matched" — the one dimension counts can't capture
# ---------------------------------------------------------------------------
_BIB = 'app/Python/digestion/bibliographyExtraction/bibliography.py'


def test_wrongly_matched_reported_and_module_touched_is_improved():
    # reader flagged a confident-WRONG citation link; patch touched a matching module; nothing regressed.
    art = dict(records=[_unsure_record()], headings={'total': 5, 'h1': 1, 'gaps': 0})
    base, after = _art(**art), _art(**art)
    tier, why = v.evaluate(base, after, patched_files=[_BIB],
                           issue_types=['citations_wrongly_matched'])
    assert tier == 'improved', why
    assert 'WRONG match' in why and 'Keep or Revert' in why


def test_wrongly_matched_not_reported_is_rejected():
    # same no-op patch WITHOUT the reader's report → no measurable improvement → reject.
    art = dict(records=[_unsure_record()], headings={'total': 5, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(_art(**art), _art(**art), patched_files=[_BIB])
    assert tier == 'reject' and 'no measurable improvement' in why


def test_wrongly_matched_reported_but_wrong_module_rejected():
    # reported, but the patch touched an unrelated file (not a matching module) → reject.
    art = dict(records=[_unsure_record()], headings={'total': 5, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(_art(**art), _art(**art),
                           patched_files=['app/Python/digestion/headings.py'],
                           issue_types=['citations_wrongly_matched'])
    assert tier == 'reject' and 'no measurable improvement' in why


# ---------------------------------------------------------------------------
# Multi-problem: gains in ANY measured dimension credited; a regression in any blocks
# ---------------------------------------------------------------------------
def test_multi_problem_headings_up_citations_flat_is_improved():
    base = _art(citations=0, records=[_unsure_record()], headings={'total': 0, 'h1': 0, 'gaps': 0})
    after = _art(citations=0, records=[_unsure_record()], headings={'total': 12, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/headings.py'],
                           issue_types=['citations_not_matched', 'headings_wrong'])
    assert tier == 'improved' and 'recovered document headings' in why


def test_multi_problem_one_dimension_regresses_is_rejected():
    # headings rose but citations fell — a regression in any measured dimension blocks the fix.
    base = _art(citations=550, records=[_unsure_record()], headings={'total': 0, 'h1': 0, 'gaps': 0})
    after = _art(citations=540, records=[_unsure_record()], headings={'total': 12, 'h1': 1, 'gaps': 0})
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/headings.py'],
                           issue_types=['citations_not_matched', 'headings_wrong'])
    assert tier == 'reject' and 'FEWER citations' in why


# ---------------------------------------------------------------------------
# _ref_key_stats + the over-extraction guards (a bibliography "fix" that over-matches)
# ---------------------------------------------------------------------------
def test_ref_key_stats(tmp_path):
    import json
    p = tmp_path / 'references.json'
    p.write_text(json.dumps([
        {'referenceId': 'adornotheodor2003'},                 # a real short author-year slug
        {'referenceId': 'x' * 338},                           # concatenated garbage (over-extraction)
        {'content': 'no key at all'},
    ]), encoding='utf-8')
    s = v._ref_key_stats(str(p))
    assert s['count'] == 3
    assert s['max_key_len'] == 338
    assert s['overlong_keys'] == 1          # only the 338-char one exceeds MAX_SANE_REF_KEY


def test_ref_key_stats_missing_file():
    assert v._ref_key_stats('/no/such/refs.json') == {'count': 0, 'max_key_len': 0, 'overlong_keys': 0}


_CLEAN_REFS = {'count': 550, 'max_key_len': 18, 'overlong_keys': 0}
_GARBAGE_REFS = {'count': 943, 'max_key_len': 338, 'overlong_keys': 1}


def test_garbage_reference_keys_rejected():
    # over-extraction that links a few citations but mints a 338-char garbage key → reject (not 'improved')
    base = _art(citations=0, citations_total=1370, records=[_unsure_record()],
                refs={'count': 1, 'max_key_len': 11, 'overlong_keys': 0})
    after = _art(citations=47, citations_total=1360, records=[_unsure_record()], refs=_GARBAGE_REFS)
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/bibliographyExtraction/bibliography.py'])
    assert tier == 'reject' and 'malformed reference key' in why


def test_citation_detection_collapse_rejected():
    # links a few (0→47) but in-text citation DETECTION collapses (1370→159) → net regression → reject
    base = _art(citations=0, citations_total=1370, records=[_unsure_record()], refs=_CLEAN_REFS)
    after = _art(citations=47, citations_total=159, records=[_unsure_record()], refs=_CLEAN_REFS)
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/bibliographyExtraction/bibliography.py'])
    assert tier == 'reject' and 'DETECTION collapsed' in why


def test_genuine_bibliography_fix_still_improved():
    # the GOOD shape (6982): links MANY more, detection stable, clean keys → still credited as improved
    base = _art(citations=0, citations_total=1370, records=[_unsure_record()],
                refs={'count': 1, 'max_key_len': 11, 'overlong_keys': 0})
    after = _art(citations=1023, citations_total=1364, records=[_unsure_record()], refs=_CLEAN_REFS)
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/bibliographyExtraction/bibliography.py'])
    assert tier == 'improved', why


def test_modest_citation_total_dip_not_rejected():
    # a small dip in detection (dedup, not collapse) must NOT trip the collapse guard
    base = _art(citations=500, citations_total=1000, records=[_unsure_record()], refs=_CLEAN_REFS)
    after = _art(citations=560, citations_total=900, records=[_unsure_record()], refs=_CLEAN_REFS)
    tier, why = v.evaluate(base, after, patched_files=['app/Python/digestion/citationLinking/citation_link_rules.py'])
    assert tier == 'improved', why


# ---------------------------------------------------------------------------
# _pick_best — the best-of-N selector across retry attempts (order-independent)
# ---------------------------------------------------------------------------
def _cand(score, tier):
    return {'score': score, 'tier': tier, 'funcs': [], 'rationale': '', 'after': '', 'why': ''}


def test_pick_best_keeps_strongest_attempt_regardless_of_order():
    # "1 good, 2 junk, 3 good" — the FIRST attempt is the strongest; it must win.
    best = None
    for c in (_cand(1090, 'improved'), _cand(0, 'improved'), _cand(900, 'improved')):
        best = v._pick_best(best, c)
    assert best['score'] == 1090   # attempt 1, not the last


def test_pick_best_late_low_clean_does_not_stomp_earlier_high_improved():
    # the bug this closes: a late, LOW-value 'clean' used to short-circuit and win — it must not.
    best = v._pick_best(_cand(1023, 'improved'), _cand(900, 'clean'))
    assert best['score'] == 1023 and best['tier'] == 'improved'


def test_pick_best_clean_breaks_ties_and_higher_clean_wins():
    assert v._pick_best(_cand(1023, 'improved'), _cand(1023, 'clean'))['tier'] == 'clean'
    assert v._pick_best(_cand(1000, 'improved'), _cand(1100, 'clean'))['score'] == 1100


def test_pick_best_handles_none():
    assert v._pick_best(None, _cand(5, 'improved'))['score'] == 5
    assert v._pick_best(_cand(5, 'improved'), None)['score'] == 5

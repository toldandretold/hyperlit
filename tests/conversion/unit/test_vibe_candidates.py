"""Best-of-N must pick the genuinely-best fix, not the one with the highest RAW count — a candidate that
linked more but mostly-wrong (false positives) loses to a cleaner one. Plus the ≥2-candidate docker
re-validation that confirms the choice. (Stage 1 of the post-success UX work.)
"""
from vibeConverter import gate as G, loop as L


def _cand(attempt, score, fault_delta, tier='improved'):
    return {'attempt': attempt, 'funcs': [{'file': 'x.py', 'name': 'fn'}], 'rationale': 'r', 'why': 'w',
            'tier': tier, 'before': 'b', 'after': f'after-{attempt}',
            'score': score, 'faults': fault_delta, 'fault_delta': fault_delta, 'total_gain': score}


# --- quality-aware ranking (_rank_key / _pick_best) -----------------------------------------------

def test_rank_prefers_fewer_false_positives_over_higher_raw_count():
    a = _cand(1, 400, 0)     # 400 links, 0 misaligned -> 400 true positives
    b = _cand(2, 410, 30)    # 410 links, 30 misaligned -> 380 true positives
    assert G._pick_best(a, b) is a       # the cleaner fix wins despite the lower raw count
    assert G._pick_best(b, a) is a       # ORDER-INDEPENDENT


def test_rank_clean_breaks_a_true_positive_tie():
    a = _cand(1, 100, 0, tier='improved')
    b = _cand(2, 100, 0, tier='clean')
    assert G._pick_best(a, b) is b       # equal true-positives -> 'clean' wins


def test_old_style_candidate_without_fault_delta_ranks_by_score():
    # candidates carrying only {score, tier} (no fault_delta) must rank exactly as the old picker did
    a = {'score': 5, 'tier': 'improved'}
    b = {'score': 9, 'tier': 'improved'}
    assert G._pick_best(a, b) is b


# --- winner selection + docker re-validation (_select_winner) -------------------------------------

def test_select_winner_single_candidate_skips_revalidation(monkeypatch):
    calls = []
    monkeypatch.setattr(L, '_revalidate_candidate', lambda *a, **k: calls.append(1))
    c = _cand(1, 100, 0)
    assert L._select_winner('/tmp/x', {'stats': {}}, [c], 0, None) is c
    assert calls == []                   # one candidate -> no re-validation


def test_select_winner_revalidates_top2_and_picks_true_best(monkeypatch):
    a = _cand(1, 400, 0)                 # true 400
    b = _cand(2, 410, 30)               # true 380 — higher raw, more false positives
    seen = []
    # stub re-validation: return the candidate's signals unchanged (the real one re-converts in docker)
    def _reval(book, art, c, bf, it):
        seen.append(c['attempt'])
        return c
    monkeypatch.setattr(L, '_revalidate_candidate', _reval)
    win = L._select_winner('/tmp/x', {'stats': {}}, [b, a], 0, None)
    assert win is a                      # the higher-true-positive fix is applied
    assert set(seen) == {1, 2}           # both top candidates were re-validated


def test_select_winner_drops_a_candidate_that_fails_revalidation(monkeypatch):
    a = _cand(1, 400, 0)
    b = _cand(2, 999, 0)                 # looks best, but re-validation now rejects it (regressed)
    def _reval(book, art, c, bf, it):
        return None if c['attempt'] == 2 else c
    monkeypatch.setattr(L, '_revalidate_candidate', _reval)
    win = L._select_winner('/tmp/x', {'stats': {}}, [a, b], 0, None)
    assert win is a                      # the flaky high-count candidate is discarded


def test_select_winner_none_when_no_improving_candidates():
    rej = {'tier': 'reject', 'score': 0}
    assert L._select_winner('/tmp/x', {'stats': {}}, [rej], 0, None) is None


# --- mid-loop "use this one" (Stage 2) ------------------------------------------------------------

def test_use_now_marker_detection(tmp_path):
    from vibeConverter import runtime as R
    marker = tmp_path / 'vibe_use_now'
    R.configure(use_now_file=str(marker))
    try:
        assert R._use_now() is False     # marker absent
        marker.write_text('1')
        assert R._use_now() is True      # marker present -> apply best so far
    finally:
        R.configure()                    # reset run state


def test_apply_winner_force_revalidates_single_candidate(monkeypatch):
    reval = []
    monkeypatch.setattr(L, '_revalidate_candidate', lambda b, a, c, bf, it: (reval.append(c['attempt']), c)[1])
    monkeypatch.setattr(L, '_persist_patch', lambda *a, **k: None)
    monkeypatch.setattr(L, '_finalize', lambda *a, **k: {})
    c = _cand(1, 100, 0)
    win = L._apply_winner('/tmp/x', {'stats': {}}, [c], 0, None, [], force_revalidate=True)
    assert win is c and reval == [1]     # 'use this one' re-validates even a lone candidate before applying

"""Unit tests for conversion/audit.py — gap / duplicate / unmatched detection."""

from conversion.audit import compute_footnote_audit


def _ref(n, fid):
    return f'<sup class="footnote-ref" fn-count-id="{n}" id="{fid}">{n}</sup>'


def _defs(*fids):
    return [{'footnoteId': f, 'content': f'note {f}'} for f in fids]


def test_clean_all_linked(soup):
    body = f'<p>a{_ref(1, "Fn1")} b{_ref(2, "Fn2")}</p>'
    audit = compute_footnote_audit(soup(body), _defs('Fn1', 'Fn2'))
    assert audit['total_refs'] == 2
    assert audit['total_defs'] == 2
    assert audit['gaps'] == []
    assert audit['unmatched_refs'] == []
    assert audit['unmatched_defs'] == []


def test_numbering_gap(soup):
    body = f'<p>a{_ref(1, "Fn1")} c{_ref(3, "Fn3")}</p>'
    audit = compute_footnote_audit(soup(body), _defs('Fn1', 'Fn3'))
    assert any(g['missing'] == 2 for g in audit['gaps'])


def test_unmatched_ref(soup):
    # in-text marker points at Fn9 which has no definition
    body = f'<p>a{_ref(1, "Fn9")}</p>'
    audit = compute_footnote_audit(soup(body), _defs('Fn1'))
    assert any(u['ref_id'] == 'Fn9' for u in audit['unmatched_refs'])


def test_unmatched_def(soup):
    # Fn2 is defined but never referenced in-text
    body = f'<p>a{_ref(1, "Fn1")}</p>'
    audit = compute_footnote_audit(soup(body), _defs('Fn1', 'Fn2'))
    assert any(u['footnote_id'] == 'Fn2' for u in audit['unmatched_defs'])


def test_repeated_number_is_treated_as_section_restart(soup):
    # A footnote number going back down (1 ... 1) is read as a NEW section, not a
    # duplicate — the audit splits refs into ascending sequences at each restart.
    # (Consequence: within a sequence numbers are strictly increasing, so the
    # duplicate-detection branch is effectively never reached — a latent dead path
    # worth revisiting, but faithfully preserved here from the original.)
    body = f'<p>a{_ref(1, "Fn1")} b{_ref(1, "Fn1b")}</p>'
    audit = compute_footnote_audit(soup(body), _defs('Fn1', 'Fn1b'))
    assert audit['total_refs'] == 2
    assert audit['duplicates'] == []

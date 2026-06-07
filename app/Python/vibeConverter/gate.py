"""vibeConverter.gate — the accept/reject gate (clean / improved / reject) + best-of-N."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.diagnosis import (flagged_forks)
from vibeConverter.runtime import (CITATION_COLLAPSE_RATIO, MAX_SANE_REF_KEY, MISALIGNED_REJECT_RATIO)




def _count_headings(nodes_path):
    """The heading STRUCTURE of a conversion's output, for the gate — counted straight from nodes.jsonl
    (each node's `type` is the HTML tag, e.g. 'h1'..'h6'). Returns total h1–h6, the h1 count (a missing
    top-level title is the common EPUB failure), and hierarchy GAPS (a heading that jumps MORE than one
    level below the previous — the 'wrong hierarchy' signal). Missing/garbled file → all zeros."""
    levels = []
    try:
        with open(nodes_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                t = (json.loads(line).get('type') or '').lower()
                if len(t) == 2 and t[0] == 'h' and t[1] in '123456':
                    levels.append(int(t[1]))
    except Exception:
        pass
    gaps = sum(1 for i in range(1, len(levels)) if levels[i] - levels[i - 1] > 1)
    return {'total': len(levels), 'h1': levels.count(1), 'gaps': gaps}




def _ref_key_stats(refs_path):
    """Reference-KEY shape, for the over-extraction guard. A real referenceId is a short author-year slug
    ('adornotheodor2003', ~17 chars); bibliography OVER-extraction concatenates a paragraph of words into
    one key (a 338-char id was seen in the wild — it also overflows the DB's varchar(255)). Returns the
    entry count, the longest key length, and how many keys are unreasonably long. Missing file → zeros."""
    out = {'count': 0, 'max_key_len': 0, 'overlong_keys': 0}
    try:
        data = json.load(open(refs_path, encoding='utf-8'))
    except Exception:
        return out
    if not isinstance(data, list):
        return out
    out['count'] = len(data)
    for r in data:
        k = (r.get('referenceId') or '') if isinstance(r, dict) else ''
        out['max_key_len'] = max(out['max_key_len'], len(k))
        if len(k) > MAX_SANE_REF_KEY:
            out['overlong_keys'] += 1
    return out




def _problem_set(records, audit):
    """The problems in a conversion: which modules are flagged + how many audit faults."""
    flagged = {r.get('module') for r in flagged_forks(records)}
    faults = sum(len(audit.get(k, [])) for k in ('gaps', 'unmatched_refs', 'unmatched_defs'))
    return flagged, faults




def evaluate(baseline_art, after, patched_files=None, issue_types=None):
    """The path-A gate, THREE-TIER (the patch only ever touches THIS doc — no regression suite):
        'clean'    — the flagged problem(s) resolved with NO new flags/faults → offer confidently
        'improved' — got materially better on ANY measured dimension (citations / footnotes / HEADINGS,
                     or FEWER audit faults — a wrong link is worse than a missing one) → SHOW with caveat
        'reject'   — crashed, regressed a previously-good metric, or no measurable improvement
    Returns (tier, reason). Accepting is non-destructive: the nodes_versioning_trigger archives the
    prior conversion to nodes_history, so the user can always revert.

    MULTI-DIMENSION: a gain in any of citations / footnotes / headings is credited; a regression in any is
    blocked. `issue_types` is what the READER reported (the toast picker) — it lets the gate honour a
    dimension only the human can see ('…_wrongly_matched': a confident-wrong link still counts as linked,
    so it can't be measured — if the reader flagged it and the patch touched the matching module without
    regressing anything, offer it for the human to Keep/Revert).

    `patched_files` (repo paths the patch edited) guards against the model GAMING the gate by editing
    the AUDIT to report fewer faults — audit faults come from audit.py:compute_footnote_audit, so a
    patch touching audit.py forfeits fault-reduction credit (it must fix the conversion, not the ruler)."""
    if not after['ok']:
        return 'reject', "the patched code crashed converting the document"
    b, a = baseline_art['stats'], after['stats']
    bh, ah = baseline_art.get('headings') or {}, after.get('headings') or {}
    b_fl, b_faults = _problem_set(baseline_art['assessment'], baseline_art['audit'])
    a_fl, a_faults = _problem_set(after['assessment'], after['audit'])
    fault_drop = b_faults - a_faults                       # >0 = fewer audit faults (good)
    # Did the patch edit the AUDIT itself? Then a fault drop is suspect — don't credit it.
    gamed_audit = bool(patched_files) and any((p or '').endswith('audit.py') for p in patched_files)
    creditable_fault_drop = fault_drop > 0 and not gamed_audit

    # Regression guard: things that were already working must not get worse.
    if a.get('citations_linked', 0) < b.get('citations_linked', 0):
        return 'reject', (f"it linked FEWER citations ({a.get('citations_linked', 0)} vs "
                          f"{b.get('citations_linked', 0)})")
    # A footnote-count DROP is a regression ONLY if it didn't also remove faults — i.e. REAL footnotes
    # were lost, not noise defs (e.g. bibliography entries mis-counted as footnote definitions). A drop
    # that simultaneously cuts audit faults (and didn't game the audit) is removing garbage = good.
    if a.get('footnotes_matched', 0) < b.get('footnotes_matched', 0) and not creditable_fault_drop:
        return 'reject', (f"it matched FEWER footnotes ({a.get('footnotes_matched', 0)} vs "
                          f"{b.get('footnotes_matched', 0)})")
    # Headings are objectively measurable (h1–h6 nodes); losing document structure is a regression.
    if ah.get('total', 0) < bh.get('total', 0):
        return 'reject', (f"it produced FEWER headings ({ah.get('total', 0)} vs {bh.get('total', 0)}) "
                          f"— lost document structure")
    # OVER-EXTRACTION guard 1: garbage reference keys. A bibliography "fix" that over-matches concatenates
    # words into absurd keys (a 338-char id was seen — it also overflows the DB's varchar(255)). A 100+-char
    # referenceId is provably not an author-year slug; if the patch introduced any (baseline had none), reject.
    br, ar = baseline_art.get('refs') or {}, after.get('refs') or {}
    if ar.get('overlong_keys', 0) > br.get('overlong_keys', 0):
        return 'reject', (f"it produced malformed reference key(s) up to {ar.get('max_key_len', 0)} chars "
                          f"— bibliography over-extraction (a real key is a short author-year slug, and "
                          f"keys this long break the DB / match no citation)")
    # OVER-EXTRACTION guard 2: citation-DETECTION collapse. citations_linked rising looks like a win, but if
    # citations_total (how many in-text citations are even RECOGNISED) has collapsed, the change links a few
    # while losing most — a net regression the raw link count hides. (8694: linked 0→47 but detected 1370→159.)
    bct, act = b.get('citations_total', 0), a.get('citations_total', 0)
    if bct >= 20 and act < CITATION_COLLAPSE_RATIO * bct:
        return 'reject', (f"in-text citation DETECTION collapsed ({bct}→{act}) — it links a few but stops "
                          f"recognising most citations; a net regression the link count hides")

    introduced = a_fl - b_fl
    persists = a_fl & b_fl
    clean = (not introduced) and (a_faults <= b_faults) and (not persists)
    if clean:
        return 'clean', "resolved the flagged problem(s) with no new faults in this document"

    fn_gain = a.get('footnotes_matched', 0) - b.get('footnotes_matched', 0)
    cit_gain = a.get('citations_linked', 0) - b.get('citations_linked', 0)
    total_gain = max(0, fn_gain) + max(0, cit_gain)
    fault_delta = a_faults - b_faults
    if total_gain > 0:
        # QUALITY GUARD (modus operandi: a wrong link is worse than a missing one). If the new
        # audit faults are a large fraction of what was newly linked, most of those links are
        # misaligned — that's NOT an improvement, it's confident-wrong-links. Reject it.
        if fault_delta > MISALIGNED_REJECT_RATIO * total_gain:
            return 'reject', (f"it linked {total_gain} more but introduced ~{fault_delta} audit "
                              f"fault(s) — most of the new links look misaligned, which is worse "
                              f"than leaving them unlinked")
        caveats = []
        if introduced:
            caveats.append(f"new flag {sorted(introduced)}")
        if fault_delta > 0:
            caveats.append(f"~{fault_delta} of {total_gain} new link(s) may be misaligned — worth a check")
        return 'improved', ("improved this document"
                            + (" — caveat: " + "; ".join(caveats) if caveats else ""))

    # CORRECTNESS WIN with no link-count gain: the conversion linked the same but has FEWER audit
    # faults (e.g. stopped mis-counting bibliography entries as orphaned footnote definitions), with
    # no new flag introduced and without editing the audit. Reducing orphans/gaps IS an improvement
    # (a wrong/orphan link is worse than a clean omission) — credit it so the loop stops rejecting
    # correct fixes that don't happen to raise the link COUNT.
    if creditable_fault_drop and not introduced:
        return 'improved', (f"reduced audit faults {b_faults}→{a_faults} (e.g. fewer orphaned "
                            f"definitions / numbering gaps) with no new faults — a correctness win "
                            f"even though the link count didn't rise")

    # HEADING win: the conversion recovered document structure — more headings, the top-level title
    # (h1) appearing where there was none, or a cleaner hierarchy. Objectively measured; the user judges
    # whether they're the RIGHT headings via Keep/Revert.
    head_win = (ah.get('total', 0) > bh.get('total', 0)
                or (bh.get('h1', 0) == 0 and ah.get('h1', 0) > 0)
                or ah.get('gaps', 0) < bh.get('gaps', 0))
    if head_win:
        cav = (" — caveat: new flag " + str(sorted(introduced))) if introduced else ""
        return 'improved', (f"recovered document headings ({bh.get('total', 0)}→{ah.get('total', 0)}, "
                            f"h1 {bh.get('h1', 0)}→{ah.get('h1', 0)})" + cav)

    # READER-REPORTED 'wrongly matched' — the ONE dimension counts can't capture (a confident-wrong link
    # still counts as linked). If the reader flagged it AND the patch touched a matching module AND nothing
    # measurable regressed (we got here, so no regression fired), offer it for the human to Keep/Revert.
    _wrongly = {'citations_wrongly_matched', 'footnotes_wrongly_matched'} & set(issue_types or [])
    if _wrongly and patched_files:
        _matchers = {'bibliography.py', 'refkeys.py', 'citation_link_rules.py',
                     'footnote_link_rules.py', 'footnotes.py'}
        if any(os.path.basename(p or '') in _matchers for p in patched_files):
            return 'improved', ("addressed a reader-reported WRONG match (" + ", ".join(sorted(_wrongly))
                                + ") — this can't be auto-verified; review the result and Keep or Revert")

    return 'reject', "no measurable improvement to this document"




def _pick_best(current, candidate):
    """Best-of-N selector for the retry loop, ORDER-INDEPENDENT. Rank = (score, is_clean): higher
    score wins (more content correctly linked); a 'clean' result (no residual flags) breaks ties.
    So the best attempt is applied no matter WHEN it appeared — attempt 1 is kept if it's the best, a
    weaker later attempt never displaces it, and a late low-value 'clean' can't stomp an earlier
    high-value 'improved'. Each arg is a candidate dict ({score, tier, funcs, …}) or None."""
    if current is None:
        return candidate
    if candidate is None:
        return current
    key = lambda c: (c['score'], c['tier'] == 'clean')
    return candidate if key(candidate) > key(current) else current

"""vibeConverter.diagnosis — decide which assessment forks are real problems (the LLM's leads)."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob




def _is_problem(r):
    """A fork worth sending the LLM: low confidence, a fall-through, an audit verdict that
    found real linking faults, or a step the pipeline declined while UNSURE. A high-confidence
    deliberate skip is NOT a problem — e.g. 'citation scan skipped — no bibliography entries'
    at confidence 1.0 is a correct non-action; flagging it sends the model chasing a non-bug."""
    conf = r.get('confidence')
    if (conf is not None and conf < 0.5) or 'FALL-THROUGH' in (r.get('margin') or ''):
        return True
    dec = (r.get('decision') or '').lower()
    if 'faulty' in dec:
        return True
    # The footnote audit can read 'clean' yet still have many orphaned definitions —
    # audit.py's verdict only tests unmatched *refs*, not unmatched *defs* (see the
    # aarushi2025attention case: 239 refs / 477 defs / 238 orphans, stamped 'clean').
    # Catch it on the evidence: any broken ref/gap, or a large unmatched-def share.
    if r.get('module') == 'footnote_audit':
        ev = r.get('evidence') or {}
        if ev.get('gaps') or ev.get('unmatched_refs'):
            return True
        udef, defs = ev.get('unmatched_defs', 0), ev.get('total_defs', 0)
        return bool(defs) and udef / defs >= 0.15
    # The EPUB linking outcome (FootnoteConverter): definitions DETECTED but never linked. This is
    # the signal that was missing — it routes a fixer to the LINKER, not the detectors. Flag on a
    # meaningful orphan share (catastrophic cases are already caught by the conf<0.5 check above).
    if r.get('module') == 'footnote_linking':
        ev = r.get('evidence') or {}
        od, tot = ev.get('orphaned_defs', 0), ev.get('detected_footnotes', 0)
        return bool(tot) and od / tot >= 0.15
    # A declined step is a lead ONLY when the pipeline wasn't sure. A confident, deliberate
    # skip (conf >= 0.8) is a correct non-action, not a code limitation.
    if conf is not None and conf >= 0.8:
        return False
    return any(w in dec for w in ('skipped', 'suppress', 'no footnotes detected'))




def flagged_forks(records):
    """The forks the pipeline was unsure about or declined — the LLM's leads."""
    return [r for r in records if _is_problem(r)]

"""vibeConverter.loop — the user-facing bounded-retry orchestrator."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.artifacts import (_stat_summary, load_artifacts)
from vibeConverter.diagnosis import (flagged_forks)
from vibeConverter.gate import (_pick_best, _problem_set, _rank_key, evaluate)
from vibeConverter.patch import (apply_function_replacements, validate_replacements)
from vibeConverter.prompt import (build_prompt)
from vibeConverter.propose import (propose_patch)
from vibeConverter.report import (_finalize, _persist_patch)
from vibeConverter.routing import (_flagged_phrase, _issue_report_phrase, _issue_working_phrase, modules_for)
from vibeConverter.runtime import (DEFAULT_DEEPSEEK_MODEL, _cancelled, _model_label, _use_now, emit, reset_usage)
from vibeConverter.sandbox import (_reconvert, make_sandbox)




def _candidate_signals(art, after, base_faults):
    """Quality signals for a re-converted candidate: the raw link count, the audit faults it leaves, the
    NEW faults vs baseline (`fault_delta` = the false-positive proxy the ranker penalises), the link gain,
    and a human stat line."""
    st = after['stats']
    _, a_faults = _problem_set(after['assessment'], after['audit'])
    b = art['stats']
    fn_gain = st.get('footnotes_matched', 0) - b.get('footnotes_matched', 0)
    cit_gain = st.get('citations_linked', 0) - b.get('citations_linked', 0)
    return {'score': st.get('footnotes_matched', 0) + st.get('citations_linked', 0),
            'faults': a_faults, 'fault_delta': a_faults - base_faults,
            'total_gain': max(0, fn_gain) + max(0, cit_gain), 'after': _stat_summary(st)}


def _revalidate_candidate(book_dir, art, cand, base_faults, issue_types):
    """Re-run a candidate's patch in a FRESH sandbox + re-convert (forcing docker when configured — a
    second, isolated, deterministic read) and re-evaluate. Returns the candidate with re-measured signals,
    or None if it now crashes / regresses — so a one-off inflated count can't win."""
    sandbox = make_sandbox()
    try:
        applied, _out = apply_function_replacements(sandbox, cand['funcs'])
        if not applied:
            return None
        after = _reconvert(sandbox, book_dir)
        tier, why = evaluate(art, after, patched_files=[f.get('file') for f in cand['funcs']],
                             issue_types=issue_types)
        if tier not in ('clean', 'improved'):
            return None
        return {**cand, 'tier': tier, 'why': why, **_candidate_signals(art, after, base_faults)}
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def _select_winner(book_dir, art, candidates, base_faults, issue_types, force_revalidate=False):
    """Choose the candidate to APPLY. One candidate → take it (or re-validate it first when
    `force_revalidate`, e.g. the mid-loop 'use this one'). ≥2 → RE-VALIDATE the top-2 (by true-positive
    rank) in a fresh sandbox/docker and pick from the re-measured signals, so the applied winner is genuinely
    best — not a candidate whose higher count was inflated by false positives in a single measurement."""
    pool = [c for c in candidates if c.get('tier') in ('clean', 'improved')]
    if not pool:
        return None
    if len(pool) < 2:
        if force_revalidate:
            emit('compare', "Re-testing the fix in an isolated sandbox before applying…")
            r = _revalidate_candidate(book_dir, art, pool[0], base_faults, issue_types)
            return r if r is not None else pool[0]   # if it now regresses, still offer what passed before
        return pool[0]
    top = sorted(pool, key=_rank_key, reverse=True)[:2]
    emit('compare', "Two attempts improved this document — re-testing both to make sure the "
         "better-looking one isn't just inflated by false positives…")
    revalidated = [r for r in (_revalidate_candidate(book_dir, art, c, base_faults, issue_types) for c in top)
                   if r is not None]
    chosen = None
    for r in revalidated:
        chosen = _pick_best(chosen, r)
    if chosen is None:                       # both failed re-validation → fall back to the pre-validation pool
        for c in pool:
            chosen = _pick_best(chosen, c)
    else:
        emit('compare', f"Chose the fix with the most CORRECT links ({chosen['after']}; "
             f"~{max(0, chosen.get('fault_delta', 0))} flagged as misaligned) over the higher raw count.")
    return chosen


def _apply_winner(book_dir, art, candidates, base_faults, issue_types, journal, force_revalidate=False):
    """Select the winning candidate, persist it (→ vibe_patch.json for the job's apply), finalise the
    report, and emit the terminal 'success' beat. Returns the winner dict, or None if nothing improved.
    Shared by the end-of-loop and the mid-loop 'use this one' path."""
    winner = _select_winner(book_dir, art, candidates, base_faults, issue_types,
                            force_revalidate=force_revalidate)
    if winner is None:
        return None
    _persist_patch(book_dir, {'rationale': winner['rationale']}, winner['funcs'])
    _finalize(book_dir, art, journal, winner['tier'], best=winner, file_issue=False)
    if winner['tier'] == 'clean':
        emit('success', f"Fixed it cleanly — {winner['after']}.",
             tier='clean', before=_stat_summary(art['stats']), after=winner['after'],
             rationale=winner['rationale'][:300])
    else:
        emit('success', f"Improved your document — {winner['after']}. {winner['why']}",
             tier='improved', before=_stat_summary(art['stats']), after=winner['after'],
             caveat=winner['why'], rationale=winner['rationale'][:300])
    return winner


def run_loop(book_dir, max_attempts, model, mock_diff=None, user_note=None, file_issue=False, issue_types=None):
    """The user-facing path: bounded retry. Each attempt asks the LLM for a patch, applies
    it in a throwaway sandbox, re-converts THIS document, and evaluates. On failure it feeds
    the new result back to the LLM and tries again — up to max_attempts. The winning diff is
    written to <book_dir>/vibe_patch.diff so an 'accept' step can apply it. Returns (rc, diff)."""
    model = model or DEFAULT_DEEPSEEK_MODEL          # --model None → this engine's default (see top)
    reset_usage()  # per-case token/cost accounting → snapshotted into the report by _finalize
    art = load_artifacts(book_dir)
    flagged = flagged_forks(art['assessment'])
    modules = modules_for(flagged, art, issue_types) or modules_for(art['assessment'], art, issue_types)
    base_flagged, base_faults = _problem_set(art['assessment'], art['audit'])
    # Narrate the problem the way the USER reported it when they picked one (issue_types) — they told us
    # what's wrong, so don't narrate the pipeline's own (possibly different / chronic / false) flag. Only
    # when no issue was selected do we describe the converter's own uncertain decision. (Not a misleading
    # "fell outside N of M pathways" — usually just one decision was uncertain here.)
    report_phrase = _issue_report_phrase(issue_types)
    working_phrase = _issue_working_phrase(issue_types) or _flagged_phrase(flagged)
    if report_phrase:
        start_msg = (f"Your document converted as: {_stat_summary(art['stats'])} — you flagged "
                     f"{report_phrase}. The model ({_model_label(model)}) will analyse why, propose a "
                     f"pipeline fix, and test it on THIS document. This takes a minute or two per attempt "
                     f"(up to {max_attempts}) — hang tight.")
    else:
        start_msg = (f"Your document converted as: {_stat_summary(art['stats'])} — but the converter "
                     f"wasn't sure about {working_phrase}. The model ({_model_label(model)}) will analyse "
                     f"why, propose a pipeline fix, and test it on THIS document. This takes a minute or "
                     f"two per attempt (up to {max_attempts}) — hang tight.")
    emit('start', start_msg,
         baseline=_stat_summary(art['stats']), flagged=sorted(base_flagged),
         modules=modules, max_attempts=max_attempts, user_note=bool(user_note))

    feedback = ""
    best = None  # running best (quality-aware) — for the mid-loop display + cancel record
    candidates = []  # EVERY clean/improved attempt (patch + quality signals) → _select_winner picks the apply
    journal = []  # per-attempt record → vibe_report.json + the GitHub issue body
    for attempt in range(1, max_attempts + 1):
        if _cancelled():
            emit('cancelled', "Cancelled — your original conversion is unchanged.")
            _finalize(book_dir, art, journal, 'cancelled', best=best, file_issue=False)
            return 1, None
        # "Use this one" (mid-loop): the reader liked an early attempt — stop searching and APPLY the best
        # found so far (re-validated in docker first). Only fires once an improving attempt exists.
        if _use_now() and candidates:
            emit('use_now', "Applying the best fix found so far, at your request…")
            winner = _apply_winner(book_dir, art, candidates, base_faults, issue_types, journal,
                                   force_revalidate=True)
            if winner is not None:
                return 0, winner['funcs']
        emit('attempt',
             f"The model ({_model_label(model)}) is working out {working_phrase}… "
             f"(attempt {attempt} of {max_attempts})",
             attempt=attempt, max_attempts=max_attempts)
        try:
            patch = propose_patch(build_prompt(art, modules, user_note=user_note, issue_types=issue_types) + feedback,
                                  mock_diff=mock_diff, model=model)
        except ValueError as e:
            # Transient (e.g. truncated JSON) — retry this attempt rather than aborting.
            emit('proposed', f"Model response unusable ({e}); retrying…", attempt=attempt)
            feedback = (f"\n\n## Attempt {attempt} feedback\nYour last response {e}. Return COMPACT "
                        f"valid JSON — change as FEW / as SMALL functions as possible to keep the "
                        f"reply short enough to complete.")
            if mock_diff:
                break
            continue
        except SystemExit as e:
            emit('error', f"The model call failed: {e}")
            return 1, None
        funcs = patch.get('functions', [])
        _touch = [f"{f.get('file','?').split('/')[-1]}:{f.get('name','?')}" for f in funcs]
        # Co-evolution signal for the post-mortem: which fix-categories + ops the model reached for.
        _meta = {'categories': sorted({(f.get('category') or '?') for f in funcs}),
                 'ops': sorted({(f.get('op') or 'replace') for f in funcs})}
        emit('proposed',
             f"The model ({_model_label(model)}) is proposing an update to the conversion pipeline "
             f"({', '.join(_touch) or 'no change'}): {patch.get('rationale', '')[:160]}",
             attempt=attempt, touches=_touch)

        ok, reason, _ = validate_replacements(funcs)
        if not ok:
            journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                            'touches': _touch, 'tier': 'rejected', 'why': reason, 'stats': None, **_meta})
            emit('rejected', f"Proposed change was out of bounds ({reason}); retrying…",
                 attempt=attempt)
            feedback = (f"\n\n## Attempt {attempt} feedback\nYour reply was rejected: {reason}. "
                        f"Return {{rationale, functions:[{{file,name,code}}]}} with full function "
                        f"bodies in allowed modules only.")
            if mock_diff:
                break
            continue

        sandbox = make_sandbox()
        try:
            applied, out = apply_function_replacements(sandbox, funcs)
            if not applied:
                # Structural apply-fails (a needed shape the format couldn't represent) are the
                # 'inexpressible' signal the post-mortem uses to route work to the patch-format.
                inexpressible = ('use op:add' in out or 'no such module-level' in out
                                 or 'already exists' in out)
                journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                                'touches': _touch, 'tier': 'apply_failed', 'why': out[:200],
                                'stats': None, 'inexpressible': inexpressible, **_meta})
                emit('apply_failed', f"The fix couldn't be applied ({out}); retrying…", attempt=attempt)
                feedback = (f"\n\n## Attempt {attempt} feedback\nCouldn't apply your replacement: "
                            f"{out}. Return the COMPLETE current function body (exact name, valid "
                            f"Python) for each function you change.")
                if mock_diff:
                    break
                continue
            emit('reconverting',
                 "Running the proposed pipeline on THIS document to confirm it actually makes "
                 "things better (and breaks nothing else here)…", attempt=attempt)
            after = _reconvert(sandbox, book_dir)
            tier, why = evaluate(art, after, patched_files=[f.get('file') for f in funcs],
                                 issue_types=issue_types)
            st = after['stats']
            journal.append({'attempt': attempt, 'diagnosis': patch.get('rationale', '')[:600],
                            'touches': _touch, 'tier': tier, 'why': why, 'stats': _stat_summary(st), **_meta})
            if tier in ('clean', 'improved'):
                cand = {'attempt': attempt, 'funcs': funcs, 'rationale': patch.get('rationale', ''),
                        'why': why, 'tier': tier, 'before': _stat_summary(art['stats']),
                        **_candidate_signals(art, after, base_faults)}
                candidates.append(cand)   # every improving attempt is kept; _select_winner picks the apply
                # Track the running best (order-independent, quality-aware — see _pick_best) for the mid-loop
                # display + the cancel record; the FINAL applied winner is chosen by _select_winner below.
                best = _pick_best(best, cand)
                if tier == 'clean':
                    # The flagged problem is fully resolved — stop searching (more attempts only risk
                    # regression), but APPLY whichever candidate ranked best (maybe an earlier 'improved').
                    emit('improved_partial', f"Fixed it cleanly — {_stat_summary(st)}. Finalising the "
                         f"best result found across attempts…", attempt=attempt)
                    break
                emit('improved_partial',
                     f"Better — {_stat_summary(st)} ({why}). Keeping the best so far and "
                     f"trying for a cleaner fix…", attempt=attempt)
            else:
                emit('not_yet', f"Not quite — {_stat_summary(st)} ({why}). Telling the model "
                     f"why and trying again…", attempt=attempt)
            nf, _ = _problem_set(after['assessment'], after['audit'])
            crash = (f"\nThe re-conversion crashed with:\n{after['stderr']}"
                     if after.get('stderr') else "")
            feedback = (f"\n\n## Attempt {attempt} feedback\nYour change applied, but {why}. "
                        f"New stats: {_stat_summary(st)}; flagged now: {sorted(nf)}.{crash}\n"
                        f"The footnote definitions DO exist (see the def-looking lines above) — match "
                        f"them to the [^N] refs and emit [^N]: definitions, WITHOUT introducing "
                        f"numbering gaps or unmatched refs. Try a more complete fix.")
        finally:
            shutil.rmtree(sandbox, ignore_errors=True)
        if mock_diff:
            break

    # Choose the winner to APPLY: with ≥2 improving attempts, _select_winner re-validates the top-2 in
    # docker so a false-positive-inflated count can't win. Accepting is non-destructive (nodes_history
    # archives the original to revert).
    winner = _apply_winner(book_dir, art, candidates, base_faults, issue_types, journal)
    if winner is not None:
        return 0, winner['funcs']

    report = _finalize(book_dir, art, journal, 'exhausted', best=None, file_issue=file_issue)
    suffix = (f" Opened GitHub issue: {report['issue_url']}" if report.get('issue_url') else "")
    emit('exhausted',
         f"The model ({_model_label(model)}) tried {max_attempts} different fixes but couldn't improve "
         f"this document, so we've kept your original and logged it for a human to review.{suffix}",
         issue_url=report.get('issue_url'))
    return 1, None

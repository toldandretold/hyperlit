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
from vibeConverter.gate import (_pick_best, _problem_set, evaluate)
from vibeConverter.patch import (apply_function_replacements, validate_replacements)
from vibeConverter.prompt import (build_prompt)
from vibeConverter.propose import (propose_patch)
from vibeConverter.report import (_finalize, _persist_patch)
from vibeConverter.routing import (_flagged_phrase, _issue_report_phrase, _issue_working_phrase, modules_for)
from vibeConverter.runtime import (DEFAULT_DEEPSEEK_MODEL, _cancelled, _model_label, emit, reset_usage)
from vibeConverter.sandbox import (_reconvert, make_sandbox)




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
    best = None  # highest-scoring 'improved' result — offered if no fully-clean fix is found
    journal = []  # per-attempt record → vibe_report.json + the GitHub issue body
    for attempt in range(1, max_attempts + 1):
        if _cancelled():
            emit('cancelled', "Cancelled — your original conversion is unchanged.")
            _finalize(book_dir, art, journal, 'cancelled', best=best, file_issue=False)
            return 1, None
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
                score = st.get('footnotes_matched', 0) + st.get('citations_linked', 0)
                cand = {'funcs': funcs, 'rationale': patch.get('rationale', ''),
                        'after': _stat_summary(st), 'why': why, 'score': score, 'tier': tier}
                # Keep the BEST across ALL attempts, INDEPENDENT OF ORDER (see _pick_best): the first
                # attempt is kept if it's the best, a weaker later attempt never overwrites it, and a
                # late LOW-value 'clean' can no longer stomp an earlier HIGH-value 'improved'.
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

    if best is not None:
        # Apply the best result found across ALL attempts (clean preferred, else highest-scoring
        # improvement). Accepting is non-destructive (nodes_history archives the original to revert).
        _persist_patch(book_dir, {'rationale': best['rationale']}, best['funcs'])
        _finalize(book_dir, art, journal, best['tier'], best=best, file_issue=False)
        if best['tier'] == 'clean':
            emit('success', f"Fixed it cleanly — {best['after']}.",
                 tier='clean', before=_stat_summary(art['stats']), after=best['after'],
                 rationale=best['rationale'][:300])
        else:
            emit('success', f"Improved your document — {best['after']}. {best['why']}",
                 tier='improved', before=_stat_summary(art['stats']), after=best['after'],
                 caveat=best['why'], rationale=best['rationale'][:300])
        return 0, best['funcs']

    report = _finalize(book_dir, art, journal, 'exhausted', best=None, file_issue=file_issue)
    suffix = (f" Opened GitHub issue: {report['issue_url']}" if report.get('issue_url') else "")
    emit('exhausted',
         f"The model ({_model_label(model)}) tried {max_attempts} different fixes but couldn't improve "
         f"this document, so we've kept your original and logged it for a human to review.{suffix}",
         issue_url=report.get('issue_url'))
    return 1, None

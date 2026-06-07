"""Digestion — AUDIT DocPass (validate footnote linking; write audit.json + conversion_stats.json).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
from shared.assessment import ASSESSMENT
from shared.pipeline_base import DocPass
from digestion._doc_shared import _detect_file_type
from digestion.finalAudit.audit import assess_link_fidelity
from digestion.finalAudit.audit import compute_footnote_audit
from digestion._doc_shared import emit_progress
import json
import os


class AuditPass(DocPass):
    name = 'audit'
    description = '[standard] Validate footnote linking (gaps/unmatched), record the VERDICT, write audit + stats.'
    plain = ('The final report card: did every footnote marker find its definition, with no gaps or '
             'leftover orphans? Records the verdict the fix-loop reacts to. Note: per-chapter numbering '
             'gaps are EXPECTED in renumbered books — a "faulty" stamp on those is over-flagging, not a '
             'real linking failure.')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        soup = ctx.soup
        output_dir = ctx.output_dir
        # ====================================================================
        # AUDIT PASS: Validate footnote linking
        # ====================================================================
        emit_progress(77, "doc_audit", "Validating footnote linking")
        print("\n--- AUDIT: Validating footnote linking ---")
        audit_data = compute_footnote_audit(soup, ctx.footnotes_data)

        print(f"📊 Audit: {audit_data['total_refs']} refs, {audit_data['total_defs']} defs, "
              f"{len(audit_data['gaps'])} gaps, {len(audit_data['duplicates'])} duplicates, "
              f"{len(audit_data['unmatched_refs'])} unmatched refs, {len(audit_data['unmatched_defs'])} unmatched defs")
        _n_gaps, _n_uref, _n_udef = (len(audit_data['gaps']), len(audit_data['unmatched_refs']),
                                     len(audit_data['unmatched_defs']))
        _n_dup = len(audit_data['duplicates'])
        _faults = _n_gaps + _n_uref + _n_udef
        _total = audit_data['total_refs'] + audit_data['total_defs']
        # The VERDICT (did the chosen path work?) — the second half of the diagnostic loop
        # alongside the strategy/linking forks. Falsifiable: names WHICH refs/defs are unmatched.
        ASSESSMENT.record(
            module='footnote_audit',
            code_ref='audit.py:compute_footnote_audit',
            node_help=self.plain,
            decision=('clean' if (_n_gaps == 0 and _n_uref == 0) else 'faulty'),
            rationale=(f"{audit_data['total_refs']} refs / {audit_data['total_defs']} defs; "
                       f"{_n_gaps} numbering gaps, {_n_uref} unmatched refs, {_n_udef} unmatched defs"),
            evidence={'total_refs': audit_data['total_refs'], 'total_defs': audit_data['total_defs'],
                      'gaps': _n_gaps, 'unmatched_refs': _n_uref, 'unmatched_defs': _n_udef,
                      'duplicates': _n_dup,
                      'gap_sample': [g.get('missing') for g in audit_data['gaps'][:8]],
                      'unmatched_ref_sample': [u.get('ref_id') for u in audit_data['unmatched_refs'][:8]],
                      'unmatched_def_sample': [u.get('footnote_id') for u in audit_data['unmatched_defs'][:8]]},
            question='Did the footnote linking produce a clean ref/def correspondence? (the VERDICT)',
            confidence=round(1.0 if not _total else max(0.0, 1 - _faults / max(_total, 1)), 2),
            margin=('no gaps or unmatched markers — footnote linking is sound' if not _faults
                    else f'{_n_uref} marker(s) with no definition + {_n_udef} definition(s) never '
                         f'referenced + {_n_gaps} numbering gap(s) — cross-check the linker/extractor'),
        )

        # Annotate audit with mojibake warnings + segment info pulled from footnote_meta.json
        audit_data['font_encoding_warnings'] = ctx.footnote_warnings
        audit_data['segment_boundaries'] = ctx.segment_boundaries
        ctx.audit_data = audit_data

        # Write audit.json
        os.makedirs(output_dir, exist_ok=True)
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (standard path)
        # Determine citation style from what was detected
        if len(ctx.references_data) > 0 and ctx.citations_found > 0:
            citation_style = 'author-year-bracket'
        elif len(ctx.references_data) > 0:
            citation_style = 'bibliography-only'
        else:
            citation_style = 'none'

        conversion_stats = {
            'references_found': len(ctx.references_data),
            'citations_total': ctx.citations_found,
            'citations_linked': ctx.citations_linked,
            'footnotes_matched': len(ctx.all_footnotes_data),
            'footnote_strategy': ctx.strategy,
            'citation_style': citation_style,
            'font_encoding_warning_count': len(ctx.footnote_warnings),
            'segment_count': len(ctx.segment_boundaries) + 1 if ctx.segment_boundaries else 1,
            'file_type': _detect_file_type(output_dir),
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

        # Cross-stage "whose bug is it": when a late symptom (0 citations / 0 footnote markers linked) was
        # caused UPSTREAM, record a flagged fork naming the upstream stage — so the fix-loop is sent there,
        # not the linker. Diagnostic-only (records to the trace; no soup/output change). Conservative: a
        # deliberate guard-suppression is not flagged. `ASSESSMENT.records` spans ingestion+digestion.
        for _fork in assess_link_fidelity(conversion_stats, audit_data, ASSESSMENT.records):
            ASSESSMENT.record(**_fork)

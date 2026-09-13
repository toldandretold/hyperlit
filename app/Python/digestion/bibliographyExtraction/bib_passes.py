"""Digestion — BIBLIOGRAPHY-extraction DocPasses (the STEM numeric-ref branch + the standard author-year extract).
Extracted from process_document.py (the orchestrator imports these into DOC_PASSES)."""
from shared.pipeline_base import DocPass
from digestion._doc_shared import _detect_file_type
from digestion._doc_shared import emit_progress
from digestion.bibliographyExtraction.bibliography import (
    extract_bibliography, merge_grobid_into_bibliography,
    assess_bibliography_health, _find_reference_paragraphs,
)
from shared.assessment import ASSESSMENT
import json
import os
import re


class StemBibliography(DocPass):
    name = 'stem_bibliography'
    description = '[STEM only] Convert wackSTEM markers to bib-entry/in-text-citation; write audit + stats.'
    plain = ('The digestion half of the wackSTEM path: the numbered [1] markers + reference list (wrapped '
             'by the PDF frontend) become bib-entries and in-text citations. A terminal branch — the '
             'normal footnote passes are skipped for STEM docs.')

    def apply(self, ctx):
        # ====================================================================
        # STEM BIBLIOGRAPHY PROCESSING (wackSTEMbibliographyNotes)
        # ====================================================================
        if not ctx.is_stem:
            return
        soup = ctx.soup
        output_dir = ctx.output_dir
        references_data = []
        footnotes_data = []
        all_footnotes_data = []

        # Convert wackSTEMdef → bib-entry and collect references. `emitted_ids` is the set of
        # anchors that actually EXIST — the citation loop below must not invent hrefs past it.
        emitted_ids = set()
        for a_tag in soup.find_all('a', class_='wackSTEMdef'):
            ref_id = a_tag.get('id', '')
            a_tag['class'] = 'bib-entry'
            # Store just the text for popup display (not the <a>/<p> wrapper)
            ref_text = a_tag.get_text()
            if ref_text:
                references_data.append({"referenceId": ref_id, "content": ref_text})
                if ref_id:
                    emitted_ids.add(ref_id)

        # Convert wackSTEMcite → in-text-citation with href — but ONLY where the target anchor
        # exists. The number here comes from the marker's own visible text, so nothing else ties
        # it to reality: when the OCR loses reference entries (a degenerate page, a dropped
        # column) the tail of the citations used to be linked to anchors that were never emitted,
        # and every one of those links was dead. A marker we cannot resolve stays PLAIN TEXT —
        # correct where determinable, no link where ambiguous — and is counted below instead.
        stem_cites = 0
        stem_linked = 0
        unmatched_refs = []
        for a_tag in soup.find_all('a', class_='wackSTEMcite'):
            stem_cites += 1
            cite_text = a_tag.get_text()
            data_refs = [r for r in (a_tag.get('data-refs') or '').split(',') if r]
            if data_refs:
                # Range citation ("[1-3]"): keep only the members that resolve, so the popup can
                # never offer a dead target, and point href at the first surviving one.
                live = [r for r in data_refs if r in emitted_ids]
                target = live[0] if live else None
                if live:
                    a_tag['data-refs'] = ','.join(live)
                else:
                    del a_tag['data-refs']
            else:
                num_match = re.search(r'\d+', cite_text)
                candidate = f'stemref_{num_match.group()}' if num_match else None
                target = candidate if candidate in emitted_ids else None
            if target:
                a_tag['href'] = f'#{target}'
                a_tag['class'] = 'in-text-citation'
                stem_linked += 1
            else:
                # Unlinkable: unwrap to plain text so it is not styled as a live link.
                unmatched_refs.append({'citation': cite_text.strip()})
                a_tag.unwrap()

        print(f"Converted {len(references_data)} STEM bibliography entries")
        print(f"Converted {stem_linked} of {stem_cites} STEM in-text citations"
              + (f" ({len(unmatched_refs)} left unlinked — no such reference entry)"
                 if unmatched_refs else ""))

        # Write audit.json. These counts are REAL: the STEM branch used to hardcode empty
        # gaps/unmatched and report citations_linked == citations_total, so a document whose
        # reference list the OCR had truncated still scored 100% linked and the maintainer queue
        # could never surface it (stem_bibliography_example: 156/156 reported, 56 of them dead).
        os.makedirs(output_dir, exist_ok=True)
        audit_data = {
            'stem_mode': True,
            'total_refs': stem_cites,
            'total_defs': len(references_data),
            'gaps': [], 'duplicates': [],
            'unmatched_refs': unmatched_refs, 'unmatched_defs': [],
            'font_encoding_warnings': ctx.footnote_warnings,
            'segment_boundaries': ctx.segment_boundaries,
        }
        with open(os.path.join(output_dir, 'audit.json'), 'w', encoding='utf-8') as f:
            json.dump(audit_data, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'audit.json')}")

        # Write conversion_stats.json (STEM path)
        conversion_stats = {
            'references_found': len(references_data),
            'citations_total': stem_cites,
            'citations_linked': stem_linked,
            'footnotes_matched': 0,
            'footnote_strategy': 'stem_bibliography',
            'citation_style': 'numbered-bracket',
            'font_encoding_warning_count': len(ctx.footnote_warnings),
            'segment_count': len(ctx.segment_boundaries) + 1 if ctx.segment_boundaries else 1,
            'file_type': _detect_file_type(output_dir),
        }
        with open(os.path.join(output_dir, 'conversion_stats.json'), 'w', encoding='utf-8') as f:
            json.dump(conversion_stats, f, ensure_ascii=False, indent=4)
        print(f"Successfully created {os.path.join(output_dir, 'conversion_stats.json')}")

        # The STEM branch is terminal — AuditPass returns early for it (audit_pass.py) — so without
        # this record the whole class of document had NO assessment entry at all and its failures
        # were invisible to the maintainer loop and the vibe loop alike. FLAGS suspicion, never
        # asserts failure: a shortfall here is usually an upstream OCR loss (a degenerate or
        # dropped reference page), not a linking bug, so it names the gap and asks for a look.
        _unlinked = len(unmatched_refs)
        _cited_max = max((int(m.group()) for a in unmatched_refs
                          for m in [re.search(r'\d+', a['citation'])] if m), default=0)
        ASSESSMENT.record(
            module='stem_citation_link_audit',
            code_ref='bib_passes.py:StemBibliography.apply',
            node_help=self.plain,
            decision=('clean' if _unlinked == 0 else 'reference_entries_missing'),
            rationale=(f'{stem_linked} of {stem_cites} numbered citation(s) resolved against '
                       f'{len(references_data)} reference entr(y/ies)'
                       + ('' if _unlinked == 0 else
                          f'; {_unlinked} cited number(s) have no entry (highest cited '
                          f'{_cited_max}) — the reference list is shorter than the citations')),
            evidence={'citations_total': stem_cites, 'citations_linked': stem_linked,
                      'references_found': len(references_data), 'unlinked': _unlinked,
                      'unlinked_sample': [a['citation'] for a in unmatched_refs[:8]],
                      'highest_cited_unresolved': _cited_max},
            question='Did every numbered [N] citation find its reference entry?',
            considered=['clean', 'reference_entries_missing'],
            confidence=round(1.0 if not stem_cites else stem_linked / stem_cites, 2),
            margin=('every numbered citation resolved' if _unlinked == 0 else
                    f'{_unlinked} citation(s) left as plain text rather than linked to a '
                    f'non-existent anchor — SUSPECT the OCR dropped reference entries (check the '
                    f'reference pages in ocr_response.json) before suspecting the linker'),
        )

        ctx.references_data = references_data
        ctx.footnotes_data = footnotes_data
        ctx.all_footnotes_data = all_footnotes_data


class ExtractBibliography(DocPass):
    name = 'extract_bibliography'
    description = '[standard] PASS 1A — build the bibliography key→entry-id map + references data.'
    plain = ('Find the reference list and give each entry an id, so in-text citations have something to '
             'point at. If citations do not link, suspect THIS (the link targets are missing) before '
             'blaming the citation linker.')

    def apply(self, ctx):
        if ctx.is_stem:
            return
        # ====================================================================
        # PASS 1: EXTRACT ALL DEFINITIONS
        # ====================================================================
        emit_progress(52, "doc_bibliography", "Scanning for bibliography")
        print("--- PASS 1: Extracting All Definitions ---")

        # --- 1A: Process Bibliography / References → conversion/bibliography.py ---
        # GROBID SURGICAL MERGE (opt-in, never blocking, ADDITIVE-ONLY). The regex extraction ALWAYS
        # runs and its result always stands — the 2026-08 trial (deploy/experiments/grobid.md)
        # showed wholesale GROBID replacement loses ~20% of reference targets even while fixing the
        # glued entries, so GROBID is only allowed to ADD: when the read-only candidate scan flags
        # SUSPECT paragraphs (run-on entries carrying multiple "(year)" patterns; merged over-long
        # blobs) AND env GROBID_URL is set AND the source PDF is on disk, GROBID's segmentation is
        # folded in for entries the regex map cannot reach (all keys absent) that probe-locate
        # INSIDE a suspect paragraph. Nothing regex found is ever removed or overwritten. Every
        # failure mode (env unset, server absent/hung — 5s probe + 120s/300s budgets, bad result)
        # simply adds nothing, so shipping this ahead of any server setup changes nothing.
        # GROBID_ALWAYS=1 forces the attempt even when not suspect (corpus trials; still merges
        # only into suspect paragraphs, so healthy books stay byte-identical by construction).
        suspect_ps = []
        health = None
        grobid_url = os.environ.get('GROBID_URL')
        pdf_path = None
        if grobid_url:
            pdf_path = next((p for p in (os.path.join(ctx.output_dir, 'original.pdf'),
                                         os.path.join(ctx.output_dir, 'source.pdf'))
                             if os.path.isfile(p)), None)
            if pdf_path:
                candidates, _ = _find_reference_paragraphs(ctx.soup)
                health = assess_bibliography_health([p.get_text(' ', strip=True) for p in candidates])
                suspect_ps = [candidates[i] for i in health['suspect_indices']]

        ctx.bibliography_map, ctx.references_data = extract_bibliography(ctx.soup)

        if suspect_ps and (health['suspect'] or os.environ.get('GROBID_ALWAYS') == '1'):
            why = '; '.join(health['reasons']) if health['suspect'] else 'GROBID_ALWAYS=1'
            print(f"  🧪 Bibliography suspect ({why}) — GROBID surgical merge ({grobid_url})")
            added = merge_grobid_into_bibliography(
                ctx.soup, pdf_path, grobid_url, ctx.bibliography_map, ctx.references_data,
                suspect_ps)
            ASSESSMENT.record(
                module='bibliography_health', code_ref='bib_passes.py:ExtractBibliography',
                node_help=('Scores the regex-scanned reference candidates for glued/merged entries '
                           'and, when suspect, folds GROBID-segmented entries INTO the regex '
                           'extraction (additive-only: nothing regex found is removed). A flag, '
                           'not a verdict — added=0 means GROBID could not do better.'),
                decision=f"suspect={health['suspect']} → GROBID surgical merge added {added} entr(y/ies)",
                rationale=why, evidence={**health, 'grobid_added': added},
                question='Did the glued/merged reference blobs hide entries the regex could not key?',
                considered=[], confidence=0.5, margin=why)

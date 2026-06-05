"""Footnote-linking audit: detect gaps, duplicates, and unmatched refs/defs.

Pure function extracted from process_document.py's audit pass — given the linked soup
and the list of footnote definitions, computes the audit_data report (the faultiness
signal the assessment trace + triage consume). No I/O, no soup mutation, so it is
directly unit-testable: build a soup of footnote-ref <sup>s + a defs list, assert the
gaps/duplicates/unmatched counts.
"""

from collections import Counter

# Cap per-gap expansion to avoid millions of entries when lettered footnotes cause
# sparse numeric sequences.
MAX_GAP_EXPANSION = 50


def _audit_context(sup_elem):
    """Extract heading/context for a ref — only called for gaps/duplicates."""
    section_id = sup_elem.get('fn-section-id', '')
    prev_heading = sup_elem.find_previous(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    heading_text = prev_heading.get_text()[:60].strip() if prev_heading else ''
    context_text = sup_elem.parent.get_text()[:120].strip() if sup_elem.parent else ''
    return section_id, heading_text, context_text


def compute_footnote_audit(soup, footnote_defs):
    """Validate footnote linking across the document. Returns the audit_data dict
    (the caller annotates it with font/segment info and writes audit.json)."""
    audit_data = {
        'total_refs': 0,
        'total_defs': len(footnote_defs),
        'gaps': [],
        'duplicates': [],
        'unmatched_refs': [],
        'unmatched_defs': []
    }

    # Walk all footnote-ref sup elements in document order
    all_ref_sups = soup.find_all('sup', class_='footnote-ref')
    audit_data['total_refs'] = len(all_ref_sups)

    # Group into sequences (restart when fn-count-id goes back to a lower number)
    sequences = []  # list of lists of (num, sup_element) tuples
    current_sequence = []
    last_num = 0

    for sup in all_ref_sups:
        fn_count = sup.get('fn-count-id', '0')
        try:
            num = int(fn_count)
        except ValueError:
            continue
        if num <= last_num and current_sequence:
            sequences.append(current_sequence)
            current_sequence = []
        current_sequence.append((num, sup))
        last_num = num

    if current_sequence:
        sequences.append(current_sequence)

    # Check for gaps and duplicates within each sequence
    for seq_idx, sequence in enumerate(sequences):
        numbers_in_seq = [item[0] for item in sequence]

        if numbers_in_seq:
            for i in range(len(numbers_in_seq) - 1):
                current = numbers_in_seq[i]
                next_num = numbers_in_seq[i + 1]
                gap_size = next_num - current - 1
                if gap_size > 0:
                    after_sid, after_heading, after_ctx = _audit_context(sequence[i][1])
                    before_sid, before_heading, before_ctx = _audit_context(sequence[i + 1][1])
                    if gap_size > MAX_GAP_EXPANSION:
                        # Record as a single summary entry instead of expanding
                        audit_data['gaps'].append({
                            'missing': f"{current + 1}-{next_num - 1}",
                            'after_ref': current,
                            'before_ref': next_num,
                            'section': seq_idx + 1,
                            'gap_size': gap_size,
                            'after_ref_context': after_ctx,
                            'after_ref_section_id': after_sid,
                            'after_ref_heading': after_heading,
                            'before_ref_context': before_ctx,
                            'before_ref_section_id': before_sid,
                            'before_ref_heading': before_heading,
                        })
                    else:
                        for missing in range(current + 1, next_num):
                            audit_data['gaps'].append({
                                'missing': missing,
                                'after_ref': current,
                                'before_ref': next_num,
                                'section': seq_idx + 1,
                                'after_ref_context': after_ctx,
                                'after_ref_section_id': after_sid,
                                'after_ref_heading': after_heading,
                                'before_ref_context': before_ctx,
                                'before_ref_section_id': before_sid,
                                'before_ref_heading': before_heading,
                            })

        # Check for duplicates
        num_counts = Counter(numbers_in_seq)
        for num, count in num_counts.items():
            if count > 1:
                dup_item = next((item for item in sequence if item[0] == num), None)
                if dup_item:
                    dup_sid, dup_heading, dup_ctx = _audit_context(dup_item[1])
                else:
                    dup_sid, dup_heading, dup_ctx = '', '', ''
                audit_data['duplicates'].append({
                    'number': num,
                    'section': seq_idx + 1,
                    'count': count,
                    'context': dup_ctx,
                    'heading': dup_heading,
                })

    # Check for unmatched refs (ref exists but no definition linked)
    linked_fn_ids = set()
    for sup in all_ref_sups:
        fn_id = sup.get('id', '')
        if fn_id:
            linked_fn_ids.add(fn_id)

    defined_fn_ids = set()
    for fn in footnote_defs:
        defined_fn_ids.add(fn.get('footnoteId', ''))

    # Refs whose IDs don't appear in definitions
    for sup in all_ref_sups:
        fn_id = sup.get('id', '')
        if fn_id and fn_id not in defined_fn_ids:
            audit_data['unmatched_refs'].append({
                'number': sup.get('fn-count-id', ''),
                'ref_id': fn_id,
                'context': sup.parent.get_text()[:80] if sup.parent else ''
            })

    # Build lookup from definition anchors for number + section metadata
    fn_id_to_metadata = {}
    for a_tag in soup.find_all('a', attrs={'fn-count-id': True}):
        fid = a_tag.get('id', '')
        if fid:
            fn_id_to_metadata[fid] = {
                'number': a_tag.get('fn-count-id', ''),
                'section_id': a_tag.get('fn-section-id', ''),
            }

    # Defs whose IDs don't appear in any ref
    for fn in footnote_defs:
        fn_id = fn.get('footnoteId', '')
        if fn_id and fn_id not in linked_fn_ids:
            meta = fn_id_to_metadata.get(fn_id, {})
            audit_data['unmatched_defs'].append({
                'footnote_id': fn_id,
                'number': meta.get('number', ''),
                'section': meta.get('section_id', ''),
                'definition_preview': fn.get('content', '')[:200]
            })

    return audit_data


# ---------------------------------------------------------------------------
# Cross-stage "whose bug is it" — the digestion analogue of the PDF
# ingestion's assess_harvest_fidelity. Runs AFTER linking + the audit, and
# names the UPSTREAM stage when a late symptom was caused earlier.
# ---------------------------------------------------------------------------
# node_help (one source) for both cross-stage forks below.
_LINK_FIDELITY_PLAIN = (
    "A cross-stage check AFTER linking: when a late symptom (citations or footnotes not linked) is really "
    "caused UPSTREAM, name the upstream stage so the fix lands there. `citations_total` far exceeds "
    "`references_found` with 0 linked ⇒ the LINK TARGETS are missing (bibliography extraction under-counted, "
    "or the citation style was mis-detected) — fixing the linker cannot help. Definitions extracted but 0 "
    "in-text markers linked (and the linkability guard did NOT deliberately suppress) ⇒ detection / the "
    "guard, not the linker or the audit (which only MEASURES the result).")


def _record_for(records, module):
    return next((r for r in records if r.get('module') == module), None)


def assess_link_fidelity(stats, audit_data, records):
    """Cross-stage discriminator for the LINKING stages — returns a list of FLAGGED fork dicts (kwargs for
    ASSESSMENT.record), only when a downstream symptom CLEARLY implies an UPSTREAM cause. Conservative by
    design (a deliberate guard-suppression is NOT a bug). `records` is the assessment trace so far, which
    spans ingestion+digestion, so a fork can attribute back to the real upstream file. Pure / no I/O."""
    out = []
    refs = stats.get('references_found', 0) or 0
    cit_total = stats.get('citations_total', 0) or 0
    cit_linked = stats.get('citations_linked', 0) or 0
    style = stats.get('citation_style', 'none')

    # (1) citation_target_gap — many in-text citations, ~none linked, far fewer reference TARGETS than
    # citations. The cause is upstream (bibliography extraction under-counted, OR the style is mis-detected
    # and these aren't really citations) — the linker can't link to targets that were never extracted.
    if cit_total >= 5 and cit_linked == 0 and refs < cit_total * 0.5:
        bib = _record_for(records, 'bibliography_extraction') or {}
        cit = _record_for(records, 'citation_link_audit') or {}
        detection = (bib.get('evidence') or {}).get('detection', 'unknown')
        unlinked = (cit.get('evidence') or {}).get('unlinked_sample', [])
        out.append(dict(
            module='citation_target_fidelity', code_ref='bibliography.py:extract_bibliography',
            node_help=_LINK_FIDELITY_PLAIN,
            decision=f'{cit_linked} of {cit_total} citations linked, but only {refs} reference target(s) exist',
            rationale=(f'{cit_total} in-text citations were found yet only {refs} bibliography entries exist to '
                       f'point at, and 0 linked — the LINK TARGETS are missing. Most likely the bibliography '
                       f'extraction under-counted (detection={detection}), OR the citation style was '
                       f'mis-detected (style={style}) so these are not really citations. The citation LINKER '
                       f'cannot link to targets that were never extracted; fixing it is futile.'),
            evidence={'references_found': refs, 'citations_total': cit_total, 'citations_linked': cit_linked,
                      'citation_style': style, 'bibliography_detection': detection,
                      'unlinked_sample': unlinked[:8]},
            question="Are the missing citation links the LINKER's fault, or are the targets missing upstream?",
            considered=[
                {'option': 'fix the citation linker', 'rejected_because': '0 of N linked with far fewer '
                 'references than citations means the targets are missing, not mis-matched',
                 'would_need': 'references that exist but were not keyed/matched (see evidence.unlinked_sample)'},
                {'option': 'the style is mis-detected — these are not citations', 'rejected_because': None,
                 'would_need': 'confirm the body really cites (Author Year) works that have entries'}],
            confidence=0.3,
            margin=(f'{cit_total} citations vs {refs} reference targets — look UPSTREAM at bibliography '
                    f'extraction (the targets) or citation-style detection, NOT the linker')))

    # (2) footnote_link_gap — definitions extracted but ~no in-text marker links them, AND the linkability
    # guard did NOT deliberately suppress (a deliberate suppression is the honest-missing-link case, not a
    # bug). So markers were never detected/survived (EPUB detection) — upstream of the linker + the audit.
    defs = audit_data.get('total_defs', 0) or 0
    total_refs = audit_data.get('total_refs', 0) or 0
    udef = len(audit_data.get('unmatched_defs', []))
    guard = _record_for(records, 'footnote_linking_guard')
    guard_suppressed = bool(guard) and 'suppress' in str(guard.get('decision', '')).lower()
    if defs >= 5 and total_refs == 0 and udef >= defs * 0.8 and not guard_suppressed:
        is_epub = any(r.get('module') in ('epub_footnote_detection', 'footnote_linking') for r in records)
        code_ref = ('footnoteMatching.py:FootnoteConverter.convert' if is_epub
                    else 'footnotes.py:process_whole_document_footnotes')
        out.append(dict(
            module='footnote_link_fidelity', code_ref=code_ref, node_help=_LINK_FIDELITY_PLAIN,
            decision=f'{defs} footnote definition(s) extracted but 0 in-text markers link them',
            rationale=(f'{defs} definitions exist yet no in-text marker references them (total_refs=0) and the '
                       f'linkability guard did NOT suppress — so the markers were never detected or did not '
                       f'survive. The cause is upstream detection (EPUB: footnoteMatching.py) or extraction, '
                       f'NOT the linker or the audit (which only MEASURES this).'),
            evidence={'total_defs': defs, 'total_refs': total_refs, 'unmatched_defs': udef,
                      'footnote_strategy': stats.get('footnote_strategy'), 'is_epub': is_epub},
            question='Definitions exist but no markers link — is it detection upstream, or the linker?',
            confidence=0.3,
            margin=(f'{defs} defs / 0 linked markers — look UPSTREAM at footnote detection, NOT the linker/audit')))
    return out

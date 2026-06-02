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

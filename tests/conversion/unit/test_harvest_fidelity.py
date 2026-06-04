"""The harvest-fidelity discriminator (mistral_ocr.assess_harvest_fidelity) — the "whose bug is it?"
signal for PDF footnotes. Same symptom ("the notes don't line up") has THREE root causes with opposite
remedies, and this record tells them apart from data we already have (page_summary refs/defs vs the
assembled markdown):

  • harvest_gap         OCR captured the definitions, we dropped them   → OUR bug   → FLAGGED
  • assembly_collisions definitions emitted but numbers aren't unique   → OUR bug   → FLAGGED
  • fidelity_loss       OCR itself lost the definitions the body cites  → UPSTREAM  → not flagged
  • clean / no_footnotes / not_applicable                               → nothing to do

The flagging contract (confidence < 0.5) is the load-bearing part: the vibe loop must chase only the
two buckets that are genuinely ours, and must NOT waste cycles on fidelity loss or on layouts that
correctly harvest nothing (none/unknown/bibliography). These tests pin both the verdict AND the flag.
"""

import os
import json

import mistral_ocr as M


def _meta(classification, page_summary):
    return {'classification': classification, 'page_summary': page_summary}


def _md(def_numbers):
    """A markdown blob with one [^N]: definition line per given number (repeats → collisions)."""
    return "\n".join(f"[^{n}]: note {n} text here." for n in def_numbers)


def _flagged(rec):
    return rec['confidence'] < 0.5


def test_clean_when_every_marker_has_a_unique_definition():
    meta = _meta('page_bottom', [
        {'index': 0, 'refs': [1, 2, 3], 'defs': []},
        {'index': 1, 'refs': [], 'defs': [1, 2, 3]},
    ])
    rec = M.assess_harvest_fidelity(meta, _md([1, 2, 3]))
    assert rec['decision'] == 'harvest=clean'
    assert not _flagged(rec)


def test_assembly_collisions_when_a_global_number_repeats():
    """Definitions harvested fine, but two share a global number → numbering/offset bug (Cox). FLAGGED."""
    meta = _meta('chapter_endnotes', [
        {'index': 0, 'refs': [1, 2, 3], 'defs': []},
        {'index': 1, 'refs': [], 'defs': [1, 2, 3]},
    ])
    rec = M.assess_harvest_fidelity(meta, _md([1, 2, 2, 3]))   # 2 appears twice
    assert rec['decision'] == 'harvest=assembly_collisions'
    assert rec['evidence']['collision_count'] == 1
    assert rec['evidence']['collision_numbers'] == [2]
    assert _flagged(rec)


def test_harvest_gap_when_ocr_has_defs_but_we_emit_few():
    """OCR captured ~20 def-lines and the body references 20 notes, yet we emit 2 → our assembly is
    LOSING definitions. FLAGGED."""
    ps = [
        {'index': 0, 'refs': list(range(1, 21)), 'defs': []},
        {'index': 1, 'refs': [], 'defs': list(range(1, 21))},
    ]
    rec = M.assess_harvest_fidelity(_meta('document_endnotes', ps), _md([1, 2]))
    assert rec['decision'] == 'harvest=harvest_gap'
    assert _flagged(rec)


def test_fidelity_loss_when_ocr_itself_lost_the_definitions():
    """Body references 20 notes but the OCR only captured 5 def-lines (we emit those 5) → the
    definitions degraded UPSTREAM in OCR, not in our code. NOT flagged — don't burn fixer cycles."""
    ps = [
        {'index': 0, 'refs': list(range(1, 21)), 'defs': []},
        {'index': 1, 'refs': [], 'defs': [1, 2, 3, 4, 5]},
    ]
    rec = M.assess_harvest_fidelity(_meta('page_bottom', ps), _md([1, 2, 3, 4, 5]))
    assert rec['decision'] == 'harvest=fidelity_loss'
    assert not _flagged(rec)


def test_no_footnotes_when_there_are_no_in_text_markers():
    """No refs → any def-shaped lines are numbered-list noise, not a footnote system (class_and_nation)."""
    rec = M.assess_harvest_fidelity(_meta('none', [{'index': 0, 'refs': [], 'defs': [1, 2, 3]}]), '')
    assert rec['decision'] == 'harvest=no_footnotes'
    assert not _flagged(rec)


def test_not_applicable_for_non_harvesting_layout():
    """unknown / bibliography layouts don't emit [^N] definitions — harvesting 0 is CORRECT, not a
    fault (stem_bibliography). Must not be flagged."""
    ps = [{'index': 0, 'refs': [1, 2, 3], 'defs': []}]
    rec = M.assess_harvest_fidelity(_meta('unknown', ps), '')
    assert rec['decision'] == 'harvest=not_applicable'
    assert not _flagged(rec)


def test_only_our_bugs_are_flagged():
    """The contract: across every verdict, ONLY harvest_gap + assembly_collisions raise the
    confidence<0.5 flag the vibe loop routes on. fidelity_loss/clean/no_footnotes/not_applicable
    must stay silent."""
    flagged = {
        'harvest=harvest_gap': True,
        'harvest=assembly_collisions': True,
        'harvest=fidelity_loss': False,
        'harvest=clean': False,
        'harvest=no_footnotes': False,
        'harvest=not_applicable': False,
    }
    cases = [
        _meta('document_endnotes', [{'index': 0, 'refs': list(range(1, 21)), 'defs': []},
                                    {'index': 1, 'refs': [], 'defs': list(range(1, 21))}]),  # harvest_gap
    ]
    rec = M.assess_harvest_fidelity(cases[0], _md([1, 2]))
    assert flagged[rec['decision']] is _flagged(rec)


def test_emission_appends_fidelity_record(tmp_path):
    """write_classification_assessment(..., markdown=...) must append the fidelity record as seq 1
    alongside the seq-0 classification record, so process_document seeds BOTH into the trace."""
    meta = {
        'classification': 'chapter_endnotes',
        'confidence': 0.8, 'rationale': 'x', 'signals': {}, 'considered': [], 'margin': None,
        'page_summary': [{'index': 0, 'refs': [1, 2, 3], 'defs': []},
                         {'index': 1, 'refs': [], 'defs': [1, 2, 3]}],
    }
    M.write_classification_assessment(meta, str(tmp_path), markdown=_md([1, 2, 2, 3]))
    data = json.loads(open(os.path.join(str(tmp_path), 'assessment.json')).read())
    assert [r['seq'] for r in data['records']] == [0, 1]
    assert data['records'][1]['module'] == 'pdf_footnote_harvest_fidelity'
    assert data['records'][1]['decision'] == 'harvest=assembly_collisions'


def test_emission_omits_fidelity_record_without_markdown(tmp_path):
    """Back-compat: with no markdown, only the seq-0 classification record is written."""
    meta = {'classification': 'none', 'confidence': 0.5, 'rationale': '', 'signals': {},
            'considered': [], 'margin': None, 'page_summary': []}
    M.write_classification_assessment(meta, str(tmp_path))
    data = json.loads(open(os.path.join(str(tmp_path), 'assessment.json')).read())
    assert len(data['records']) == 1


# --- pypdf-recovery awareness (footnote_warnings) — deterministic, no real PDF needed ----------------

def _fidelity_loss_meta():
    """body references 20 notes; OCR only captured 5 def-lines → fidelity_loss bucket."""
    return _meta('page_bottom', [
        {'index': 0, 'refs': list(range(1, 21)), 'defs': []},
        {'index': 1, 'refs': [], 'defs': [1, 2, 3, 4, 5]},
    ])


def test_fidelity_loss_untested_when_no_warnings():
    """footnote_warnings=None → pypdf never ran (replay harness). Record says so: recovery NOT
    attempted, so the loss is UNTESTED not confirmed."""
    rec = M.assess_harvest_fidelity(_fidelity_loss_meta(), _md([1, 2, 3, 4, 5]), None)
    assert rec['decision'] == 'harvest=fidelity_loss'
    assert rec['evidence']['pypdf_recovery_attempted'] is False
    assert 'NOT attempted' in rec['rationale']


def test_fidelity_loss_confirmed_upstream_when_pypdf_also_failed():
    """warnings show pypdf tried and left defs unrecovered → confirmed upstream (our best tool lost it)."""
    warnings = [{'page': 1, 'recovered': [], 'unrecovered': [10, 11, 12]}]
    rec = M.assess_harvest_fidelity(_fidelity_loss_meta(), _md([1, 2, 3, 4, 5]), warnings)
    assert rec['decision'] == 'harvest=fidelity_loss'
    assert rec['evidence']['pypdf_recovery_attempted'] is True
    assert rec['evidence']['pypdf_unrecovered'] == 3
    assert 'confirmed upstream' in rec['rationale']
    assert not _flagged(rec)   # still upstream — never flagged as ours


def test_recovery_counts_surface_in_evidence():
    """pypdf_recovered/unrecovered are reported regardless of verdict, for the report + vibe loop."""
    warnings = [{'page': 9, 'recovered': [3, 4], 'unrecovered': [7]}]
    rec = M.assess_harvest_fidelity(_meta('page_bottom', [
        {'index': 0, 'refs': [1, 2, 3], 'defs': []}, {'index': 1, 'refs': [], 'defs': [1, 2, 3]},
    ]), _md([1, 2, 3]), warnings)
    assert rec['evidence']['pypdf_recovered'] == 2
    assert rec['evidence']['pypdf_unrecovered'] == 1

"""The human-in-the-loop trigger (README §0): a reader's STRUCTURED issue categories route the right
module source + a per-category gloss into the vibe prompt — even when the pipeline self-flagged NOTHING
(a WRONG link / bad heading is invisible to self-assessment). Also pins the suspicion reframe of the
prompt (we flag suspicion, we never assert failure).
"""
import os

import vibe_convert as vc


# The one vocabulary — must stay in sync with the JS chips + the PHP enum.
_KEYS = {'citations_not_matched', 'citations_wrongly_matched', 'footnotes_not_matched',
         'footnotes_wrongly_matched', 'headings_wrong'}


def _art(assessment=None):
    return {
        'is_pdf': False, 'is_epub': True, 'source': '# converted\nbody', 'markdown': None, 'book_dir': '/tmp/x',
        'stats': {'references_found': 3, 'citations_total': 5, 'citations_linked': 5,
                  'footnotes_matched': 0, 'footnote_strategy': 'no_footnotes', 'citation_style': 'author-year-bracket'},
        'audit': {'total_refs': 3, 'total_defs': 0, 'gaps': [], 'unmatched_refs': [], 'unmatched_defs': []},
        'assessment': assessment if assessment is not None else [],
    }


# --- the category vocabulary + its module map are consistent --------------------------------------
def test_category_keys_match_the_vocabulary():
    assert set(vc._ISSUE_CATEGORY_MODULES) == _KEYS
    assert set(vc._ISSUE_CATEGORY_GLOSS) == _KEYS


def test_every_category_resolves_to_real_files():
    for cat in _KEYS:
        mods = vc._issue_category_modules([cat])
        assert mods, f'{cat} routed to no modules'
        for m in mods:
            assert os.path.isfile(os.path.join(vc.REPO_ROOT, m)), f'{cat} → {m} does not exist'


# --- the KEY guarantee: a human report routes modules even with ZERO system flags -----------------
def test_modules_for_routes_categories_when_nothing_flagged():
    # No assessment records at all (the pipeline thought everything was fine) — the report is the only signal.
    mods = vc.modules_for([], _art(), issue_types=['headings_wrong'])
    assert any('headingMatching.py' in m for m in mods)
    assert any('finalNormalisation.py' in m for m in mods)
    # a headings report must NOT drag in the citation/footnote linkers
    assert not any('footnote_link_rules.py' in m for m in mods)
    assert not any('citation_link_rules.py' in m for m in mods)


def test_wrongly_matched_routes_to_keygen_and_bibliography():
    mods = vc.modules_for([], _art(), issue_types=['citations_wrongly_matched'])
    assert any('bibliography.py' in m for m in mods)   # collision-suffixing = the WRONG-link cause
    assert any('refkeys.py' in m for m in mods)        # key generation


def test_categories_are_added_on_top_of_flagged_modules():
    # a flagged citation fork (routes bibliography + linker) PLUS a headings report → both sets present.
    recs = [{'module': 'citation_link_audit', 'code_ref': 'citations.py:link_citations'}]
    mods = vc.modules_for(recs, _art(recs), issue_types=['headings_wrong'])
    assert any('bibliography.py' in m for m in mods)     # from the flagged fork
    assert any('headingMatching.py' in m for m in mods)  # from the human report


# --- the structured prompt section + glosses ------------------------------------------------------
def test_structured_section_rendered_with_glosses():
    ctx = "\n\n".join(vc.build_diagnostic_context(
        _art(), [], issue_types=['citations_wrongly_matched', 'headings_wrong']))
    assert 'What the reader reports' in ctx
    assert 'collision-suffixing' in ctx                 # the wrongly-matched gloss
    assert 'HeadingNormalizer' in ctx                   # the headings gloss
    assert 'cannot self-detect' in ctx.lower() or 'could not self-detect' in ctx.lower()


def test_no_structured_section_when_no_issue_types():
    ctx = "\n\n".join(vc.build_diagnostic_context(_art(), []))
    assert 'What the reader reports' not in ctx


# --- the suspicion reframe (flag suspicion, never assert failure) ---------------------------------
def test_prompt_reframed_to_suspicion():
    art = _art([{'seq': 0, 'module': 'footnote_audit', 'code_ref': 'audit.py:compute_footnote_audit',
                 'decision': 'x', 'confidence': 0.0}])
    full = vc.build_prompt(art, ['app/Python/digestion/finalAudit/audit.py'])
    # softened headers/directives present
    assert '## What converted' in full
    assert 'SUSPICION to verify' in full
    assert 'flagged for review' in full
    assert 'NO change' in full and 'valued outcome' in full
    # the old assertive strings are gone
    assert '## The problem' not in full
    assert 'the likely fault' not in full
    assert 'converted badly' not in full

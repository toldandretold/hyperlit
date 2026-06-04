"""The LLM-facing half of the node-notes work: each flagged fork's `node_help` (the deciding unit's
plain-English "what this stage does / how it fails" note) must reach the diagnostic LLM's prompt, so
the model is oriented before it reads the terse decision/rationale. See vibe_convert.build_prompt.
"""

import vibe_convert


def _art(fork):
    return {'assessment': [fork], 'stats': {}, 'audit': {}, 'is_pdf': False, 'source': ''}


def test_flagged_fork_prompt_includes_node_help():
    note = 'THIS-STAGE-DECIDES-X and the classic failure is Y'
    fork = {'seq': 0, 'module': 'pdf_footnote_classification',
            'code_ref': 'mistral_ocr.py:classify_footnotes', 'node_help': note,
            'decision': 'footnote_layout=unknown', 'rationale': 'x',
            'confidence': 0.0, 'margin': 'FALL-THROUGH'}
    prompt = vibe_convert.build_prompt(_art(fork), [])
    assert note in prompt, "node_help did not reach the LLM prompt's flagged-decisions block"


def test_node_help_is_omitted_cleanly_when_absent():
    """A flagged fork without node_help (a lean record) must still build a valid prompt — the key is
    simply absent, not a crash."""
    fork = {'seq': 0, 'module': 'strategy_selection', 'code_ref': 'strategy.py:x',
            'decision': 'footnote_strategy=whole_document', 'rationale': 'y',
            'confidence': 0.3, 'margin': 'FALL-THROUGH: defaulted'}
    prompt = vibe_convert.build_prompt(_art(fork), [])
    assert 'strategy.py:x' in prompt

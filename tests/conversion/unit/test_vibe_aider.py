"""Unit tests for the aider edit-gen engine (vibe_aider.py) — the pure pieces that don't need
aider or an LLM: the diagnostic message builder, the diff validation (same guarantees as
validate_replacements), usage parsing, and the git-apply path used by accept-with-diff.
"""

import os
import subprocess

import vibe_aider as va
import vibe_convert as vc


def _art():
    # A minimal artifacts dict shaped like load_artifacts() output.
    return {
        'book_dir': '/tmp/none', 'is_pdf': False, 'is_epub': True, 'source': None, 'markdown': None,
        'stats': {'references_found': 0, 'citations_total': 0, 'citations_linked': 0,
                  'footnotes_matched': 477, 'footnote_strategy': 'pre_processed', 'citation_style': 'none'},
        'audit': {'total_refs': 239, 'total_defs': 477, 'gaps': [], 'unmatched_refs': [],
                  'unmatched_defs': [{'footnote_id': 'x'}] * 238},
        'assessment': [{'module': 'footnote_linking', 'code_ref': 'footnoteMatching.py:FootnoteConverter.convert',
                        'decision': '239 linked; 238 ORPHANED', 'confidence': 0.0,
                        'evidence': {'detected_footnotes': 239, 'orphaned_defs': 238, 'linked': 239}}],
    }


def test_build_message_has_diagnostic_sections_not_a_json_contract():
    msg = va.build_aider_message(_art(), ['app/Python/ingestion/epub/footnoteMatching.py'])
    assert 'What converted' in msg and 'references_found' in msg and 'Audit verdict' in msg
    assert 'Where the responsible code lives' in msg
    assert 'modus operandi' in msg.lower()
    # it must NOT impose our op/JSON contract (aider owns the edit format)
    assert 'STRICT JSON' not in msg and 'op="replace"' not in msg


def test_both_engines_send_IDENTICAL_diagnostic_context():
    """The controlled-experiment guarantee: deepseek (vc.build_prompt) and aider (va.build_aider_message)
    embed the SAME diagnostic context verbatim, so a deepseek-vs-aider (or model-vs-model) comparison
    varies only the edit MECHANISM, never the diagnosis. If a section drifts into one builder only, this
    fails — which is exactly the bug that left aider without node_help / pathway / structure."""
    art = {
        'is_pdf': False, 'is_epub': True, 'source': '# converted\nbody', 'markdown': None, 'book_dir': '/tmp/x',
        'stats': {'references_found': 0, 'citations_total': 24, 'citations_linked': 0,
                  'footnotes_matched': 30, 'footnote_strategy': 'pre_processed', 'citation_style': 'none'},
        'audit': {'total_refs': 0, 'total_defs': 30, 'gaps': [], 'unmatched_refs': [],
                  'unmatched_defs': [{'footnote_id': 'x'}] * 30},
        'assessment': [{'seq': 0, 'module': 'footnote_linking',
                        'code_ref': 'footnoteMatching.py:FootnoteConverter.convert',
                        'node_help': 'NODE_HELP_SENTINEL', 'decision': '30 ORPHANED', 'confidence': 0.0,
                        'evidence': {'detected_footnotes': 30, 'orphaned_defs': 30, 'linked': 0}}],
    }
    mods = ['app/Python/digestion/citationLinking/citations.py']
    ctx = "\n\n".join(vc.build_diagnostic_context(art, mods))
    native, aider = vc.build_prompt(art, mods), va.build_aider_message(art, mods)
    assert ctx in native and ctx in aider          # the shared payload is embedded verbatim in BOTH
    # the bits aider USED to lack are now in both engines:
    for needle in ('NODE_HELP_SENTINEL', "PATHWAY through the pipeline", 'folders ARE the tree',
                   'How to localize the cause'):
        assert needle in native and needle in aider, f"diagnostic drift — only one engine has: {needle}"
    # leads with the PROBLEM (symptom before the pipeline tree), and the tree carries no dev-meta:
    assert native.index('## What converted') < native.index('## The conversion pipeline')
    assert 'Built by `gen_pipeline_tree.py`' not in native   # dev-meta stripped from what the model sees
    # only the necessary mechanism differs:
    assert 'STRICT JSON' in native and 'STRICT JSON' not in aider          # native = op contract
    assert 'Responsible module source' in native and 'repo map' in aider   # native inlines / aider repo-map


def test_prompt_variant_lean_drops_the_fix_menu():
    """`full` (default) includes the fix-category menu; `lean` drops it (relying on the self-describing
    tree) — both still lead with the problem + carry the pipeline tree. This is the A/B lever."""
    art = {
        'is_pdf': False, 'is_epub': True, 'source': 'x', 'markdown': None, 'book_dir': '/tmp/x',
        'stats': {'references_found': 0, 'citations_total': 0, 'citations_linked': 0,
                  'footnotes_matched': 0, 'footnote_strategy': 'x', 'citation_style': 'none'},
        'audit': {'total_refs': 0, 'total_defs': 0, 'gaps': [], 'unmatched_refs': [], 'unmatched_defs': []},
        'assessment': [{'seq': 0, 'module': 'footnote_audit', 'code_ref': 'audit.py:compute_footnote_audit',
                        'decision': 'x'}],
    }
    mods = ['app/Python/digestion/finalAudit/audit.py']
    os.environ.pop('VIBE_PROMPT_VARIANT', None)
    full = "\n\n".join(vc.build_diagnostic_context(art, mods))
    os.environ['VIBE_PROMPT_VARIANT'] = 'lean'
    try:
        lean = "\n\n".join(vc.build_diagnostic_context(art, mods))
    finally:
        os.environ.pop('VIBE_PROMPT_VARIANT', None)
    assert 'Fix-category menu' in full and 'Fix-category menu' not in lean
    for both in ('## What converted', '## The conversion pipeline'):
        assert both in full and both in lean


def test_validate_diff_accepts_conversion_edit():
    diff = ("diff --git a/app/Python/conversion/footnotes.py b/app/Python/conversion/footnotes.py\n"
            "--- a/app/Python/conversion/footnotes.py\n+++ b/app/Python/conversion/footnotes.py\n"
            "+    x = 1\n")
    ok, why = va._validate_diff(diff)
    assert ok, why


def test_validate_diff_rejects_out_of_tree():
    ok, why = va._validate_diff("+++ b/app/Models/User.php\n+ hack\n")
    assert not ok and 'disallowed' in why


def test_validate_diff_rejects_dangerous_code():
    ok, why = va._validate_diff("+++ b/app/Python/conversion/footnotes.py\n+    import os; os.system('x')\n")
    assert not ok and 'refused' in why


def test_validate_diff_rejects_empty():
    ok, why = va._validate_diff("   \n")
    assert not ok and 'no changes' in why


def test_parse_usage_pulls_cost():
    u = va._parse_usage("Tokens: 57,714 sent, 21,742 received. Cost: $0.30 message, $0.31 session.",
                        'accounts/fireworks/models/gpt-oss-120b')
    assert u['prompt_tokens'] == 57714 and u['completion_tokens'] == 21742
    assert u['cost_usd'] == 0.31  # the SESSION total, not message+session double-counted
    assert u['model'] == 'aider/accounts/fireworks/models/gpt-oss-120b'  # the REAL model, not a hardcode


def test_parse_usage_handles_abbreviated_tokens():
    u = va._parse_usage("Tokens: 2.6k sent, 43 received. Cost: $0.0047 message, $0.0047 session.",
                        'accounts/fireworks/models/gpt-oss-120b')
    assert u['prompt_tokens'] == 2600 and u['completion_tokens'] == 43
    assert u['cost_usd'] == 0.0047


def test_journal_from_gate_lines():
    log = "GATE [reject] no measurable improvement\nGATE [improved] linked 30 more"
    j = va._journal_from(log, "diff", ['footnotes.py'])
    assert len(j) == 2 and j[-1]['tier'] == 'improved'


def test_apply_diff_git_applies_in_sandbox(tmp_path):
    # a real git diff (add a line) generated in a temp repo, then applied by _apply_diff
    rel = 'app/Python/conversion/_demo.py'
    repo = tmp_path / 'repo'
    (repo / 'app/Python/conversion').mkdir(parents=True)
    (repo / rel).write_text("def f():\n    return 1\n", encoding='utf-8')
    subprocess.run(['git', '-C', str(repo), 'init', '-q'])
    subprocess.run(['git', '-C', str(repo), 'add', '-A'])
    subprocess.run(['git', '-C', str(repo), '-c', 'user.email=x', '-c', 'user.name=x', 'commit', '-qm', 'b'])
    (repo / rel).write_text("def f():\n    return 999\n", encoding='utf-8')
    diff = subprocess.run(['git', '-C', str(repo), 'diff'], capture_output=True, text=True).stdout
    subprocess.run(['git', '-C', str(repo), 'checkout', '--', '.'])  # revert to baseline

    diff_file = tmp_path / 'p.diff'
    diff_file.write_text(diff, encoding='utf-8')
    ok, msg = vc._apply_diff(str(repo), str(diff_file))
    assert ok, msg
    assert 'return 999' in (repo / rel).read_text(encoding='utf-8')

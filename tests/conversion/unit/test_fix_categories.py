"""Unit tests for the living fix-category registry loader (conversion/fix_categories.py).

The registry is the centerpiece of the co-evolution harness: the menu rendered into DeepSeek's
prompt AND the tag vocabulary for post-mortems. These pin its shape + the append discipline.
"""

import json

from conversion import fix_categories as fc


def test_seed_registry_loads():
    reg = fc.load()
    assert reg['version'] == 'v1'
    ids = {c['id'] for c in reg['categories']}
    # the two shapes the user named + the three inexpressible-until-additive ones must be present
    for want in ('add_epub_detector', 'add_strategy_fork', 'add_pipeline_pass',
                 'extend_patch_apply_format', 'path_b_human'):
        assert want in ids, f"missing seed category {want}"


def test_scopes_split_model_vs_harness():
    model = {c['id'] for c in fc.model_categories()}
    assert 'add_epub_detector' in model           # actionable by DeepSeek
    assert 'improve_prompt_or_taxonomy' not in model  # harness-scope, not in the model's menu
    assert 'path_b_human' not in model                # disposition, not a fix


def test_by_id():
    assert fc.by_id('add_epub_detector')['expressible'] == 'additive'
    assert fc.by_id('tune_threshold')['expressible'] == 'replace'
    assert fc.by_id('does_not_exist') is None


def test_render_prompt_block_teaches_ops_and_menu():
    block = fc.render_prompt_block()
    assert 'Fix-category menu' in block
    for op in ('"replace"', '"add"', '"register"'):
        assert op in block
    # only model-scope categories appear in the menu
    assert 'add_epub_detector' in block
    assert 'improve_prompt_or_taxonomy' not in block


def test_render_prompt_block_stars_relevant_module():
    block = fc.render_prompt_block(['app/Python/epub_normalizer.py'])
    # the epub detector category should be marked relevant (★) when an epub module is sent
    assert '★ add_epub_detector' in block or '★ fix_structural_normalization' in block


def test_append_category_is_living_and_refuses_dupes(tmp_path):
    # copy the seed registry to a temp file so we don't mutate the real one
    reg = fc.load()
    p = tmp_path / 'fix_categories.json'
    p.write_text(json.dumps(reg), encoding='utf-8')

    before = len(fc.categories(str(p)))
    fc.append_category({'id': 'reconcile_segment_numbering',
                        'name': 'Reconcile per-segment footnote numbering',
                        'scope': 'model'}, path=str(p))
    after = fc.categories(str(p))
    assert len(after) == before + 1
    new = fc.by_id('reconcile_segment_numbering', path=str(p))
    assert new['status'] == 'discovered'   # defaulted
    assert new['examples'] == []           # defaulted

    # refuses to clobber an existing id
    try:
        fc.append_category({'id': 'reconcile_segment_numbering', 'name': 'dup'}, path=str(p))
        assert False, "expected ValueError on duplicate id"
    except ValueError:
        pass

"""Completeness gate for the import-pathway decision tree (tests/conversion/pipeline_map.json).

This is the test that makes the tree HONEST: it walks the real `app/Python/` tree and asserts that
EVERY module and EVERY decision-registry on disk is placed in the map — and that the map has no stale
entries and the visual (PIPELINE_MAP.md) names them all. If someone adds a new module or registry and
forgets to place it, this fails LOUDLY naming the orphan, so the map can never silently drift out of
sync with the code (which is exactly how a memory-built tree missed 8 legacy/dead modules).
"""

import ast
import glob
import json
import os
import sys

import pytest

_HERE = os.path.dirname(__file__)
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
_PYDIR = os.path.join(_REPO, 'app', 'Python')
_MAP_PATH = os.path.join(_HERE, '..', 'pipeline_map.json')
_MD_PATH = os.path.join(_HERE, '..', 'PIPELINE_MAP.md')

_MAP = json.loads(open(_MAP_PATH, encoding='utf-8').read())
_VALID_BANDS = {'frontend', 'backend', 'shared', 'meta', 'other_subsystem', 'legacy', 'dead'}


_SHIM_MARKER = 'Compatibility shim'


def _is_shim(path):
    """A re-export shim left at an old path during the ingestion/digestion reorg — not a real module
    (its body just re-exports from the new location). Detected by the marker in its docstring."""
    try:
        return _SHIM_MARKER in open(path, encoding='utf-8').read(300)
    except Exception:
        return False


def _disk_modules():
    """Every REAL conversion module on disk, keyed by its path relative to app/Python (posix). Recurses
    the package tree (ingestion/ digestion/ shared/ conversion/ + top level) so the map tracks modules
    wherever they live; skips __init__.py, __pycache__, and the re-export shims at the old paths."""
    out = set()
    for root, dirs, files in os.walk(_PYDIR):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for fn in files:
            if not fn.endswith('.py') or fn == '__init__.py':
                continue
            full = os.path.join(root, fn)
            if _is_shim(full):
                continue
            out.add(os.path.relpath(full, _PYDIR).replace(os.sep, '/'))
    return out


def _map_modules():
    return {k for k in _MAP['modules'] if not k.startswith('_')}


def _is_rule_registry(node):
    """A DECISION registry = a module-level UPPER list-of-Call (e.g. [NoOpRule(), ...]) or dict whose
    VALUES are Calls (e.g. {'page_bottom': PageBottomAssembler()}). This separates rule registries
    from config lists (ALLOWED_TAGS = strings, _DANGEROUS = tuples) without a hardcoded allowlist."""
    if not isinstance(node, ast.Assign):
        return False
    tgt = node.targets[0] if len(node.targets) == 1 else None
    if not (isinstance(tgt, ast.Name) and tgt.id.isupper()):
        return False
    v = node.value
    if isinstance(v, ast.List) and v.elts and all(isinstance(e, ast.Call) for e in v.elts):
        return tgt.id
    if isinstance(v, ast.Dict) and v.values and all(isinstance(e, ast.Call) for e in v.values):
        return tgt.id
    return False


def _disk_registries():
    """{registry_name: module_path_relative_to_app_Python} for every rule registry found on disk."""
    found = {}
    for mod in _disk_modules():
        path = os.path.join(_PYDIR, mod)
        try:
            tree = ast.parse(open(path, encoding='utf-8').read())
        except Exception:
            continue
        for n in tree.body:
            name = _is_rule_registry(n)
            if name:
                found[name] = mod
    return found


# ---------------------------------------------------------------------------
# Every module on disk is placed; every placed module exists; bands are valid.
# ---------------------------------------------------------------------------
def test_every_module_is_placed_in_the_tree():
    disk = _disk_modules()
    placed = _map_modules()
    orphans = disk - placed                      # on disk but NOT in the map -> the dangerous case
    stale = placed - disk                        # in the map but deleted from disk
    assert not orphans, (
        "modules on disk but NOT placed in pipeline_map.json (add them under a band):\n  "
        + "\n  ".join(sorted(orphans)))
    assert not stale, (
        "pipeline_map.json names modules that no longer exist on disk (remove them):\n  "
        + "\n  ".join(sorted(stale)))


def test_every_module_has_a_valid_band():
    bad = {m: v.get('band') for m, v in _MAP['modules'].items()
           if not m.startswith('_') and v.get('band') not in _VALID_BANDS}
    assert not bad, f"modules with an unknown band (allowed {sorted(_VALID_BANDS)}): {bad}"


# ---------------------------------------------------------------------------
# Every decision registry on disk is placed; no stale registry entries.
# ---------------------------------------------------------------------------
def test_every_registry_is_placed():
    disk = _disk_registries()
    placed = {k for k in _MAP['registries'] if not k.startswith('_')}
    orphans = set(disk) - placed
    stale = placed - set(disk)
    assert not orphans, (
        "decision registries on disk but NOT in pipeline_map.json.registries:\n  "
        + "\n  ".join(f"{r}  ({disk[r]})" for r in sorted(orphans)))
    assert not stale, f"pipeline_map.json.registries names registries not found on disk: {sorted(stale)}"


def test_registry_files_match_disk():
    disk = _disk_registries()
    for name, info in _MAP['registries'].items():
        if name.startswith('_'):
            continue
        assert name in disk, f"{name} not found on disk"
        assert disk[name] in info['file'] or info['file'].endswith(disk[name]), (
            f"{name}: map says {info['file']!r} but it lives in {disk[name]!r}")


# ---------------------------------------------------------------------------
# The VISUAL matches the data: PIPELINE_MAP.md names every module + registry.
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not os.path.isfile(_MD_PATH), reason="PIPELINE_MAP.md not written yet")
def test_visual_map_names_every_module_and_registry():
    md = open(_MD_PATH, encoding='utf-8').read()
    missing_mods = [m for m in _map_modules() if os.path.basename(m) not in md]
    missing_regs = [r for r in _MAP['registries'] if not r.startswith('_') and r not in md]
    assert not missing_mods, f"PIPELINE_MAP.md doesn't mention these modules: {sorted(missing_mods)}"
    assert not missing_regs, f"PIPELINE_MAP.md doesn't mention these registries: {sorted(missing_regs)}"


# ---------------------------------------------------------------------------
# Code-sourced node notes (pipeline_notes.json) — completeness + no-drift.
# Every decision unit carries a `plain` note; the committed JSON the visual + the
# LLM report read must equal what the generator produces from the code, so they
# can never disagree. (The notes also ride into assessment.json as node_help.)
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(_HERE, '..'))                 # tests/conversion (gen_pipeline_notes.py)
sys.path.insert(0, os.path.join(_REPO, 'app', 'Python'))      # the conversion modules it imports
_NOTES_JSON = os.path.join(_HERE, '..', 'pipeline_notes.json')


def test_every_decision_unit_has_a_plain_note():
    from gen_pipeline_notes import collect_notes
    notes = collect_notes()
    blank = sorted(k for k, v in notes.items() if not (v and v.strip()))
    assert not blank, f"decision units missing a non-empty `plain` note: {blank}"
    # Floor: the known node families must all be present (a dropped registry would shrink this).
    assert len([k for k in notes if k.startswith('classifier:')]) >= 6, "missing PDF classifiers"
    assert len([k for k in notes if k.startswith('assembler:')]) >= 5, "missing PDF assemblers"
    assert {'recovery:markers', 'recovery:mojibake', 'recovery:missingdefs', 'fidelity',
            'strategy', 'guard', 'bibliography', 'citation', 'audit',
            'epub:detection', 'epub:linking'} <= set(notes)


def test_pipeline_notes_json_matches_code():
    from gen_pipeline_notes import collect_notes, render_json
    committed = open(_NOTES_JSON, encoding='utf-8').read()
    assert committed == render_json(collect_notes()), (
        "pipeline_notes.json is STALE vs the code's `plain` notes — "
        "run: python3 tests/conversion/gen_pipeline_notes.py")


def test_pipeline_structure_md_matches_folders():
    """The visual structure is GENERATED from the actual ingestion/digestion/shared folders + their
    registries; the committed doc must equal a fresh render, so the tree can't drift from the layout."""
    from gen_pipeline_tree import render
    committed = open(os.path.join(_HERE, '..', 'PIPELINE_STRUCTURE.generated.md'), encoding='utf-8').read()
    assert committed == render(), (
        "PIPELINE_STRUCTURE.generated.md is STALE vs the folders — "
        "run: python3 tests/conversion/gen_pipeline_tree.py")


def test_every_epub_footnote_detector_has_a_plain_note():
    """Every EPUB footnote-detection scheme (the run-all fan) must carry a `plain` note, so a new
    detector added to TRANSFORM_PIPELINE / _DETECTOR_NEEDS shows up in the viewer + LLM report."""
    import epub_normalizer as E
    blank = [name for name in E.EpubNormalizer._DETECTOR_NEEDS
             if not (getattr(getattr(E, name, None), 'plain', '') or '').strip()]
    assert not blank, f"EPUB footnote detectors missing a `plain` note: {blank}"


def test_every_epub_heading_detector_has_a_plain_note():
    """Every EPUB heading-detection strategy (publisher markup → h1/h2/h3) must carry a `plain` note."""
    import epub_normalizer as E
    blank = [name for name in E.EpubNormalizer._HEADING_NEEDS
             if not (getattr(getattr(E, name, None), 'plain', '') or '').strip()]
    assert not blank, f"EPUB heading detectors missing a `plain` note: {blank}"


def test_pipeline_map_data_js_matches_code():
    """The interactive viewer's DIAGRAM + node data are generated from PDF_CLASSIFIERS/PDF_ASSEMBLERS +
    the recovery funcs + the ASSESSMENT.record sites + folders. The committed pipeline_map_data.js must
    equal a fresh render — so adding a classifier / moving a file shows up, and the diagram can't drift."""
    from gen_pipeline_map import render
    committed = open(os.path.join(_HERE, '..', 'pipeline_map_data.js'), encoding='utf-8').read()
    assert committed == render(), (
        "pipeline_map_data.js is STALE vs the registries/folders — "
        "run: python3 tests/conversion/gen_pipeline_map.py")

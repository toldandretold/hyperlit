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

import pytest

_HERE = os.path.dirname(__file__)
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
_PYDIR = os.path.join(_REPO, 'app', 'Python')
_MAP_PATH = os.path.join(_HERE, '..', 'pipeline_map.json')
_MD_PATH = os.path.join(_HERE, '..', 'PIPELINE_MAP.md')

_MAP = json.loads(open(_MAP_PATH, encoding='utf-8').read())
_VALID_BANDS = {'frontend', 'backend', 'shared', 'meta', 'other_subsystem', 'legacy', 'dead'}


def _disk_modules():
    """Every importable conversion module on disk: app/Python/*.py + app/Python/conversion/*.py,
    excluding __init__.py. Keys match pipeline_map.json (top-level basename, conversion/<name>)."""
    out = set()
    for p in glob.glob(os.path.join(_PYDIR, '*.py')):
        out.add(os.path.basename(p))
    for p in glob.glob(os.path.join(_PYDIR, 'conversion', '*.py')):
        out.add('conversion/' + os.path.basename(p))
    out.discard('__init__.py')
    out.discard('conversion/__init__.py')
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
    """{registry_name: module_path} for every rule registry found on disk."""
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

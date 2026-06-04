"""Generate PIPELINE_STRUCTURE.generated.md — the conversion decision tree, derived FROM the actual
folders (ingestion/ digestion/ shared/) + the decision registries they contain + the `plain` notes on
each unit. After the Phase 2 reorg the folder layout IS the tree, so this is the visual rebuilt from
the code itself: re-run it and the doc reflects exactly what's on disk. A no-drift test
(unit/test_pipeline_map.py) fails if the committed file falls out of sync.

Run:  python3 tests/conversion/gen_pipeline_tree.py     # rewrites PIPELINE_STRUCTURE.generated.md
"""
import ast
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..'))
_PY = os.path.join(_REPO, 'app', 'Python')
sys.path.insert(0, _PY)

from gen_pipeline_notes import collect_notes   # noqa: E402  (the per-unit plain notes)

_STAGE_BLURB = {
    'ingestion': 'read each input format → the common HTML (one folder per format)',
    'digestion': 'the shared pipeline over that HTML: extract → link → audit → emit',
    'shared': 'cross-cutting helpers used by both ingestion and digestion',
}


def _is_shim(path):
    try:
        return 'Compatibility shim' in open(path, encoding='utf-8').read(300)
    except Exception:
        return False


def _registries_in(path):
    """UPPER module-level list/dict-of-Calls = a decision registry (same rule as the completeness gate)."""
    try:
        tree = ast.parse(open(path, encoding='utf-8').read())
    except Exception:
        return []
    out = []
    for n in tree.body:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) \
                and n.targets[0].id.isupper():
            v = n.value
            if (isinstance(v, ast.List) and v.elts and all(isinstance(e, ast.Call) for e in v.elts)) or \
               (isinstance(v, ast.Dict) and v.values and all(isinstance(e, ast.Call) for e in v.values)):
                out.append(n.targets[0].id)
    return out


def _doc_first_line(path):
    try:
        d = ast.get_docstring(ast.parse(open(path, encoding='utf-8').read()))
        return (d.split('\n', 1)[0].strip() if d else '')
    except Exception:
        return ''


def _walk_stage(stage):
    """Ordered list of (relpath_under_stage, [registries], first_docstring_line) for the real modules."""
    base = os.path.join(_PY, stage)
    rows = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d != '__pycache__')
        for fn in sorted(files):
            if not fn.endswith('.py') or fn == '__init__.py':
                continue
            full = os.path.join(root, fn)
            if _is_shim(full):
                continue
            rel = os.path.relpath(full, base).replace(os.sep, '/')
            rows.append((rel, _registries_in(full), _doc_first_line(full)))
    return rows


def render():
    notes = collect_notes()
    note_count = len(notes)
    lines = [
        '# Pipeline structure — GENERATED from the folders',
        '',
        '> Built by `gen_pipeline_tree.py` from the actual `app/Python/{ingestion,digestion,shared}/`',
        '> tree + the decision registries in each module. Do NOT hand-edit — re-run the generator. A',
        f'> no-drift test pins it. ({note_count} per-unit `plain` notes feed the LLM report + the viewer.)',
        '',
    ]
    for stage in ('ingestion', 'digestion', 'shared'):
        lines.append(f'## {stage}/ — {_STAGE_BLURB[stage]}')
        lines.append('```')
        last_dir = None
        for rel, regs, _doc in _walk_stage(stage):
            parts = rel.split('/')
            if len(parts) > 1:
                sub = '/'.join(parts[:-1])
                if sub != last_dir:
                    lines.append(f'{sub}/')
                    last_dir = sub
                indent = '  '
                name = parts[-1]
            else:
                indent = ''
                name = rel
            reg = f'   · registries: {", ".join(regs)}' if regs else ''
            lines.append(f'{indent}{name}{reg}')
        lines.append('```')
        lines.append('')
    return '\n'.join(lines).rstrip('\n') + '\n'


def main():
    body = render()
    with open(os.path.join(_HERE, 'PIPELINE_STRUCTURE.generated.md'), 'w', encoding='utf-8') as f:
        f.write(body)
    print('wrote PIPELINE_STRUCTURE.generated.md')
    return body


if __name__ == '__main__':
    main()

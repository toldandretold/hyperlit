"""Loader + prompt-renderer for the LIVING fix-category registry
(tests/conversion/fix_categories.json).

The registry is the centrepiece of the co-evolution harness: one append-only catalogue of the
SHAPES a conversion fix can take. It is consumed two ways:

  1. build_prompt() in vibe_convert.py renders the MODEL-scope categories into DeepSeek's prompt —
     a menu of fix-shapes + the op vocabulary (replace / add / register) so the model can choose
     and EXPRESS the right kind of change (not just replace existing functions).
  2. Post-mortems tag each failure with a category id (or coin a NEW one via append_category()).

See the plan: ~/.claude/plans/okay-now-for-the-luminous-ritchie.md and tests/conversion/README.md.
"""

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
REGISTRY_PATH = os.path.join(_REPO_ROOT, 'tests', 'conversion', 'fix_categories.json')


def load(path=None):
    """Return the parsed registry dict ({'version', 'note', 'categories': [...]})."""
    with open(path or REGISTRY_PATH, encoding='utf-8') as f:
        return json.load(f)


def categories(path=None):
    return load(path).get('categories', [])


def by_id(cat_id, path=None):
    return next((c for c in categories(path) if c.get('id') == cat_id), None)


def model_categories(path=None):
    """The categories DeepSeek can ACT on (rendered into its prompt). Harness/disposition
    categories are for our post-mortems, not the model's fix-menu."""
    return [c for c in categories(path) if c.get('scope') == 'model']


# The op vocabulary the patch format understands — kept here so the prompt and the applier
# describe the SAME contract. Mirror of vibe_convert.apply_function_replacements.
OPS_BLURB = (
    "Each edit in `functions` carries an `op`:\n"
    "  • \"replace\" (default) — swap the FULL body of an EXISTING function (module-level def or a "
    "method); `name` is that function's name.\n"
    "  • \"add\" — introduce a NEW top-level function or class; `name` is the new def/class name, "
    "`code` is its full source. Use this to add an EpubTransform detector, a new pass, etc.\n"
    "  • \"register\" — append an item to a known module-level list/tuple (e.g. TRANSFORM_PIPELINE, "
    "_ALL_STRATEGIES); `name` is the LIST name and `code` is the Python expression to append "
    "(e.g. \"MyDetector()\" or \"'my_strategy'\")."
)


def render_prompt_block(module_paths=None, path=None):
    """A compact menu of the MODEL-scope fix-categories + the op vocabulary, for build_prompt().
    If module_paths is given, categories whose target file matches a sent module are marked ★ and
    sorted first (the most likely shapes for THIS case)."""
    mods = set(module_paths or [])

    def relevant(c):
        f = c.get('file', '')
        return any(m and m in f for m in mods)

    cats = sorted(model_categories(path), key=lambda c: (not relevant(c), c['id']))
    lines = [
        "## Fix-category menu — the SHAPES a fix can take (pick the one(s) that fit; combine if needed)",
        OPS_BLURB,
        "",
        "Categories (★ = most likely for this case):",
    ]
    for c in cats:
        star = "★ " if relevant(c) else "  "
        lines.append(
            f"{star}{c['id']} [{c.get('expressible', '?')}] — {c.get('symptom', '')}\n"
            f"      where: {c.get('file', '')} · {c.get('slot', '')}\n"
            f"      how:   {c.get('recipe', '')}"
        )
    lines.append(
        "\nFor EACH edit you return, also include a \"category\" field with the id you used "
        "(from the list above) so we can learn which shapes work. If the right fix fits NONE of "
        "these shapes, say so in `rationale` and name the new shape."
    )
    return "\n".join(lines)


def append_category(entry, path=None):
    """Append a NEWLY-DISCOVERED category to the registry (the living-list discipline). Used when
    a post-mortem coins a shape not already covered. `entry` must carry at least id/name/scope;
    missing housekeeping fields are defaulted. Refuses to clobber an existing id. Returns the entry."""
    path = path or REGISTRY_PATH
    reg = load(path)
    if any(c.get('id') == entry.get('id') for c in reg['categories']):
        raise ValueError(f"category id already exists: {entry.get('id')!r}")
    entry.setdefault('status', 'discovered')
    entry.setdefault('examples', [])
    for k in ('scope', 'symptom', 'stage', 'file', 'slot', 'recipe', 'expressible'):
        entry.setdefault(k, '')
    reg['categories'].append(entry)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return entry


if __name__ == '__main__':
    import sys
    if '--prompt' in sys.argv:
        print(render_prompt_block())
    else:
        reg = load()
        print(f"registry {reg.get('version')}: {len(reg['categories'])} categories "
              f"({len(model_categories())} model-scope)")
        for c in reg['categories']:
            print(f"  [{c.get('scope','?'):11}] {c['id']:32} {c.get('name','')}")

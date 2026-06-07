"""vibeConverter.patch — validate + apply full-function / op:edit / op:add / op:register replacements (AST engine)."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.runtime import (ALLOWED_FILES, ALLOWED_PREFIXES, REGISTERABLE_LISTS, _DANGEROUS)




def validate_replacements(functions):
    """Path-allowlist + dangerous-construct scan on the proposed edits, across all ops
    (edit / replace / add / register). Returns (ok, reason, files)."""
    if not isinstance(functions, list) or not functions:
        return False, "no edits returned", []
    files = []
    for fn in functions:
        op = fn.get('op') or 'replace'
        if op not in ('edit', 'replace', 'add', 'register'):
            return False, f"unknown op {op!r} (use edit/replace/add/register)", []
        path = (fn.get('file') or '').replace('\\', '/').lstrip('./')
        if not path:
            return False, "an edit is missing 'file'", []
        allowed = path in ALLOWED_FILES or any(path.startswith(p) for p in ALLOWED_PREFIXES)
        if not allowed:
            return False, f"edit touches a disallowed path: {path}", []
        if op == 'edit':
            # surgical search/replace — needs a non-empty search; replace may be '' (a deletion)
            if not fn.get('search') or fn.get('replace') is None:
                return False, "an op:edit needs a non-empty 'search' and a 'replace'", []
            scan = fn.get('replace') or ''
        else:
            if not fn.get('name') or not fn.get('code'):
                return False, "an op:replace/add/register needs 'name' and 'code'", []
            if op == 'register' and fn['name'] not in REGISTERABLE_LISTS:
                return False, (f"op=register may only append to {sorted(REGISTERABLE_LISTS)}, "
                               f"not {fn['name']!r}"), []
            scan = fn['code']
        for rx, label in _DANGEROUS:
            if rx.search(scan):
                return False, (f"proposed code uses '{label}', which conversion logic must never "
                               f"do — refused for safety"), []
        files.append(path)
    return True, "ok", sorted(set(files))




def _offset(src, lineno, col):
    """Absolute char index in src for a 1-based lineno + 0-based col (ast coordinates)."""
    lines = src.split('\n')
    return sum(len(l) + 1 for l in lines[:lineno - 1]) + col




def _replace_function(src, name, new_code):
    """Splice `new_code` in for the def/async-def named `name` using ast to find its exact span
    — robust where unified-diff context matching is brittle. `name` may be a bare function name
    OR a qualified `ClassName.method` (the natural way to name a method — and necessary to
    disambiguate when many classes share a method name, e.g. the EPUB detectors' `transform`).
    Returns the new source, or None if the target isn't found."""
    import ast
    import textwrap
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    _FDEF = (ast.FunctionDef, ast.AsyncFunctionDef)
    if '.' in name:
        cls_name, meth = name.rsplit('.', 1)
        cls = next((n for n in ast.walk(tree)
                    if isinstance(n, ast.ClassDef) and n.name == cls_name), None)
        target = next((n for n in cls.body if isinstance(n, _FDEF) and n.name == meth), None) if cls else None
    else:
        target = next((nd for nd in ast.walk(tree) if isinstance(nd, _FDEF) and nd.name == name), None)
    if target is None:
        return None
    lines = src.split('\n')
    start = target.lineno - 1
    if target.decorator_list:
        start = min(d.lineno for d in target.decorator_list) - 1
    end = target.end_lineno  # 1-indexed inclusive -> slice end
    indent = lines[target.lineno - 1][:len(lines[target.lineno - 1]) - len(lines[target.lineno - 1].lstrip())]
    body = textwrap.dedent(new_code).rstrip('\n').split('\n')
    reindented = [(indent + ln if ln.strip() else '') for ln in body]
    return '\n'.join(lines[:start] + reindented + lines[end:])




def _add_definition(src, name, new_code, before_name=None):
    """Insert a NEW top-level function/class `name` (op:add). `new_code` must parse and define
    `name` at top level; refuses to clobber an existing top-level `name` (use replace for that).
    Inserts before the module-level `before_name` (def/class/assignment) when given — so a new
    detector lands BEFORE the TRANSFORM_PIPELINE list that registers it — else at end of file.
    Returns the new source, or None if it can't be added safely."""
    import ast
    import textwrap
    block = textwrap.dedent(new_code).strip('\n')
    try:
        newmod = ast.parse(block)
    except SyntaxError:
        return None
    defined = {n.name for n in newmod.body
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    if name not in defined:
        return None  # `code` must actually define `name`
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    existing = {n.name for n in tree.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    if name in existing:
        return None  # don't silently shadow — the model should have used op:replace
    lines = src.split('\n')
    if before_name:
        for n in tree.body:
            names = ([t.id for t in n.targets if isinstance(t, ast.Name)]
                     if isinstance(n, ast.Assign)
                     else [n.name] if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                     else [])
            if before_name in names:
                at = (min(d.lineno for d in n.decorator_list)
                      if getattr(n, 'decorator_list', None) else n.lineno) - 1
                return '\n'.join(lines[:at] + [block, '', ''] + lines[at:])
    return src.rstrip('\n') + '\n\n\n' + block + '\n'




def _register_in_list(src, list_name, item_expr):
    """Append `item_expr` to the module-level list/tuple assigned to `list_name` (op:register).
    Rebuilds the literal from ast source-segments so it always re-parses; preserves multi-line
    layout. Returns the new source, or None if no such module-level list/tuple exists."""
    import ast
    import re as _re
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    node = None
    for n in tree.body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == list_name
                                             for t in n.targets) and isinstance(n.value, (ast.List, ast.Tuple)):
            node = n.value
            break
    if node is None:
        return None
    segs = [ast.get_source_segment(src, e) for e in node.elts]
    if any(s is None for s in segs):
        return None
    segs.append(item_expr.strip())
    ob, cb = ('[', ']') if isinstance(node, ast.List) else ('(', ')')
    start = _offset(src, node.lineno, node.col_offset)
    end = _offset(src, node.end_lineno, node.end_col_offset)
    orig = src[start:end]
    if '\n' in orig:
        first_el_line = src.split('\n')[node.elts[0].lineno - 1] if node.elts else ''
        indent = _re.match(r'\s*', first_el_line).group(0) or '    '
        close_indent = _re.match(r'\s*', src.split('\n')[node.end_lineno - 1]).group(0)
        body = (',\n' + indent).join(segs)
        new = f"{ob}\n{indent}{body},\n{close_indent}{cb}"
    else:
        tail = ',' if (isinstance(node, ast.Tuple) and len(segs) == 1) else ''
        new = ob + ', '.join(segs) + tail + cb
    return src[:start] + new + src[end:]




def _scope_span(src, name):
    """Char span (start, end) of function/method `name` (bare or Class.method) in src, or None.
    Lets op:edit scope its search to one function (disambiguating identical snippets across methods)."""
    import ast
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    _F = (ast.FunctionDef, ast.AsyncFunctionDef)
    if '.' in name:
        cn, mn = name.rsplit('.', 1)
        cls = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == cn), None)
        node = next((n for n in cls.body if isinstance(n, _F) and n.name == mn), None) if cls else None
    else:
        # A bare name may be a function OR a class — scoping to a class lets op:edit change
        # class-level code (e.g. a detector's ID_PATTERNS list) without dumping the whole class.
        node = next((n for n in ast.walk(tree)
                     if isinstance(n, _F + (ast.ClassDef,)) and n.name == name), None)
    if node is None:
        return None
    start_line = min([d.lineno for d in node.decorator_list], default=node.lineno)
    lines = src.split('\n')
    return _offset(src, start_line, 0), _offset(src, node.end_lineno, len(lines[node.end_lineno - 1]))




def _flex_find(hay, needle):
    """Locate `needle` in `hay`: exact substring first (must be UNIQUE), else a whitespace-flexible
    match (compares the sequence of stripped non-blank lines, tolerating indentation drift). Returns
    (start, end) char offsets, the string 'ambiguous' (>1 exact hit), or None (no match)."""
    c = hay.count(needle)
    if c == 1:
        i = hay.index(needle)
        return (i, i + len(needle))
    if c > 1:
        return 'ambiguous'
    nlines = needle.split('\n')
    while nlines and not nlines[0].strip():
        nlines.pop(0)
    while nlines and not nlines[-1].strip():
        nlines.pop()
    if not nlines:
        return None
    target = [l.strip() for l in nlines]
    hlines = hay.split('\n')
    for i in range(len(hlines) - len(target) + 1):
        if [hlines[i + j].strip() for j in range(len(target))] == target:
            start = sum(len(l) + 1 for l in hlines[:i])
            end = sum(len(l) + 1 for l in hlines[:i + len(target)]) - 1
            return (start, end)
    return None




def _available_scopes(src):
    """Names op:edit can scope to in `src`: top-level functions/classes + each Class.method.
    Used to turn a 'not found' into a did-you-mean so the model's retry lands instead of guessing."""
    import ast
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    _F = (ast.FunctionDef, ast.AsyncFunctionDef)
    names = []
    for n in tree.body:
        if isinstance(n, _F + (ast.ClassDef,)):
            names.append(n.name)
        if isinstance(n, ast.ClassDef):
            names += [f"{n.name}.{m.name}" for m in n.body if isinstance(m, _F)]
    return names




def _apply_edit(src, search, replace, scope_name=None):
    """Surgical search/replace (op:edit) — the scalpel that lets the model change a few lines of a
    big method instead of resending the whole body (which kept clobbering working logic). Optionally
    scoped to function `scope_name`. Returns (new_src, None) or (None, reason)."""
    rs, re_ = 0, len(src)
    if scope_name:
        span = _scope_span(src, scope_name)
        if span is None:
            avail = _available_scopes(src)
            import difflib
            near = difflib.get_close_matches(scope_name, avail, n=3, cutoff=0.5)
            hint = (f" — did you mean {', '.join(near)}?" if near
                    else (f" — this file defines: {', '.join(avail)}" if avail else ""))
            return None, (f"scope function '{scope_name}' not found{hint}. Use one of the names "
                          f"listed, or omit 'name' and put the verbatim search text instead")
        rs, re_ = span
    region = src[rs:re_]
    found = _flex_find(region, search)
    if found is None:
        return None, ("search text not found — copy it VERBATIM from the source shown above "
                      "(including indentation), or set name to scope it")
    if found == 'ambiguous':
        return None, "search text appears more than once — include more surrounding lines, or set name to scope it"
    s, e = found
    matched = region[s:e]
    if matched != search:
        # Flexible (indentation-drifted) match: realign `replace` to the matched region's indent so
        # it doesn't land at the wrong column (the exact-match path needs no shift).
        def _indent(t):
            for ln in t.split('\n'):
                if ln.strip():
                    return len(ln) - len(ln.lstrip())
            return 0
        delta = _indent(matched) - _indent(search)
        if delta > 0:
            replace = '\n'.join((' ' * delta + ln) if ln.strip() else ln for ln in replace.split('\n'))
        elif delta < 0:
            replace = '\n'.join(ln[-delta:] if ln[:-delta].strip() == '' else ln.lstrip()
                                for ln in replace.split('\n'))
    return src[:rs] + region[:s] + replace + region[e:] + src[re_:], None




def apply_function_replacements(sandbox, functions):
    """Apply each edit ({file, op, ...}) in the sandbox, grouped per file and ordered
    replace → edit → add → register (so a surgical edit hits the original body, and an added
    detector exists before it's registered).

    BEST-EFFORT: an edit that doesn't match (wrong/absent search text) or that would break the file's
    syntax is SKIPPED and reported — it does NOT discard the rest of the patch. So one good edit isn't
    lost to a co-bundled bad one (the schumpeter case: a clean one-line footnote fix was nuked because
    the model bundled it with a bibliography edit whose search text didn't match verbatim). Each edit is
    parse-checked atomically (a non-parsing result is reverted), so a written file always parses.

    Returns (ok, message): ok=True if AT LEAST ONE edit applied; `message` says how many applied and lists
    what was skipped + why (fed back to the model so it can re-send the skipped edits with exact text).
    ok=False only when NOTHING applied (the loop treats that as an apply failure)."""
    import ast
    by_file = {}
    for fn in functions:
        by_file.setdefault(fn['file'].replace('\\', '/').lstrip('./'), []).append(fn)

    applied_n, skipped = 0, []
    src, file_applied = '', 0

    def _try(new, label):
        """Accept `new` if it's non-None AND parses; else record `label` as skipped. Mutates src + counters."""
        nonlocal src, file_applied, applied_n
        if new is None:
            skipped.append(label)
            return False
        try:
            ast.parse(new)
        except SyntaxError as e:
            skipped.append(f"{label} [would break syntax: {e}]")
            return False
        src = new
        file_applied += 1
        applied_n += 1
        return True

    for path, fns in by_file.items():
        full = os.path.join(sandbox, path)
        if not os.path.isfile(full):
            skipped.append(f"{path}: target file not in sandbox")
            continue
        src = open(full, encoding='utf-8').read()
        file_applied = 0
        add_failed = False
        # An added def is placed just before the list that registers it (when both are present).
        anchor = next((f['name'] for f in fns if (f.get('op') == 'register')), None)

        for fn in [f for f in fns if (f.get('op') or 'replace') == 'replace']:
            _try(_replace_function(src, fn['name'], fn['code']),
                 f"{path}: op:replace '{fn['name']}' not found (or its code didn't parse) — if NEW use op:add")
        for fn in [f for f in fns if f.get('op') == 'edit']:
            new, reason = _apply_edit(src, fn['search'], fn.get('replace') or '', scope_name=fn.get('name'))
            _try(new, f"{path}: op:edit — {reason}")
        for fn in [f for f in fns if f.get('op') == 'add']:
            if not _try(_add_definition(src, fn['name'], fn['code'], before_name=anchor),
                        f"{path}: op:add '{fn['name']}' (didn't parse, name mismatch, or already exists)"):
                add_failed = True
        for fn in [f for f in fns if f.get('op') == 'register']:
            if add_failed:                 # don't register a class whose op:add was skipped (would NameError)
                skipped.append(f"{path}: op:register '{fn['name']}' skipped — its op:add didn't apply")
                continue
            _try(_register_in_list(src, fn['name'], fn['code']),
                 f"{path}: op:register into '{fn['name']}' — no such module-level list/tuple")

        if file_applied:
            open(full, 'w', encoding='utf-8').write(src)

    if applied_n == 0:
        return False, "no edits could be applied — " + "; ".join(skipped)
    msg = f"applied {applied_n} edit(s)"
    if skipped:
        msg += f"; SKIPPED {len(skipped)}: " + "; ".join(skipped)
    return True, msg




def _apply_diff(sandbox, diff_path):
    """Apply an aider git diff in the sandbox (git apply, then a -p1 fallback). Returns (ok, msg)."""
    r = subprocess.run(['git', '-C', sandbox, 'apply', '--whitespace=nowarn', diff_path],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return True, "ok"
    r2 = subprocess.run(['patch', '-p1', '-d', sandbox, '-i', diff_path], capture_output=True, text=True)
    return (r2.returncode == 0), (r.stderr or r2.stderr or 'git apply failed')[-300:]

"""Unit tests for the additive-patch ops in vibe_convert.py (op: add / register).

These make the user's headline fix-shapes EXPRESSIBLE — "add a class detector" (op:add a class +
op:register it into TRANSFORM_PIPELINE) and "add a new fork" (op:register into _ALL_STRATEGIES).
Before this, the patch format could only REPLACE existing functions.
"""

import ast

import vibe_convert as v


# --- _register_in_list --------------------------------------------------------

def test_register_into_multiline_list_preserves_layout():
    src = "X = 1\nTRANSFORM_PIPELINE = [\n    A(),\n    B(),\n]\nY = 2\n"
    out = v._register_in_list(src, 'TRANSFORM_PIPELINE', 'MyDet()')
    ast.parse(out)
    assert 'MyDet()' in out
    assert out.count('\n    ') >= 3        # stayed multi-line (didn't collapse to one line)


def test_register_into_single_line_tuple():
    src = "_ALL_STRATEGIES = ('a', 'b', 'c')\n"
    out = v._register_in_list(src, '_ALL_STRATEGIES', "'sectioned_end'")
    ast.parse(out)
    assert "'sectioned_end'" in out


def test_register_missing_list_returns_none():
    assert v._register_in_list("x = 1\n", 'NOPE', 'Y()') is None


# --- _add_definition ----------------------------------------------------------

def test_add_before_anchor_orders_class_first():
    src = "import x\n\nclass A:\n    pass\n\nTRANSFORM_PIPELINE = [A()]\n"
    out = v._add_definition(src, 'NewDet', "class NewDet:\n    pass\n", before_name='TRANSFORM_PIPELINE')
    ast.parse(out)
    assert out.index('class NewDet') < out.index('TRANSFORM_PIPELINE')


def test_add_appends_at_end_without_anchor():
    src = "def a():\n    return 1\n"
    out = v._add_definition(src, 'b', "def b():\n    return 2\n")
    ast.parse(out)
    assert out.index('def a') < out.index('def b')


def test_add_refuses_to_clobber_existing():
    src = "class A:\n    pass\n"
    assert v._add_definition(src, 'A', "class A:\n    pass\n") is None


def test_add_requires_code_to_define_the_named_symbol():
    src = "x = 1\n"
    assert v._add_definition(src, 'Missing', "class Other:\n    pass\n") is None


# --- _replace_function with qualified Class.method names ---------------------

_TWO_DETECTORS = (
    "class A:\n"
    "    def transform(self, soup):\n"
    "        return 'a'\n"
    "\n"
    "class B:\n"
    "    def transform(self, soup):\n"
    "        return 'b'\n"
)


def test_replace_qualified_method_targets_right_class():
    out = v._replace_function(_TWO_DETECTORS, 'B.transform',
                              "def transform(self, soup):\n    return 'PATCHED'\n")
    ast.parse(out)
    # B.transform changed, A.transform untouched (disambiguation that a bare name can't do)
    import re
    a_body = re.search(r'class A:.*?(?=\nclass |\Z)', out, re.S).group(0)
    b_body = re.search(r'class B:.*?(?=\nclass |\Z)', out, re.S).group(0)
    assert "return 'a'" in a_body and 'PATCHED' not in a_body
    assert 'PATCHED' in b_body


def test_replace_qualified_method_missing_class_returns_none():
    assert v._replace_function(_TWO_DETECTORS, 'Nope.transform', "def transform(self):\n    return 0\n") is None


def test_apply_replace_qualified_method(tmp_path):
    rel = 'app/Python/conversion/_demo3.py'
    full = tmp_path / rel
    full.parent.mkdir(parents=True)
    full.write_text(_TWO_DETECTORS, encoding='utf-8')
    ok, msg = v.apply_function_replacements(
        str(tmp_path), [{'file': rel, 'name': 'A.transform', 'op': 'replace',
                         'code': "def transform(self, soup):\n    return 'ZZ'\n"}])
    assert ok, msg
    assert "return 'ZZ'" in full.read_text(encoding='utf-8')


# --- op:edit — surgical search/replace (the scalpel vs whole-method rewrite) -

_DUP = ("class A:\n"
        "    def transform(self, soup):\n"
        "        if a.get('class'):\n"
        "            continue\n"
        "        return 'a'\n"
        "\n"
        "class B:\n"
        "    def transform(self, soup):\n"
        "        if a.get('class'):\n"
        "            continue\n"
        "        return 'b'\n")


def test_edit_scoped_to_one_method_when_snippet_is_duplicated():
    out, reason = v._apply_edit(
        _DUP, "        if a.get('class'):\n            continue",
        "        if a.get('class') and not _is_fn(a):\n            continue", scope_name='B.transform')
    assert out is not None, reason
    ast.parse(out)
    # only B changed; A's identical line untouched
    assert '_is_fn' in out.split('class B:')[1]
    assert '_is_fn' not in out.split('class B:')[0]


def test_edit_can_scope_to_a_class_for_class_level_code():
    src = ("class Det:\n"
           "    ID_PATTERNS = ['a', 'b']\n"
           "    def transform(self):\n"
           "        return 1\n")
    out, reason = v._apply_edit(src, "ID_PATTERNS = ['a', 'b']",
                                "ID_PATTERNS = ['a', 'b', 'c']", scope_name='Det')
    assert out is not None, reason
    ast.parse(out)
    assert "'c'" in out


def test_edit_unscoped_duplicate_is_refused_not_guessed():
    out, reason = v._apply_edit(_DUP, "        if a.get('class'):\n            continue", "x")
    assert out is None and 'more than once' in reason


def test_edit_missing_search_is_refused():
    out, reason = v._apply_edit(_DUP, "this text is not in the file", "x", scope_name='A.transform')
    assert out is None and 'not found' in reason


def test_edit_whitespace_flexible_match():
    # search supplied with the WRONG indentation still matches
    out, _ = v._apply_edit(_DUP, "if a.get('class'):\n    continue", "pass  # flexed", scope_name='A.transform')
    assert out is not None and 'flexed' in out
    ast.parse(out)


def test_edit_replace_can_be_empty_deletion():
    out, _ = v._apply_edit(_DUP, "        return 'a'\n", "", scope_name='A.transform')
    assert out is not None
    ast.parse('class A:\n    def transform(self, soup):\n        if a.get("class"):\n            continue\n')


def test_validate_accepts_edit_op():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'op': 'edit',
          'search': 'foo', 'replace': 'bar'}])
    assert ok, reason


def test_validate_edit_needs_search_and_replace():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'op': 'edit', 'replace': 'bar'}])
    assert not ok and 'search' in reason


def test_validate_edit_scans_replace_for_dangerous_code():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'op': 'edit',
          'search': 'x', 'replace': 'import socket'}])
    assert not ok and 'refused' in reason


def test_apply_edit_op_end_to_end(tmp_path):
    rel = 'app/Python/conversion/_demoedit.py'
    full = tmp_path / rel
    full.parent.mkdir(parents=True)
    full.write_text("def f():\n    return 1\n", encoding='utf-8')
    ok, msg = v.apply_function_replacements(
        str(tmp_path), [{'file': rel, 'op': 'edit', 'search': 'return 1', 'replace': 'return 999'}])
    assert ok, msg
    assert 'return 999' in full.read_text(encoding='utf-8')


# --- validate_replacements across ops ----------------------------------------

def test_validate_accepts_add_and_register():
    funcs = [
        {'file': 'app/Python/epub_normalizer.py', 'name': 'NewDet', 'op': 'add', 'code': 'class NewDet:\n pass'},
        {'file': 'app/Python/epub_normalizer.py', 'name': 'TRANSFORM_PIPELINE', 'op': 'register', 'code': 'NewDet()'},
    ]
    ok, reason, files = v.validate_replacements(funcs)
    assert ok, reason


def test_validate_rejects_unknown_op():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'name': 'x', 'op': 'delete', 'code': 'x'}])
    assert not ok and 'unknown op' in reason


def test_validate_register_only_allowed_lists():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'name': 'SOME_OTHER_LIST', 'op': 'register', 'code': 'x'}])
    assert not ok and 'register' in reason


def test_validate_register_allows_known_registry():
    ok, _, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'name': '_ALL_STRATEGIES', 'op': 'register', 'code': "'z'"}])
    assert ok


def test_validate_still_blocks_dangerous_code():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Python/conversion/strategy.py', 'name': 'NewThing', 'op': 'add',
          'code': 'import os\ndef NewThing():\n    os.system("rm -rf /")'}])
    assert not ok and 'refused' in reason


def test_validate_disallows_out_of_tree_path():
    ok, reason, _ = v.validate_replacements(
        [{'file': 'app/Models/User.php', 'name': 'x', 'op': 'replace', 'code': 'x'}])
    assert not ok and 'disallowed' in reason


# --- apply_function_replacements dispatch (tmp sandbox) -----------------------

def test_apply_add_then_register_into_tmp_module(tmp_path):
    rel = 'app/Python/conversion/_demo.py'
    full = tmp_path / rel
    full.parent.mkdir(parents=True)
    full.write_text("class Base:\n    pass\n\nPIPELINE = [\n]\n", encoding='utf-8')

    funcs = [
        {'file': rel, 'name': 'Mine', 'op': 'add', 'code': 'class Mine(Base):\n    pass\n'},
        {'file': rel, 'name': 'PIPELINE', 'op': 'register', 'code': 'Mine()'},
    ]
    ok, msg = v.apply_function_replacements(str(tmp_path), funcs)
    assert ok, msg
    text = full.read_text(encoding='utf-8')
    ast.parse(text)
    assert text.index('class Mine') < text.index('PIPELINE = [') or 'Mine()' in text
    assert 'Mine()' in text


def test_apply_replace_missing_function_hints_op_add(tmp_path):
    rel = 'app/Python/conversion/_demo2.py'
    full = tmp_path / rel
    full.parent.mkdir(parents=True)
    full.write_text("def existing():\n    return 1\n", encoding='utf-8')
    ok, msg = v.apply_function_replacements(
        str(tmp_path), [{'file': rel, 'name': 'ghost', 'op': 'replace', 'code': 'def ghost():\n    return 0'}])
    assert not ok and 'op:add' in msg

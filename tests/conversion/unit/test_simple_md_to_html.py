"""Unit tests for the markdown front-end — simple_md_to_html.py.

Covers inline formatting, block elements, and the footnote SECTION-MARKER emission
(footnoteDefinitionsStart / footnoteSectionStart) that drives the sequential strategy.
Also pins the line semantics relevant to the blank-line-between-definitions rule:
this custom converter makes EACH non-blank line its own <p> (unlike CommonMark/pandoc,
which merge consecutive non-blank lines into one paragraph).
"""

import re

from simple_md_to_html import convert_markdown_to_html, process_inline_formatting, repair_unbalanced_latex


def md(s):
    return convert_markdown_to_html(s)


# ---------------------------------------------------------------------------
# LaTeX \left/\right balancing (KaTeX hard-errors on an unmatched \left)
# ---------------------------------------------------------------------------
def test_repair_closes_dropped_right_before_delimiter():
    # OCR dropped the \right before the final ) — should become \right) so KaTeX renders it.
    tex = r'\frac{p r (+ \left| m ^ {e} r ; T\right)}{p r (+ \left| m ^ {e} r ; T)}'
    fixed = repair_unbalanced_latex(tex)
    assert fixed.count(r'\left') == fixed.count(r'\right')
    assert '; T\\right)}' in fixed          # the bare ) was upgraded to \right)


def test_repair_leaves_balanced_latex_untouched():
    # a correct equation (incl. nested literal parens) must be byte-identical after the pass
    for ok in [r'\frac{a}{b} \left( x + y \right) = z', r'\left| f(x) \right|', r'a^2 + b^2 = c^2']:
        assert repair_unbalanced_latex(ok) == ok


def test_repair_falls_back_to_invisible_right_when_no_delimiter():
    # no bare closer at the group end → \right. keeps it parseable
    assert repair_unbalanced_latex(r'\left| f(x) ; T') == r'\left| f(x) ; T\right.'


def test_repair_strips_stray_right_with_no_left():
    # OCR emitted a \right) with no matching \left — the \right must be dropped, leaving a literal ).
    tex = r'pr(h \leftrightarrow e; mr(T)\right)'
    fixed = repair_unbalanced_latex(tex)
    assert fixed == r'pr(h \leftrightarrow e; mr(T))'
    assert '\\right' not in fixed


def test_repair_never_mistakes_leftrightarrow_for_a_delimiter():
    # \leftrightarrow / \rightarrow start with \left / \right but are NOT delimiter commands —
    # a balanced arrow equation must be byte-identical (regression: injected spurious \right.).
    for ok in [r'a \leftrightarrow b', r'x \rightarrow y', r'\left( p \right) \leftrightarrow q']:
        assert repair_unbalanced_latex(ok) == ok


# ---------------------------------------------------------------------------
# Inline formatting
# ---------------------------------------------------------------------------
def test_bold_and_italic():
    assert process_inline_formatting('**b** and *i*') == '<strong>b</strong> and <em>i</em>'


def test_link():
    assert process_inline_formatting('[text](http://x.test)') == '<a href="http://x.test">text</a>'


def test_inline_math_becomes_latex_tag():
    out = process_inline_formatting('mass $E=mc^2$ here')
    assert '<latex data-math="' in out
    assert '$' not in out


def test_currency_dollars_not_treated_as_math():
    out = process_inline_formatting('it cost $5 to $10 each')
    assert '<latex' not in out


def test_inline_display_math_becomes_latex_block_and_is_not_italicised():
    # A $$…$$ display equation sitting INLINE mid-paragraph (common in maths papers) must render as a
    # latex-block, and its "_" subscripts must NOT be eaten by the italic pass (A_1^o → A<em>1^o).
    out = process_inline_formatting(r'$$w + (1-r)A_1^o - B$$ where $A_1^o$ is the bequest.')
    assert '<latex-block data-math="' in out
    assert '<em>' not in out
    assert '$$' not in out


# ---------------------------------------------------------------------------
# Block elements
# ---------------------------------------------------------------------------
def test_header_gets_slug_id():
    out = md('# Introduction Title')
    assert '<h1 id="introduction-title">Introduction Title</h1>' in out


def test_horizontal_rule():
    assert '<hr />' in md('---')


def test_each_nonblank_line_is_its_own_paragraph():
    # KEY semantic: consecutive non-blank lines do NOT merge (contrast pandoc).
    out = md('Line one.\nLine two.')
    assert '<p>Line one.</p>' in out
    assert '<p>Line two.</p>' in out


# ---------------------------------------------------------------------------
# Footnote markers
# ---------------------------------------------------------------------------
def test_footnote_ref_preserved_as_text():
    out = md('A claim[^1] in the body.')
    assert '[^1]' in out


def test_first_footnote_definition_opens_a_def_section():
    out = md('[^1]: the first footnote definition.')
    assert 'footnoteDefinitionsStart' in out
    assert 'fnDefSection_1' in out


def test_definition_restart_opens_new_def_section():
    # numbering goes 1,2 then restarts at 1 -> a second definition section is opened
    out = md('[^1]: one\n[^2]: two\n[^1]: restart one')
    sections = re.findall(r'fnDefSection_(\d+)', out)
    assert sections == ['1', '2']      # two distinct def-section anchors


def test_reference_restart_opens_ref_section():
    out = md('See[^1] and[^2].\nLater[^1] again.')
    assert 'footnoteSectionStart' in out
    assert 'fnRefSection_' in out


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------
def test_gfm_table_converted():
    out = md('| A | B |\n| --- | --- |\n| 1 | 2 |')
    assert '<table' in out
    assert '<td' in out or '<th' in out

"""Unit tests for the markdown front-end — simple_md_to_html.py.

Covers inline formatting, block elements, and the footnote SECTION-MARKER emission
(footnoteDefinitionsStart / footnoteSectionStart) that drives the sequential strategy.
Also pins the line semantics relevant to the blank-line-between-definitions rule:
this custom converter makes EACH non-blank line its own <p> (unlike CommonMark/pandoc,
which merge consecutive non-blank lines into one paragraph).
"""

import re

from simple_md_to_html import convert_markdown_to_html, process_inline_formatting


def md(s):
    return convert_markdown_to_html(s)


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

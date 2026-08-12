"""Pin the markdown-table converter's math-aware row splitting (simple_md_to_html).

A pipe INSIDE table-cell content — the conditional-probability bar in 'pr(⊗|λσ;T)'
(1313c1a2, Table 5) or a $…$ math span — is content, not a cell delimiter. The naive
split turned the first column into two cells and gave every row a phantom column.

The smart split is used ONLY when the naive split over-produces relative to the header
AND the smart split lands exactly on the header width, so a table with stray unbalanced
parentheses can never regress to merged cells.
"""

import re
import sys

sys.path.insert(0, __file__.rsplit('/tests/', 1)[0] + '/app/Python')

from ingestion.markdown_and_pdf_to_html.simple_md_to_html import (   # noqa: E402
    convert_table_block,
    _split_row_math_aware,
)


def _cells_per_row(html):
    rows = re.findall(r'<tr>(.*?)</tr>', html, re.S)
    return [len(re.findall(r'<t[hd][^>]*>', r)) for r in rows]


def test_pipe_inside_parens_is_content_not_delimiter():
    lines = [
        '|  Statistic | λσ | TBL | TAll | Tpol | Tmov  |',
        '| --- | --- | --- | --- | --- | --- |',
        '|  pr(⊗|λσ;T) | er | 0.34 | 0.35 | 0.37 | 0.29  |',
        '|   |  hd | 0.45 | 0.47 | 0.48 | 0.49  |',
    ]
    html, end = convert_table_block(lines, 0)
    assert end == 4
    assert _cells_per_row(html) == [6, 6, 6]
    assert 'pr(⊗|λσ;T)' in html


def test_pipe_inside_math_span_is_content():
    lines = [
        '| Model | Score |',
        '| --- | --- |',
        '| $p(x|y)$ | 0.9 |',
    ]
    html, _ = convert_table_block(lines, 0)
    assert _cells_per_row(html) == [2, 2]
    # the math cell renders as ONE <latex> element carrying the whole expression (pipe intact)
    import base64
    m = re.search(r'<latex data-math="([^"]+)"', html)
    assert m and base64.b64decode(m.group(1)).decode() == 'p(x|y)'


def test_plain_table_unchanged_and_unbalanced_paren_safe():
    # A stray unbalanced '(' must not merge cells: the smart split would swallow the row,
    # but it only applies when the naive split OVER-produces — here it matches the header.
    lines = [
        '| A | B | C |',
        '| --- | --- | --- |',
        '| 1 (see note | 2 | 3 |',
    ]
    html, _ = convert_table_block(lines, 0)
    assert _cells_per_row(html) == [3, 3]
    assert '1 (see note' in html


def test_split_helper_masks_parens_and_math():
    assert _split_row_math_aware('| pr(a|b) | 1 |')[1:-1] == [' pr(a|b) ', ' 1 ']
    assert _split_row_math_aware('| $x|y$ | 2 |')[1:-1] == [' $x|y$ ', ' 2 ']


def test_absolute_value_bars_survive_via_space_split():
    # 1313c1a2 Table 4: '|er(T)|/|T|' cells — glued pipes are content, ' | ' pipes delimit.
    lines = [
        '|  Corpus | TBL | TAll | Tpol | Tmov  |',
        '| --- | --- | --- | --- | --- |',
        '|  |er(T)|/|T | 0.65 | 0.79 | 0.76 | 0.70  |',
        '|  |hd(T)|/|T | 0.12 | 0.08 | 0.13 | 0.04  |',
    ]
    html, _ = convert_table_block(lines, 0)
    assert _cells_per_row(html) == [5, 5, 5]
    assert '|er(T)|/|T' in html


def test_rejoin_never_merges_table_rows():
    # 1313c1a2 Table 2: the last table row ends with '|' (no sentence punct) and the next
    # paragraph starts lowercase — the continuation rule used to glue them, breaking the row
    # out of the table.
    from ingestion.pdf.pdf_shared import rejoin_page_breaks
    text = ('|  Classifier | er |\n| --- | --- |\n|  Sentiment | 64.4  |\n\n\n'
            "taken from Christopher Potts' sentiment tutorial6.")
    out = rejoin_page_breaks(text)
    assert '|  Sentiment | 64.4  |' in out.split('\n')
    assert "| taken from" not in out

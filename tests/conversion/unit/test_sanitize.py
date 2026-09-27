"""Unit tests for conversion/sanitize.py — HTML/URL sanitization."""

from shared.sanitize import sanitize_html, sanitize_url


def test_strips_script_tag():
    out = sanitize_html('<p>ok</p><script>alert(1)</script>')
    assert '<script' not in out
    assert 'ok' in out


def test_strips_event_handler():
    out = sanitize_html('<p onclick="steal()">hi</p>')
    assert 'onclick' not in out
    assert 'hi' in out


def test_strips_javascript_href():
    out = sanitize_html('<a href="javascript:evil()">x</a>')
    assert 'javascript:' not in out


def test_preserves_functional_footnote_markup():
    html = '<sup class="footnote-ref" id="Fn1" fn-count-id="1">1</sup>'
    out = sanitize_html(html)
    assert 'footnote-ref' in out
    assert 'fn-count-id' in out


def test_sanitize_url_blocks_dangerous():
    for bad in ('javascript:alert(1)', 'vbscript:x', 'data:text/html,x', 'file:///etc/passwd'):
        assert sanitize_url(bad) in (None, '', '#')


def test_sanitize_url_allows_http():
    assert sanitize_url('https://example.org/page') == 'https://example.org/page'


def test_preserves_citation_path_marker_table():
    # The review report's "how this citation was checked" block travels as a data-chart marker
    # table (ClaimMarkdownFormatter::buildPathTableMd); the client renderer keys the outcome chip
    # off data-recorded and the row colours off data-band/data-kind. An allowlist silently drops
    # anything it has not been told about — these WERE dropped on first ship (2026-09-28), and
    # every traced citation rendered as "not recorded".
    html = ('<table data-chart="citation-path" data-recorded="1"><tbody>'
            '<tr data-band="ladder" data-kind="resolved"><td>Which work is it?</td>'
            '<td>Identified <a href="https://github.com/x" rel="noopener">code</a></td></tr>'
            '</tbody></table>')
    out = sanitize_html(html)
    for attr in ('data-chart="citation-path"', 'data-recorded="1"',
                 'data-band="ladder"', 'data-kind="resolved"', 'rel="noopener"'):
        assert attr in out, f'sanitizer dropped {attr}'

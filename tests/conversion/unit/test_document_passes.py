"""Unit tests for the orchestration DocPass units (process_document.py — the orchestrator
decomposition). main() was a single ~618-line function; each phase is now a small, guarded,
independently-testable DocPass threading a shared DocContext. These isolate the pure-soup passes so a
broken phase pinpoints to one class (the end-to-end byte-identity is guarded by the regression suite).
"""

import json
import os

from bs4 import BeautifulSoup

import process_document as P


def _ctx(tmp_path, html=None, book_id='book1'):
    ctx = P.DocContext('input.html', str(tmp_path), book_id)
    if html is not None:
        ctx.soup = BeautifulSoup(html, 'html.parser')
    return ctx


# ---------------------------------------------------------------------------
# SafariRtlFix — strip <span dir="rtl"> smart-quote spans
# ---------------------------------------------------------------------------
def test_safari_rtl_fix_strips_rtl_spans(tmp_path):
    ctx = _ctx(tmp_path, '<body><p>It<span dir="rtl">’</span>s here</p></body>')
    P.SafariRtlFix().apply(ctx)
    assert ctx.soup.find('span', attrs={'dir': 'rtl'}) is None
    # the quote character survives as text
    assert '’' in ctx.soup.get_text()


def test_safari_rtl_fix_noop_without_rtl(tmp_path):
    ctx = _ctx(tmp_path, '<body><p>plain</p></body>')
    P.SafariRtlFix().apply(ctx)
    assert ctx.soup.get_text() == 'plain'


# ---------------------------------------------------------------------------
# SplitBibliographyParagraphs — split a newline-crammed multi-entry <p>
# ---------------------------------------------------------------------------
def test_split_multi_entry_bibliography_paragraph(tmp_path):
    html = ('<body><p>Marcuse, H. 1964. One-Dimensional Man.\n'
            'Amin, S. 1974. Accumulation on a World Scale.</p></body>')
    ctx = _ctx(tmp_path, html)
    P.SplitBibliographyParagraphs().apply(ctx)
    ps = ctx.soup.find_all('p')
    assert len(ps) == 2
    assert 'Marcuse' in ps[0].get_text()
    assert 'Amin' in ps[1].get_text()


def test_split_leaves_single_line_paragraph_untouched(tmp_path):
    ctx = _ctx(tmp_path, '<body><p>A single ordinary paragraph, 2020, with a year.</p></body>')
    P.SplitBibliographyParagraphs().apply(ctx)
    assert len(ctx.soup.find_all('p')) == 1


# ---------------------------------------------------------------------------
# StemBibliography — guarded; converts wackSTEM markers + writes audit/stats
# ---------------------------------------------------------------------------
def test_stem_bibliography_converts_and_writes(tmp_path):
    html = ('<body><p>Claim<a class="wackSTEMcite">1</a>.</p>'
            '<a class="wackSTEMdef" id="stemref_1">Marcuse 1964</a></body>')
    ctx = _ctx(tmp_path, html)
    ctx.is_stem = True
    P.StemBibliography().apply(ctx)
    # wackSTEMdef → bib-entry collected as a reference
    assert ctx.references_data == [{'referenceId': 'stemref_1', 'content': 'Marcuse 1964'}]
    # wackSTEMcite → in-text-citation with href to the ref
    cite = ctx.soup.find('a', class_='in-text-citation')
    assert cite is not None and cite['href'] == '#stemref_1'
    # audit.json + conversion_stats.json written with stem_mode
    audit = json.load(open(os.path.join(str(tmp_path), 'audit.json')))
    assert audit['stem_mode'] is True
    stats = json.load(open(os.path.join(str(tmp_path), 'conversion_stats.json')))
    assert stats['footnote_strategy'] == 'stem_bibliography'


def test_stem_bibliography_guard_noop_when_not_stem(tmp_path):
    ctx = _ctx(tmp_path, '<body><a class="wackSTEMdef" id="x">y</a></body>')
    ctx.is_stem = False
    P.StemBibliography().apply(ctx)
    assert ctx.references_data == []
    assert not os.path.exists(os.path.join(str(tmp_path), 'audit.json'))


def test_extract_bibliography_guard_noop_when_stem(tmp_path):
    ctx = _ctx(tmp_path, '<body><p>x</p></body>')
    ctx.is_stem = True
    P.ExtractBibliography().apply(ctx)
    assert ctx.bibliography_map == {}        # untouched — the STEM branch owns this case


# ---------------------------------------------------------------------------
# GenerateNodeChunks — node objects with numeric ids + extracted refs/footnotes
# ---------------------------------------------------------------------------
def test_generate_node_chunks_extracts_refs_and_footnotes(tmp_path):
    html = ('<body>'
            '<p>Prose with a <a class="in-text-citation" href="#bib1">cite</a>.</p>'
            '<p>And a marker<sup class="footnote-ref" id="Fn99" fn-count-id="3">3</sup>.</p>'
            '</body>')
    ctx = _ctx(tmp_path, html, book_id='bk')
    P.GenerateNodeChunks().apply(ctx)
    nodes = ctx.node_chunks_data
    assert len(nodes) == 2
    # node keys + numeric ids
    assert nodes[0]['id'] == 'bk_1' and nodes[1]['id'] == 'bk_2'
    # citation href extracted
    assert nodes[0]['references'] == ['bib1']
    # footnote id + marker extracted
    assert nodes[1]['footnotes'] == [{'id': 'Fn99', 'marker': '3'}]
    # styling classes stripped, functional class kept
    assert 'in-text-citation' in nodes[0]['content']


# ---------------------------------------------------------------------------
# DOC_PASSES registry order invariants
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# StructuralCoverageAssessment — flag "reference-shaped paragraphs present but not extracted"
# (the christian2014digital case: a styled-<p> 'BIBLIOGRAPHY' header hid 573 references)
# ---------------------------------------------------------------------------
_AUTHORS = ['Adorno, Theodor W.', 'Althusser, Louis', 'Marx, Karl', 'Engels, Friedrich',
            'Williams, Raymond', 'Hall, Stuart', 'Harvey, David', 'Fuchs, Christian']


def _refs_html(n):
    ps = [f'<p>{_AUTHORS[i % len(_AUTHORS)]}. {1960 + i}. A work titled number {i}. London: Verso.</p>'
          for i in range(n)]
    return '<body>' + ''.join(ps) + '</body>'


def _coverage_records():
    return [r for r in P.ASSESSMENT.records if r.get('module') == 'structural_coverage']


def test_structural_coverage_flags_unextracted_references(tmp_path):
    ctx = _ctx(tmp_path, _refs_html(20))
    ctx.references_data = []                  # the bug: the reference list was never located
    P.ASSESSMENT.reset()
    P.StructuralCoverageAssessment().apply(ctx)
    recs = _coverage_records()
    assert len(recs) == 1
    assert recs[0]['decision'] == 'faulty'
    assert 'bibliography.py' in recs[0]['code_ref']           # routes to the scan (+ heading sibling via vibe loop)
    assert 'heading' in recs[0]['rationale'].lower()          # names the real cause: a styled-<p> header, not an <h*>
    assert recs[0]['evidence']['reference_shaped_paragraphs'] >= 20


def test_structural_coverage_silent_when_references_extracted(tmp_path):
    ctx = _ctx(tmp_path, _refs_html(20))
    ctx.references_data = [{'referenceId': f'k{i}'} for i in range(18)]   # extracted fine
    P.ASSESSMENT.reset()
    P.StructuralCoverageAssessment().apply(ctx)
    assert _coverage_records() == []


def test_structural_coverage_silent_on_small_doc(tmp_path):
    ctx = _ctx(tmp_path, _refs_html(4))       # below MIN_REF_SHAPED — too few to be sure
    ctx.references_data = []
    P.ASSESSMENT.reset()
    P.StructuralCoverageAssessment().apply(ctx)
    assert _coverage_records() == []


def test_structural_coverage_guard_noop_when_stem(tmp_path):
    ctx = _ctx(tmp_path, _refs_html(20))
    ctx.references_data = []
    ctx.is_stem = True                        # STEM numeric-ref path is counted differently
    P.ASSESSMENT.reset()
    P.StructuralCoverageAssessment().apply(ctx)
    assert _coverage_records() == []


def _coverage_fn_records():
    return [r for r in _coverage_records() if 'list items' in r.get('rationale', '')]


def test_structural_coverage_flags_footnotes_in_list_items(tmp_path):
    # a page-list-style <ol> of numbers matched as footnotes → flag, routed to footnote DETECTION
    lis = ''.join(f'<li><sup class="footnote-ref" fn-count-id="{i}">{400 + i}</sup></li>' for i in range(15))
    ctx = _ctx(tmp_path, f'<body><ol>{lis}</ol><p>ordinary body text here</p></body>')
    ctx.references_data = [{'referenceId': 'x'}]        # keep the reference contradiction quiet
    P.ASSESSMENT.reset()
    P.StructuralCoverageAssessment().apply(ctx)
    recs = _coverage_fn_records()
    assert len(recs) == 1
    assert recs[0]['decision'] == 'faulty'
    assert 'footnoteMatching' in recs[0]['code_ref']
    assert recs[0]['evidence']['footnote_refs_in_list_items'] == 15


def test_structural_coverage_silent_on_few_list_footnotes(tmp_path):
    # a handful of genuine footnotes that happen to sit in list items must NOT trip it
    lis = ''.join(f'<li><sup class="footnote-ref">{i}</sup></li>' for i in range(3))
    ctx = _ctx(tmp_path, f'<body><ol>{lis}</ol></body>')
    ctx.references_data = [{'referenceId': 'x'}]
    P.ASSESSMENT.reset()
    P.StructuralCoverageAssessment().apply(ctx)
    assert _coverage_fn_records() == []


# ---------------------------------------------------------------------------
# StripStylingSpans — FINAL universal span removal (node + footnote + reference content)
# ---------------------------------------------------------------------------
def test_strip_styling_spans_clears_all_spans_keeping_anchor(tmp_path):
    # the rudolph case: a heading whose text is inside <span>s (broke the TOC) → ALL spans gone, text kept;
    # an id-bearing span (anchor target) survives as an empty <a> jump-target, NOT a span.
    ctx = _ctx(tmp_path, '<body>'
               '<h2><a href="#x"><span>III</span> <span>Other works mentioned</span></a></h2>'
               '<p><span id="page_5">5</span> body text</p></body>')
    out = P.StripStylingSpans().apply(ctx)
    assert out['spans_stripped'] == 3
    assert ctx.soup.find_all('span') == []                                           # NO spans survive
    # text preserved (normalise whitespace — the space between the two unwrapped spans survives in the DOM)
    assert ' '.join(ctx.soup.find('h2').get_text().split()) == 'III Other works mentioned'
    assert ctx.soup.find('a', id='page_5') is not None                               # anchor kept as <a>
    assert '5 body text' in ctx.soup.get_text()                                      # content preserved


def test_strip_styling_spans_promotes_italic_bold_not_underline(tmp_path):
    # italic/bold (class OR inline style) keep their meaning as <i>/<b>; underline does NOT become <u>
    # (<u> is reserved for the hypercite system) — it flattens to plain text.
    ctx = _ctx(tmp_path, '<body><p>'
               '<span class="italic">Title</span> '
               '<span class="bold">key</span> '
               '<span style="font-style: italic">also</span> '
               '<span style="text-decoration: underline">under</span> '
               '<span class="calibre3">plain</span>'
               '</p></body>')
    out = P.StripStylingSpans().apply(ctx)
    assert ctx.soup.find_all('span') == []                       # no spans survive
    assert ctx.soup.find_all('u') == []                          # NO <u> — reserved for hypercites
    assert out['spans_promoted'] == 3                            # 2 italic + 1 bold (underline NOT promoted)
    assert [i.get_text() for i in ctx.soup.find_all('i')] == ['Title', 'also']
    assert ctx.soup.find('b').get_text() == 'key'
    assert 'under' in ctx.soup.get_text() and 'plain' in ctx.soup.get_text()  # both flattened to text


def test_strip_styling_spans_cleans_footnote_and_reference_content(tmp_path):
    ctx = _ctx(tmp_path, '<body><p>x</p></body>')
    ctx.footnotes_data = [{'footnoteId': 'F1', 'content': '<p>a note with <span>styled</span> words</p>'}]
    ctx.references_data = [{'referenceId': 'r1', 'content': '<p>Author. 1981. <span>Title</span>.</p>'}]
    P.StripStylingSpans().apply(ctx)
    assert '<span' not in ctx.footnotes_data[0]['content'] and 'styled' in ctx.footnotes_data[0]['content']
    assert '<span' not in ctx.references_data[0]['content'] and 'Title' in ctx.references_data[0]['content']


def test_doc_passes_order_invariants():
    names = [p.name for p in P.DOC_PASSES]
    # extract precedes link precedes audit
    assert names.index('extract_bibliography') < names.index('link_citations')
    assert names.index('link_citations') < names.index('audit')
    assert names.index('select_footnote_strategy') < names.index('link_footnotes')
    # structural coverage reads the extracted counts → must run after audit, before node-gen
    assert names.index('audit') < names.index('structural_coverage') < names.index('generate_node_chunks')
    # span strip runs AFTER all detection/linking but BEFORE node-gen (so node content is span-free)
    assert names.index('audit') < names.index('strip_styling_spans') < names.index('generate_node_chunks')
    # node-gen + sanitize are always last (they run for both STEM and standard)
    assert names[-2:] == ['generate_node_chunks', 'sanitize_and_write']
    # load is first
    assert names[0] == 'load_document'


def test_every_doc_pass_is_a_docpass():
    from shared.pipeline_base import DocPass
    assert all(isinstance(p, DocPass) for p in P.DOC_PASSES)
    # unique, non-empty names
    names = [p.name for p in P.DOC_PASSES]
    assert len(names) == len(set(names)) and all(names)

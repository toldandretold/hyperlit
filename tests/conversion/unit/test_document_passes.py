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
def test_doc_passes_order_invariants():
    names = [p.name for p in P.DOC_PASSES]
    # extract precedes link precedes audit
    assert names.index('extract_bibliography') < names.index('link_citations')
    assert names.index('link_citations') < names.index('audit')
    assert names.index('select_footnote_strategy') < names.index('link_footnotes')
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

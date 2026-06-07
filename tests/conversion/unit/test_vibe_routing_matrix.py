"""The headline guarantee of the vibeConverter split: for a given (problem X, file type Y) we can pin
EXACTLY what reaches the model — (1) which source modules are inlined, (2) which prompt sections fire,
(3) what evidence the file-type-aware samplers surface. This is the "what's sent to the model" matrix.

Imports through the `vibe_convert` shim on purpose — it exercises the real wired package end-to-end.
"""
import os
import textwrap

import vibe_convert as vc


def _art(book_dir='/tmp/x', is_epub=False, is_pdf=False, footnotes_matched=1, source='# converted\nbody',
         markdown=None, assessment=None):
    """A synthetic artifacts dict — the only inputs routing + prompt building depend on."""
    return {
        'is_pdf': is_pdf, 'is_epub': is_epub, 'source': source, 'markdown': markdown, 'book_dir': book_dir,
        'stats': {'references_found': 3, 'citations_total': 5, 'citations_linked': 5,
                  'footnotes_matched': footnotes_matched, 'footnote_strategy': 'x', 'citation_style': 'x'},
        'audit': {'total_refs': 3, 'total_defs': footnotes_matched, 'gaps': [],
                  'unmatched_refs': [], 'unmatched_defs': []},
        'assessment': assessment if assessment is not None else [],
    }


def _mods(issue, **art_kw):
    return vc.modules_for([], _art(**art_kw), issue_types=[issue])


# ── 1. MODULES ROUTED — the right detector for the pathway, human report leads ────────────────────

def test_footnotes_not_matched_epub_routes_the_epub_detector_first():
    mods = _mods('footnotes_not_matched', is_epub=True)
    assert any('ingestion/epub/footnoteMatching.py' in m for m in mods), mods
    # the footnote files lead; the citation red-herring (if any) is demoted below them
    fn_idx = next(i for i, m in enumerate(mods) if m.endswith('footnoteExtraction/footnotes.py'))
    cit = [i for i, m in enumerate(mods) if 'citationLinking' in m or 'bibliography' in m]
    assert all(fn_idx < c for c in cit), f'footnote files must precede citation files: {mods}'


def test_footnotes_not_matched_pdf_routes_the_ocr_classifier_not_process_document():
    mods = _mods('footnotes_not_matched', is_pdf=True)
    assert any('ingestion/pdf/classification.py' in m for m in mods), mods
    assert any('ingestion/pdf/assembly.py' in m for m in mods), mods
    assert not any(m.endswith('digestion/process_document.py') for m in mods), mods


def test_footnotes_not_matched_html_routes_the_shared_orchestrator():
    mods = _mods('footnotes_not_matched')          # neither epub nor pdf
    assert any(m.endswith('digestion/process_document.py') for m in mods), mods
    assert not any('footnoteMatching.py' in m for m in mods), mods
    assert not any('ingestion/pdf/classification.py' in m for m in mods), mods


def test_citations_not_matched_routes_bibliography_and_linker():
    mods = _mods('citations_not_matched', is_epub=True)
    assert any('bibliography.py' in m for m in mods), mods
    assert any('citation_link_rules.py' in m for m in mods), mods


def test_headings_wrong_routes_heading_detection_only():
    mods = _mods('headings_wrong', is_epub=True)
    assert any('headingMatching.py' in m for m in mods), mods
    assert not any('footnoteMatching.py' in m for m in mods), mods


# ── 2. PROMPT SECTIONS PRESENT — the report leads, the per-issue gloss + raw-marker evidence fire ──

def _epub_book(tmp_path, n=14):
    bd = tmp_path / 'book'
    (bd / 'epub_original').mkdir(parents=True)
    markers = '\n'.join(f'<p>Sentence {i}.<a href="#fn{i}"><sup>{i}</sup></a></p>' for i in range(1, n + 1))
    (bd / 'epub_original' / 'ch.xhtml').write_text('<html><body>' + markers + '</body></html>')
    return str(bd)


def test_footnote_report_prompt_leads_with_human_report_and_detection_gloss(tmp_path):
    bd = _epub_book(tmp_path)
    art = _art(book_dir=bd, is_epub=True, footnotes_matched=1)
    mods = vc.modules_for([], art, issue_types=['footnotes_not_matched'])
    prompt = vc.build_prompt(art, mods, issue_types=['footnotes_not_matched'])
    # the reader's report is present and leads (before the inlined module source)
    assert 'What the reader reports' in prompt
    assert prompt.index('What the reader reports') < prompt.index('Responsible module source')
    # the detection-first gloss for footnotes_not_matched
    assert 'FIRST suspect' in prompt and 'DETECTION' in prompt


def test_raw_marker_evidence_section_fires_when_markers_exceed_detected(tmp_path):
    bd = _epub_book(tmp_path, n=14)
    art = _art(book_dir=bd, is_epub=True, footnotes_matched=1)
    prompt = vc.build_prompt(art, vc.modules_for([], art, issue_types=['footnotes_not_matched']),
                             issue_types=['footnotes_not_matched'])
    assert 'RAW source' in prompt           # the "Footnote-marker shapes in the RAW source" block
    assert '<sup>' in prompt                 # the verbatim scheme the detector missed


# ── 3. MARKER SAMPLER BY FILETYPE — the right evidence shape per source type ───────────────────────

def test_epub_sampler_finds_anchored_sup_markers(tmp_path):
    bd = _epub_book(tmp_path, n=12)
    count, samples = vc._raw_footnote_markers(_art(book_dir=bd, is_epub=True))
    assert count == 12, count
    assert samples and any('<sup>' in s for s in samples)


def test_pdf_sampler_finds_markdown_footnote_refs(tmp_path):
    bd = tmp_path / 'pdfbook'
    bd.mkdir()
    md = textwrap.dedent("""\
        Some prose with a footnote.[^1] And another.[^2]

        [^1]: First note.
        [^2]: Second note.
    """)
    (bd / 'main-text.md').write_text(md)
    art = _art(book_dir=str(bd), is_pdf=True, markdown=md, source=md)
    out = vc._footnote_samples(art)
    assert '[^1]' in out and '[^2]' in out

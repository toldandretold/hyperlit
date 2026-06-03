"""Unit tests for the PDF frontend registries (mistral_ocr.py) — the PDF_CLASSIFIERS analysis
registry and the PDF_ASSEMBLERS assembly registry that classify_footnotes / assemble_markdown were
decomposed into. Each classifier owns one layout's gate; each assembler owns one layout's per-page +
post-combine handling. PDFs are endlessly varied → a new shape is a new classifier + assembler.

End-to-end byte-identity is guarded by test_pdf_assembly_snapshot.py; these isolate the units so a
broken gate/handler pinpoints to one class.
"""

import mistral_ocr as M


def _sig(**over):
    """A neutral signals dict; override the keys a gate reads."""
    base = {
        "pages_with_refs": 5, "pages_with_both": 0, "pages_with_defs": 0,
        "co_location_ratio": 0.0, "def_clustering_ratio": 0.5, "reset_count": 0,
        "reset_frequency": 0.0, "notes_page_count": 0, "ref_number_max_page_spread": 1,
        "numbers_on_multiple_pages": 0, "max_ref_number": 5,
        "trailing_page_number_consistency": 0.0,
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# Registry shape + order (the decision-tree order is load-bearing)
# ---------------------------------------------------------------------------
def test_classifier_registry_order():
    names = [c.name for c in M.PDF_CLASSIFIERS]
    # none first; wackSTEM before page_bottom (it was tested first in the old tree)
    assert names == ['none', 'wackSTEMbibliographyNotes', 'page_bottom',
                     'chapter_endnotes', 'document_endnotes']
    # unknown is the fall-through default, not in the matching list
    assert M._UNKNOWN_CLASSIFIER.name == 'unknown'
    assert 'unknown' not in names


def test_assembler_registry_covers_each_class():
    assert set(M.PDF_ASSEMBLERS) == {'page_bottom', 'chapter_endnotes',
                                     'document_endnotes', 'wackSTEMbibliographyNotes'}
    # the generic/unknown path uses the default assembler
    assert isinstance(M._DEFAULT_ASSEMBLER, M.DefaultAssembler)


# ---------------------------------------------------------------------------
# Per-classifier gates (matches fires on its target, not on a neutral signal)
# ---------------------------------------------------------------------------
def test_none_classifier_gate():
    assert M.NoneClassifier().matches(_sig(pages_with_refs=0)) is True
    assert M.NoneClassifier().matches(_sig(pages_with_refs=5)) is False
    assert M.NoneClassifier().confidence(_sig()) == 1.0


def test_wackstem_classifier_gate():
    hit = _sig(ref_number_max_page_spread=5, co_location_ratio=0.0, notes_page_count=0,
               reset_count=0, reset_frequency=0.0, max_ref_number=50)
    assert M.WackStemClassifier().matches(hit) is True
    # a Notes header disqualifies it
    assert M.WackStemClassifier().matches(_sig(**{**hit, 'notes_page_count': 1})) is False
    # too many resets disqualifies it
    assert M.WackStemClassifier().matches(_sig(**{**hit, 'reset_count': 4, 'reset_frequency': 0.9, 'max_ref_number': 10})) is False


def test_page_bottom_classifier_both_gates():
    cont = _sig(co_location_ratio=0.5, pages_with_both=3, reset_frequency=0.0, max_ref_number=20)
    assert M.PageBottomClassifier().matches(cont) is True
    restart = _sig(co_location_ratio=0.6, reset_frequency=0.5)
    assert M.PageBottomClassifier().matches(restart) is True
    assert M.PageBottomClassifier().matches(_sig(co_location_ratio=0.1)) is False


def test_chapter_endnotes_classifier_gates():
    notes = _sig(notes_page_count=2, co_location_ratio=0.0)
    assert M.ChapterEndnotesClassifier().matches(notes) is True
    resets = _sig(co_location_ratio=0.2, pages_with_defs=3, reset_frequency=0.5)
    assert M.ChapterEndnotesClassifier().matches(resets) is True
    assert M.ChapterEndnotesClassifier().matches(_sig(co_location_ratio=0.5)) is False


def test_document_endnotes_classifier_gate():
    assert M.DocumentEndnotesClassifier().matches(_sig(co_location_ratio=0.05, def_clustering_ratio=0.05)) is True
    assert M.DocumentEndnotesClassifier().matches(_sig(co_location_ratio=0.5, def_clustering_ratio=0.5)) is False


def test_story_hooks_are_self_describing():
    # each classifier carries its own would_need + a signal-driven margin/rejected_because
    sig = _sig(co_location_ratio=0.0)
    for clf in M.PDF_CLASSIFIERS + [M._UNKNOWN_CLASSIFIER]:
        assert clf.would_need
        assert isinstance(clf.rejected_because(sig), str)
        assert isinstance(clf.margin(sig), str)


# ---------------------------------------------------------------------------
# Per-assembler behaviour (the per-page + post-combine handling)
# ---------------------------------------------------------------------------
def test_default_assembler_normalizes_definitions():
    ctx = M.AssemblyContext({"pages": []}, 'unknown', None)
    out = M.DefaultAssembler().post_combine(ctx, "Body text.\n\n[^1] A definition.")
    # OCR "[^1] text" → markdown "[^1]: text"
    assert "[^1]: A definition." in out


def test_page_bottom_assembler_splits_body_and_defs():
    ctx = M.AssemblyContext({"pages": []}, 'page_bottom', None)
    page_md = "Body with a marker[^1].\n\n[^1]: the footnote text"
    M.PageBottomAssembler().per_page(ctx, 0, {}, page_md, page_md.strip())
    # body goes to md_parts, the definition to fn_defs_parts
    assert ctx.md_parts and any('[^' in p for p in ctx.md_parts)
    assert ctx.fn_defs_parts


def test_wackstem_assembler_wraps_citations():
    ctx = M.AssemblyContext({"pages": []}, 'wackSTEMbibliographyNotes', None)
    out = M.WackStemAssembler().post_combine(ctx, "A claim [1] and another [2].")
    assert 'wackSTEMcite' in out


def test_chapter_assembler_setup_builds_offsets_only_with_meta():
    # no footnote_meta → no chapter offsets (guarded)
    ctx = M.AssemblyContext({"pages": [{"markdown": ""}]}, 'chapter_endnotes', None)
    M.ChapterEndnotesAssembler().setup(ctx)
    assert ctx.chapter_fn_offsets is None
    # with a page_summary showing a number reset → offsets get built
    meta = {'page_summary': [
        {'index': 0, 'refs': [1, 12], 'defs': []},
        {'index': 1, 'refs': [1, 8], 'defs': []},   # reset (ref drops well below prior max)
    ]}
    ctx2 = M.AssemblyContext({"pages": [{"markdown": ""}, {"markdown": ""}]}, 'chapter_endnotes', meta)
    M.ChapterEndnotesAssembler().setup(ctx2)
    assert ctx2.chapter_fn_offsets is not None and len(ctx2.chapter_fn_offsets) == 2

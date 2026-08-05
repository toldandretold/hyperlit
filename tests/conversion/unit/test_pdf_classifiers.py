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
        "trailing_page_number_consistency": 0.0, "citation_group_ratio": 0.0,
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
    # too many resets disqualifies it — when numbering stays LOW (chapter-restart shape)
    assert M.WackStemClassifier().matches(_sig(**{**hit, 'reset_count': 4, 'reset_frequency': 0.9, 'max_ref_number': 10})) is False
    # …but NOT when numbering is global-bibliography scale: re-citing [1] late in the paper IS the
    # wackSTEM signature, and every re-citation of a low number reads as a "reset". The Sci-Hub
    # coverage paper (129 refs, 9 resets from re-citation) was misclassified chapter_endnotes.
    assert M.WackStemClassifier().matches(_sig(**{**hit, 'reset_count': 9, 'reset_frequency': 0.47, 'max_ref_number': 129})) is True


def test_wackstem_citation_group_ratio_excuses_resets():
    # A SHORT numbered-bibliography paper (709c9348): re-cited low numbers read as resets and the
    # ceiling never climbs (max-ref 33), so the max_ref>50 escape misses it. Dense "[1,2,3]" Vancouver
    # multi-cites (citation_group_ratio 0.25) are the second escape — chapter endnotes never cite in
    # bracket GROUPS.
    borderline = _sig(ref_number_max_page_spread=4, co_location_ratio=0.0, notes_page_count=0,
                      reset_count=6, reset_frequency=0.55, max_ref_number=33)
    assert M.WackStemClassifier().matches(borderline) is False
    assert M.WackStemClassifier().matches(_sig(**{**borderline, 'citation_group_ratio': 0.25})) is True
    # Guard: a footnoted book with a STRAY "[5, 12]" group (low ratio) stays out — else 433d423b
    # (a real chapter_endnotes book, ratio ~0.03) would be misrouted to wackSTEM.
    assert M.WackStemClassifier().matches(_sig(**{**borderline, 'citation_group_ratio': 0.03})) is False


def test_page_bottom_classifier_both_gates():
    cont = _sig(co_location_ratio=0.5, pages_with_both=3, reset_frequency=0.0, max_ref_number=20)
    assert M.PageBottomClassifier().matches(cont) is True
    restart = _sig(co_location_ratio=0.6, reset_frequency=0.5)
    assert M.PageBottomClassifier().matches(restart) is True
    assert M.PageBottomClassifier().matches(_sig(co_location_ratio=0.1)) is False


def test_page_bottom_classifier_ocr_diluted_coloc_gate():
    # Bedjaoui "Towards a NIEO": page-bottom footnotes, but messy OCR dropped defs on many ref pages
    # so overall co-location reads LOW (0.29). The defs that survived sit WITH their refs
    # (31/33 def-pages carry refs → def_coloc 0.94), numbering restarts (rf 0.98), no notes section.
    # page_bottom is checked before chapter_endnotes → it must claim this instead of mis-routing to
    # chapter_endnotes (which found no notes pages and extracted 0 footnotes).
    bedjaoui = _sig(co_location_ratio=0.29, pages_with_refs=107, pages_with_defs=33,
                    pages_with_both=31, reset_frequency=0.98, notes_page_count=0, max_ref_number=5)
    assert M.PageBottomClassifier().matches(bedjaoui) is True
    # Guard: genuine separated endnotes (def pages are ref-FREE → def_coloc low) must NOT be claimed.
    separated = _sig(co_location_ratio=0.1, pages_with_refs=100, pages_with_defs=10,
                     pages_with_both=1, reset_frequency=0.9, notes_page_count=0)
    assert M.PageBottomClassifier().matches(separated) is False


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


def test_wackstem_wraps_endash_ranges_and_heading_defs():
    # En-dash range [1–3] (real typesetting) expands to the individual refs.
    out = M.wrap_stem_citations("Estimates suggest paywalls limit access [1–3].")
    assert 'data-refs="stemref_1,stemref_2,stemref_3"' in out
    assert '[1–3]' in out  # the document's own dash survives in the visible text
    # Heading-shaped reference entries (Mistral reads a bold ref title as a heading)
    # are wrapped as defs — but ONLY after the References heading; a numbered
    # SECTION heading before it is never touched (no confident wrong links).
    md = "# 3. Methods\n\nBody text.\n\n# References\n\n1. First Ref\n\n# 79. The Rise of Pirate Libraries\n"
    out = M.wrap_stem_definitions(md)
    assert '<a class="wackSTEMdef" id="stemref_79">79. The Rise of Pirate Libraries</a>' in out
    assert 'id="stemref_1"' in out
    assert '# 3. Methods' in out  # section heading untouched


def test_toc_dotted_leader_page_numbers_not_wrapped():
    # "Introduction and Scope...3" is a TABLE-OF-CONTENTS page number, never a footnote marker.
    toc = "# Table of Contents\n\nIntroduction and Scope...3\n\nUsage Data...30\n"
    out = M.convert_inline_footnote_markers(toc)
    assert '[^' not in out
    out2 = M.normalize_all_footnote_refs(toc)
    assert '[^' not in out2
    # a genuine marker after a year is still resurrected ("…status quo in 2007.26 Table 1")
    assert '[^26]' in M.normalize_all_footnote_refs("known [^1] fact. status quo in 2007.26 Table 1 shows [^40].")
    # a decimal in a table cell ("8.7") is not a marker
    assert '[^7]' not in M.normalize_all_footnote_refs("cell [^1] value 8.7 next [^40].")


def test_affiliation_block_resolves_or_demotes():
    ctx = M.AssemblyContext({"pages": []}, 'unknown', None)
    # Unambiguous: author markers + glued affiliation defs, none colliding → link them.
    md = ("Ann Lee[^1], Bo Ng[^2], Cy Ho[^3]\n\n"
          "[^1]London School of Economics\n[^2]University of Melbourne\n[^3]University of Zurich\n")
    out = M._resolve_affiliation_block(md)
    assert "[^1]: London School of Economics" in out
    assert "[^3]: University of Zurich" in out
    # Colliding: the same numbers ALSO define real footnotes elsewhere → demote (no wrong links).
    md2 = ("Ann Lee[^1], Bo Ng[^2], Cy Ho[^3]\n\n"
           "[^1]Prof of X\n[^2]Editor of Y\n[^3]Dir of Z\n\nBody.[^1]\n\n[^1]: The JIF is defined as…\n")
    out2 = M._resolve_affiliation_block(md2)
    assert "1. Prof of X" in out2                 # affiliation demoted to plain text
    assert "Ann Lee, Bo Ng, Cy Ho" in out2        # author-line markers stripped


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

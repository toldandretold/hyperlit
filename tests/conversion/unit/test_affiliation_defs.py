"""Author-affiliation definition rescue + demotion (cases 2c0544c4 / a280cf5b).

Two opposite failure shapes around author-line affiliation markers:
- 2c0544c4: the defs EXIST but Mistral glued the whole affiliation list into ONE paragraph
  ("[^1]: Copernicus…  [^2] Department…  … [^18] e-mail…") — only [^1] is a line-start def, so
  markers 2-18 never link. _split_glued_inline_defs splits the ascending run into one def per line.
- a280cf5b: the defs are ABSENT from the entire OCR response — the author line's [^1]..[^5]
  are permanently unlinkable literal junk. _demote_defless_author_markers strips them, but ONLY
  on a name-list-shaped line; body prose with genuinely missing footnotes keeps its markers so
  the loss stays visible in the audit.
"""

from ingestion.pdf.assembly import (
    _split_glued_inline_defs, _demote_defless_author_markers, _demote_defless_citation_refs)


GLUED = ('[^1]: Copernicus Institute, Utrecht University, The Netherlands.  '
         '[^2] Department of Political Science, Lund University, Sweden.  '
         '[^3] German Institute for International and Security Affairs, Berlin, Germany.  '
         '[^4] Department of Political Science, University of Toronto, Canada.')


def test_glued_affiliation_block_splits_into_one_def_per_line():
    out = _split_glued_inline_defs('Body paragraph.\n' + GLUED + '\nMore body.')
    assert '\n[^2]: Department of Political Science, Lund University, Sweden.\n' in out
    assert '\n[^3]: German Institute for International and Security Affairs, Berlin, Germany.\n' in out
    assert '\n[^4]: Department of Political Science, University of Toronto, Canada.' in out


def test_non_ascending_embedded_markers_left_untouched():
    line = ('[^5]: A definition citing other notes.  [^2] mentioned earlier.  '
            '[^9] and another back-reference here.')
    assert _split_glued_inline_defs(line) == line


def test_single_embedded_marker_left_untouched():
    line = '[^1]: A def whose text happens to mention  [^2] once with wide spacing.'
    assert _split_glued_inline_defs(line) == line


def test_body_paragraph_with_inline_refs_untouched():
    # Inline refs are glued to words (no two-space + no-colon opener shape) — never split.
    line = 'A body claim[^3] with another marker[^4] later in the sentence.'
    assert _split_glued_inline_defs(line) == line


AUTHORS = 'Roger Few[^1], Daniel Morchain[^2], Dian Spear[^3], Adelina Mensah[^4] and Ramkumar Bendapudi[^5]'


def test_defless_author_line_markers_are_stripped():
    md = '# Title\n\n' + AUTHORS + '\n\nABSTRACT In recent years there has been…'
    out = _demote_defless_author_markers(md)
    assert 'Roger Few, Daniel Morchain, Dian Spear, Adelina Mensah and Ramkumar Bendapudi' in out
    assert '[^1]' not in out


def test_author_markers_kept_when_any_def_exists():
    md = '# Title\n\n' + AUTHORS + '\n\nBody.\n\n[^3]: University of Cape Town, South Africa'
    assert _demote_defless_author_markers(md) == md


def test_sentence_shaped_line_keeps_defless_markers():
    # A body sentence with genuinely missing footnote defs must keep its markers (audit-visible).
    md = ('# Title\n\nThe committee reviewed the evidence,[^7] and the report was '
          'adopted without amendment.[^8]\n\nMore body.')
    assert _demote_defless_author_markers(md) == md


def test_deep_body_line_untouched():
    # Beyond the top-of-document window, even a name-list line keeps its markers.
    md = '\n'.join(f'line {i}' for i in range(60)) + '\n' + AUTHORS
    assert _demote_defless_author_markers(md) == md


AFFIL_DEFS = '\n'.join(f'[^{i}]: Affiliation number {i}.' for i in range(1, 6))
BIB = '\n'.join(f'{i}. Author {i} (2020) A cited work.' for i in range(1, 40))


def test_vancouver_refs_beyond_affiliation_universe_demote_to_bracket_citations():
    md = ('Author One[^1], Author Two[^2]\n\nnever merged[^27]. Some countries[^30][^31] '
          'highlight this.\n\n' + AFFIL_DEFS + '\n\n# References\n\n' + BIB)
    out = _demote_defless_citation_refs(md)
    assert 'never merged[27].' in out                       # citation bracket, linkable
    assert 'countries[30,31]' in out                        # adjacent singles merged
    assert 'Author One[^1], Author Two[^2]' in out          # in-universe refs untouched
    assert '[^3]: Affiliation number 3.' in out             # defs untouched


def test_mid_range_lost_def_keeps_marker():
    # Ref 3 whose def the OCR lost sits INSIDE the def universe — stays audit-visible.
    md = ('A claim[^3] here.\n\n[^1]: A.\n[^2]: B.\n[^4]: D.\n[^5]: E.\n\n' + BIB)
    assert _demote_defless_citation_refs(md) == md


def test_large_def_universe_disables_demotion():
    # A real endnote doc (defs 1..40) keeps every ref even when a numbered list exists.
    defs = '\n'.join(f'[^{i}]: Note {i}.' for i in range(1, 41))
    md = 'A claim[^45] here.\n\n' + defs + '\n\n' + BIB + '\n45. Author 45 (2020) Work.'
    assert _demote_defless_citation_refs(md) == md


def test_no_bibliography_no_demotion():
    md = 'A claim[^27] here.\n\n' + AFFIL_DEFS
    assert _demote_defless_citation_refs(md) == md


def test_body_refs_inside_def_universe_demote_outside_author_zone():
    # 2c0544c4 wrong-link: body superscript 13 cites BIBLIOGRAPHY entry 13, but linked to
    # affiliation def 13. Author-block occurrences keep their markers; body ones demote to
    # linkable bracket citations — GATED on evidence (beyond-universe refs present).
    authors = 'Author One[^1], Prajal Pradhan[^13], Rob Raven[^1][^14]'
    body = ('An effective orchestrator[^13] in global governance[^27], with best practices '
            'disseminated across countries[^29] and actors[^14] in many settings, and a '
            'latex range remains$^{20-22}$ in the prose.')
    defs = '\n'.join(f'[^{i}]: Affiliation number {i}.' for i in range(1, 15))
    bib = '\n'.join(f'{i}. Author {i} (2020) A cited work.' for i in range(1, 40))
    md = authors + '\n\n' + body + '\n\n' + defs + '\n\n# References\n\n' + bib
    out = _demote_defless_citation_refs(md)
    assert 'Pradhan[^13]' in out and 'Raven[^1][^14]' in out     # author zone keeps markers
    assert 'orchestrator[13]' in out and 'actors[14]' in out     # body demotes to citations
    assert 'governance[27]' in out and 'countries[29]' in out
    assert 'remains[20-22]' in out                               # latex range → range citation
    assert out.count('[^13]:') == 1 and '[^14]: Affiliation number 14.' in out  # defs untouched


def test_in_universe_body_refs_kept_without_beyond_universe_evidence():
    # BOTH regimes share numbers 1..N — with no beyond-universe citations in the doc there
    # is no evidence the body superscripts are citations, so they keep their footnote links.
    authors = 'Author One[^1], Prajal Pradhan[^13]'
    body = 'An effective orchestrator[^13] in global governance discussed at length here.'
    defs = '\n'.join(f'[^{i}]: Affiliation number {i}.' for i in range(1, 15))
    bib = '\n'.join(f'{i}. Author {i} (2020) A cited work.' for i in range(1, 40))
    md = authors + '\n\n' + body + '\n\n' + defs + '\n\n# References\n\n' + bib
    assert _demote_defless_citation_refs(md) == md

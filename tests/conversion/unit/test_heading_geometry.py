"""Heading GEOMETRY: the PDF's own type styles as the universal key for section structure the
OCR's markdown lost — a heading emitted as a plain paragraph (5fc4aad4: "The Social Distancing of
Old, Weak and Ill Individuals", set in Arial-BoldMT exactly like the nine headings Mistral DID
mark) and a printed section NUMBER the OCR dropped (c0813ca6: "1.(Digital) Work and Labour…",
"1.1.Defining Cultural Labour" — without the number, `_level_numbered_headings` cannot fix levels
either).

The whole safety argument is that the pass learns from THIS document: a style promotes only where
the OCR already marked a heading in that style, and only onto a paragraph the PDF line matches
whole and uniquely.
"""

from ingestion.pdf.heading_geometry import recover_geometric_headings


BOLD = ['Arial-BoldMT', 0.24]
BODY = ['ArialMT', 0.24]
PAD = '\n\n'.join(f'Filler paragraph number {i} carrying enough prose to be a real paragraph.'
                  for i in range(9))          # clears the front-matter window


def info(*lines):
    return {'body_style': BODY,
            'lines': [{'page': p, 'text': t, 'style': s, 'x': 18} for p, t, s in lines]}


def test_promotes_a_paragraph_set_in_a_confirmed_heading_style():
    md = (PAD + '\n\n## Critical Infrastructures\n\nSome prose about infrastructure.\n\n'
          'The Social Distancing of Old, Weak and Ill Individuals\n\n'
          'Old people and people suffering from chronic disease are at risk.')
    out, renum, promoted, _lvl = recover_geometric_headings(md, info(
        (12, 'Critical Infrastructures', BOLD),
        (13, 'The Social Distancing of Old, Weak and Ill Individuals', BOLD)))
    assert promoted == ['The Social Distancing of Old, Weak and Ill Individuals']
    # level comes from the nearest confirmed heading of the same style
    assert '## The Social Distancing of Old, Weak and Ill Individuals' in out


def test_unconfirmed_style_promotes_nothing():
    # The style never appears as a marked heading in this document, so there is no evidence that
    # the document uses it for headings — a bold lead-in is exactly this shape.
    md = PAD + '\n\nA short bold statement standing alone\n\nOrdinary following paragraph.'
    out, renum, promoted, _lvl = recover_geometric_headings(md, info(
        (4, 'A short bold statement standing alone', BOLD)))
    assert (out, renum, promoted) == (md, [], [])


def test_ambiguous_match_is_left_alone():
    md = (PAD + '\n\n## Confirmed Heading\n\nbody\n\nRepeated Line\n\nbody\n\nRepeated Line')
    out, _r, promoted, _lvl = recover_geometric_headings(md, info(
        (1, 'Confirmed Heading', BOLD), (2, 'Repeated Line', BOLD)))
    assert promoted == []
    assert out.count('## Repeated Line') == 0


def test_table_header_row_is_not_promoted():
    md = (PAD + '\n\n## Confirmed Heading\n\n'
          '| Subject area | Number of OAJ |\n| --- | --- |\n| Arts | 21 |')
    out, _r, promoted, _lvl = recover_geometric_headings(md, info(
        (1, 'Confirmed Heading', BOLD), (6, 'Subject area Number of OAJ', BOLD)))
    assert promoted == []
    assert '|' in out


def test_restores_a_dropped_section_number():
    md = (PAD + '\n\n## (Digital) Work and Labour: A Cultural‐Materialist Perspective\n\nprose\n\n'
          '### Defining Cultural Labour\n\nmore prose')
    out, renum, _p, _lvl = recover_geometric_headings(md, info(
        (1, '1.(Digital) Work and Labour: A Cultural-Materialist Perspective', BOLD),
        (1, '1.1.Defining Cultural Labour', BOLD)))
    assert '## 1. (Digital) Work and Labour: A Cultural‐Materialist Perspective' in out
    assert '### 1.1. Defining Cultural Labour' in out
    assert len(renum) == 2


def test_existing_number_is_not_doubled():
    md = PAD + '\n\n## 2. The Corporate Publishing Industry\n\nprose'
    out, renum, _p, _lvl = recover_geometric_headings(md, info(
        (3, '2.The Corporate Publishing Industry', BOLD)))
    assert '## 2. The Corporate Publishing Industry' in out
    assert renum == []


def test_promotion_restores_the_number_too():
    # ffbb3ac7: the OCR dropped BOTH the heading mark and the number, and the PDF heading wrapped
    # across two lines (merged upstream by detect_heading_lines).
    md = (PAD + '\n\n## 2. The Corporate Publishing Industry\n\nprose\n\n'
          'The Policy and Industry Perspective: Gold Open Access as New Business Model\n\n'
          'The analysed policy documents tend to define Gold OA as immediate publishing.')
    out, _r, promoted, _lvl = recover_geometric_headings(md, info(
        (3, '2.The Corporate Publishing Industry', BOLD),
        (5, '3.The Policy and Industry Perspective: Gold Open Access as New Business Model', BOLD)))
    assert ('## 3. The Policy and Industry Perspective: Gold Open Access as New Business Model'
            in out)
    assert len(promoted) == 1


def test_cover_sheet_chrome_is_never_promoted():
    # A repository cover sheet sets its labels in the same bold style, and its "Citation" label is
    # usually marked as a heading by the OCR — which confirms the style (24d86fb9).
    md = ('# Citation\n\nS. Englert (2020), Digital workerism, tripleC 18(1).\n\n'
          'Note: To cite this publication please use the final published version (if applicable)\n\n'
          + PAD)
    out, _r, promoted, _lvl = recover_geometric_headings(md, info(
        (0, 'Citation', BOLD),
        (0, 'Note: To cite this publication please use the final published version '
            '(if applicable)', BOLD)))
    assert promoted == []
    assert out == md


def test_no_pdf_evidence_is_a_no_op():
    md = PAD
    assert recover_geometric_headings(md, {'body_style': BODY, 'lines': []}) == (md, [], [], [])


# ---------------------------------------------------------------------------
# Two-column pages: pypdf reconstructs a "line" per y, so a right-column heading arrives glued to
# left-column BODY text ("2.2.Discussion and Debatehow the media operates. After a first phase of"),
# a column break hyphenates the title itself ("1.4.Classifying Types of Internet Activ-"), and a
# wrap fuses two words ("the Economyto Political Order"). Matching is therefore scored on the
# common PREFIX of the space-stripped texts (46c0fbb5, cc796552).
# ---------------------------------------------------------------------------
def test_number_restored_when_the_pdf_line_carries_other_column_text():
    md = PAD + '\n\n### Discussion and Debate\n\nbody prose here.'
    out, renum, _p, _lvl = recover_geometric_headings(md, info(
        (10, '2.2.Discussion and Debatehow the media operates. After a first phase of', BOLD)))
    assert '### 2.2. Discussion and Debate' in out
    assert renum == ['2.2. Discussion and Debate']


def test_number_restored_across_a_hyphenated_column_break():
    md = PAD + '\n\n### Classifying Types of Internet Activism\n\nbody prose here.'
    out, renum, _p, _lvl = recover_geometric_headings(md, info(
        (7, '1.4.Classifying Types of Internet Activ-they distinguish persuasive actions', BOLD)))
    assert '### 1.4. Classifying Types of Internet Activism' in out


def test_number_restored_when_a_wrap_fused_two_words():
    md = (PAD + '\n\n## The Subordination of the Economy to Political Order: Daniel Bell and the '
          'Post-Industrial Society\n\nbody prose here.')
    out, renum, _p, _lvl = recover_geometric_headings(md, info(
        (2, '2.The Subordination of the Economyto Political Order: Daniel Bell and the Post', BOLD)))
    assert out.startswith(PAD.split('\n\n')[0])
    assert '## 2. The Subordination of the Economy to Political Order' in out


def test_a_weak_prefix_does_not_match():
    md = PAD + '\n\n## Information\n\nbody\n\n## Interpretation and Method\n\nbody'
    out, renum, _p, _lvl = recover_geometric_headings(md, info(
        (3, '5.Interstellar Travel and Other Matters entirely unrelated to this book', BOLD)))
    assert renum == []


# ---------------------------------------------------------------------------
# LEVEL normalisation: headings that are typographically IDENTICAL are the same level. Mistral
# assigns levels by guesswork — 5fc4aad4 sets every section in ONE style and got #, ## and ###
# scattered at random, so a mid-article section rendered as big as the document title.
# ---------------------------------------------------------------------------
def _levels_doc(levels):
    parts = [PAD, '# The Document Title']
    for n, lvl in enumerate(levels):
        parts.append('#' * lvl + f' Section Number {n}')
        parts.append(f'Body prose for section number {n}.')
    return '\n\n'.join(parts)


def _levels_info(levels, style=BOLD, x=18):
    lines = [{'page': 0, 'text': 'The Document Title', 'style': ['TrebuchetMS-Bold', 0.3], 'x': x}]
    for n, _lvl in enumerate(levels):
        lines.append({'page': n + 1, 'text': f'Section Number {n}', 'style': style, 'x': x})
    return {'body_style': BODY, 'lines': lines}


def test_outlier_levels_are_pulled_to_the_style_plurality():
    levels = [2, 2, 2, 2, 2, 2, 2, 1, 1, 3]
    out, _r, _p, relevelled = recover_geometric_headings(_levels_doc(levels), _levels_info(levels))
    assert len(relevelled) == 3
    assert out.count('\n## Section Number') == 10
    assert '# The Document Title' in out            # the title is exempt


def test_a_class_that_genuinely_mixes_levels_is_left_alone():
    levels = [2, 2, 2, 3, 3, 3]                     # no plurality winner
    md = _levels_doc(levels)
    out, _r, _p, relevelled = recover_geometric_headings(md, _levels_info(levels))
    assert relevelled == []
    assert out == md


def test_a_small_class_is_left_alone():
    levels = [2, 2, 1]                              # below MIN_LEVEL_CLASS
    md = _levels_doc(levels)
    out, _r, _p, relevelled = recover_geometric_headings(md, _levels_info(levels))
    assert relevelled == []


def test_numbered_headings_are_exempt_from_level_normalisation():
    # A number carries its own level, and _level_numbered_headings applies it afterwards.
    parts = [PAD, '# The Document Title']
    for n in range(6):
        parts.append(f'## {n + 1}. Section Number {n}')
        parts.append(f'Body prose for section number {n}.')
    parts.append('# Unnumbered Outlier One')
    parts.append('body')
    md = '\n\n'.join(parts)
    lines = [{'page': 0, 'text': 'The Document Title', 'style': ['TrebuchetMS-Bold', 0.3], 'x': 18}]
    for n in range(6):
        lines.append({'page': n + 1, 'text': f'{n + 1}.Section Number {n}', 'style': BOLD, 'x': 18})
    lines.append({'page': 7, 'text': 'Unnumbered Outlier One', 'style': BOLD, 'x': 18})
    out, _r, _p, relevelled = recover_geometric_headings(md, {'body_style': BODY, 'lines': lines})
    assert relevelled == []                          # only ONE unnumbered member — no class
    assert '## 1. Section Number 0' in out


def test_headings_at_a_different_indent_are_a_different_class():
    # Same font, different left edge = a visible difference, so the two are not one class.
    levels = [2, 2, 2, 2, 2, 3]
    info_a = _levels_info(levels)
    info_a['lines'][-1]['x'] = 60                    # the h3 sits indented — its own class
    md = _levels_doc(levels)
    out, _r, _p, relevelled = recover_geometric_headings(md, info_a)
    assert relevelled == []

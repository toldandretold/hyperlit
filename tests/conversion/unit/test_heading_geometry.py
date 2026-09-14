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
            'lines': [{'page': p, 'text': t, 'style': s} for p, t, s in lines]}


def test_promotes_a_paragraph_set_in_a_confirmed_heading_style():
    md = (PAD + '\n\n## Critical Infrastructures\n\nSome prose about infrastructure.\n\n'
          'The Social Distancing of Old, Weak and Ill Individuals\n\n'
          'Old people and people suffering from chronic disease are at risk.')
    out, renum, promoted = recover_geometric_headings(md, info(
        (12, 'Critical Infrastructures', BOLD),
        (13, 'The Social Distancing of Old, Weak and Ill Individuals', BOLD)))
    assert promoted == ['The Social Distancing of Old, Weak and Ill Individuals']
    # level comes from the nearest confirmed heading of the same style
    assert '## The Social Distancing of Old, Weak and Ill Individuals' in out


def test_unconfirmed_style_promotes_nothing():
    # The style never appears as a marked heading in this document, so there is no evidence that
    # the document uses it for headings — a bold lead-in is exactly this shape.
    md = PAD + '\n\nA short bold statement standing alone\n\nOrdinary following paragraph.'
    out, renum, promoted = recover_geometric_headings(md, info(
        (4, 'A short bold statement standing alone', BOLD)))
    assert (out, renum, promoted) == (md, [], [])


def test_ambiguous_match_is_left_alone():
    md = (PAD + '\n\n## Confirmed Heading\n\nbody\n\nRepeated Line\n\nbody\n\nRepeated Line')
    out, _r, promoted = recover_geometric_headings(md, info(
        (1, 'Confirmed Heading', BOLD), (2, 'Repeated Line', BOLD)))
    assert promoted == []
    assert out.count('## Repeated Line') == 0


def test_table_header_row_is_not_promoted():
    md = (PAD + '\n\n## Confirmed Heading\n\n'
          '| Subject area | Number of OAJ |\n| --- | --- |\n| Arts | 21 |')
    out, _r, promoted = recover_geometric_headings(md, info(
        (1, 'Confirmed Heading', BOLD), (6, 'Subject area Number of OAJ', BOLD)))
    assert promoted == []
    assert '|' in out


def test_restores_a_dropped_section_number():
    md = (PAD + '\n\n## (Digital) Work and Labour: A Cultural‐Materialist Perspective\n\nprose\n\n'
          '### Defining Cultural Labour\n\nmore prose')
    out, renum, _p = recover_geometric_headings(md, info(
        (1, '1.(Digital) Work and Labour: A Cultural-Materialist Perspective', BOLD),
        (1, '1.1.Defining Cultural Labour', BOLD)))
    assert '## 1. (Digital) Work and Labour: A Cultural‐Materialist Perspective' in out
    assert '### 1.1. Defining Cultural Labour' in out
    assert len(renum) == 2


def test_existing_number_is_not_doubled():
    md = PAD + '\n\n## 2. The Corporate Publishing Industry\n\nprose'
    out, renum, _p = recover_geometric_headings(md, info(
        (3, '2.The Corporate Publishing Industry', BOLD)))
    assert '## 2. The Corporate Publishing Industry' in out
    assert renum == []


def test_promotion_restores_the_number_too():
    # ffbb3ac7: the OCR dropped BOTH the heading mark and the number, and the PDF heading wrapped
    # across two lines (merged upstream by detect_heading_lines).
    md = (PAD + '\n\n## 2. The Corporate Publishing Industry\n\nprose\n\n'
          'The Policy and Industry Perspective: Gold Open Access as New Business Model\n\n'
          'The analysed policy documents tend to define Gold OA as immediate publishing.')
    out, _r, promoted = recover_geometric_headings(md, info(
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
    out, _r, promoted = recover_geometric_headings(md, info(
        (0, 'Citation', BOLD),
        (0, 'Note: To cite this publication please use the final published version '
            '(if applicable)', BOLD)))
    assert promoted == []
    assert out == md


def test_no_pdf_evidence_is_a_no_op():
    md = PAD
    assert recover_geometric_headings(md, {'body_style': BODY, 'lines': []}) == (md, [], [])

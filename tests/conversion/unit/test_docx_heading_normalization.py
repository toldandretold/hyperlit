"""Unit tests for ingestion/word/normalize_docx_headings.py.

THE BUG (nicholls-nieo-docx, phase2-pathways, 2026-09-18): pandoc reads a DOCX paragraph's
heading level off the style NAME only — `heading 1`..`heading 9` — while OOXML actually defines
the level with `<w:outlineLvl>`. A journal template whose own style is called "Heading" and
carries `<w:outlineLvl w:val="0"/>` therefore converted with ZERO <h1>-<h6>, which took the
bibliography's heading-anchored extraction, footnote-strategy section detection and the book's
title/chapters down with it.

These pin the PLANNER (which styles get renamed, and — just as important — which do not), since
that is where every judgement call lives; the rewrite itself is a substitution.
"""

import zipfile

from ingestion.word.normalize_docx_headings import (
    normalize_headings, plan_heading_renames, rewrite_styles_xml,
)


def _styles(*blocks):
    return ('<?xml version="1.0" encoding="UTF-8"?><w:styles '
            'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            + ''.join(blocks) + '</w:styles>')


def _style(style_id, name=None, outline=None, based_on=None, stype='paragraph'):
    body = ''
    if name is not None:
        body += f'<w:name w:val="{name}"/>'
    if based_on is not None:
        body += f'<w:basedOn w:val="{based_on}"/>'
    if outline is not None:
        body += f'<w:pPr><w:outlineLvl w:val="{outline}"/></w:pPr>'
    return f'<w:style w:type="{stype}" w:styleId="{style_id}">{body}</w:style>'


def test_outline_level_zero_style_is_renamed_to_heading_1():
    xml = _styles(
        _style('Normal', name='Normal'),
        _style('Heading', name='Heading', outline=0),
    )
    assert plan_heading_renames(xml) == [('Heading', 'Heading', 'heading 1')]


def test_body_text_outline_level_nine_is_left_alone():
    # 9 is Word's "body text" sentinel — the value every non-heading style in the nicholls
    # template carried. Treating it as a level would turn the abstract into a heading.
    xml = _styles(
        _style('Abstract', name='Abstract', outline=9),
        _style('Paragraph', name='Paragraph', outline=9),
        _style('Articletitle', name='Article title', outline=9),
    )
    assert plan_heading_renames(xml) == []


def test_style_without_an_outline_level_is_left_alone():
    xml = _styles(_style('Quote', name='Displayed quotation'))
    assert plan_heading_renames(xml) == []


def test_builtin_heading_style_is_not_renamed():
    # An ordinary Word document already speaks pandoc's language — touching it would be churn.
    xml = _styles(_style('Heading1', name='heading 1', outline=0),
                  _style('Heading2', name='Heading 2', outline=1))
    assert plan_heading_renames(xml) == []


def test_a_level_already_claimed_is_skipped_rather_than_duplicated():
    # Two styles answering to "heading 1" is an ambiguity pandoc cannot resolve and neither can
    # we — leaving the custom one as a <p> is the honest outcome.
    xml = _styles(_style('Heading1', name='heading 1', outline=0),
                  _style('MyHeading', name='Section Head', outline=0))
    assert plan_heading_renames(xml) == []


def test_outline_level_is_inherited_through_based_on():
    # A style that declares no level of its own still IS a heading when the style it is based
    # on declares one — Word resolves pPr through the basedOn chain, so we must too.
    xml = _styles(_style('Chapter', name='Chapter Title', based_on='BigHead'),
                  _style('BigHead', name='Big Head', outline=1))
    assert plan_heading_renames(xml) == [('Chapter', 'Chapter Title', 'heading 2')]


def test_only_the_first_style_at_a_level_is_renamed():
    # KNOWN LIMIT, pinned deliberately: two custom styles at the SAME outline level cannot both
    # take the one builtin name, so the second stays a <p>. First-in-document wins; the
    # alternative (duplicate style names in the file we write back) is worse.
    xml = _styles(_style('HeadA', name='Head A', outline=0),
                  _style('HeadB', name='Head B', outline=0))
    assert plan_heading_renames(xml) == [('HeadA', 'Head A', 'heading 1')]


def test_circular_based_on_chain_does_not_hang():
    xml = _styles(_style('A', name='A', based_on='B'), _style('B', name='B', based_on='A'))
    assert plan_heading_renames(xml) == []


def test_character_styles_are_ignored():
    xml = _styles(_style('CharHead', name='Char Head', outline=0, stype='character'))
    assert plan_heading_renames(xml) == []


def test_rewrite_changes_the_name_but_never_the_style_id():
    # Every <w:pStyle w:val="Heading"/> in document.xml points at the styleId — renaming it
    # would orphan every heading paragraph in the document.
    xml = _styles(_style('Heading', name='Heading', outline=0))
    out = rewrite_styles_xml(xml, plan_heading_renames(xml))
    assert '<w:name w:val="heading 1"/>' in out
    assert 'w:styleId="Heading"' in out
    assert '<w:name w:val="Heading"/>' not in out


def test_normalize_is_a_noop_on_a_docx_with_no_styles_part(tmp_path):
    path = tmp_path / 'bare.docx'
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('word/document.xml', '<w:document/>')
    assert normalize_headings(str(path)) == []
    with zipfile.ZipFile(path) as z:
        assert z.namelist() == ['word/document.xml']


def test_normalize_rewrites_in_place_and_keeps_every_other_part(tmp_path):
    path = tmp_path / 'doc.docx'
    styles = _styles(_style('Heading', name='Heading', outline=0))
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', '<w:document><w:pStyle w:val="Heading"/></w:document>')
        z.writestr('word/styles.xml', styles)

    assert normalize_headings(str(path)) == [('Heading', 'Heading', 'heading 1')]

    with zipfile.ZipFile(path) as z:
        assert set(z.namelist()) == {'[Content_Types].xml', 'word/document.xml', 'word/styles.xml'}
        assert '<w:name w:val="heading 1"/>' in z.read('word/styles.xml').decode()
        # the document's reference to the style is untouched
        assert 'w:pStyle w:val="Heading"' in z.read('word/document.xml').decode()

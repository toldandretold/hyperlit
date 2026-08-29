"""Sentence-interrupting boxed sections (case 63817b36, BMJ 'Summary points'): print layout
drops a side box into the MIDDLE of a body sentence, and Mistral flattens it in place —
'…they seek and' → '## Summary points' → box paragraphs → 'compete for the best…'.
_relocate_sentence_interrupting_boxes rejoins the split sentence and moves the box after it.
The negative space matters: a heading after a COMPLETED sentence is a normal section start and
must never move.
"""

from ingestion.pdf.assembly import _relocate_sentence_interrupting_boxes


BOX = ('## Summary points\n\n'
       'Much foreign-led research remains semicolonial in nature\n\n'
       'Annexed site research should be phased out and replaced by a partnership model')


def test_box_relocated_and_sentence_rejoined():
    md = ('These sites operate by inflated salary scales, and they seek and\n\n'
          + BOX + '\n\n'
          'compete for the best and brightest local talent. Salaries are far greater there.\n\n'
          'Next ordinary paragraph.')
    out = _relocate_sentence_interrupting_boxes(md)
    assert 'they seek and compete for the best and brightest local talent.' in out
    # box follows the rejoined paragraph, before the next ordinary paragraph
    assert out.index('local talent') < out.index('**Summary points**') < out.index('Next ordinary paragraph')


def test_heading_after_completed_sentence_untouched():
    md = ('The previous section ends with a full sentence.\n\n'
          + BOX + '\n\n'
          'compete is a word that happens to open this paragraph in lowercase.')
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_no_lowercase_continuation_untouched():
    md = ('These sites operate by inflated salary scales, and they seek and\n\n'
          + BOX + '\n\n'
          'The next paragraph opens uppercase — no continuation to rejoin.')
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_second_heading_bounds_the_box():
    # A run of REAL sections (heading, content, heading, …) after a truncated paragraph must
    # not be treated as a relocatable box.
    md = ('An OCR-truncated paragraph ending mid-thought and\n\n'
          '## First real section\n\nContent of the first section.\n\n'
          '## Second real section\n\ncontinues in lowercase for its own reasons.')
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_vocabulary_titled_box_renders_as_inset_blockquote():
    # The relocated "Summary points" box renders as heading + ONE inset blockquote —
    # the closest reader primitive to the bordered box in print.
    md = ('These sites operate by inflated salary scales, and they seek and\n\n'
          + BOX + '\n\n'
          'compete for the best and brightest local talent. Salaries are far greater there.')
    out = _relocate_sentence_interrupting_boxes(md)
    # the title lives INSIDE the inset as bold text (as print renders it) — the whole unit
    # is one secondary block, and no heading reaches the TOC/chapter machinery
    assert '> **Summary points**\n>\n> Much foreign-led research remains semicolonial in nature' in out
    assert '>\n> Annexed site research should be phased out' in out
    assert '# Summary points' not in out


def test_ordinary_titled_relocated_section_keeps_plain_paragraphs():
    section = ('## Methodological considerations\n\n'
               'Much foreign-led research remains semicolonial in nature\n\n'
               'Annexed site research should be phased out and replaced by a partnership model')
    md = ('These sites operate by inflated salary scales, and they seek and\n\n'
          + section + '\n\n'
          'compete for the best and brightest local talent. Salaries are far greater there.')
    out = _relocate_sentence_interrupting_boxes(md)
    assert '> ' not in out                                  # no box vocabulary → no inset
    assert 'they seek and compete for the best' in out      # relocation itself still fires

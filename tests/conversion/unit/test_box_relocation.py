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


# ---------------------------------------------------------------------------
# The negative space that matters MOST: a paragraph that merely LOOKS unfinished because it is a
# label, a caption or an attribution. 19 of the fixture corpus's 28 firings were this shape, and
# each one glued front matter to a page-break continuation belonging to a paragraph further down
# AND moved the real section out of document order.
# ---------------------------------------------------------------------------

INTRO = ('# 1. Introduction\n\n'
         'Digital activism, a term widely used to describe different forms of activism that '
         'utilise digital technology, has undergone a rapid transformation. This wave '
         'encompassed a number of projects and initiatives waged by tech and alternative')


def _tripleC(front_matter):
    return (front_matter + '\n\n' + INTRO + '\n\n'
            'media activists of the anti-globalisation movement, including Indymedia.')


def test_keyword_list_is_not_half_a_sentence():
    md = _tripleC('Keywords: Digital activism, ideology, social media, populism, autonomism, '
                  'Internet, counterculture, popular culture, techno-politics, techno-determinism')
    out = _relocate_sentence_interrupting_boxes(md)
    assert out == md
    assert 'techno-determinism media activists' not in out


def test_table_caption_is_not_half_a_sentence():
    md = _tripleC('Table 2.4: Discourse elements of the scientific article')
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_epigraph_attribution_is_not_half_a_sentence():
    md = _tripleC('The only way to abolish the evils of democracy is by more democracy.'
                  '—JOHN DEWEY, The Public and Its Problems')
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_byline_is_not_half_a_sentence():
    md = _tripleC('Jane Doe, Doctoral researcher Birkbeck, University of London')
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_semicolon_ends_a_list_item_not_a_sentence():
    md = ('and the attempts to impose hegemony on the economics of the developing countries;\n\n'
          '## Decides:\n\n'
          '1. To express concern over the non-implementation of all the provisions agreed.\n\n'
          '2. To urge the Non-Aligned countries producing raw materials and commo\n\n'
          "organizations for producers, i.e. producers' associations, to safeguard their earnings.")
    assert _relocate_sentence_interrupting_boxes(md) == md


def test_function_word_tail_still_relocates():
    # The genuine shape: the tail cannot end a sentence ("…they seek and"), so the heading really
    # did land inside the sentence.
    md = ('These sites operate by using inflated local salary scales, and they seek and\n\n'
          + BOX + '\n\n'
          'compete for the best and brightest local talent.')
    assert 'they seek and compete for the best' in _relocate_sentence_interrupting_boxes(md)


def test_hyphenated_compound_tail_still_relocates():
    md = ('Numbers fell by 91 per cent between 1967 and 2007 (Holt et al., 2012). Many '
          'long-distance\n\n'
          '# Corresponding author:\n\n'
          'William M. Adams, Department of Geography, University of Cambridge.\n\n'
          'migratory species are in decline, making them an urgent conservation priority.')
    out = _relocate_sentence_interrupting_boxes(md)
    assert 'Many long-distance migratory species are in decline' in out


def test_page_chrome_interruption_relocates_without_a_function_word_tail():
    # Chrome is the one interruption allowed without the incomplete-tail evidence: a running
    # header/footer wedged into a sentence in a scanned typescript (nam1976).
    md = ('its members exercise unceasing vigilance in order to exercise unceasing vigilance\n\n'
          '# - 14 -\n\n'
          'NAC/CONF.5/S2.\nPage 6\n\n'
          'to preserve intact the essential character of Non-Alignment and maintain fidelity.')
    out = _relocate_sentence_interrupting_boxes(md)
    assert 'unceasing vigilance to preserve intact' in out


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

"""When the OCR mangles a page's footnote apparatus, the PDF text layer arbitrates.

Three failures from one book, each of which leaves a conversion that LOOKS clean: a two-column
note block read out of order and mis-labelled, a note block printed beside the body and so
emitted mid-page, and two pages whose markers AND notes vanished entirely.

Case anand2025communist-literary-internationalilsm (maintainer report, 2026-09-22). The article
prints its page-bottom notes in TWO columns — 3,4,5,6 on the left, 7,8,9 on the right — and Mistral
read the column pair out of order AND relabelled the first two bodies it emitted:

    "3 See among others, Manali Desai…"      ← actually note 5
    "4 In this contextualization…"           ← actually note 6
    "7 J Devika…"  "8 J Devika…"  "9 J. Devika…"
    "3 See for instance, Ali Raza…"          ← the real note 3
    "4 See for instance, Govindan Parayil…"  ← the real note 4

So the page offered the number 3 twice carrying two different works, and 4 likewise.
renumber_page_footnotes mapped local→global on those numbers, the collided pairs took ONE global
number each, and the reader showed the Desai note under the marker for Raza. Nothing downstream
can see it: no number is missing, so there is no hole for any later pass to notice.

Pinned here: the repair (numbers re-derived from the text layer, definitions re-ordered so page
order is numeric order), the refusals that keep it from guessing, and the local→global mapping
that has to be numeric for any of it to survive.
"""

import ingestion.pdf.pdf_shared as S


# The page's real notes, as the PDF's own text layer carries them.
PYPDF_PAGE = [
    # Leading junk: the text layer's reading order glues a BODY line that opens with the
    # marker digit. It must never win a match, and must not block the repair either.
    (7, 'Against this backdrop, Devika brought attention to the notion of regionality'),
    (3, 'See for instance, Ali Raza, Franziska Roy, and Benjamin Zachariah, The Inter- '
        'nationalist Moment: South Asia, Worlds, and World Views 1917 e39'),
    (4, 'See for instance, Govindan Parayil, ‘The “Kerala Model ” of Development: '
        'Development and Sustainability in the Third World'),
    (5, 'See among others, Manali Desai, ‘The Relative Autonomy of Party Practices: A '
        'Counterfactual Analysis of Left Party Ascendancy in Kerala'),
    (6, 'In this contextualization, I draw from scholars like Ali Raza and others who have '
        'deployed internationalism as distinct from most writings'),
    (7, 'J Devika, ‘Cochin Creole and the Perils of Casteist Cosmopolitanism: Reading '
        'Requiem for the Living'),
    (8, 'J Devika, ‘Migration, Transnationalism, and Modernity: Thinking of Kerala’s '
        'Many Cosmopolitanisms'),
]

# What Mistral emitted, in its order, with its numbering.
OCR_BLOCK = [
    (10, 3, '3', "See among others, Manali Desai, 'The Relative Autonomy of Party Practices: A "
                 "Counterfactual Analysis of Left Party Ascendancy in Kerala"),
    (12, 4, '4', "In this contextualization, I draw from scholars like Ali Raza and others who "
                 "have deployed internationalism as distinct from most writings"),
    (14, 7, '7', "J Devika, 'Cochin Creole and the Perils of Casteist Cosmopolitanism: Reading "
                 "Requiem for the Living"),
    (16, 8, '8', "J Devika, 'Migration, Transnationalism, and Modernity: Thinking of Kerala's "
                 "Many Cosmopolitanisms"),
    (18, 3, '3', "See for instance, Ali Raza, Franziska Roy, and Benjamin Zachariah, The "
                 "Internationalist Moment: South Asia, Worlds, and World Views 1917-39"),
    (20, 4, '4', "See for instance, Govindan Parayil, 'The \"Kerala Model\" of Development: "
                 "Development and Sustainability in the Third World"),
]


def _numbers(block):
    return [n for _i, n, _s, _b in block]


def _bodies(block):
    return [b[:24] for _i, _n, _s, b in block]


def test_repairs_numbers_from_the_text_layer():
    out, repaired = S.repair_page_def_numbers(OCR_BLOCK, PYPDF_PAGE)
    assert repaired
    assert _numbers(out) == [3, 4, 5, 6, 7, 8]


def test_reorders_so_page_order_is_numeric_order():
    """The scrambled block leaves a DESCENDING step in the markdown, which
    simple_md_to_html reads as the start of a new footnote SECTION — that is how one
    mis-numbered column became three phantom definition sections."""
    out, _ = S.repair_page_def_numbers(OCR_BLOCK, PYPDF_PAGE)
    # Keyed on the author, not the shared "See for instance," opener — 3 and 4 both start
    # that way, and the whole bug was two notes that LOOK interchangeable at a glance.
    named = [(n, next(w for w in ('contextualization', 'Raza', 'Parayil', 'Desai',
                                  'Cochin', 'Migration') if w in body))
             for _i, n, _s, body in out]
    assert named == [(3, 'Raza'), (4, 'Parayil'), (5, 'Desai'),
                     (6, 'contextualization'), (7, 'Cochin'), (8, 'Migration')]
    # written back into the SAME line slots, so nothing else on the page moves
    assert [i for i, _n, _s, _b in out] == [i for i, _n, _s, _b in OCR_BLOCK]
    # and the numbering the repair produces carries into the rendered marker
    assert [s for _i, _n, s, _b in out] == ['3', '4', '5', '6', '7', '8']


def test_leaves_a_well_formed_block_alone():
    """The trigger is the OCR contradicting ITSELF. A block that ascends with no repeats
    is never second-guessed, however the text layer reads."""
    clean = [(10, 3, '3', OCR_BLOCK[4][3]), (12, 4, '4', OCR_BLOCK[5][3]),
             (14, 5, '5', OCR_BLOCK[0][3])]
    out, repaired = S.repair_page_def_numbers(clean, PYPDF_PAGE)
    assert not repaired and out == clean


def test_refuses_when_two_notes_are_indistinguishable():
    """Notes 11 and 12 of this very article are byte-identical ("Pasco, 'Literature as
    Historical Archive', p. 388."). There is no evidence that says which is which, and a
    wrong footnote link is worse than a missing one — so the whole page is left alone."""
    ibid = "Pasco, 'Literature as Historical Archive', p. 388."
    pypdf = [(11, ibid), (12, ibid), (13, 'Adom Getachew, Worldmaking after Empire')]
    block = [(10, 12, '12', ibid), (12, 11, '11', ibid)]
    out, repaired = S.repair_page_def_numbers(block, pypdf)
    assert not repaired and out == block


def test_refuses_when_a_definition_matches_nothing():
    """All-or-nothing: a page that half-repairs is a fresh way to collide."""
    block = list(OCR_BLOCK[:2]) + [(14, 3, '3', 'A note the text layer never saw at all, '
                                                'because the extractor glued it elsewhere')]
    out, repaired = S.repair_page_def_numbers(block, PYPDF_PAGE)
    assert not repaired and out == block


def test_no_text_layer_means_no_repair():
    out, repaired = S.repair_page_def_numbers(OCR_BLOCK, [])
    assert not repaired and out == OCR_BLOCK


# --- the same article's FIRST page: notes printed BESIDE the body, not under it ----------

MIDPAGE = ('Damodaran, prompting him to write a letter to the editor.\n'
           '\n'
           'E-mail address: anand.sreekumar@adelaide.edu.au.\n'
           '\n'
           "1 Shahul Hameed Mattumannil, 'The Left Approach to Social Diversity: How the "
           "Communist Party Interacted with Kerala's Social Landscape?', Cogent Social Sciences.\n"
           '2 Tariq Ali, "Memoir of an Indian Communist." Interview by K. Damodaran, '
           'New Left Review 93 (1975) 35-59.\n'
           '\n'
           'Tsarist absolutism. To put it differently, the nationalist fervour of the article '
           'was horrifying to me.[^2]\n')

MIDPAGE_PYPDF = [
    (1, "Shahul Hameed Mattumannil, ‘The Left Approach to Social Diversity: How the "
        "Communist Party Interacted with Kerala's Social Landscape?"),
    (2, 'Tariq Ali, ‘“Memoir of an Indian Communist. ” Interview by K. Damodaran ’, '
        'New Left Review 93 (1975) 35 e59.'),
]


def test_midpage_note_block_is_lifted_to_the_page_foot():
    """Both notes were stranded in the body as bare numbered prose, and the apparatus was
    renumbered around the hole — which shifted EVERY later note one place against the print."""
    out, counter = S.renumber_page_footnotes(MIDPAGE, 1, {}, pypdf_defs=MIDPAGE_PYPDF)
    assert '[^1]: Shahul Hameed Mattumannil' in out
    assert '[^2]: Tariq Ali' in out
    assert counter == 3
    # lifted, not copied — the body must not keep the prose version
    assert '\n1 Shahul Hameed Mattumannil' not in out
    # and the definitions now sit AFTER the body that followed them on the page
    assert out.index('Tsarist absolutism') < out.index('[^1]: Shahul')


def test_midpage_rescue_needs_the_text_layer_to_agree():
    """Two lines that open with a number is also every numbered list in the corpus. With no
    corroborating definitions the block stays where it is rather than being invented."""
    out, _ = S.renumber_page_footnotes(MIDPAGE, 1, {}, pypdf_defs=[])
    assert '[^1]: Shahul Hameed Mattumannil' not in out


def test_midpage_rescue_does_not_touch_a_page_with_a_bottom_block():
    """The ordinary page already has its notes in the right place; this pass is for the page
    where the bottom-up scan finds nothing at all."""
    page = ('Body with a marker[^1] and another[^2].\n'
            '\n'
            '1 Shahul Hameed Mattumannil, on social diversity in Kerala.\n'
            '2 Tariq Ali, Memoir of an Indian Communist.\n')
    lines = page.split('\n')
    assert S.find_midpage_def_block(lines, lambda s: _cand(s), MIDPAGE_PYPDF) == []


def _cand(stripped):
    import re
    m = re.match(r'^(\d{1,3})\.?\s+(\S.+)', stripped)
    return (int(m.group(1)), m.group(1), m.group(2)) if m else None


# --- markers the OCR dropped on a page that lost its whole apparatus ----------------------
#
# PDF pages 7 and 9 of this article came back from OCR with NO markers and NO note block. That
# is worse than losing 19 definitions, because a page_bottom page's definitions are recovered
# through the local→global map built from its own markers (assembly.py) — no markers, no way to
# receive them. Only the GLUED seam was recognised, and the layer glues a superscript only when
# the printed line happened not to break beside it.

import ingestion.pdf.recovery as REC


def _resurrect(ocr, layer, nums, def_texts=None):
    return REC.resurrect_dropped_markers_from_pypdf(ocr, layer, nums, '', def_texts)


def test_glued_seam_still_works():
    """The original rule (deloitte p9) — unchanged behaviour."""
    out, n = _resurrect('We must mitigate risk. This ensures that.',
                        'We must mitigate risk.9 This ensures that.', {9})
    assert n == 1 and 'risk.[^9] This' in out


def test_line_broken_seam():
    """The layer put the newline beside the digit: a superscript at a line end or line start.
    Prose does not break a line to isolate a number."""
    for layer in ('the family he adopts. 63\nThis socialist vision',
                  'the family he adopts.\n63 This socialist vision',
                  'the family he adopts.\n63\nThis socialist vision'):
        out, n = _resurrect('the family he adopts. This socialist vision', layer, {63})
        assert n == 1, layer
        assert 'adopts.[^63] This' in out


def test_sentence_boundary_seam():
    """Spaced on both sides, so it carries the strictest test: the punctuation must END a
    sentence and the next word must be Capitalised."""
    out, n = _resurrect('books printed in the Soviet Union. While dialectical materialism',
                        'books printed in the Soviet Union. 88 While dialectical materialism',
                        {88})
    assert n == 1 and 'Union.[^88] While' in out


def test_a_spaced_digit_inside_a_clause_is_still_prose():
    """The shape the original rule excluded, and it stays excluded: nothing ends, and the
    following word is lowercase. "rose by 9 percent" is not a footnote."""
    out, n = _resurrect('revenue rose by 9 percent over the year',
                        'revenue rose by 9 percent over the year', {9})
    assert n == 0 and out == 'revenue rose by 9 percent over the year'


def test_closing_quote_between_the_word_and_the_digit():
    """"…blowing across the world.'70 Thus" — two punctuation characters, and the OCR renders
    the quote differently from the layer, so the match anchors on the two WORDS."""
    out, n = _resurrect("winds blowing across the world.' Thus for the likes of",
                        "winds blowing across the world.’70 Thus for the likes of", {70})
    assert n == 1 and '[^70]' in out
    assert out.index('[^70]') > out.index('world')


def test_the_notes_own_printed_number_is_not_a_marker():
    """"…of Kerala.\\n63 P Kesavadev, Odayil Ninnu" is the note BLOCK. Without the definition
    bodies to compare against, the line-broken shape plants a marker inside the note area."""
    layer = 'a history of Kerala.\n63 P Kesavadev, Odayil Ninnu (Calicut: Poorna, 2000).'
    ocr = 'a history of Kerala. P Kesavadev, Odayil Ninnu (Calicut: Poorna, 2000).'
    out, n = _resurrect(ocr, layer, {63},
                        {63: ['P Kesavadev, Odayil Ninnu (Calicut: Poorna publications, 2000).']})
    assert n == 0 and out == ocr


def test_an_ambiguous_seam_is_never_guessed():
    """The seam must occur EXACTLY once in the OCR page — a wrong link is worse than none."""
    ocr = 'he adopts. This vision. Later he adopts. This vision again.'
    out, n = _resurrect(ocr, 'he adopts. 63\nThis vision', {63})
    assert n == 0 and out == ocr


def test_page_local_numbers_map_to_globals_in_PRINT_order():
    """A note defined at the foot of a page whose marker sat on the PREVIOUS page appears
    only in the definition block — after every body marker. Mapping local→global by first
    appearance therefore handed note 3 a number above notes 4-9 and interleaved the
    definition list; the mapping follows the printed numbering instead."""
    page = ('Body text with markers[^4] and more[^5] and another[^6].\n'
            '\n'
            '[^3]: The note whose marker printed on the previous page.\n'
            '[^4]: Four.\n'
            '[^5]: Five.\n'
            '[^6]: Six.\n')
    mapping = {}
    out, counter = S.renumber_page_footnotes(page, 100, mapping)
    assert mapping == {3: 100, 4: 101, 5: 102, 6: 103}
    assert counter == 104
    assert '[^100]: The note whose marker printed on the previous page.' in out


# --- a page whose note block the OCR could not READ at all --------------------------------
#
# deloitte2025independent prints its page-bottom notes in ~5pt part-italic type. Mistral could
# not read page 6's block and produced, instead of the four notes printed there, a truncated
# note 1 ("Failing Thaw" for "Failing Those", its URL continuation line gone), a wholly
# FABRICATED citation standing where the page prints "Ibid.", and the real notes 3 and 4
# labelled 4 and 5. Every number ascends, so repair_page_def_numbers above — whose trigger is
# the OCR contradicting ITSELF — never looks; and repair_def_text_from_pypdf pairs by NUMBER,
# so once the numbering is wrong every comparison is against the wrong note and refuses at its
# similarity floor. Zero repairs fired, and marker 2's claim was held against an invented work.

LAYER_P6 = [
    (1, 'Senate Education and Employment Ref erences Committee, Jobactiv e: Failing Those It '
        'Is Int ended to Serve(Report, February 2019) https://www.aph.gov.au/Parliamentary_'
        'Business/Committees/Senate/Education_and_Employment/JobActive2018/Report .'),
    (2, 'Ibid.'),
    (3, 'Social Security (Administ ration) Act 1999 (Cth) pt 3 div 3AA; Social Security '
        '(Administ ration) (Non-Compliance) Determination 2018 (No 1) (Cth).'),
    (4, 'Department of Employment and Workplace Relations (Cth), Statement of Work - '
        'Statement of Assurance on t he Operat ions of t he T argeted Compliance Framework'
        '(ESE24/1263, 28 November 2024) (co py on file with author).'),
]

OCR_P6 = [
    (10, 1, '1', 'Senate Education and Employment References Committee, *Jobactive: Failing '
                 'Thaw It Is Intended to Serve* (Report, February 2019)'),
    (11, 2, '2', 'EIER (2019) *How to Make a World: A Guide to the TCF* (Report, February 2019)'),
    (12, 3, '3', 'StoE'),
    (13, 4, '4', 'Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA; *Social '
                 'Security (Administration)/Non-Compliance Determination 2018* (No 1) (Cth)'),
    (14, 5, '5', 'Department of Employment and Workplace Relations (Cth), *Statement of Work '
                 '- Statement of Assurance on the Operations of the Targeted Compliance '
                 'Framework* (ESE24/1263, 28 November 2024) (copy on file with author).'),
]

P6_LINES = ['Body carrying [^1] and [^2] and [^3] and [^4].'] + [b[3] for b in OCR_P6]
P6_BLOCK = [(i + 1, n, s, b) for i, (_old, n, s, b) in enumerate(OCR_P6)]
P6_REFS = {1, 2, 3, 4}


def test_a_fabricated_definition_is_replaced_by_the_note_the_page_prints():
    """The hallucination and the printed "Ibid." are the only pair the alignment cannot
    anchor, so "Ibid." is assigned by ELIMINATION — which is the whole reason this aligns
    sequences instead of matching each definition on its own. Its 4-character fingerprint
    could never win a similarity contest."""
    block, lines, changed = S.reconcile_page_defs_with_pypdf(
        list(P6_BLOCK), list(P6_LINES), LAYER_P6, P6_REFS)
    assert changed
    assert _numbers(block) == [1, 2, 3, 4]
    assert block[1][3] == 'Ibid.'
    assert 'EIER' not in '\n'.join(lines)


def test_the_surplus_definition_is_dropped_and_the_rest_renumbered():
    """Five definitions for four printed notes: the junk one consumes a global number and
    shifts every later note against the print — which is how marker 4's claim came to be
    held against note 3."""
    block, lines, changed = S.reconcile_page_defs_with_pypdf(
        list(P6_BLOCK), list(P6_LINES), LAYER_P6, P6_REFS)
    assert changed
    assert 'StoE' not in '\n'.join(lines)
    assert [b[1] for b in block] == [1, 2, 3, 4]
    # note 3 of the print is numbered 3, not 4
    assert 'Social Security' in block[2][3]
    assert 'Statement of Work' in block[3][3]


def test_a_definition_the_ocr_lost_is_inserted_from_the_text_layer():
    ocr = [b for b in P6_BLOCK if b[1] != 2]
    ocr = [(i, n if n < 2 else n - 1, str(n if n < 2 else n - 1), b) for i, n, _s, b in ocr]
    lines = ['Body carrying [^1] and [^2] and [^3] and [^4].'] + [b[3] for b in ocr]
    block, lines, changed = S.reconcile_page_defs_with_pypdf(
        list(ocr), list(lines), LAYER_P6, P6_REFS)
    assert changed
    assert 'Ibid.' in [b[3] for b in block]


def test_a_block_the_text_layer_agrees_with_is_left_alone():
    """The gate that keeps this off every healthy page in the corpus."""
    clean = [(1, 1, '1', 'Senate Education and Employment References Committee, Jobactive: '
                         'Failing Those It Is Intended to Serve (Report, February 2019)'),
             (2, 2, '2', 'Ibid.'),
             (3, 3, '3', 'Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA; Social '
                         'Security (Administration) (Non-Compliance) Determination 2018 (No 1) (Cth).'),
             (4, 4, '4', 'Department of Employment and Workplace Relations (Cth), Statement of '
                         'Work - Statement of Assurance on the Operations of the Targeted '
                         'Compliance Framework (ESE24/1263, 28 November 2024) (copy on file with author).')]
    lines = ['Body [^1][^2][^3][^4].'] + [b[3] for b in clean]
    block, out_lines, changed = S.reconcile_page_defs_with_pypdf(
        list(clean), list(lines), LAYER_P6, P6_REFS)
    assert not changed and block == clean and out_lines == lines


def test_refuses_when_the_text_layer_block_is_not_contiguous():
    """deloitte's Contents page reads as definitions 6,7,9,10,11,12. A gap means the
    extractor missed something, and then "no counterpart" stops meaning "invented"."""
    layer = [(6, 'Background and Methodology 44'), (7, 'Legislative and Policy Traceability 51'),
             (9, 'Governance and Assurance 66')]
    block, lines, changed = S.reconcile_page_defs_with_pypdf(
        list(P6_BLOCK), list(P6_LINES), layer, P6_REFS)
    assert not changed and block == P6_BLOCK


def test_refuses_a_scrambled_layer_block():
    """The anand page: the text layer's own order is 7(junk),3,4,5,6,7,8. This pass trusts
    layer ORDER, so it must refuse that page and leave it to repair_page_def_numbers."""
    block, lines, changed = S.reconcile_page_defs_with_pypdf(
        list(OCR_BLOCK), list(P6_LINES), PYPDF_PAGE, {3, 4, 5, 6, 7, 8})
    assert not changed and block == OCR_BLOCK


def test_refuses_when_too_little_of_the_page_is_anchored():
    """Below the anchor floor we are not reading the same block, and every gap-fill would be
    positional guesswork bracketed by nothing."""
    foreign = [(i, n, s, 'Entirely unrelated note number %d about something else' % n)
               for i, n, s, _b in P6_BLOCK]
    block, lines, changed = S.reconcile_page_defs_with_pypdf(
        list(foreign), list(P6_LINES), LAYER_P6, P6_REFS)
    assert not changed and block == foreign


def test_a_reconciled_page_renumbers_the_whole_document_correctly():
    """End to end through renumber_page_footnotes: four markers and four definitions consume
    four global numbers, not five, so nothing downstream of this page is shifted."""
    # The glued converted-superscript form this book's note block actually arrives in:
    # Mistral renders the printed number as a superscript with no space after it.
    page = ('Body carrying [^1] and [^2] and [^3] and [^4].\n'
            '\n'
            + '\n'.join('[^{0}]{1}'.format(n, b) for _i, n, _s, b in P6_BLOCK) + '\n')
    mapping = {}
    confirmed = set()
    out, counter = S.renumber_page_footnotes(
        page, 100, mapping, pypdf_defs=LAYER_P6, confirmed_out=confirmed)
    assert counter == 104, 'a junk definition must not consume a global number'
    assert mapping == {1: 100, 2: 101, 3: 102, 4: 103}
    assert '[^101]: Ibid.' in out
    assert 'EIER' not in out and 'StoE' not in out
    # The pairings the alignment settled are published so the text repair can lower its
    # similarity floor for them. 101 is NOT among them: its body already came from the text
    # layer, so there is nothing left for the repair to establish.
    assert confirmed == {100, 102, 103}


def test_nothing_is_confirmed_by_a_refused_page():
    confirmed = set()
    page = ('Body carrying [^1] and [^2] and [^3] and [^4].\n'
            '\n'
            + '\n'.join('[^{0}]{1}'.format(n, b) for _i, n, _s, b in P6_BLOCK) + '\n')
    out, _counter = S.renumber_page_footnotes(
        page, 100, {}, pypdf_defs=[(6, 'Background and Methodology 44')],
        confirmed_out=confirmed)
    assert confirmed == set()


# --- emitting the text layer's own words --------------------------------------------------

def test_a_wrapped_url_is_rejoined():
    """pypdf positions text glyph by glyph, so a URL arrives in pieces. A reader works around
    "Workplace R elations"; a dead link is not workable, and the printed URL is the strongest
    signal citation resolution has."""
    out = S.sanitize_layer_def_text(
        'Dept (Web Page, 2025) https://www .dewr.gov.au/assuring-integrity-targeted-co '
        'mpliance-framework/anno uncements/secretarys-opening-statement.')
    assert 'https://www.dewr.gov.au/assuring-integrity-targeted-compliance-framework/' \
           'announcements/secretarys-opening-statement.' in out


def test_a_url_stops_at_the_prose_after_it():
    out = S.sanitize_layer_def_text(
        'A (2023) https://www.finance.gov.au/government/comcover/risk -services/management/risk '
        '- management-to olkit/element-1 ; In stitute o f In ternal Au ditors, The Model.')
    assert 'https://www.finance.gov.au/government/comcover/risk-services/management/' \
           'risk-management-toolkit/element-1' in out
    assert 'In stitute o f In ternal Au ditors' in out


def test_a_bare_number_after_a_url_is_the_next_notes_number():
    out = S.sanitize_layer_def_text(
        'Data source: https://en.wikipedia.org/wiki/2019_coronavirus_in_mainland_China 2 Data '
        'source: WHO.')
    assert 'mainland_China 2 Data' in out


def test_a_parenthetical_after_a_url_is_not_path():
    out = S.sanitize_layer_def_text(
        'See the video: http://www.youtube.com/watch?v=uyeRAhxcPjQ&feature=youtu.be '
        '(accessed on September 8, 2013).')
    assert 'youtu.be (accessed on September 8, 2013).' in out


def test_text_without_a_url_is_returned_untouched():
    """Only URL spans are rewritten — pypdf's other artifacts are left for a reader to see
    rather than guessed at."""
    text = 'An earlier version has been published as:  Fuchs, Christian (2003).  ISBN 0- 9740735-1-2.'
    assert S.sanitize_layer_def_text(text) == text

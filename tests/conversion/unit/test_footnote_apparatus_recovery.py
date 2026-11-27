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
import ingestion.pdf.recovery as R


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


# tripleC e403008c page 5 / 00120a28 page 9 (2026-11-23): two ways the trailing block or the
# layer block is only PART of the page's notes, where elimination reads the missing part as
# "the OCR lost it" / "the OCR invented it". Both shipped across a 900-article journal.
TRIPLEC_NOTES = [
    (10, 'J.D. Peters, op.cit. p. 13: The doctrine of ideas, developed initially by Descartes, '
         'was central to early modern philosophy, both rationalist and empiricist.'),
    (11, 'According to J.D. Peters, op.cit. p. 12, Bacon criticizes in the Great Instauration '
         'the logicians of his day for receiving as conclusive the immediate informations.'),
    (12, 'See Annex and the Diccionario de Autoridades entry reproduced there in full.'),
    (13, 'Claude E. Shannon and Warren Weaver: The mathematical theory of communication. '
         'Urbana, IL: University of Illinois Press 1972 (orig. 1949), p. 31.'),
]


def test_a_note_standing_above_the_trailing_block_is_not_inserted_again():
    """Body text between two notes leaves only the LAST run as `block`. The layer's notes 10
    and 11 are a few lines up the same page — inserting them minted two [^10]s."""
    lines = ['Body [^10] and [^11].', TRIPLEC_NOTES[0][1], TRIPLEC_NOTES[1][1],
             'A paragraph the OCR read between the notes [^12] [^13].',
             TRIPLEC_NOTES[2][1], TRIPLEC_NOTES[3][1]]
    block = [(4, 12, '12', TRIPLEC_NOTES[2][1]), (5, 13, '13', TRIPLEC_NOTES[3][1])]
    stray = [(10, TRIPLEC_NOTES[0][1]), (11, TRIPLEC_NOTES[1][1])]
    out_block, out_lines, changed = S.reconcile_page_defs_with_pypdf(
        list(block), list(lines), TRIPLEC_NOTES, {10, 11, 12, 13}, stray_defs=stray)
    assert not changed and out_lines == lines
    # positive control: with no stray definitions the same page DOES get its lost notes back
    _b, with_insert, changed = S.reconcile_page_defs_with_pypdf(
        list(block), list(lines), TRIPLEC_NOTES, {10, 11, 12, 13})
    assert changed and len(with_insert) > len(lines)


def test_a_referenced_note_past_the_end_of_the_layer_block_is_not_dropped():
    """The layer stopped after two of four notes. The other two are called by markers on this
    very page, so they are not inventions — a truncated layer cannot say otherwise."""
    lines = ['Body [^10] [^11] [^12] [^13].'] + [t for _n, t in TRIPLEC_NOTES]
    block = [(i + 1, n, str(n), t) for i, (n, t) in enumerate(TRIPLEC_NOTES)]
    out_block, out_lines, changed = S.reconcile_page_defs_with_pypdf(
        list(block), list(lines), TRIPLEC_NOTES[:2], {10, 11, 12, 13})
    assert not changed and len(out_block) == 4
    # positive control: nobody on the page calls them → still dropped as surplus
    out_block, _l, changed = S.reconcile_page_defs_with_pypdf(
        list(block), list(lines), TRIPLEC_NOTES[:2], {10, 11})
    assert changed and [b[1] for b in out_block] == [10, 11]


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


# --- tripleC 25cfb2ff (2026-11-23): URL-only notes, and a superscript in a reference title ---

def test_url_only_notes_run_together_are_split_on_one_boundary():
    assert REC.split_run_on_numbered_def(
        1, 'http://www.marxists.org/a/mswv5_65.htm 2 http://www.marxists.org/b/mswv8_09.htm'
    ) == [(1, 'http://www.marxists.org/a/mswv5_65.htm'),
          (2, 'http://www.marxists.org/b/mswv8_09.htm')]


def test_a_prose_note_mentioning_one_number_before_a_url_is_not_split():
    text = 'See the tables in volume 5 http://example.org/tables for the full series.'
    assert REC.split_run_on_numbered_def(4, text) == [(4, text)]
    url_note = 'http://example.org/page (accessed on August 20, 2011).'
    assert REC.split_run_on_numbered_def(4, url_note) == [(4, url_note)]


def test_a_title_superscript_in_a_reference_entry_is_not_a_footnote_marker():
    import ingestion.pdf.assembly as ASM
    md = ('Body text with a real marker.[^2]\n\n## References\n\n'
          'Comscore. 2012. The Power of Like[^2]. How Social Marketing Works. White Paper.\n\n'
          '## Footnotes\n\n[^2]: http://www.marxists.org/b/mswv8_09.htm')
    out = ASM._demote_markers_in_bibliography_entries(md)
    assert 'The Power of Like 2. How' in out
    assert 'real marker.[^2]' in out and '[^2]: http' in out


# ── Angle-bracketed URLs: the OCR returns "<https://host/a/b.pdf>" as a tag-shaped ──────────
# "<https: b.pdf="" a="" host="">" with its segments lower-cased and SORTED. Which URL that
# was is decided by the segments it kept, never by its position among the page's URLs.

class _FakePage:
    def __init__(self, text):
        self._t = text

    def extract_text(self):
        return self._t


class _FakeReader:
    def __init__(self, texts):
        self.pages = [_FakePage(t) for t in texts]


def _fix_urls(md, layer, monkeypatch):
    monkeypatch.setattr(REC, 'PdfReader', lambda _p: _FakeReader([layer]))
    return REC.fix_mangled_urls(md, 'unused.pdf')


def test_a_mangled_url_is_matched_by_its_segments_not_its_position(monkeypatch):
    # The layer holds one URL the OCR did NOT mangle (so the lists are out of step) — position
    # would hand note 5 the site root and push every later note onto its neighbour's address.
    layer = ('1 The RDC is at: <https://example.org/>. See also https://example.org/about\n'
             '5 <https://example.org/ArchivePDFs/87.pdf>. (Author 1942).\n'
             '9 available at: <https://example.org/ArchivePDFs/1492.pdf>')
    md = ('[^1]: The RDC is at: <https: example.org=""></https:>.\n\n'
          '[^5]: <https: 87.pdf="" archivepdfs="" example.org="">. (Author 1942).\n\n'
          '[^9]: available at: <https: 1492.pdf="" archivepdfs="" example.org="">')
    out = _fix_urls(md, layer, monkeypatch)
    assert '[^1]: The RDC is at: <https://example.org/>.' in out
    assert '[^5]: <https://example.org/ArchivePDFs/87.pdf>.' in out
    assert '[^9]: available at: <https://example.org/ArchivePDFs/1492.pdf>' in out
    assert '</https' not in out


def test_a_url_wrapped_across_a_line_in_the_layer_is_still_matched(monkeypatch):
    layer = 'available at: <https://example.org/raya/Archive\nPDFs/5824.pdf> (Author 1978).'
    md = '[^9]: available at: <https: 5824.pdf="" archivepdfs="" example.org="" raya="">'
    assert ('<https://example.org/raya/ArchivePDFs/5824.pdf>'
            in _fix_urls(md, layer, monkeypatch))


def test_a_segment_the_ocr_dropped_does_not_stop_the_match(monkeypatch):
    layer = ('<https://example.org/ArchivePDFs/87.pdf> and '
             '<https://example.org/raya/ArchivePDFs/5824.pdf>')
    md = 'see <https: 5824.pdf="" archivepdfs="" example.org="">'
    assert ('<https://example.org/raya/ArchivePDFs/5824.pdf>'
            in _fix_urls(md, layer, monkeypatch))


def test_a_note_that_is_only_a_bracketed_url_leaves_the_body_with_its_page_notes():
    md = ('Body text that ends the page "Two\n\n'
          '[^5]: <https: 87.pdf="" archivepdfs="" example.org="">. (Author 1942).\n\n'
          '[^6]: A prose note that follows it.')
    body, notes = S.split_body_and_footnotes(md)
    assert body == 'Body text that ends the page "Two'
    assert notes.startswith('[^5]: <https:')


# ── 27e44104: notes the layer ran together, and a note printed inside a list item ──────────

def test_note_ending_in_a_url_splits_from_the_next_numbered_note():
    run = ('See http://de.wikipedia.org/wiki/Werkunterricht 18 Translation from German. '
           'Lehrpläne technisches Werken, http://www.bmukk.gv.at/medienpool/792/ahs17.pdf')
    out = REC.split_run_on_numbered_def(17, run)
    assert [n for n, _t in out] == [17, 18]
    assert out[0][1] == 'See http://de.wikipedia.org/wiki/Werkunterricht'
    assert out[1][1].startswith('Translation from German.')


def test_a_date_after_a_url_is_not_the_next_note():
    run = 'See http://example.org/report.html 18 March 2013, section two of the report'
    assert REC.split_run_on_numbered_def(17, run) == [(17, run)]


def test_a_number_inside_prose_does_not_split_a_note():
    run = 'Compare the figures in chapter 18 Translation is discussed at http://example.org/x'
    assert REC.split_run_on_numbered_def(17, run) == [(17, run)]


def test_list_numbered_page_foot_note_becomes_a_definition():
    md = ('pose a strong incentive for people to move into work”²⁰. It does not matter.\n\n'
          '1. *BBC Online*, Iain Duncan Smith criticised over benefit cap figures. May 9, 2013.\n')
    layer = ('…if this is techno-        1. 20 BBC Online, Iain Duncan Smith criticised over '
             'benefit cap figures. May 9, 2013.')
    out = S.promote_list_numbered_note(md, layer)
    assert '\n²⁰ *BBC Online*, Iain Duncan Smith' in out
    assert '\n1. *BBC Online*' not in out


def test_an_ordinary_closing_list_item_is_left_alone():
    md = 'Some text with a marker²⁰ here.\n\n1. First point of the argument is made here.\n'
    layer = 'Some text with a marker20 here. 1. First point of the argument is made here.'
    assert S.promote_list_numbered_note(md, layer) == md
    # layer agrees on the shape but the page has no such marker → still left alone
    layer2 = 'x 1. 20 First point of the argument is made here.'
    md2 = 'Some text with no marker.\n\n1. First point of the argument is made here.\n'
    assert S.promote_list_numbered_note(md2, layer2) == md2


def test_the_word_correspondence_does_not_cut_a_note():
    run = ('Lenin, The Theoretic Mistakes of the comrades are discussed here at length. '
           '16 See the last writings on Lenin in the collected volumes of the archive. '
           '17 For Lukacs the Absolute Spirit introduced no really new knowledge of history. '
           '18 See Marcuse-Dunayevskaya Correspondence see RDC, Volume 12, Section V.')
    out = REC.split_run_on_numbered_def(15, run)
    assert out[-1] == (18, 'See Marcuse-Dunayevskaya Correspondence see RDC, Volume 12, Section V.')


def test_a_marker_the_ocr_wrote_as_latex_is_not_resurrected_a_second_time():
    # 99a9fa50: "$^{26}$" already marks note 26; the layer's "British Sign Language,26 the sign"
    # also fits "French Sign Language, "the sign" two sentences earlier.
    md = ('derived from the French Sign Language, "the sign for work is made by fists.\n\n'
          'In British Sign Language, $^{26}$  the sign for work is made with open palms.')
    layer = ('derived from the French Sign Language, “the sign for work is made by fists. '
             'In British Sign Language,26 the sign for work is made with open palms.')
    out, n = REC.resurrect_dropped_markers_from_pypdf(md, layer, {26})
    assert n == 0 and out == md
    for shape in ('²⁶', '<sup>26</sup>', '[^26]'):
        md2 = md.replace('$^{26}$', shape)
        assert REC.resurrect_dropped_markers_from_pypdf(md2, layer, {26})[1] == 0


def test_an_unclosed_angle_url_does_not_swallow_the_notes_after_it():
    md = ('[^14]: see also the journal:<http://www.isj.org.uk/index.php4?s=contents&issue=114.\n\n'
          '[^15]: A note with no link at all.\n\n'
          '[^16]: found in this post: <http://www.renesys.com/blog/egypt.shtml>.')
    out = S.autolink_angle_urls(md)
    assert out.count('[^15]:') == 1 and out.count('[^16]:') == 1
    assert '<a href="http://www.renesys.com/blog/egypt.shtml" target="_blank">' in out
    assert S.autolink_angle_urls('x < http://a.org/b> y') == 'x <a href="http://a.org/b" target="_blank">http://a.org/b</a> y'


def test_two_notes_on_one_page_with_the_same_url_are_not_page_chrome():
    by_page = {33: [(5, 'http://money.cnn.com/data/us_markets/'),
                    (6, 'http://money.cnn.com/data/us_markets/')]}
    got = REC.recover_missing_defs(set(), by_page, 6)
    assert [n for n, _t in got] == [5, 6]
    # the same text on two different pages is still a running footer
    footer = {2: [(2, 'Palgrave Communications 3:17092 DOI 10.1057')],
              4: [(4, 'Palgrave Communications 3:17092 DOI 10.1057')]}
    assert REC.recover_missing_defs(set(), footer, 9) == []


# ── headings: what the text layer can put back ────────────────────────────────────────────

def test_dropped_section_number_is_restored_from_the_layer():
    md = 'Some prose here.\n\n### Defining Cultural Labour\n\nThere exists a latent debate.\n'
    layer = 'how to define cultural labour.  1.1. Defining Cultural Labour There exists a latent debate.'
    out = S.restore_heading_evidence_from_layer(md, layer)
    assert '### 1.1. Defining Cultural Labour' in out


def test_heading_number_needs_the_exact_text_once_and_a_dotted_number():
    md = '## Results\n\nText.\n\n## Digital Labour Today\n\nMore.\n'
    # bare number (page/note number look-alike), and a heading the layer never numbers
    layer = 'page 3 Results Text. Digital Labour Today More.'
    assert S.restore_heading_evidence_from_layer(md, layer) == md
    # ambiguous: printed twice with a number (contents list + body)
    layer2 = '2.1. Digital Labour Today .... 5  2.1. Digital Labour Today More.'
    assert S.restore_heading_evidence_from_layer(md, layer2) == md
    # already numbered headings are left alone
    md3 = '## 1.4. Digital Work and Digital Labour\n\nText.\n'
    assert S.restore_heading_evidence_from_layer(md3, '1.4. Digital Work and Digital Labour Text.') == md3


def test_bullet_lead_in_the_ocr_made_a_heading_goes_back_to_a_list_item():
    md = ('communities, etc.\n\n### False coronavirus news:\n\n'
          'The collective shock is a fertile ground.\n\n### Types of false coronavirus news:\n\n'
          'There are two main types.\n')
    layer = ('communities, etc.   \u2022 False coronavirus news:  The collective shock is a fertile '
             'ground.  \u2022 Types of false coronavirus news:  There are two main types.')
    out = S.restore_heading_evidence_from_layer(md, layer)
    assert '#' not in out
    assert '- False coronavirus news: The collective shock is a fertile ground.' in out
    assert '- Types of false coronavirus news: There are two main types.' in out


def test_a_real_colon_heading_with_no_bullet_in_the_layer_is_kept():
    md = '## Key Findings:\n\nThe findings are these.\n'
    assert S.restore_heading_evidence_from_layer(md, 'Key Findings: The findings are these.') == md


def test_the_tail_of_a_doi_is_not_a_section_number():
    md = '## How to cite TSpace items\n\nAlways cite the published version.\n'
    layer = 'available at: http://www.tandfonline.com/10.5235/20414005.5.1.60. \n \nHow to cite TSpace items \nAlways cite'
    assert S.restore_heading_evidence_from_layer(md, layer) == md


def test_a_numbered_section_heading_is_not_recovered_as_a_note():
    # 8c40a2a0: the layer reads "2 The Limits of Laplace´s Demon The point is…" as note 2.
    from ingestion.pdf.assembly import _drop_section_heading_defs
    combined = ('Body text.[^1]\n\n# 2 The Limits of Laplace\'s Demon\n\nThe point is that even '
                'the demon cannot.\n\n[^1]: A real note.')
    recovered = [(2, 'The Limits of Laplace´s Demon The point is that even the demon cannot.'),
                 (3, 'A note that is nobody\'s heading, lost by the OCR.')]
    assert _drop_section_heading_defs(recovered, combined) == [recovered[1]]


def test_a_heading_with_another_number_does_not_swallow_a_note():
    from ingestion.pdf.assembly import _drop_section_heading_defs
    combined = '# 4 Tailored medications\n\nText.'
    recovered = [(9, 'Tailored medications are discussed by Smith (2001).')]
    assert _drop_section_heading_defs(recovered, combined) == recovered


def test_a_note_block_left_in_the_body_a_note_per_line_is_absorbed():
    # 749b9c6b: "6 https://engelliweb.com/⏎7 Last accessed on…" stayed in the body as well.
    from ingestion.pdf.assembly import _absorb_numbered_body_twins
    combined = ('Body sentence one.\n\n6 https://engelliweb.com/\n7 Last accessed on 1 October '
                '2016—the number was 110,464 on 4 May 2016.\n\n## Next\n\n'
                '[^6]: https://engelliweb.com/\n\n'
                '[^7]: Last accessed on 1 October 2016—the number was 110,464 on 4 May 2016.')
    out = _absorb_numbered_body_twins(combined, [
        (6, 'https://engelliweb.com/'),
        (7, 'Last accessed on 1 October 2016—the number was 110,464 on 4 May 2016.')])
    assert '\n6 https' not in out and '\n7 Last' not in out
    assert '[^6]: https://engelliweb.com/' in out and '[^7]: Last accessed' in out


def test_a_number_opening_a_line_of_the_previous_note_is_not_a_new_note():
    # f8e87370: "…viewers in only⏎6 days, and thus it broke all previous records"
    assert R._LOWER_OPENER_RE.match('days, and thus it broke all previous records')
    assert not R._TERMINAL_CLOSE_RE.search('gathered 100 million viewers in only')
    assert R._TERMINAL_CLOSE_RE.search('of justice” (5).')
    assert not R._LOWER_OPENER_RE.match('Many of these accusations were handled')


def test_two_notes_on_one_line_split_at_a_sentence_end_when_the_number_is_missing():
    text = ('“They are nice guys, right?” Gavin asks his father, the boy that he knew. '
            '17 Gavin’s image comes from http://example.org/a , accessed May 30, 2012.')
    got = R.split_run_on_numbered_def(16, text, taken={16})
    assert [n for n, _t in got] == [16, 17]
    assert got[0][1].endswith('he knew.') and got[1][1].startswith('Gavin’s image')
    # the page already holds a note 17: the "17" here is something the note says
    assert R.split_run_on_numbered_def(16, text, taken={16, 17}) == [(16, text)]
    # a date is never a note opening
    dated = 'See the report of the committee. 17 April 2013 was the date of the hearing.'
    assert R.split_run_on_numbered_def(16, dated, taken={16}) == [(16, dated)]
    # and without the page's numbers nothing is read this way
    assert R.split_run_on_numbered_def(16, text) == [(16, text)]


def test_an_unlinked_definition_with_no_layer_to_ask_gets_no_verdict_of_absence():
    md = 'Body with one marker.[^1]\n\n[^1]: A linked note.\n\n[^2]: A note nobody points to at all.'
    got = R.assess_unlinked_definitions(md, None)
    assert [(r['number'], r['verdict']) for r in got] == [(2, 'no_layer')]
    assert R.assess_unlinked_definitions('Body.[^1]\n\n[^1]: Linked.', None) == []


def test_a_note_cut_out_of_its_predecessor_is_marked_so_it_can_be_put_back():
    # 00120a28: printed note 9 has no marker and no OCR copy; a consumer that cannot place it
    # must be able to tell it was the tail of note 8 and leave it there.
    text = ('We find ourselves in a very different intellectual moment, as Murphy described. '
            '9 In an essay entitled “The Social Exclusion Discourse” Béland documents it.')
    got = R.split_run_on_numbered_def(8, text, taken={8})
    assert [n for n, _t in got] == [8, 9]
    assert not isinstance(got[0][1], R.SplitBornNote) and isinstance(got[1][1], R.SplitBornNote)
    assert got[1][1] == 'In an essay entitled “The Social Exclusion Discourse” Béland documents it.'


# --- 2026-11-25 batch: what the text layer says about numbers ------------------------------


def test_a_folio_glued_to_the_running_head_is_not_a_note():
    """c45b67a0: "2 Geoff M. Bocher & Emily McAvan …" heads every even page, each swallowing the
    page under it, so no two share a text — the number climbing with the page gives them away."""
    layer = {
        1: [(2, 'Geoff M. Bocher & Emily McAvan CC-BY-NC-ND. Sci-Fi Author: In my book I invented')],
        3: [(4, 'Geoff M. Bocher & Emily McAvan CC-BY-NC-ND. of Silicon Valley is trying to make')],
        5: [(6, 'Geoff M. Bocher & Emily McAvan CC-BY-NC-ND. The most recent mutation of the'),
            (2, 'One oft-unremarked underlying thread that ties key figures together.')],
    }
    recovered = R.recover_missing_defs(set(), layer, 10)
    assert recovered == [(2, 'One oft-unremarked underlying thread that ties key figures together.')]


def test_notes_that_merely_open_alike_are_not_folios():
    layer = {
        1: [(1, 'Translation from German: the first of several translated passages.')],
        2: [(4, 'Translation from German: another passage entirely, on a later page.')],
        4: [(9, 'Translation from German: and a third, where the numbers do not track pages.')],
    }
    assert [n for n, _t in R.recover_missing_defs(set(), layer, 10)] == [1, 4, 9]


def test_a_definition_gets_back_the_number_the_pdf_prints_it_under():
    """0c64b464: an unnumbered table note in the block pushed the OCR's count up by one, so
    marker 6 opened the table note and the real note 6 had no marker."""
    md = ('Body with a marker[^6]. More body.\n\n'
          '[^5]: Colin Sparks (1989) explains the debt to Ernesto Laclau.\n'
          '[^6]: See italicized, bolded items in Table 1, p. 9.\n'
          '[^7]: The following interpretation of the theorization of ideology is indebted to Larrain.\n\n'
          '[^8]: Emphasis in original.\n')
    layer = {2: [(5, 'Colin Sparks (1989) explains the debt to Ernesto Laclau.'),
                 (6, 'The following interpretation of the theorization of ideology is indebted to Larrain.')],
             4: [(7, 'The Young Hegelians were leftist Prussian intellectuals.'),
                 (8, 'Emphasis in original.')]}
    out, moved = R.realign_def_numbers_to_layer(md, layer)
    assert moved == [(6, 9), (7, 6)]
    assert '[^6]: The following interpretation' in out
    assert '[^9]: See italicized' in out            # the note the print gives no number
    assert '[^7]:' not in out                       # left free for the layer's own note 7


def test_definitions_are_not_renumbered_when_the_layer_restarts_its_count():
    md = '[^1]: A first note with enough words to compare.\n\n[^2]: A second note with enough words.\n'
    layer = {1: [(1, 'A second note with enough words.')],
             2: [(1, 'Something else entirely that also carries number one.')]}
    assert R.realign_def_numbers_to_layer(md, layer) == (md, [])


def test_two_definitions_under_one_number_are_told_apart_by_the_layer():
    """03e9f2f7: "[^18]: Galison…" beside the real "[^18]: Latour…" — the first is printed 16."""
    md = ('[^17]: http://lcg.web.cern.ch/LCG. There is also a big effort.\n\n'
          '[^18]: Galison &amp; Hevly (1994).\n\n'
          '[^18]: Latour (1986), Giere &amp; Moffat (2003).\n')
    layer = {5: [(16, 'Galison & Hevly (1994).'),
                 (17, 'http://lcg.web.cern.ch/LCG. There is also a big effort.'),
                 (18, 'Latour (1986), Giere & Moffat (2003).')]}
    out, moved = R.realign_def_numbers_to_layer(md, layer)
    assert moved == [(18, 16)]
    assert '[^16]: Galison' in out and '[^18]: Latour' in out


_LONE_PAGE = (
    'meanings of intelligence or rationality\n1\n.  \n'
    'this is an ad machinam  fallacy\n5\n. \n'
    'attribute will to it, as to the animals\n6\n. They feared the arguments\n'
    'talk of the automation of proof\n13\n. \n'
    'valuable to research and discovery\n14\n. \n'
    'has appeared in the historical development\n18\n. We must remember\n'
    '                                        \n'
    '1\n Kurzweil (1990). \n'
    '2\n Brooks (1991). \n'
    '3\n Vallverdu (2005). \n'
)


def test_notes_whose_numbers_sit_on_their_own_line_are_read_as_a_block():
    lines = _LONE_PAGE.split('\n')
    assert R._lone_line_note_defs(lines) == [
        (1, 'Kurzweil (1990).'), (2, 'Brooks (1991).'), (3, 'Vallverdu (2005).')]
    # a body marker is not a note: nothing opens like one after it
    assert R._lone_line_note_defs('some text\n7\n: and it goes on\n'.split('\n')) == []


def test_marker_numbers_are_held_to_the_layers_own_superscripts():
    """03e9f2f7: OCR read marker 5 as 6, put a phantom 5 on an ordinal, and dropped marker 1."""
    md = ("We use different meanings of 'intelligence' or 'rationality'.\n\n"
          'We can travel to XVII[^5] Century. This is an *ad machinam* fallacy[^6].\n\n'
          'We can talk of the automation of proof[^13]. Valuable to research and discovery[^14].\n\n'
          'It has appeared in the historical development[^18]. We must remember.\n\n'
          '[^1]: Kurzweil (1990).\n\n[^5]: The neologism is mine.\n\n[^6]: Thoughts, Chapter VI.\n\n'
          '[^13]: Mackenzie (1995).\n\n[^14]: Stormo (2000).\n\n[^18]: Latour (1986).\n')
    out, corrected, removed, planted = R.reconcile_markers_with_lone_line_seams(md, {0: _LONE_PAGE})
    assert corrected == [(6, 5)] and removed == [5] and planted == [1]
    assert "'rationality'[^1]." in out
    assert 'XVII Century' in out
    assert 'fallacy[^5].' in out


def test_marker_numbers_are_left_alone_without_an_established_lone_line_layout():
    md = 'An *ad machinam* fallacy[^6].\n\n[^5]: The neologism.\n\n[^6]: Thoughts.\n'
    page = 'this is an ad machinam  fallacy\n5\n. \n'
    assert R.reconcile_markers_with_lone_line_seams(md, {0: page}) == (md, [], [], [])


def test_a_run_of_notes_splits_at_a_short_form_note():
    """d6c052da: "…/business-20288077  14 ibid.  15 Amazon: …" — the split stopped at "ibid."."""
    text = ('Starbucks, Google and Amazon grilled over tax avoidance. BBC Online. '
            'http://www.bbc.co.uk/news/business-20288077  14 ibid.  15 Amazon: £7bn sales, no UK '
            'corporation tax. The Guardian Online. http://www.guardian.co.uk/technology/amazon  '
            '16 Should we boycott the tax-avoiding companies? The Guardian Online.')
    parts = R.split_run_on_numbered_def(13, text, taken={12, 13})
    assert [n for n, _t in parts] == [13, 14, 15, 16]
    assert parts[1][1] == 'ibid.'


def test_an_endnote_marker_pages_before_its_note_counts_as_in_the_layer(monkeypatch):
    """d943d806: notes on the last pages, "…among psychologists36." on page 5."""
    monkeypatch.setattr(R, 'extract_pypdf_page_texts', lambda _p: {
        4: 'there seems to be no doubt among psychologists36. From the numerous phobias',
        19: '36 But cf. Franz Alexander, Psychoanalysis of the Total Personality, concerning'})
    monkeypatch.setattr(R, 'extract_pypdf_footnote_defs', lambda _p: {
        19: [(36, 'But cf. Franz Alexander, Psychoanalysis of the Total Personality, concerning')]})
    md = 'Body text.\n\n[^36]: But cf. Franz Alexander, Psychoanalysis of the Total Personality, concerning\n'
    assert R.assess_unlinked_definitions(md, 'x.pdf')[0]['verdict'] == 'marker_in_layer'


def test_a_licensed_number_on_a_closing_quote_is_a_marker():
    """820fe235: 'disappears"50.' and 'Da-sein" 64 (61-62)' — the page's own notes vouch."""
    page = ('He says that "the human being disappears"50.\n\n'
            'The brand name of the \'master race\'"52 (Anders 2001, 277). For Anders this matters.\n\n'
            '50 Translation from German: the first passage.\n\n'
            '51 Translation from German: the second passage.\n\n'
            '52 Translation from German: the third passage.')
    out, _counter = S.renumber_page_footnotes(page, 1)
    assert 'disappears"[^1].' in out
    assert '\'master race\'"[^3] (Anders' in out


def test_a_clock_time_is_not_a_marker():
    text = ('See the first claim.[^17] Video screen running time: 03:18 (mm:ss); key narratives '
            'follow. Another claim.[^19]\n\n[^17]: One.\n\n[^18]: Two.\n\n[^19]: Three.\n')
    assert '03:18 (mm:ss)' in S.normalize_all_footnote_refs(text)


def test_prose_between_two_formulas_is_not_masked_as_maths():
    """d6c052da: three "US$" on the page paired the dollars the wrong way round."""
    text = ('bought for US$ 30 million. It paid tax  $(0.05\\%)$ ^{15}. Facebook paid tax '
            '$(0.1\\%)$  in  $2011^{16}$ .')
    out = S.convert_bare_caret_footnotes(S.expand_latex_superscripts(text))
    assert '[^15]' in out and '2011[^16]' in out


def test_a_sentence_running_over_two_page_turns_is_joined_twice():
    text = ('It is only a technical term, i.e., a\n\n'
            'matter of giving someone knowledge ("faire connaître quelque chose à\n\n'
            'quelqu\'un") as the dictionary has it.')
    assert S.rejoin_page_breaks(text).count('\n') == 0


def test_the_blank_run_left_by_lifted_notes_does_not_stop_a_join():
    text = ('These potentials might be destroyed and fascist potentials' + '\n' * 7
            + 'that divide society might be realised.')
    assert 'fascist potentials that divide' in S.rejoin_page_breaks(text)


# --- 2026-11-26 batch ----------------------------------------------------------------------

def test_markers_follow_definitions_the_layer_renumbered():
    """ad226741 page 2 prints notes 3-8; the OCR read markers AND definitions as 1-6. With only
    the definitions corrected the page held eight local numbers and four markers opened a note
    two places from their own."""
    before = {'This theory has been treated': 1, 'Although there are systems': 2, 'When not referenced': 3}
    block = [(3, 3, '3', 'This theory has been treated'), (4, 4, '4', 'Although there are systems'),
             (5, 5, '5', 'When not referenced')]
    lines = ['affiliated to systems theory[^1]. Natural systems[^2] may be categorized[^3].', '',
             '', '3 This theory has been treated', '4 Although there are systems', '5 When not referenced']
    refs = {1, 2, 3}
    out = S._follow_def_renumber_in_markers(before, block, lines, refs)
    assert out[0] == 'affiliated to systems theory[^3]. Natural systems[^4] may be categorized[^5].'
    assert {3, 4, 5} <= refs and 1 not in refs


def test_markers_that_were_right_are_not_moved_onto_each_other():
    """deloitte page 6: markers 1-4 are right and only the definitions were mislabelled 4, 5.
    Moving marker 4 to 3 would land it on the marker 3 already there."""
    before = {'note one': 1, 'ibid': 2, 'note three': 4, 'note four': 5}
    block = [(5, 1, '1', 'note one'), (6, 2, '2', 'ibid'), (7, 3, '3', 'note three'), (8, 4, '4', 'note four')]
    lines = ['a[^1] b[^2] c[^3] d[^4]', '', '', '', '', '1 note one', '2 ibid', '3 note three', '4 note four']
    assert S._follow_def_renumber_in_markers(before, block, list(lines), {1, 2, 3, 4}) == lines


def test_one_misread_marker_follows_its_definition():
    """1f74c7ff page 3: markers 2 and 4, definitions 2 and 3 that the page prints as 3 and 4."""
    before = {'Ce terme est largement utilisé': 2, 'En avril 2009.': 3}
    block = [(2, 3, '3', 'Ce terme est largement utilisé'), (3, 4, '4', 'En avril 2009.')]
    lines = ['des groupes de base[^2], et présidentielle[^4], inscrite', '',
             '3 Ce terme est largement utilisé', '4 En avril 2009.']
    out = S._follow_def_renumber_in_markers(before, block, lines, {2, 3, 4})
    assert out[0] == 'des groupes de base[^3], et présidentielle[^4], inscrite'


def test_a_lone_line_note_may_open_with_a_figure():
    """1f74c7ff note 31 reads '1 rand = 80 centimes d’euro.' — the run broke there and the page's
    whole block (30-34) went unread."""
    lines = ['corps du texte qui continue ici.', '',
             '30', ' L’Actualité.com, 16 avril 2008', '31', ' 1 rand = 80 centimes d’euro.',
             '32', ' Source : statistiques nationales.', '33', ' « Le peuple boer se forge']
    assert [n for n, _t in REC._lone_line_note_defs(lines)] == [30, 31, 32, 33]


def test_a_note_ending_on_a_parenthetical_reference_splits_from_the_next():
    """0eb69a75: '…adherents”. (ThIS, p.31) 6 “This chapter has examined…' is notes 5 and 6."""
    text = ('„The character of information is such as to have transformed how we live.” (ThIS, p. 9) '
            'The most persuasive conception is the least commonly suggested. (ThIS, p.31) '
            '6 “This chapter has examined six analytically separable conceptions”. (ISR, p. 22).')
    segs = REC.split_run_on_numbered_def(5, text, taken={3, 4, 5})
    assert [n for n, _t in segs] == [5, 6]
    assert segs[1][1].startswith('“This chapter')


# ── A continuous print numbering keeps its gaps (08a2e7a9) ───────────────────────────────────

GAP_PAGE = ('The most populous minority in the country,[^10] contrary to smaller minorities, '
            'is under-represented in this selection of pictures.[^11]\n\n'
            '[^10]: According to the Ministry of Foreign Affairs there are over a million.\n'
            '[^11]: Conversely, the website dedicates a whole section to them.')


def test_a_jump_past_the_counter_is_lost_markers_when_the_layer_prints_the_notes():
    """The page before lost markers 8 and 9, so the counter stands at 8 when a page numbered
    10-11 arrives. Counting on would hand marker "10" the number 8 — and the layer's own note 8
    with it. The layer prints notes 8 and 9, so the gap is theirs."""
    mapping = {}
    out, counter = S.renumber_page_footnotes(GAP_PAGE, 8, mapping, layer_gap_nums={6, 7, 8, 9, 10, 11})
    assert mapping == {10: 10, 11: 11} and counter == 12
    assert 'country,[^10] contrary' in out and '[^11]: Conversely' in out


def test_a_jump_is_closed_up_when_nothing_prints_the_skipped_notes():
    mapping = {}
    S.renumber_page_footnotes(GAP_PAGE, 8, mapping, layer_gap_nums={6, 7, 10, 11})
    assert mapping == {10: 8, 11: 9}
    mapping = {}
    S.renumber_page_footnotes(GAP_PAGE, 8, mapping)          # a per-page restart: no witness passed
    assert mapping == {10: 8, 11: 9}


def test_a_repeated_translation_note_is_not_page_furniture():
    """"Translated by the author." under notes 6 and 12 was thrown out as a running footer, and
    both markers were left with nothing to open."""
    assert R._SHORT_FORM_DEF_RE.match('translated by the author.')
    assert R._SHORT_FORM_DEF_RE.match('Emphasis added.')
    assert R._SHORT_FORM_DEF_RE.match('my translation')
    assert not R._SHORT_FORM_DEF_RE.match('translated by the author of the present volume in 1987 for the press.')
    assert not R._SHORT_FORM_DEF_RE.match('palgrave communications | 3:17092 | doi 10.1057')


def test_a_superscript_ordinal_is_not_a_footnote_marker():
    """"³ᵈ Edition" in a reference list opened note 3 (2da2e8fc)."""
    out = S.convert_footnotes('Category Theory for Computing Science ³ᵈ Edition, Montreal. In the ²¹ˢᵗ century.³')
    assert out == 'Category Theory for Computing Science 3d Edition, Montreal. In the 21st century.[^3]'
    # a lone superscript letter after a digit elsewhere is left for the marker passes
    assert S.convert_footnotes('the argument³ᵈ follows') == 'the argument[^3]ᵈ follows'


def test_affiliation_lines_do_not_send_the_first_page_to_the_notes():
    """Numbered affiliations under the author line, then the abstract and the introduction:
    everything after the first numbered line used to be collected as footnotes (024de307)."""
    page = ('# For the Lulz\n\nA. Author[^1], B. Author[^2]\n\n'
            '[^1]Department of Culture and Media Studies, Umeå University.\n\n'
            '[^2]Department of Sociology, Umeå University.\n\n'
            'Abstract: This paper discusses affect.\n\n## 1. Introduction\n\n'
            'The focus of this paper is on power.[^3]\n\n[^3]: On the art of governing see Foucault.')
    body, notes = S.split_body_and_footnotes(page)
    assert notes == '[^3]: On the art of governing see Foucault.'
    assert body.endswith('The focus of this paper is on power.[^3]') and 'Abstract:' in body
    # a page with nothing after its numbered lines splits where it always did
    plain = 'Body text.[^1]\n\n[^1]: First note.\n[^2]: Second note.'
    assert S.split_body_and_footnotes(plain) == ('Body text.[^1]', '[^1]: First note.\n[^2]: Second note.')


def test_author_numbers_keyed_to_an_affiliation_block_are_not_footnote_markers():
    page = ('# For the Lulz\n\nRodrigo Ferrada Stoehrel¹, Simon Lindgren²\n\n'
            '¹Department of Culture and Media Studies, Umeå University.\n\n'
            '²Department of Sociology, Umeå University.\n\nAbstract: This paper discusses affect.\n\n'
            'The focus of this paper is on power.¹ It goes on.\n\n¹ On the art of governing see Foucault.')
    out = S.convert_inline_footnote_markers(page)
    assert 'Rodrigo Ferrada Stoehrel<sup>1</sup>, Simon Lindgren<sup>2</sup>' in out
    assert '<sup>1</sup> Department of Culture' in out and '<sup>2</sup> Department of Sociology' in out
    assert 'on power.[^1] It goes on.' in out            # the article's own note 1 is untouched


def test_a_byline_without_its_affiliation_block_keeps_its_markers():
    page = '# Title\n\nA. Author¹, B. Author²\n\nAbstract: Something.\n\nBody text here.¹ More.\n\n¹ A note.'
    assert 'A. Author[^1], B. Author[^2]' in S.convert_inline_footnote_markers(page)
    # body prose whose notes follow on the next lines is not a byline
    prose = 'The claim is made twice.¹ ²\n\n¹ First note text.\n\n² Second note text.'
    assert '<sup>' not in S.convert_inline_footnote_markers(prose)
    # …nor is a body line over a note that opens the next line (99a9fa50)
    body = 'In Indo-European languages, the root orbho,²⁰ signifying orphan\n\n²⁰Podkorny’s entry, p. 780, adapted.'
    assert '<sup>' not in S.convert_inline_footnote_markers(body)
    lower = 'the claim about the root is made here¹ and again²\n\n¹First note.\n\n²Second note.'
    assert '<sup>' not in S.convert_inline_footnote_markers(lower)

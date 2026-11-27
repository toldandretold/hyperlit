"""Refless footer-footnote rescue (case 5c548774): Mistral dropped the in-text marker
ENTIRELY ("…interventions were reviewed¹." OCR'd with no superscript) while the definition
landed in the page `footer` field. With zero refs the doc classifies 'none' and no recovery
path ever runs — this pass uses the PDF TEXT LAYER as the marker witness and folds the def
in, renumbering when the printed number is already taken (author affiliations occupied
[^1..14] in the real book, so reusing 1 would wrong-link to an affiliation).

The pypdf reader is stubbed via monkeypatching extract_pypdf_page_texts — the seam matching
and renumbering are what's pinned here; the real-PDF path was verified against 5c548774's
actual original.pdf.
"""

import ingestion.pdf.assembly as A


BODY = ('Beginning with interventions familiar to the authors. In total 34 empirical studies '
        'of adaptation interventions were reviewed. The cases were selected on the criteria '
        'that actual adaptation actions were implemented.')
FOOTER_DEF = ('As examined in section 2: Abbink et al. (2014), Artur and Hilhorst (2012), '
              'Barrett (2014), Beckman (2011).')
PYPDF_TEXT = ('empirical studies of adaptation interventions were reviewed\n1.\n'
              'The cases were selected on the criteria that actual adaptation')


def _with_stub(monkeypatch, page_texts):
    monkeypatch.setattr(A, 'extract_pypdf_page_texts', lambda _pdf: page_texts)


def test_rescues_marker_and_def_with_fresh_number(monkeypatch):
    _with_stub(monkeypatch, {1: PYPDF_TEXT})
    combined = BODY + '\n\n' + '\n\n'.join(f'[^{i}]: Affiliation {i}.' for i in range(1, 15))
    resp = {'pages': [{'index': 0, 'footer': ''}, {'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(combined, resp, '/fake.pdf')
    assert n == 1
    assert 'interventions were reviewed[^15]. The cases' in out
    assert '[^15]: As examined in section 2: Abbink et al.' in out
    assert '[^1]: Affiliation 1.' in out            # affiliations untouched


def test_keeps_printed_number_when_free(monkeypatch):
    _with_stub(monkeypatch, {1: PYPDF_TEXT})
    resp = {'pages': [{'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(BODY, resp, '/fake.pdf')
    assert n == 1 and 'reviewed[^1]. The cases' in out


def test_no_witness_in_text_layer_no_rescue(monkeypatch):
    _with_stub(monkeypatch, {1: 'completely different text with no marker seam anywhere'})
    resp = {'pages': [{'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(BODY, resp, '/fake.pdf')
    assert n == 0 and out == BODY


def test_ambiguous_seam_skips(monkeypatch):
    # TRUE ambiguity: both md occurrences continue IDENTICALLY beyond the witness-extension
    # window, so no amount of follow-word extension can disambiguate — must skip.
    _with_stub(monkeypatch, {1: PYPDF_TEXT})
    doubled = BODY + '\n\nAgain the interventions were reviewed. The cases were selected on the '\
              'criteria that actual adaptation actions were implemented.'
    resp = {'pages': [{'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(doubled, resp, '/fake.pdf')
    assert n == 0


def test_ambiguous_seam_resolved_by_longer_witness(monkeypatch):
    # cece961b's [^4]: "2017). The" matched twice, but the text layer's continuation
    # ("The regulation") is unique — the extended witness resolves it.
    _with_stub(monkeypatch, {1: 'kept determined (Chouhan et al., 2017).\n1 \nThe regulation states that koliwadas'})
    md = ('The categories were determined (Chouhan et al., 2017). The regulation states that '
          'koliwadas should be mapped and declared as rural zones today.\n\n'
          'Another mention entirely (Chouhan et al., 2017). The earlier notification differed '
          'in its treatment of the coastal zones altogether.')
    resp = {'pages': [{'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(md, resp, '/fake.pdf')
    assert n == 1
    assert '(Chouhan et al., 2017).[^1] The regulation' in out


def test_number_with_existing_inline_ref_left_alone(monkeypatch):
    _with_stub(monkeypatch, {1: PYPDF_TEXT})
    linked = BODY.replace('were reviewed.', 'were reviewed[^1].') + '\n\n[^1]: Existing def.'
    resp = {'pages': [{'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(linked, resp, '/fake.pdf')
    assert n == 0 and out == linked


def test_chrome_only_footer_ignored(monkeypatch):
    _with_stub(monkeypatch, {1: PYPDF_TEXT})
    resp = {'pages': [{'index': 1, 'footer': 'World Development 141 (2021) 105383'}]}
    out, n = A._rescue_refless_footer_footnotes(BODY, resp, '/fake.pdf')
    assert n == 0 and out == BODY


def test_page_local_footer_number_colliding_with_linked_ref_rescues_under_fresh_number(monkeypatch):
    # 699314f1: the footer's page-LOCAL "2" collides with a globally-linked [^2] that is a
    # DIFFERENT note — the distinct-text footer def proceeds under a fresh number; a footer
    # def matching the linked def's text stays skipped.
    _with_stub(monkeypatch, {3: 'drawing on Aniekwe et al. (2012).2 The outline \nof key findings'})
    linked = ('A body claim[^2] here about administration matters, and later the concept note '
              'was prepared drawing on Aniekwe et al. (2012). The outline of key findings '
              'followed.\n\n[^2]: What administration constituted was unclear but core staff '
              'salary, research and training were included.')
    resp = {'pages': [{'index': 3, 'footer': '2 Briefing note documents and workshop materials '
                                             'associated with the Cracking collaboration project.'}]}
    out, n = A._rescue_refless_footer_footnotes(linked, resp, '/fake.pdf')
    assert n == 1
    assert '(2012).[^3] The outline' in out
    assert '[^3]: Briefing note documents and workshop materials' in out
    assert '[^2]: What administration constituted' in out    # linked note untouched
    # same-text footer def under the linked number: skipped
    resp2 = {'pages': [{'index': 3, 'footer': '2 What administration constituted was unclear '
                                              'but core staff salary, research and training.'}]}
    out2, n2 = A._rescue_refless_footer_footnotes(linked, resp2, '/fake.pdf')
    assert n2 == 0


# ---------------------------------------------------------------------------
# deloitte c132 — TWO NUMBER SPACES. A renumbered (page_bottom) doc's markdown
# markers drift away from the printed numbers at every lost marker, and the
# footer candidates carry PRINTED numbers. The attach-under-the-ref's-own-number
# branch glued printed note 30 (Wilcock) onto markdown [^30] (printed 31,
# Carney) — a confidently wrong definition no count can see. Candidates must be
# translated through the page's own local→global map; untranslatable ones may
# seam-insert under a fresh number but never attach to a same-numbered ref.
# ---------------------------------------------------------------------------

# A renumbered doc: printed 29 was lost, so markdown [^29] = printed 30 (def
# present, OCR-damaged) and markdown [^30] = printed 31 (ref live, def LOST).
DRIFTED = ('Embed proactive system features for engagement.[^29] Define and enforce core '
           'architectural principles for integrity.[^30]\n\n'
           '[^29]: Scarlett Wilcock, Policing Welfare Fraud: The Government of Welfare '
           'Fraud and Non -Compliance (Rou tledge, 2024) 85-89.')
DRIFT_MAPS = {33: {30: 29}, 34: {31: 30}}


def test_renumbered_doc_footer_def_translates_through_the_page_map(monkeypatch):
    # Page 34's footer holds printed note 31 (Carney) — the page map says printed 31 IS
    # markdown [^30], whose def was lost: attach it there, not under a literal [^31].
    _with_stub(monkeypatch, {33: 'features for engagement.30 Define', 34: 'integrity.31 More'})
    resp = {'pages': [
        {'index': 33, 'footer': '30 Scarlett Wilcock, Policing Welfare Fraud: The Government '
                                'of Welfare Fraud and Non-Compliance (Routledge, 2024) 85-89.'},
        {'index': 34, 'footer': '31 Terry Carney, Automating Compliance and Administrative '
                                'Justice in Australia (2024) 31(1) JSSL 32.'},
    ]}
    out, n = A._rescue_refless_footer_footnotes(DRIFTED, resp, '/fake.pdf',
                                                page_local_to_global=DRIFT_MAPS)
    assert '[^30]: Terry Carney, Automating Compliance' in out
    # Printed 30 translates to markdown 29, whose (damaged) def is the SAME note — skipped,
    # and above all the Wilcock text must never land under [^30].
    assert 'Policing Welfare Fraud' not in out.split('[^30]:')[1]
    assert out.count('Policing Welfare Fraud') == 1


def test_renumbered_doc_untranslatable_candidate_never_attaches_to_a_same_numbered_ref(monkeypatch):
    # The candidate's page built no map (its markers were all lost) — the printed number
    # cannot name a markdown number, so [^30] must stay defless rather than inherit the
    # wrong printed note. No seam witness here either, so nothing is inserted.
    _with_stub(monkeypatch, {33: 'nothing matching any seam at all'})
    resp = {'pages': [{'index': 33, 'footer': '30 Scarlett Wilcock, Policing Welfare Fraud: '
                                              'The Government of Welfare Fraud (2024) 85-89.'}]}
    out, n = A._rescue_refless_footer_footnotes(DRIFTED, resp, '/fake.pdf',
                                                page_local_to_global=DRIFT_MAPS)
    assert n == 0
    assert 'Policing Welfare Fraud: The Government of Welfare Fraud (2024)' not in out


def test_doc_without_renumbering_keeps_attaching_by_printed_number(monkeypatch):
    # Empty maps = the doc never renumbered (the 5c548774 class): printed numbers ARE
    # markdown numbers and the attach branch behaves exactly as before.
    _with_stub(monkeypatch, {1: PYPDF_TEXT})
    refless = BODY.replace('were reviewed.', 'were reviewed[^1].')
    resp = {'pages': [{'index': 1, 'footer': '1 ' + FOOTER_DEF}]}
    out, n = A._rescue_refless_footer_footnotes(refless, resp, '/fake.pdf',
                                                page_local_to_global={})
    assert n == 1 and '[^1]: As examined in section 2: Abbink et al.' in out


# ---------------------------------------------------------------------------
# 7fa30289 — Mistral dropped 8 of 9 superscript markers. The seams the old shape
# list could not see, plus the page-bottom RUN that licenses recovery when no
# surviving marker is left to set a ceiling.
# ---------------------------------------------------------------------------

def test_marker_glued_to_a_word_with_no_punctuation(monkeypatch):
    """"…the duality of structure4 because the structural…" — nothing but gluedness marks it.
    Every older shape required punctuation touching the marker, so three notes were lost."""
    pypdf = ('corresponds to Giddens notion of the duality of structure4 because the '
             'structural properties of societal systems')
    _with_stub(monkeypatch, {3: pypdf})
    combined = ('corresponds to Giddens notion of the duality of structure because the '
                'structural properties of societal systems\n\n[^4]: According to the notion.')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1
    assert 'duality of structure[^4] because' in out


def test_marker_glued_to_a_heading(monkeypatch):
    """A section heading carries its own note ("1. Introduction1⏎In recent times…") — the
    maintainer's headline complaint on 7fa30289."""
    _with_stub(monkeypatch, {0: '1. Introduction1\nIn recent times the terms co-operation'})
    combined = ('# 1. Introduction\n\nIn recent times the terms co-operation\n\n'
                '[^1]: An earlier version of this article.')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1
    assert '# 1. Introduction[^1]' in out


def test_marker_swallowed_by_a_substituted_superscript_letter(monkeypatch):
    """Mistral rendered the superscript 9 as 'ᵃ'. The text layer still has the digit, so the
    marker REPLACES the corpse instead of standing beside it."""
    _with_stub(monkeypatch, {5: 'see also Oberquelle 19919). This result can'})
    combined = ('see also Oberquelle 1991ᵃ). This result can\n\n[^9]: Unter kooperativer Arbeit.')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1
    assert 'Oberquelle 1991[^9]). This' in out
    assert 'ᵃ' not in out


def test_ambiguous_seam_still_refuses_to_guess(monkeypatch):
    """The looser shapes must not weaken the rule: a digitless seam that also occurs as plain
    prose in the text layer is not a witness, so nothing is inserted. (The words after the
    marker may lengthen the witness — see the 95d37f35 case below — but here they are the same
    at both sites, so there is still nothing to tell them apart.)"""
    _with_stub(monkeypatch, {0: 'the duality of structure4 because it holds in every case here. '
                                'A duality of structure because it holds in every case there.'})
    combined = ('the duality of structure because it holds in every case here. '
                'A duality of structure because it holds in every case there.\n\n[^4]: A note.')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 0 and '[^4] because' not in out


def test_pypdf_run_licenses_recovery_when_every_marker_is_gone():
    """One note per page, ascending from 1 across many pages = a printed footnote run. It is
    the only evidence of the document's footnote universe once the markers are gone."""
    defs = {p: [(n, f'Note {n} text.')] for n, p in zip(range(1, 10), range(0, 30, 3))}
    assert A._pypdf_footnote_run(defs) == 9
    del defs[12]                                   # one def the extractor missed (fn 5)
    assert A._pypdf_footnote_run(defs) == 9        # a single hole is tolerated


def test_pypdf_run_rejects_a_stacked_numbered_bibliography():
    """The same "N + text" shape reads a Vancouver reference list. Twenty entries on one page
    is not a page-bottom note run, and must not raise the recovery ceiling."""
    assert A._pypdf_footnote_run({7: [(n, f'Author {n}, A. (2001).') for n in range(1, 21)]}) == 0
    # …nor one that does not start at the first note
    assert A._pypdf_footnote_run({0: [(4, 'x')], 3: [(5, 'y')], 6: [(6, 'z')]}) == 0


def test_marker_after_a_closing_quote_then_period(monkeypatch):
    """d7322ddc: the text layer prints '…adequately”.1 Presumably' (quote BEFORE the period, the
    American order) while the OCR wrote a straight quote and dropped the digit. The marker goes
    after the punctuation, where the print has it."""
    pypdf = 'changed the world only by interpreting it adequately”.1 Presumably, Marx wrote Capital'
    _with_stub(monkeypatch, {0: pypdf})
    combined = ('changed the world only by interpreting it adequately". Presumably, Marx wrote '
                'Capital\n\n[^1]: See: www.youtube.com/watch?v=OxmzGT1w_kk (February 15, 2017).')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1
    assert 'adequately".[^1] Presumably' in out


# --- 2026-11-25 batch ----------------------------------------------------------------------


def test_numbered_lines_that_fill_a_hole_in_the_notes_are_adopted():
    """320fda56: definitions 5 and 8 exist; "6 Taken from…" / "7 Taken from…" sit in the body."""
    from ingestion.pdf.assembly import _adopt_gap_filling_note_lines
    md = ('Body paragraph one.\n\n'
          '6 Taken from http://v.youku.com/v_show/id_A.html on July 31, 2013, Berlin Time.\n'
          '7 Taken from http://v.youku.com/v_show/id_B.html on July 31, 2013, Berlin Time.\n\n'
          'Body paragraph two.\n\n'
          '[^5]: With the diffusion of the Internet a new form has emerged.\n\n'
          '[^8]: Income Gini coefficient: a measure of deviation.\n')
    out, adopted = _adopt_gap_filling_note_lines(md)
    assert adopted == [6, 7]
    assert '[^6]: Taken from http://v.youku.com/v_show/id_A.html' in out
    assert '\n6 Taken from' not in out


def test_a_numbered_list_that_fills_no_hole_stays_in_the_body():
    from ingestion.pdf.assembly import _adopt_gap_filling_note_lines
    md = ('Body.\n\n1 First principle of the charter, stated at length.\n'
          '2 Second principle of the charter, stated at length.\n\n'
          '[^1]: A note that already holds the number one.\n\n[^2]: And the second note as well.\n')
    assert _adopt_gap_filling_note_lines(md) == (md, [])


def test_a_year_is_not_a_marker_witness():
    """d943d806: "January 6, 1941, President" must not witness marker 41 on the word "19"."""
    from ingestion.pdf.assembly import _marker_seam_witnesses
    assert list(_marker_seam_witnesses('On January 6, 1941, President Roosevelt said', 41)) == []
    hits = list(_marker_seam_witnesses('the Italian Scipio Sighele41, and Le Bon', 41))
    assert hits and hits[0][1][0] == 'Sighele'
    # a citation year still carries its marker
    assert list(_marker_seam_witnesses('(see also Oberquelle 19919). This shows', 9))


# --- 2026-11-26 batch ----------------------------------------------------------------------

def test_marker_set_off_by_a_space_after_a_closing_quote(monkeypatch):
    """95d37f35: the layer prints 'individual journals” 1. Data' — quote, space, number."""
    _with_stub(monkeypatch, {0: 'prices for subscriptions to individual journals” 1. Data for a sample'})
    combined = ('prices for subscriptions to individual journals". Data for a sample\n\n'
                '[^1]: http://thecostofknowledge.com/ , accessed on July 26, 2013.')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1 and 'journals"[^1]. Data' in out


def test_a_witness_shared_by_other_sentences_is_lengthened_not_abandoned(monkeypatch):
    """95d37f35 note 6: '(NUJ 2012, 2). The …' closes three sentences; the marker is on one."""
    layer = ('quality has suffered” (NUJ 2012, 2) 6. The NUJ shares concerns about prices. '
             'part of the process” (NUJ 2012, 2). The corporate publishing industry is large.')
    _with_stub(monkeypatch, {0: layer})
    combined = ('quality has suffered” (NUJ 2012, 2). The NUJ shares concerns about prices. '
                'part of the process” (NUJ 2012, 2). The corporate publishing industry is large.'
                '\n\n[^6]: See also the video of the NUJ debate on Open Access.')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1
    assert '2)[^6]. The NUJ shares' in out and '2). The corporate' in out


def test_marker_leading_into_a_quotation(monkeypatch):
    """25cfb2ff: 'In 1958, he said2: “The Tatsepao…'."""
    _with_stub(monkeypatch, {0: 'hold forums. In 1958, he said2: “The Tatsepao, or big-character poster'})
    combined = ('hold forums. In 1958, he said: “The Tatsepao, or big-character poster\n\n'
                '[^2]: http://www.marxists.org/reference/archive/mao/selected-works/volume-8/mswv8_09.htm')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert n == 1 and 'he said[^2]: “The' in out


def test_a_link_only_note_is_anchored_to_its_own_page(monkeypatch):
    """5fc4aad4: two notes that are YouTube links share their first thirty characters, so neither
    named a page and the first page with any '3' on it took the rescue."""
    _with_stub(monkeypatch, {
        0: 'has changed. Section 3 focuses on the communication of ideology.',
        1: 'This is a nasty disease”3. Johnson and his advisor chose\n3 https://www.youtube.com/watch?v=2XRc389TvG8',
        2: 'another claim.\n9 https://www.youtube.com/watch?v=ZZZZ999 other'})
    combined = ('has changed. Section 3 focuses on the communication of ideology.\n\n'
                'This is a nasty disease”. Johnson and his advisor chose\n\n'
                '[^3]: https://www.youtube.com/watch?v=2XRc389TvG8\n\n'
                '[^9]: https://www.youtube.com/watch?v=ZZZZ999')
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, '/fake.pdf')
    assert 'disease”[^3]. Johnson' in out


def test_a_sentence_a_captioned_figure_was_floated_into_is_rejoined():
    md = ('For example, when a character kills a monster this action must be communicated back '
          'by the server to all the other\n\n'
          '![img-2.jpeg](img-2.jpeg)\nclients. In addition, the server validates requests.\n'
          'Figure 3: An example of a character killing monsters\n\nNext paragraph.')
    out, n = A._rejoin_figure_interrupted_sentences(md)
    assert n == 1
    assert 'to all the other clients. In addition' in out
    assert '![img-2.jpeg](img-2.jpeg)\nFigure 3: An example' in out


def test_a_display_the_sentence_runs_through_stays_where_it_is():
    md = ('A subobject classifier is a generalized set of truth values such that the diagram of '
          'the form\n\n![img-3.jpeg](img-3.jpeg)\nis a pullback. This time D is the denotator.\n'
          'More text here.')
    assert A._rejoin_figure_interrupted_sentences(md) == (md, 0)


def test_series_members_the_ocr_made_headings_go_back_to_prose():
    md = ('## 2. Theses\n\nT1. We have to abandon the definitions.\n\nT2. Since density is new.\n\n'
          'T3. Theories are accidental.\n\n## T5. More information does not result a new society.\n\n'
          'T6. Better not to use the term.')
    out, n = A._demote_minority_series_headings(md)
    assert n == 1 and '\n\nT5. More information' in out and '## 2. Theses' in out
    all_heads = '## A1. One\n\n## A2. Two\n\n## A3. Three'
    assert A._demote_minority_series_headings(all_heads) == (all_heads, 0)


def test_a_body_twin_is_recognised_through_an_html_entity():
    """df532d32 note 13: the layer has '&', the OCR's body copy '&amp;', and the layer's text is
    shorter than the forty characters the comparison used to demand."""
    combined = ('where the mapping of the type is such that\n\n'
                '13 See also Andreas Blass: Topoi &amp; Computation. (preprint from the website) In '
                'this paper the author constructs the exact parallel.\n\n'
                'commutation properties stay preserved.\n\n'
                '[^13]: See also Andreas Blass: Topoi & Computation.')
    out = A._absorb_numbered_body_twins(combined, [(13, 'See also Andreas Blass: Topoi & Computation.')])
    assert '\n13 See also' not in out
    assert '[^13]: See also Andreas Blass: Topoi &amp; Computation. (preprint' in out


def test_seam_with_a_one_letter_word_after_the_marker():
    from ingestion.pdf.assembly import _marker_seam_witnesses
    hits = list(_marker_seam_witnesses('Government Press Office. CC BY-NC-SA 2.0).8 A few months before', 8))
    assert hits and hits[0][1] == ('0).', '', 'A')


def test_seam_where_the_layer_letter_spaces_the_next_word():
    from ingestion.pdf.assembly import _marker_seam_witnesses
    hits = list(_marker_seam_witnesses('describe the organization of the data structure7 o f  a  MMORPG character', 7))
    assert ('structure', '', 'o f') in [h[1] for h in hits]


PLAIN_BODY = ('Users should control any commercial uses of her or his identity in social web '
              'platforms.1 It thus rests on the premise that individual web users have recourse.')
PLAIN_LAYER = 'uses of her or his identity in social web platforms. 1\nThe definition of persona rights'


def test_plain_digit_at_a_sentence_end_is_the_marker_of_the_unlinked_note():
    """The layer sets the superscript at the end of its line and carries on with another line
    altogether, so the seam hunt's follow word never matches the markdown (c8c7c8b6)."""
    site = A._plain_digit_marker_site(PLAIN_BODY, 1, PLAIN_LAYER)
    assert site is not None
    m, prefix = site
    assert PLAIN_BODY[m.start() + prefix:m.end(1)] == '1'


def test_plain_digit_refuses_two_sites_and_an_unwitnessed_one():
    twice = PLAIN_BODY + ' Another sentence ends on the word platforms.1 Then it goes on.'
    assert A._plain_digit_marker_site(twice, 1, PLAIN_LAYER) is None
    assert A._plain_digit_marker_site(PLAIN_BODY, 1, 'a page that prints other words entirely') is None
    assert A._plain_digit_marker_site(PLAIN_BODY, 2, PLAIN_LAYER) is None


def test_rescued_marker_goes_to_the_note_the_document_already_holds(monkeypatch):
    """The layer recovery had already put note 4 in the definitions, unlinked. Folding the
    footer's copy in under a fresh number printed the note twice (4ab0609a)."""
    note = 'It may be noted that a flood of books for would-be entrepreneurs now jockey for sales.'
    combined = ('Much of it contrived for other entrepreneurs of the digital self. The user, in '
                'conducting labour, goes on.[^5]\n\n[^4]: ' + note + '\n\n[^5]: Future work.')
    _with_stub(monkeypatch, {3: 'other entrepreneurs of the digital self.4 The user, in conducting\n4 ' + note})
    out, n = A._rescue_refless_footer_footnotes(
        combined, {'pages': [{'index': 3, 'footer': '4 ' + note}]}, 'x.pdf')
    assert 'digital self.[^4] The user' in out
    assert out.count(note) == 1 and '[^6]' not in out


def test_footer_copy_under_another_number_is_not_planted(monkeypatch):
    """The document holds the OECD note as 5, unlinked. A footer offers the same text as "3":
    its seam is some other note's place, so nothing is planted and nothing duplicated
    (c7c6db2b: marker 5 appeared where the page prints 3)."""
    note = 'Organisation for Economic Co-operation and Development, http://www.oecd.org'
    combined = ('We build this shared effort among disciplines. For instance, reflections on how '
                'to build research.\n\n[^5]: ' + note)
    _with_stub(monkeypatch, {1: 'this shared effort among disciplines.3 For instance, reflections'})
    out, n = A._rescue_refless_footer_footnotes(
        combined, {'pages': [{'index': 1, 'footer': '3 ' + note}]}, 'x.pdf')
    assert out == combined and n == 0


def test_marker_is_never_planted_inside_a_number(monkeypatch):
    """A table cell the layer breaks across lines reads like a superscript on its own line."""
    combined = ('| Sports press | 11,823,453 | 11,481,654 |\n\nBody text.\n\n'
                '[^3]: According to Infoadex, below-the-line advertising includes mailing.')
    _with_stub(monkeypatch, {5: 'Sports press 11,823,45\n3 \n11,481,654 9,224,834\n'
                                '3 According to Infoadex, below-the-line advertising includes mailing.'})
    out, n = A._rescue_refless_footer_footnotes(combined, {'pages': []}, 'x.pdf')
    assert '11,823,453' in out and '[^3]3' not in out


def test_mislabelled_copy_of_a_note_held_under_its_own_number_is_dropped():
    """The OCR numbered note 8 as 9; the layer brought the real 8 back. Two notes now sit under
    9 and the first — note 8 again — is what marker 9 opened (9c7e6724)."""
    eight = '“Die Welt des Daseins ist Mitwelt”. (Heidegger 1979: 118); In contrast to the Umwelt concept, a biosemiotic one'
    nine = 'Mutualism: non-obligatory or temporary relationship between two populations that benefits both'
    combined = ('Symbiotic, parasitic)[^9] are no less important.\n\n'
                f'[^8]: {eight}\n\n[^9]: {eight.replace("“", chr(34)).replace("”", chr(34))}\n\n[^9]: {nine}')
    out, dropped = A._drop_defs_repeating_another_number(combined)
    assert dropped == [(9, 8)]
    assert out.count('Die Welt des Daseins') == 1 and f'[^9]: {nine}' in out and f'[^8]: {eight}' in out
    # two DIFFERENT notes sharing a number, neither held elsewhere: not this pass's business
    other = combined.replace(f'[^8]: {eight}\n\n', '')
    assert A._drop_defs_repeating_another_number(other) == (other, [])
    # a book that restarts its numbering each chapter shares many numbers and repeats its
    # short citations: nothing there is a mislabelled copy (f07b7fff)
    cite = 'Raymond, The Cathedral and the Bazaar, a longer short-form citation.'
    book = '\n\n'.join(f'[^{n}]: Chapter one note {n} with its own distinct text here.' for n in (1, 2, 3, 4))
    book += '\n\n' + '\n\n'.join(f'[^{n}]: {cite}' for n in (1, 2, 3)) + f'\n\n[^5]: {cite}'
    assert A._drop_defs_repeating_another_number(book) == (book, [])

"""The checks no count can make (ingestion/pdf/link_checks.py): a marker that opens a different
note than the PDF prints for it, a marker far from its note, markers out of sequence, and page
text that never reached the document. The PDF readers are stubbed; the shapes are the real
ones (08a2e7a9's renumbered page, 27e44104, 99a9fa50 and d3b5d31f in the fixture corpus)."""

import ingestion.pdf.link_checks as LC


def _stub(monkeypatch, page_texts, layer_defs):
    monkeypatch.setattr(LC, 'extract_pypdf_page_texts', lambda _pdf: page_texts)
    monkeypatch.setattr(LC, 'extract_pypdf_footnote_defs', lambda _pdf: layer_defs)


PAGE_3 = ('Figure 3: The Water Dance performed by members of Kibbutz Urim.8 A few months before '
          'the account was created, the director wished to avoid security matters9 and the rest.\n'
          '8 http://www.flickr.com/photos/government_press_office/7731103414 (accessed 2014).\n'
          '9 The interview was conducted on August 7, 2011, in Jerusalem.')
PAGE_4 = ('The fact that no specific album was devoted to Muslim Arabs, the most populous minority '
          'in the country,10 contrary to smaller minorities like the Druze, reflects tensions.\n'
          '10 According to the Ministry of Foreign Affairs there are over 1.2 million Muslim Arabs.')
LAYER_DEFS = {3: [(8, 'http://www.flickr.com/photos/government_press_office/7731103414 (accessed 2014).'),
                  (9, 'The interview was conducted on August 7, 2011, in Jerusalem.')],
              4: [(10, 'According to the Ministry of Foreign Affairs there are over 1.2 million Muslim Arabs.')]}
BODY = ('The fact that no specific album was devoted to Muslim Arabs, the most populous minority '
        'in the country,[^{n}] contrary to smaller minorities like the Druze, reflects tensions.')


def test_marker_opening_a_different_note_than_the_pdf_prints(monkeypatch):
    """The page's marker is printed 10; counted on from a lost marker it became 8 and opens the
    note printed as 8."""
    _stub(monkeypatch, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS)
    md = (BODY.format(n=8) + '\n\n[^8]: http://www.flickr.com/photos/government_press_office/'
          '7731103414 (accessed 2014).')
    out = LC.assess_link_integrity(md, 'x.pdf')
    assert [(w['marker_printed'], w['note_printed']) for w in out['wrong_note']] == [(10, 8)]


def test_marker_opening_the_note_the_pdf_prints_is_silent(monkeypatch):
    _stub(monkeypatch, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS)
    md = (BODY.format(n=10) + '\n\n[^10]: According to the Ministry of Foreign Affairs there are '
          'over 1.2 million Muslim Arabs.')
    out = LC.assess_link_integrity(md, 'x.pdf')
    assert out['witnessed'] == 1 and out['wrong_note'] == []


def test_the_documents_own_numbers_do_not_matter_only_the_printed_ones(monkeypatch):
    """A renumbered document: marker 3 opens note 3, both printed as 10. Nothing to report."""
    _stub(monkeypatch, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS)
    md = (BODY.format(n=3) + '\n\n[^3]: According to the Ministry of Foreign Affairs there are '
          'over 1.2 million Muslim Arabs.')
    assert LC.assess_link_integrity(md, 'x.pdf')['wrong_note'] == []


def test_words_the_layer_has_twice_witness_nothing(monkeypatch):
    _stub(monkeypatch, {3: PAGE_3, 4: PAGE_4, 5: PAGE_4}, LAYER_DEFS)
    md = (BODY.format(n=8) + '\n\n[^8]: http://www.flickr.com/photos/government_press_office/'
          '7731103414 (accessed 2014).')
    out = LC.assess_link_integrity(md, 'x.pdf')
    assert out['witnessed'] == 0 and out['wrong_note'] == []


def test_a_layer_without_the_superscript_witnesses_nothing(monkeypatch):
    """No digit after the words: the layer dropped the superscript. A number further on in the
    prose is not the marker."""
    page = PAGE_4.replace('country,10 contrary', 'country, contrary to 12 smaller')
    _stub(monkeypatch, {4: page}, LAYER_DEFS)
    md = (BODY.format(n=8) + '\n\n[^8]: http://www.flickr.com/photos/government_press_office/'
          '7731103414 (accessed 2014).')
    assert LC.assess_link_integrity(md, 'x.pdf')['wrong_note'] == []


def test_markers_out_of_sequence_need_no_pdf():
    md = 'One.[^1] Two.[^4] Three.[^2] Four.[^5] Again.[^2]\n\n[^1]: a\n[^2]: b\n[^4]: c\n[^5]: d'
    out = LC.assess_link_integrity(md, None)
    assert [(o['number'], o['after']) for o in out['out_of_order']] == [(2, 4)]


def _note_pages():
    pages, defs, body, notes = {}, {}, [], []
    for n in range(1, 7):
        sentence = f'Sentence number {"abcdefg"[n]} about the political economy of topic {"uvwxyz"[n - 1]} ends here'
        note = (('Aardvark', 'Bismuth', 'Cormorant', 'Dulcimer', 'Estuary', 'Flotsam')[n - 1] * 3
                + f' is the distinct opening of note {n}, citing its own source at length.')
        pages[n] = f'{sentence}.{n} More prose follows.\n{n} {note}'
        defs[n] = [(n, note)]
        body.append(f'{sentence}.[^{n}] More prose follows.')
        notes.append(f'[^{n}]: {note}')
    return pages, defs, body, notes


def test_marker_far_from_its_note_in_a_page_foot_document(monkeypatch):
    pages, defs, body, notes = _note_pages()
    # note 6 is printed on page 2, far from its marker on page 6
    defs[2] = defs[2] + defs.pop(6)
    _stub(monkeypatch, pages, defs)
    out = LC.assess_link_integrity('\n\n'.join(body + notes), 'x.pdf')
    assert [(f['number'], f['marker_page'], f['note_page']) for f in out['far_from_note']] == [(6, 6, 2)]


def test_endnotes_are_never_far_from_their_markers(monkeypatch):
    """Every note on one page at the end: that is where endnotes live."""
    pages, defs, body, notes = _note_pages()
    _stub(monkeypatch, pages, {9: [d for n in sorted(defs) for d in defs[n]]})
    assert LC.assess_link_integrity('\n\n'.join(body + notes), 'x.pdf')['far_from_note'] == []


PROSE = ('It is in the nature of the argument that the conditions of production are also the '
         'conditions of the reproduction of the society in which that production is carried on, and '
         'it follows from this that the analysis of the one is not to be had without the analysis '
         'of the other. The point is made at length in the second part of the work, and it is the '
         'ground on which the later chapters stand, as the reader of those chapters will find for '
         'themselves in due course and with no great effort on their part.')
KEPT = ('A different paragraph, which the converted document does hold, about the circulation of '
        'commodities and the forms that money takes on in the course of that circulation.')


def test_a_paragraph_of_page_text_absent_from_the_document(monkeypatch):
    _stub(monkeypatch, {2: KEPT + '\n' + PROSE}, {})
    out = LC.assess_link_integrity(KEPT, 'x.pdf')
    assert len(out['lost_text']) == 1 and out['lost_text'][0]['page'] == 2
    assert 'conditions of production' in out['lost_text'][0]['excerpt']
    assert 'course of that circulation.' in out['lost_text'][0]['before']
    _stub(monkeypatch, {2: KEPT + '\n' + PROSE}, {})
    assert LC.assess_link_integrity(KEPT + '\n\n' + PROSE, 'x.pdf')['lost_text'] == []


def test_hyphenation_spacing_and_an_escaped_less_than_do_not_read_as_loss(monkeypatch):
    layer = PROSE.replace('reproduction', 'repro-\nduction').replace('analysis', 'ana lysis')
    _stub(monkeypatch, {2: layer}, {})
    md = 'Income &lt; 20,000 was the cut-off.\n\n' + PROSE + '\n\nA later line with a &gt; sign.'
    assert LC.assess_link_integrity(md, 'x.pdf')['lost_text'] == []


def test_the_labels_of_a_figure_are_not_lost_prose(monkeypatch):
    table = ' '.join(['Personal conversation Phone calls Mailing lists Facebook profile Twitter '
                      'Video YouTube Livestream Posters Flyers Newspapers Radio Television'] * 6)
    _stub(monkeypatch, {2: KEPT + '\n' + table}, {})
    assert LC.assess_link_integrity(KEPT, 'x.pdf')['lost_text'] == []


def test_the_texts_own_closing_digits_are_not_the_marker(monkeypatch):
    """"(p.161).¹³" and "(e2).²⁶": the layer is read past the digits the prose itself ends on.
    Taken for the marker, 161 and 2 were reported as "wrong notes" (c69a9641, 4cc3c696)."""
    page = ('bezeichnet er als ihre hauptsächliche Bedeutung (p.161).13 Weiter heisst es dort, dass '
            'the system is bounded by the Earth ecosystem (e2).26 and so on.\n'
            '13 Erste Anmerkung zur hauptsächlichen Bedeutung des Begriffs bei Lorenz.\n'
            '26 As briefly discussed above, the VSM was intended to cope with complex systems.')
    defs = {5: [(13, 'Erste Anmerkung zur hauptsächlichen Bedeutung des Begriffs bei Lorenz.'),
                (26, 'As briefly discussed above, the VSM was intended to cope with complex systems.')]}
    _stub(monkeypatch, {5: page}, defs)
    md = ('bezeichnet er als ihre hauptsächliche Bedeutung (p.161).[^13] Weiter heisst es dort, dass '
          'the system is bounded by the Earth ecosystem (e2).[^26] and so on.\n\n'
          '[^13]: Erste Anmerkung zur hauptsächlichen Bedeutung des Begriffs bei Lorenz.\n\n'
          '[^26]: As briefly discussed above, the VSM was intended to cope with complex systems.')
    out = LC.assess_link_integrity(md, 'x.pdf')
    assert out['witnessed'] == 2 and out['wrong_note'] == []


def test_the_checks_only_report():
    """assess_link_integrity rewrites nothing: a finding is a fault for the converter to fix.
    An automatic repair lived here briefly and unlinked correct markers on a misreading. The
    converter's own correction (`misread_marker_corrections`) returns positions and never edits."""
    assert not [name for name in dir(LC) if name.startswith('repair')]


def test_misread_marker_is_corrected_only_onto_an_unlinked_note(monkeypatch):
    """The OCR read "country,¹⁰" as ⁸; note 10 is held and nothing points to it."""
    _stub(monkeypatch, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS)
    md = (BODY.format(n=8) + '\n\n[^8]: http://www.flickr.com/photos/government_press_office/'
          '7731103414 (accessed 2014).\n\n[^10]: According to the Ministry of Foreign Affairs there are '
          'over 1.2 million Muslim Arabs.')
    fixes = LC.misread_marker_corrections(md, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS)
    assert [(was, now) for _s, _e, was, now in fixes] == [(8, 10)]
    start, end, _w, _n = fixes[0]
    assert md[start:end] == '[^8]'
    # note 10 already has a marker of its own: nothing is taken from it
    taken = md.replace('reflects tensions.', 'reflects tensions. Elsewhere.[^10]')
    assert LC.misread_marker_corrections(taken, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS) == []
    # the document does not hold note 10 at all: left for the check to report
    absent = md.split('\n\n[^10]:')[0]
    assert LC.misread_marker_corrections(absent, {3: PAGE_3, 4: PAGE_4}, LAYER_DEFS) == []


def test_a_marker_whose_note_the_source_never_printed_takes_its_number_and_opens_nothing(monkeypatch):
    """d3b5d31f prints notes 1-3 and 5, and marker 4 after "a shared problem"; the OCR read
    the 4 as 3. The marker becomes [^4] with no definition — what the print says."""
    page = ('Sociology and Computer Science must find common solutions to a shared problem4. And '
            'more prose follows on this page.\n'
            '3 For Trust as Result and Trust Modelling we use capital initials here.\n'
            '5 Organisation for Economic Co-operation and Development, http://www.oecd.org')
    layer = {3: [(1, 'See Section 2 of this paper for a discussion of the point.'),
                 (2, 'These include that many of us work in the area of Trust research.'),
                 (3, 'For Trust as Result and Trust Modelling we use capital initials here.')],
             4: [(5, 'Organisation for Economic Co-operation and Development, http://www.oecd.org')]}
    md = ('Sociology and Computer Science must find common solutions to a shared problem[^3]. And more.\n\n'
          '[^1]: See Section 2 of this paper for a discussion of the point.\n\n'
          '[^2]: These include that many of us work in the area of Trust research.\n\n'
          '[^3]: For Trust as Result and Trust Modelling we use capital initials here.\n\n'
          '[^5]: Organisation for Economic Co-operation and Development, http://www.oecd.org')
    _stub(monkeypatch, {4: page}, layer)
    fixes = LC.misread_marker_corrections(md, {4: page}, layer)
    assert [(was, now) for _s, _e, was, now in fixes] == [(3, 4)]
    # a number the source DOES print as a note elsewhere is not a gap: nothing happens
    layer_with_4 = {**layer, 6: [(4, 'A fourth note that the print does carry somewhere.')]}
    assert LC.misread_marker_corrections(md, {4: page}, layer_with_4) == []

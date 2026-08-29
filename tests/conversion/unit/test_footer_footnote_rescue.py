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

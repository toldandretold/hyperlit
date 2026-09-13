"""OCR page degeneration — the model LOOPING instead of transcribing.

The most dangerous OCR failure we have, because it leaves no hole: it substitutes fluent, plausible
FILLER, so nothing downstream and no reader can tell the page is not the work. stem_bibliography_
example's reference pages came back at 727/1321/1176 chars against ~5.5 KB neighbours, carrying a
repeated conference caption and the heading '# 4.2.2.2.2.2.2.2.2'; references 62-103 and 124-155
were never transcribed.

A repetition COUNT cannot detect it — a healthy page legitimately repeats a sentence three times
(table captions, boilerplate) and counting flagged 47 pages of which 43 were fine. The measure is
the duplication RATIO plus page collapse, and where a PDF is available the text layer is the
ground-truth arbiter.
"""

from ingestion.pdf.recovery import scan_page_degeneration


def _resp(pages):
    return {'pages': [{'index': i, 'markdown': md} for i, md in enumerate(pages)]}


FULL = ('The regulation states that coastal zones are managed under the Act of 1991. '
        'Municipal authorities retain discretion over permitted development. '
        'Fishing communities hold customary rights that predate the statute. '
        'Enforcement has varied considerably between districts since then. ') * 4
LOOP = ('The performance of the 2023 Conference on Computer Vision and Pattern Recognition. ' * 6)
# a MILD repeater: 3 copies, which is where corroboration actually decides the verdict
MILD = ('The performance of the 2023 Conference on Computer Vision and Pattern Recognition. ' * 3)


def test_a_looping_page_is_flagged():
    r = _resp([FULL, FULL, LOOP, FULL, FULL])
    f = scan_page_degeneration(r)
    assert [x['page'] for x in f] == [2]
    assert f[0]['duplication_ratio'] >= 0.45


def test_a_healthy_page_is_not_flagged_for_repeating_a_sentence():
    """deloitte2025independent p219 repeats a sentence 3x across 5496 chars and is entirely fine —
    it is at or above median length, which is what separates it from a collapsed loop."""
    repeater = FULL + 'See Table 4 for the detailed breakdown of each category. ' * 3
    f = scan_page_degeneration(_resp([FULL, FULL, repeater, FULL]))
    assert f == []


def test_runaway_numeric_heading_is_confirmed_without_a_pdf():
    """'# 4.2.2.2.2.2.2.2.2' is a pure decoder loop and never real structure."""
    f = scan_page_degeneration(_resp([FULL, FULL, '# 4.2.2.2.2.2.2.2.2.2.2.2\n\n' + FULL, FULL]))
    assert len(f) == 1 and f[0]['verdict'] == 'confirmed'
    assert any('runaway' in r for r in f[0]['reasons'])


def test_a_dotted_number_run_outside_a_heading_is_ordinary_content():
    """Unscoped, this pattern fired on prod against a mathematical integer partition in a power-law
    paper ('5.4.1.3.2.3.1.1.2.2.1.2.1.1.1.1.1.1.1') and against a mangled-URL artifact."""
    partition = FULL + ' the partition 5.4.1.3.2.3.1.1.2.2.1.2.1.1.1.1.1.1.1 looks very uneven. '
    assert scan_page_degeneration(_resp([FULL, FULL, partition, FULL])) == []


def test_the_pdf_text_layer_vetoes_a_genuinely_short_page(monkeypatch):
    """93d34a74 p359: a figure page whose two captions share a boilerplate sentence — 626 chars,
    ratio 0.50, and completely genuine. pypdf sees 588 chars there, i.e. the page really IS that
    short, so mild repetition must NOT be believed. This veto is what makes the signal precise."""
    import ingestion.pdf.recovery as R
    monkeypatch.setattr(R, 'extract_pypdf_page_texts', lambda _p: {2: 'x' * 200})
    assert scan_page_degeneration(_resp([FULL, FULL, MILD, FULL]), '/fake.pdf') == []


def test_an_unambiguous_loop_outranks_the_veto(monkeypatch):
    """If the OCR emits six identical sentences where the text layer holds almost nothing, the model
    did not merely miss text — it INVENTED it. No corroboration can excuse that."""
    import ingestion.pdf.recovery as R
    monkeypatch.setattr(R, 'extract_pypdf_page_texts', lambda _p: {2: 'x' * 200})
    f = scan_page_degeneration(_resp([FULL, FULL, LOOP, FULL]), '/fake.pdf')
    assert len(f) == 1 and f[0]['verdict'] == 'confirmed'


def test_mild_repetition_alone_is_not_enough():
    """Ratio + collapse used to be the whole rule, and it confused a figure PLATE (two captions
    sharing a Source/Note line) with a loop. On prod every true positive repeated one sentence 5x
    while every false positive topped out at 2."""
    twice = ('Source: UNCTADStat, calculated from the COMTRADE database for the year. ' * 2)
    assert scan_page_degeneration(_resp([FULL, FULL, twice, FULL])) == []


def test_the_pdf_text_layer_confirms_missing_text(monkeypatch):
    """The same page, but pypdf can still read a full page of text the OCR did not return —
    evidence the content is MISSING rather than absent."""
    import ingestion.pdf.recovery as R
    monkeypatch.setattr(R, 'extract_pypdf_page_texts', lambda _p: {2: 'x' * 6000})
    f = scan_page_degeneration(_resp([FULL, FULL, LOOP, FULL]), '/fake.pdf')
    assert len(f) == 1 and f[0]['verdict'] == 'confirmed'
    assert f[0]['text_layer_chars'] == 6000


def test_without_a_pdf_a_borderline_page_is_only_suspected():
    f = scan_page_degeneration(_resp([FULL, FULL, MILD, FULL]))
    assert len(f) == 1 and f[0]['verdict'] == 'suspected'
    assert 'corroborate' in f[0]['reasons'][0]


def test_a_healthy_response_yields_nothing():
    assert scan_page_degeneration(_resp([FULL, FULL, FULL])) == []
    assert scan_page_degeneration({'pages': []}) == []

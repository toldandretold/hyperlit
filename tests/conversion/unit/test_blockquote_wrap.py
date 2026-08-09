"""Pin the blockquote heuristic (_wrap_quote_blockquotes) and the bare-marker recovery in
renumber_page_footnotes — both born from 3f202e8f (Mackenzie Owen, 'The scientific article in
the age of digitization').

Mistral emits almost no structural signal for block quotations (native '>' on ~5 of 308 pages);
the ONLY safe detectable shape is typographic: an intro paragraph ending in ':' followed by a
paragraph fully wrapped in quote marks. The heuristic is deliberately asymmetric — a missed
quote stays a normal paragraph (cheap), a false positive rewrites body text as a quote
(expensive) — so these tests pin the NEGATIVE space as hard as the positive.

KNOWN LIMITATION (accepted): a blockquote typeset WITHOUT quote marks (indentation-only, the
editor treating the block itself as the quote) is indistinguishable from a body paragraph in
Mistral's markdown — no indent, no font info survives. Detecting those would need PDF-layout
analysis, not markdown heuristics. They stay paragraphs.
"""

from ingestion.pdf.assembly import _wrap_quote_blockquotes
from ingestion.pdf.pdf_shared import renumber_page_footnotes


LONG_QUOTE = ("'New technologies will soon bring fundamental changes to the process of "
              "scientific communication and no observer doubts the scale of what is coming'.")


def test_wraps_colon_introduced_fully_quoted_paragraph():
    md = "Schaffner expressed the general feeling as follows:\n\n" + LONG_QUOTE
    out = _wrap_quote_blockquotes(md)
    assert '\n\n> ' + LONG_QUOTE in out


def test_wraps_when_quote_ends_with_footnote_marker():
    quote = LONG_QUOTE[:-2] + "'.[^18]"
    md = "Hitchcock et al. had to conclude that:\n\n" + quote
    out = _wrap_quote_blockquotes(md)
    assert '> ' + quote in out


def test_wraps_when_quote_ends_with_bare_ocr_number():
    quote = LONG_QUOTE[:-2] + "'. 11"
    md = "Harmon and Gross describe the scientific article as:\n\n" + quote
    out = _wrap_quote_blockquotes(md)
    assert '> ' + quote in out


def test_no_wrap_without_colon_intro():
    md = "This paragraph ends with a period.\n\n" + LONG_QUOTE
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_no_wrap_for_short_quoted_phrase():
    md = "The theme was announced as:\n\n'Information revolution'."
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_no_wrap_for_unquoted_paragraph_after_colon():
    # A quoteless (indentation-typeset) blockquote is NOT detectable — must stay a paragraph.
    md = ("The committee concluded that:\n\nThe evidence base was diverse and inconsistent, "
          "suggesting that any standardised process would need to accommodate wide variation.")
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_no_wrap_when_quote_never_closes():
    # First half of a page-spanning quote on its own (no native '>' continuation below).
    md = ("Feldman wrote that:\n\n'Yet, while all of these changes have altered society, the "
          "primary means by which scientists communicate has remained frozen and")
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_page_spanning_native_continuation_merges_backward():
    first_half = ("'Yet, while all of these changes have radically altered our society, the "
                  "primary means by which scientists communicate has remained frozen and")
    continuation = ("> are omitted when the time comes to distribute the knowledge among our "
                    "colleagues since we cannot include a movie or sound in print.")
    out = _wrap_quote_blockquotes("Intro paragraph.\n\n" + first_half + "\n\n" + continuation)
    # the two halves become ONE contiguous '>' block: wrapped first half, '>' separator line,
    # then the native continuation — no blank paragraph gap between them
    assert '> ' + first_half + '\n>\n' + continuation in out


def test_uppercase_native_blockquote_not_merged_backward():
    prev = ("'Yet, while all of these changes have radically altered our society, scientists "
            "still communicate as they always have and")
    native = "> The following is a separate quotation that opens in uppercase."
    out = _wrap_quote_blockquotes(prev + "\n\n" + native)
    assert prev + "\n\n" + native in out  # untouched


def test_bare_marker_recovery_licenses_def_block():
    # Superscripts lost entirely: marker survives as "…century'. 11" and the page's ascending
    # def block 9/10/11 has ZERO detectable refs — the ref-overlap gate alone would leave every
    # def as a body paragraph (3f202e8f p17).
    page = ("Body text about the scientific article and its history in the seventeenth "
            "century'. 11\n\nMore body prose follows here.\n\n"
            "9 For a comprehensive review see Sapp and Gilmour 2002, 2003.\n"
            "10 Lu et al. 2002.\n"
            "11 Harmon and Gross 2003, session 5, in marked contrast with Gross et al. 2002.")
    out, counter = renumber_page_footnotes(page, 1)
    assert "century'.[^" in out.replace(' [^', '[^') or "century'. [^" in out
    # all three defs converted to definition form
    assert out.count(']: ') == 3
    # the recovered marker links to the def that carries the Harmon text
    import re
    m = re.search(r"century'\.\s*\[\^(\d+)\]", out)
    assert m, out
    n = m.group(1)
    assert re.search(r'(?m)^\[\^' + n + r'\]: Harmon and Gross 2003', out)


def test_constant_offset_def_block_rekeyed_to_page_refs():
    # Fetch-time chunk renumbering shifts line-start [N] defs by the segment offset but NOT
    # inline [N] refs (3f202e8f p176: refs [65]/[66], defs [241]/[242], offset 176). The
    # ascending block shares no numbers with the refs but aligns at one constant offset —
    # rekey the defs to the ref numbers so ref and def renumber together.
    page = ("Body text with a marker[65] and the Ford example ends with integrity'.[66]\n\n"
            "More prose follows here.\n\n"
            "[241] Thompson 1990, p. 164-171.\n"
            "[242] Shapin 1996, p. 63-64.")
    out, _ = renumber_page_footnotes(page, 1)
    import re
    ref2 = re.search(r"integrity'\.\[\^(\d+)\]", out)
    def2 = re.search(r'(?m)^\[\^(\d+)\]: Shapin 1996', out)
    assert ref2 and def2 and ref2.group(1) == def2.group(1)
    ref1 = re.search(r'marker\[\^(\d+)\]', out)
    def1 = re.search(r'(?m)^\[\^(\d+)\]: Thompson 1990', out)
    assert ref1 and def1 and ref1.group(1) == def1.group(1)


def test_small_offset_def_block_not_rekeyed():
    # A small constant difference is an OCR misread or a genuine near-miss, not a segment
    # offset — the defs keep their own numbers and stay unlicensed (literal) rather than
    # being force-paired onto the wrong refs.
    import re
    page = ("Body text with a marker[65] and more text ending here[66].\n\n"
            "[67] A note whose number is only slightly above the refs.\n"
            "[68] Another note in the same ascending run.")
    out, _ = renumber_page_footnotes(page, 1)
    assert '[67] A note' in out
    assert re.search(r'(?m)^\[\^\d+\]: A note', out) is None


def test_bare_number_in_prose_never_converts():
    # A number after punctuation that is NOT in the trailing def block must stay text.
    page = ("The society was founded in 1975. 90 percent of members agreed'. \n\n"
            "Body continues.\n\n"
            "5 A real note whose ref exists elsewhere[^5] on the page.")
    out, _ = renumber_page_footnotes(page, 1)
    assert '90 percent' in out
    assert '[^90]' not in out

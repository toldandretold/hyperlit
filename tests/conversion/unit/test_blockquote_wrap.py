"""Pin the blockquote heuristic (_wrap_quote_blockquotes) and the bare-marker recovery in
renumber_page_footnotes — both born from 3f202e8f (Mackenzie Owen, 'The scientific article in
the age of digitization').

Mistral emits almost no structural signal for block quotations (native '>' on ~5 of 308 pages);
the ONLY safe detectable shape is typographic: an intro paragraph ending in ':' followed by a
paragraph fully wrapped in quote marks. The heuristic is deliberately asymmetric — a missed
quote stays a normal paragraph (cheap), a false positive rewrites body text as a quote
(expensive) — so these tests pin the NEGATIVE space as hard as the positive.

KNOWN LIMITATION (narrowed 2026-08, cases 244ae673/3fbb92da/68252cc2): a blockquote typeset
WITHOUT wrapping quote marks IS now detectable in two specific typographic shapes — (A) the
paragraph ends ". (Author, 1998, p.5)": sentence-terminal punctuation BEFORE a final
parenthetical citation with nothing after it (inline citations are the mirror image — period
AFTER the paren); (B) an attributed colon intro ("As Neocleous (2013: np) argues:") followed by
a quote-DENSE paragraph (>= 2 internal double-quoted spans). Everything else quoteless stays a
paragraph — a bare colon intro + plain prose is still pinned negative below.
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


# --- Heuristic A: citation-terminated quote paragraph (case 244ae673 / 68252cc2) ---

DELORIA_QUOTE = ("The indeterminacy of American identities stems, in part, from the nation's "
                 "inability to deal with Indian people. Americans wanted to feel a natural "
                 "affinity with the continent, and it was Indians who could teach them such "
                 "aboriginal closeness. Yet, in order to control the landscape they had to "
                 "destroy the original inhabitants. (Deloria, 1998, p.5)")

BEAR71_QUOTE = ("She lived her life under near constant surveillance and was continually "
                "stressed by the interactions with the human world. She was tracked and logged "
                "as data... We're watching her. She's watching us. And at the same time, we're "
                "watching ourselves. (Mendez and Allison (2012) Bear 71. National Film Board "
                "of Canada)")


def test_wraps_citation_terminated_quote_no_intro_needed():
    md = "A previous body paragraph that ends normally.\n\n" + DELORIA_QUOTE + "\n\nMore body."
    out = _wrap_quote_blockquotes(md)
    assert '\n\n> ' + DELORIA_QUOTE + '\n\n' in out


def test_wraps_citation_terminated_quote_with_nested_paren_source():
    md = "# Keywords\n\nanimal geographies, camera traps, surveillance\n\n" + BEAR71_QUOTE
    out = _wrap_quote_blockquotes(md)
    assert '> ' + BEAR71_QUOTE in out


def test_no_wrap_when_period_follows_the_citation():
    # Inline citation shape: the paren is INSIDE the sentence, period after it.
    para = ("L. Frank Baum famously asserted in 1890 that the safety of white settlers was "
            "only guaranteed by the total annihilation of the few remaining Indians "
            "(as quoted in Hastings, 2007).")
    assert '> ' not in _wrap_quote_blockquotes("Intro paragraph.\n\n" + para)


def test_no_wrap_for_see_also_aside_paren():
    para = ("The committee reviewed all of the available material over the course of three "
            "separate sessions and reached broad agreement on the substance of the report "
            "before the final vote was taken. (See also Smith, 2004)")
    assert '> ' not in _wrap_quote_blockquotes("Intro paragraph.\n\n" + para)


def test_no_wrap_for_parenthesized_full_sentence():
    para = ("The committee reviewed all of the available material over the course of three "
            "separate sessions and reached broad agreement on the substance of the report. "
            "(This point was revisited at length in the 2004 edition of the handbook.)")
    assert '> ' not in _wrap_quote_blockquotes("Intro paragraph.\n\n" + para)


def test_no_wrap_when_terminal_is_bare_closing_quote_before_citation():
    # 3fbb92da false positive: a quoted TERM right before the citation is mid-sentence, not a
    # sentence end — "…'feeling rules' (Hochschild, 1983; Gill & Kanai, 2018)".
    para = ("In this framing there is a move on from conventional understandings of "
            "neoliberalism as a political and economic rationality, with attention to "
            "neoliberalism as a project built around ‘feeling rules’ "
            "(Hochschild, 1983; Gill & Kanai, 2018)")
    assert '> ' not in _wrap_quote_blockquotes("Intro paragraph.\n\n" + para)


def test_no_wrap_for_lowercase_opening_continuation_paragraph():
    # A body paragraph split at a page break: the continuation opens lowercase and happens to
    # end with a terminal citation — still not a quotation.
    para = ("what it makes visible or occludes, how it materialises across different sites, "
            "and what it does ideologically or performatively, insinuating itself into the "
            "nooks and crannies of everyday life as a psychological project. "
            "(Scharff, 2015)")
    assert '> ' not in _wrap_quote_blockquotes("Intro paragraph.\n\n" + para)


def test_no_wrap_for_yearless_terminal_paren():
    para = ("The committee reviewed all of the available material over the course of three "
            "separate sessions and reached broad agreement on the substance of the report "
            "before the final vote. (emphasis added)")
    assert '> ' not in _wrap_quote_blockquotes("Intro paragraph.\n\n" + para)


# --- Heuristic C: epigraph + dash-led attribution line (case 244ae673, Fanon epigraphs) ---

FANON_QUOTE = ('Decolonization, which sets out to change the order of the world, is, obviously, '
               'a program of complete disorder. But it cannot come as a result of magical '
               'practices, nor of a natural shock, nor of a friendly understanding.')
FANON_ATTR = '-Franz Fanon, The Wretched of the Earth, 1963, p. 36'


def test_epigraph_with_dash_attribution_wraps_as_one_blockquote():
    md = FANON_QUOTE + '\n\n' + FANON_ATTR + '\n\n## Introduction\n\nBody text follows here.'
    out = _wrap_quote_blockquotes(md)
    assert '> ' + FANON_QUOTE + '\n>\n> ' + FANON_ATTR in out


def test_consecutive_epigraphs_each_wrap():
    second_q = ('Let us admit it, the settler knows perfectly well that no phraseology can be '
                'a substitute for reality.')
    second_a = '-Franz Fanon, The Wretched of the Earth, 1963, p. 45'
    md = FANON_QUOTE + '\n\n' + FANON_ATTR + '\n\n' + second_q + '\n\n' + second_a
    out = _wrap_quote_blockquotes(md)
    assert '> ' + FANON_QUOTE + '\n>\n> ' + FANON_ATTR in out
    assert '> ' + second_q + '\n>\n> ' + second_a in out


def test_dash_bullet_list_is_not_an_attribution():
    # Consecutive dash lines are a LIST — the first item carrying a year must not pull the
    # preceding paragraph into a blockquote.
    md = ('An ordinary body paragraph long enough to qualify as a quote candidate for the '
          'epigraph heuristic if the guards were loose.\n\n'
          '-First finding, reported in the 2015 survey, was inconclusive\n\n'
          '-Second finding needs no year at all\n\n'
          '-Third finding closes the list')
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_yearless_dash_line_is_not_an_attribution():
    md = ('A paragraph of prose that is long enough to qualify as an epigraph quote '
          'candidate under the length gate.\n\n'
          '-A dash line with commas, but no year or page reference anywhere')
    assert '> ' not in _wrap_quote_blockquotes(md)


# --- Heuristic B: attributed colon intro + quote-dense paragraph (case 3fbb92da) ---

NEOCLEOUS_INTRO = ("A small but important literature has begun to interrogate the promotion of "
                   "resilience as a regulatory ideal. As Mark Neocleous (2013: np) argues:")
NEOCLEOUS_QUOTE = ('Good subjects will "survive and thrive in any situation", they will '
                   '"achieve balance" across several insecure and part-time jobs, they have '
                   '"overcome life\'s hurdles" such as facing retirement without a pension to '
                   'speak of, and just "bounce back" from whatever life throws, whether it be '
                   'cut to benefits, wage freezes or global economic meltdown.')


def test_wraps_quote_dense_paragraph_after_attributed_colon_intro():
    out = _wrap_quote_blockquotes(NEOCLEOUS_INTRO + "\n\n" + NEOCLEOUS_QUOTE)
    assert '> ' + NEOCLEOUS_QUOTE in out


def test_no_wrap_quote_dense_without_colon_intro():
    md = "A previous paragraph that ends with a period.\n\n" + NEOCLEOUS_QUOTE
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_no_wrap_after_attributed_colon_when_paragraph_has_few_quotes():
    # One quoted term is scare-quoting, not a quotation — must stay a paragraph.
    para = ('Good subjects are expected to demonstrate "resilience" across several insecure '
            'and part-time jobs while facing retirement without a pension to speak of, '
            'whether it be cuts to benefits, wage freezes or global economic meltdown.')
    out = _wrap_quote_blockquotes(NEOCLEOUS_INTRO + "\n\n" + para)
    assert '> ' not in out


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


def test_bibliography_repeat_author_pair_is_not_an_epigraph():
    # f07b7fff regression: an author-first entry followed by an em-dash repeat-author entry
    # ("— Essays…") looked like quote + attribution and ate 2 references.
    md = ('Rabinow, Paul. Anthropos Today: Reflections on Modern Equipment. Princeton: '
          'Princeton University Press, 2003.\n\n'
          '— Essays on the Anthropology of Reason. Princeton: Princeton University Press, 1997.')
    assert '> ' not in _wrap_quote_blockquotes(md)


def test_trailing_period_after_terminal_citation_still_wraps():
    # Some typesetters close the quote's citation with a period AFTER the paren:
    # "…vanish from the landscape. (Lawrence, as quoted in Deloria, 1998, p. 4)."
    para = ('Lawrence argued that in order to meet the demon of the continent head on, '
            'white Americans needed either to destroy Indians or assimilate them into a '
            'white American world, both aimed at making Indians vanish from the landscape. '
            '(Lawrence, as quoted in Deloria, 1998, p. 4).')
    out = _wrap_quote_blockquotes('Intro paragraph.\n\n' + para + '\n\nNext body paragraph.')
    assert '> ' + para in out

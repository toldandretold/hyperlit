"""Guardrail: merge_hard_wrapped_lines — the typewriter-scan paragraph rejoin.

simple_md_to_html emits one <p> PER LINE (not markdown paragraph semantics);
typewriter scans (the NAM archive corpus, nam1976) OCR one SOURCE LINE per
markdown line, so every typed line rendered as its own paragraph. The merge
pre-pass rejoins blocks that demonstrably look wrapped at a typewriter margin
— and MUST NOT touch anything else. Each guard below was discovered by a real
regression-corpus failure (a naive merge broke 31 fixtures; one document's
reference extraction collapsed 89 -> 5).

The regression corpus locks this end-to-end, but the flagship typewriter
fixtures live in git-ignored fixtures-local/ — this unit test is the COMMITTED
pin for the merge behavior and every guard.
"""

# conftest puts app/Python on sys.path; the package import keeps the bare
# module name out of sys.modules (a bare import here shadowed the layout
# test's shim-resolution check).
from ingestion.markdown_and_pdf_to_html.simple_md_to_html import merge_hard_wrapped_lines


# A genuine typewriter-wrapped paragraph (shape of NAC/CONF.5/S2): uniform
# ragged-right margin ~64 chars, hyphen wrap, a sentence ending mid-paragraph.
WRAPPED = (
    "7. Non-Alignment symbolizes mankind's search for peace and\n"
    "security among nations and the determination to establish a new\n"
    "and equitable international economic, social and political order.\n"
    "It is a vital force in the struggle against imperialism in all\n"
    "its forms and manifestations, and all other forms of foreign\n"
    "domination. Non-Alignment upholds the right of all peoples to free-\n"
    "dom and self-determination of all nations to pursue their own\n"
    "independent strategy for development and for participation in the\n"
    "resolution of international problems."
)


def test_wrapped_paragraph_merges_to_one_line_with_dehyphenation():
    merged = merge_hard_wrapped_lines(WRAPPED)
    assert '\n' not in merged
    assert 'peace and security among' in merged
    # Hyphen wrap heals: "free-\ndom" -> "freedom" (lowercase-to-lowercase only).
    assert 'freedom and self-determination' in merged
    assert 'free- dom' not in merged and 'free-dom' not in merged


def test_modern_ocr_one_line_per_paragraph_is_untouched():
    md = (
        "A modern OCR paragraph arrives as one long line, however long it runs, and must pass through unchanged.\n"
        "\n"
        "So must the next one — there are no consecutive plain lines to merge.\n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_bibliography_entries_never_merge():
    # Contiguous one-line-per-entry refs: wildly varying lengths fail the
    # margin-uniformity test. Gluing these collapsed extraction (89 -> 5).
    md = (
        "Smith, J. (1990). A Short Title. Journal of Things 4(2), 1-10.\n"
        "Garcia-Lopez, M. and Chen, W. (2005). A Considerably Longer Title About Many Things. Elsevier.\n"
        "Doe, A. (2001). Brief. MIT Press.\n"
        "Nguyen, T. (2018). Another Entry Of Middling Length Here. Routledge, London and New York.\n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_poetry_short_lines_untouched():
    md = (
        "'We need to ask what it is we are against,\n"
        "what it is we are for, knowing full well\n"
        "that this we is not a foundation\n"
        "but what we are working toward.'\n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_escaped_blockquote_lines_untouched():
    # Fixture markdown carries HTML-escaped quote markers (&gt;) — Brecht's
    # verse in bedjaoui was mashed until the special-line regex learned them.
    md = (
        "&gt; What there is shall go to those who are good for it,\n"
        "&gt; Thus: the children go to the motherly, that they prosper,\n"
        "&gt; The carts to good drivers, that they are driven well,\n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_toc_page_number_lines_untouched():
    md = (
        "2. Legal Analysis of Applicant Tracking Systems in Hiring...83\n"
        "3. Predictive Analytics in College Admissions and the Law...99\n"
        "4. Automated Decision Systems in Municipal Policing Today...104\n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_lettered_enumeration_untouched():
    md = (
        "A Identifying useful metrics for research assessment today.\n"
        "B How metrics should be used in day-to-day research assessment.\n"
        "C 'Gaming' and strategic use of metrics in modern institutions.\n"
        "D International perspective on all of the practices described.\n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_markdown_hard_breaks_untouched():
    # Trailing double space = explicit markdown line break (colophons).
    md = (
        "Published in 1979 by the United Nations Educational Organization  \n"
        "7 Place de Fontenoy, 75700 Paris, in the French Republic itself  \n"
        "Printed by Presses Universitaires de France, Vendome, La France  \n"
    )
    assert merge_hard_wrapped_lines(md) == md


def test_numbered_and_bare_number_lines_open_new_units():
    # Two wrapped numbered clauses with no blank line between them: the "N."
    # opener keeps them separate paragraphs; bare-number footnote-def runs
    # ("6 Cagliari...") rely on the same rule for orphan-def recovery.
    md = (
        "8. The Non-Aligned have always considered that world conflict\n"
        "is not inevitable and that newly-independent countries have an\n"
        "important role to play in easing world tensions significantly.\n"
        "9. The Non-Aligned Movement's unfaltering support for the very\n"
        "principles of true independence and of real co-operation there\n"
        "transcends the divisions imposed by power blocs significantly.\n"
    )
    merged = merge_hard_wrapped_lines(md)
    lines = [l for l in merged.split('\n') if l.strip()]
    assert len(lines) == 2
    assert lines[0].startswith('8. ') and 'easing world tensions' in lines[0]
    assert lines[1].startswith('9. ') and 'transcends the divisions' in lines[1]


def test_footnote_defs_and_headings_stay_per_line():
    md = (
        "[^1]: A footnote definition that must stay on its own line always.\n"
        "[^2]: Another definition kept per-line for the def-section scanner.\n"
        "## A Heading Line That Must Also Never Be Merged Into Anything\n"
    )
    assert merge_hard_wrapped_lines(md) == md

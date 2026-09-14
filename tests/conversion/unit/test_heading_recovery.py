"""HEADING fidelity in PDF assembly — the two failure modes journal articles hit, both first seen
on e938f76f (Global Social Challenges Journal, a diamond-OA harvest):

  1. PHANTOM headings — Mistral's per-page `header` field is injected as a section heading when it
     doesn't look like a running head. `extract_header` is patchy (4 of 9 pages on e938f76f), and a
     journal's verso=authors / recto=short-title heads therefore surface too rarely to clear a
     repeat threshold measured against ALL pages. Result: '# More than a metaphor' and
     '# Gurminder K. Bhambra and Peter Newell' injected INTO the reference list.
     Fixes: the threshold's denominator is the header-BEARING page count, plus a front-matter rule
     that treats any header restating the article's own title/byline as chrome at any count.

  2. MISSING headings — 'Introduction', 'References', 'Conflict of interest' are bold-but-not-bigger
     in most journal layouts, so OCR emits them as plain lines (or drops them). The ones that
     survive as text are promoted back to headings at the document's own top-level section tier.

Pure functions over OCR-shaped dicts: no PDF, no network.
"""

import re

from ingestion.pdf import assembly as A
from ingestion.pdf.pdf_shared import extract_section_name


def _page(md, header=""):
    return {"markdown": md, "header": header}


def _running_headers(pages):
    """Re-derive assembly's running-header set (threshold + front-matter chrome)."""
    counts, with_header = {}, 0
    for p in pages:
        h = p.get("header") or ""
        if h.strip():
            with_header += 1
        for line in h.split("\n"):
            name = extract_section_name(line)
            if name:
                counts[name] = counts.get(name, 0) + 1
    threshold = max(2, (with_header or len(pages)) * 0.4)
    running = {n for n, c in counts.items() if c >= threshold}
    return running | A._front_matter_chrome(pages, counts.keys())


# --- 1. Phantom heading suppression ----------------------------------------------------------------

def test_running_head_is_caught_when_ocr_only_extracted_headers_on_some_pages():
    """The e938f76f shape: 9 pages, `header` populated on 4. A head on 2 of those 4 is a running
    head — under the old len(pages) denominator it scored 2 < 3.6 and got injected as a heading."""
    pages = [_page("# The Title\n\nBody.", "")] + [_page("Body.", "") for _ in range(5)] + [
        _page("Refs.", "Short Title"), _page("Refs.", "Some Author"), _page("Refs.", "Short Title"),
    ]
    assert "Short Title" in _running_headers(pages)


def test_article_title_and_byline_headers_are_chrome_at_any_count():
    """Verso/recto heads appearing ONCE each are still chrome: the short title is a prefix of the
    title heading and every author in the byline head is named on page 1."""
    front = ("# More than a metaphor: 'climate colonialism' in perspective\n\n"
             "Gurminder K. Bhambra, g.k.bhambra@sussex.ac.uk\nPeter Newell, p.j.newell@sussex.ac.uk\n")
    pages = [_page(front, "")] + [_page("Body.", "") for _ in range(4)] + [
        _page("Bhambra, G.K. (2022a) Relations of extraction…", "More than a metaphor"),
        _page("Lohmann, L. (2006) Carbon Trading…", "Gurminder K. Bhambra and Peter Newell"),
    ]
    running = _running_headers(pages)
    assert "More than a metaphor" in running
    assert "Gurminder K. Bhambra and Peter Newell" in running


def test_front_matter_rule_looks_past_a_repository_cover_sheet():
    """A Leiden/LSE/White-Rose cover sheet pushes the real front matter off page 0, so comparing a
    running head against page 0 alone found neither the title nor the byline — and the verso head
    "Sai Englert, Jamie Woodcock and Callum Cant" was injected as an h1 in mid-article (24d86fb9).
    The title page is the first page that opens with an h1."""
    cover = ("Universiteit Leiden\n\nVersion: Publisher's Version\n\n"
             "Downloaded from: https://hdl.handle.net/1887/3220824\n")
    title = ("# Digital Workerism: Technology, Platforms, and the Circulation of Workers' "
             "Struggles\n\nSai Englert*, Jamie Woodcock** and Callum Cant***\n")
    pages = [_page(cover, ""), _page(title, ""), _page("Body.", ""),
             _page("Body.", "Sai Englert, Jamie Woodcock and Callum Cant")]
    assert ("Sai Englert, Jamie Woodcock and Callum Cant"
            in A._front_matter_chrome(pages, ["Sai Englert, Jamie Woodcock and Callum Cant"]))


def test_front_matter_rule_is_skipped_on_a_contents_page():
    """A printed Contents page names every chapter; the front-matter rule must not fire there or it
    would suppress the chapter-name injections books rely on."""
    toc = "\n".join(f"Chapter About Something {n} … {n * 10}" for n in range(1, 8))
    pages = [_page(toc, "")] + [_page("Body.", "Chapter About Something 3")]
    assert A._front_matter_chrome(pages, ["Chapter About Something 3"]) == set()


def test_short_header_names_are_left_to_the_repeat_threshold():
    """'Notes' appearing inside the front matter must not be branded chrome by substring luck —
    the front-matter rule only considers names long enough to be distinctive."""
    pages = [_page("# Title\n\nNotes on method follow.", ""), _page("1. A note.", "Notes")]
    assert A._front_matter_chrome(pages, ["Notes"]) == set()


# --- 2. Missing-divider promotion ------------------------------------------------------------------

def test_plain_section_name_is_promoted_to_a_heading():
    md = "Preceding paragraph text.\n\nIntroduction\n\nThe language of colonialism is invoked…"
    out, promoted = A._promote_plain_sections(md, 2, set())
    assert promoted == ["Introduction"]
    assert "## Introduction" in out


def test_promotion_requires_a_standalone_line():
    """'Introduction' opening a sentence is prose, not a divider — blank lines both sides required."""
    md = "Introduction to the topic is deferred.\nThe argument continues here."
    out, promoted = A._promote_plain_sections(md, 2, set())
    assert promoted == []
    assert "#" not in out


def test_promotion_skips_a_divider_already_seen():
    """seen_sections is shared with header injection, so a divider can never be created twice."""
    seen = {A._norm_heading("References")}
    md = "Body.\n\nReferences\n\nAdger, N. (2006) Fairness in Adaptation…"
    out, promoted = A._promote_plain_sections(md, 2, seen)
    assert promoted == []


def test_promoted_divider_adopts_the_top_level_section_tier():
    """Sibling of the sections it divides — NOT the most common tier: a numbered hierarchy
    ('3. Sanctions' h3 → '4.1.1 …' h5) has its deepest tier as the most common, and a divider
    promoted there would sit under the subsections it should follow."""
    pages = [
        _page("# Article Title"),
        _page("### 3. Sanctions\n\n#### 4. Analysis\n\n##### 4.1 Domestic\n\n##### 4.1.1 Impact"),
        _page("##### 4.1.2 More\n\n#### 5. Wrap"),
    ]
    assert A._body_section_level(pages) == 3


def test_section_tier_ignores_a_lone_title_heading():
    """A single h1 on page 1 is the article title, not a section tier — dividers follow the h2s."""
    pages = [_page("# Title"), _page("# Stray\n\n## Section One"), _page("## Section Two")]
    assert A._body_section_level(pages) == 2


# ---------------------------------------------------------------------------
# 7fa30289 — two more ways a non-heading becomes a heading
# ---------------------------------------------------------------------------

def test_masthead_chrome_is_never_a_section_name():
    """'tripleC 1(1): 1-52, 2003' appeared on 15 of 39 header-bearing pages — a hair under the
    40% running-header bar — so it was injected mid-paragraph as '# tripleC 1(1): 1-52,' (the
    trailing-page-number strip ate the year). A citation locator / ISSN / URL is never a
    section, and neither is a name left dangling on a comma."""
    assert extract_section_name('tripleC 1(1): 1-52, 2003') is None
    assert extract_section_name('ISSN 1726-670X') is None
    assert extract_section_name('http://tripleC.uti.at') is None
    assert extract_section_name('Collectivity in scholar-led publishing | Adema and Moore') is None
    assert extract_section_name("Earl Stanhope's Logic Demonstrator, 1777") is None
    # real section names still come through, page number stripped
    assert extract_section_name('Introduction 35') == 'Introduction'
    assert extract_section_name('4. Information and Self-Organisation in Society') == \
        '4. Information and Self-Organisation in Society'


def test_list_leadin_sentence_is_demoted_to_prose():
    """A bolded sentence that introduces the list under it ('Aspects of emergence are:') is a
    lead-in, not a section: as a heading it enters the TOC as a fragment and is severed from
    the list that completes it. The same article leaves the unbolded parallel construction as
    prose, which is what the sentence was meant to be."""
    md = ('## Aspects of emergence are:\n\n'
          '- Synergism: Emergence is due to productive interaction.\n'
          '- Novelty: new qualities show up.\n')
    assert A._demote_list_leadin_headings(md).startswith('Aspects of emergence are:\n')


def test_real_headings_over_a_list_keep_their_level():
    """Gated on SENTENCE shape — a title-case heading, a numbered section, and a colon heading
    with no list under it all stay headings."""
    keep = [
        '## Key Findings and Limits:\n\n- one thing\n- another thing\n',
        '## 3.1 Materials and Methods:\n\n- a reagent\n- another\n',
        '## Aspects of emergence are:\n\nEmergence is due to productive interaction.\n',
        '## Results:\n\n- one\n- two\n',                      # too few words to be a sentence
    ]
    for md in keep:
        assert A._demote_list_leadin_headings(md) == md


# ---------------------------------------------------------------------------
# Heading LEVELS follow the section NUMBERS (7fa30289)
# ---------------------------------------------------------------------------

def test_numbered_siblings_are_levelled_together_and_subsections_nest():
    """Mistral levels a heading by how big the type looked on its page, so siblings drift: the
    Fuchs article's ten top-level sections alternated h1/h2 ('5. Co-action' ended up ABOVE
    '6. Self-organization'), and 8.1-8.4 sat at the SAME level as their own parent 8 while 8.5
    became h3. The number is unambiguous structure, so it decides."""
    md = ('# Co-Operation and Self-Organization\n\n'
          '# 1. Introduction\n\n## 2. General Aspects\n\n# 3. Physical Co-operation\n\n'
          '## 8. From Competition\n\n## 8.1 Towards a Co-operative Ecology\n\n'
          '### 8.2 Towards a Co-operative Technology\n\n## Footnotes\n')
    out, relevelled = A._level_numbered_headings(md)
    levels = dict((t, len(h)) for h, t in re.findall(r'(?m)^(#{1,6})[ \t]+(.+)$', out))
    assert levels['Co-Operation and Self-Organization'] == 1   # unnumbered title untouched
    assert levels['Footnotes'] == 1 or levels['Footnotes'] == 2  # unnumbered, not re-levelled
    assert levels['1. Introduction'] == 2
    assert levels['2. General Aspects'] == 2
    assert levels['3. Physical Co-operation'] == 2
    assert levels['8. From Competition'] == 2
    assert levels['8.1 Towards a Co-operative Ecology'] == 3
    assert levels['8.2 Towards a Co-operative Technology'] == 3
    assert relevelled != []


def test_emphasis_wrapped_section_numbers_are_seen():
    """Mistral wraps a heading it read as bold type ('## **4. Analysis of the Impacts**'), and
    the markers hid the number — d4c0b31e's section 4 family stayed spread over h3/h4/h5 while
    sections 1-3 sat at h2."""
    assert A._numbered_heading_depth('**4. Analysis of the Impacts**') == 1
    assert A._numbered_heading_depth('*4.1 Domestic Influences*') == 2
    md = ('## 1. Introduction\n\n## 2. Ukraine Crisis\n\n## 3. Sanctions\n\n'
          '#### **4. Analysis of the Impacts**\n\n##### *4.1 Domestic Influences*\n\n'
          '##### **4.1.1 Economy**\n')
    out, _ = A._level_numbered_headings(md)
    assert '## **4. Analysis of the Impacts**' in out
    assert '### *4.1 Domestic Influences*' in out
    assert '#### **4.1.1 Economy**' in out


def test_multi_regime_outline_is_left_alone():
    """Roman chapters over lettered sections over Arabic subsections (1ee13ed9): the Arabic tier
    is the DEEPEST one, so levelling it at its own majority would hoist real subsections up
    beside the chapters. Only the regimes this pass cannot read carry the placing evidence — so
    it declines rather than guesses."""
    md = ('# I. BACKGROUND\n\n## A. RATIONALES\n\n## II. METHODS\n\n### C. DATA SOURCES\n\n'
          '## 1. OVERALL RESULTS\n\n### 2. RESULTS OVER TIME\n\n## 3. DISCUSSION\n')
    out, relevelled = A._level_numbered_headings(md)
    assert out == md and relevelled == []


def test_a_year_or_a_lone_number_is_not_a_section_number():
    """A single-part number needs a '.' or ')' separator, so a year-opening title stays prose-
    levelled; and fewer than three top-level numbered headings means no outline to trust."""
    assert A._numbered_heading_depth('1984 and the Surveillance State') is None
    assert A._numbered_heading_depth('2. Methods') == 1
    md = '# Title\n\n## 1. Only One Numbered Heading\n\n## Discussion\n\n## References\n'
    out, relevelled = A._level_numbered_headings(md)
    assert out == md and relevelled == []


def test_bare_number_top_level_needs_corroboration_from_a_dotted_child():
    """'2 Background and Related Work' numbers a section with no separator at all. One such
    heading is unknowable ('5 Reasons to Switch' is a title), but a bare number that ALSO opens a
    dotted heading ('2.1 CS Functions') is that heading's parent — two corroborations settle it
    for the document. Without this 1313c1a2 pinned '2.1' level-with its own parent '2'."""
    assert A._bare_number_tops(['2 Background', '2.1 CS Functions', '3 Problem', '3.1 Definitions'])
    # no dotted children to corroborate → a bare number stays prose-numbered
    assert not A._bare_number_tops(['5 Reasons to Switch', '7 Habits', '1 Big Idea'])
    # one corroboration is not enough
    assert not A._bare_number_tops(['2 Background', '2.1 CS Functions', '9 Other'])

    md = ('# Title\n\n# 1 Introduction\n\n## 2 Background\n\n### 2.1 CS Functions\n\n'
          '### 2.2 Bilingualism\n\n# 3 Problem Formulation\n\n# 3.1 Definitions\n')
    out, _ = A._level_numbered_headings(md)
    levels = dict((t, len(h)) for h, t in re.findall(r'(?m)^(#{1,6})[ \t]+(.+)$', out))
    assert levels['1 Introduction'] == levels['2 Background'] == levels['3 Problem Formulation']
    assert levels['2.1 CS Functions'] == levels['2.2 Bilingualism'] == levels['3.1 Definitions']
    assert levels['2.1 CS Functions'] == levels['2 Background'] + 1


def test_a_missing_parent_tier_still_leaves_room_for_it():
    """OCR dropped every top-level heading and left only subsections (1313c1a2). They are still
    siblings and must be levelled TOGETHER — and never at h1, because something contains them
    (the title, plus the parent section the OCR lost)."""
    md = ('# Title\n\n### 2.1 CS Functions\n\n## 2.2 Bilingualism\n\n# 3.1 Definitions\n')
    out, _ = A._level_numbered_headings(md)
    got = re.findall(r'(?m)^(#+)[ \t]+\d', out)
    assert len(set(got)) == 1                       # one tier, not three
    assert len(got[0]) >= 2                         # depth-2 headings are never h1
    assert len(got) == 3

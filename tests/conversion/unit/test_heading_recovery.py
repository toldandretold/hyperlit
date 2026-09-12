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

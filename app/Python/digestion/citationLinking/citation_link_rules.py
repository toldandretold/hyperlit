"""Citation linking as an ordered `LinkRule` registry (Decomposition C of the LINKING-layer
modularisation). `link_citations` was a ~380-line monolith; here it is a `CitationLinkContext`
threaded through `CITATION_LINK_RULES`:

    PreLinkedAnchorConverter  →  CitationPatternGate  →  ParenthesizedCitationLinker
        →  SquareBracketCitationLinker  →  AssessmentRecorder

The modus operandi is unchanged: a citation only links when a generated ref-key actually matches a
bibliography entry (with a bounded ±3yr fuzzy-year fallback) — otherwise it is left as plain text.
The paren and bracket scans share byte-identical per-text-node logic, so that logic lives once in
`_link_citations_in_text_node`; the two rules differ only in the bracket regex/delimiters and the
fact that the paren scan emits scan progress. Both scans are gated behind the parenthesized-pattern
pre-check (the known [Author YEAR]-only limitation is recorded by `AssessmentRecorder`).

A new citation-shape variant is absorbed by ADDING a rule to `CITATION_LINK_RULES`, never by editing
the scan. See `link_base.py` for the abstraction.
"""
import re

from bs4 import NavigableString

from shared.assessment import ASSESSMENT

# A "reading-list" / footnote-cited source has only a handful of "references" but MANY bracketed-year
# candidates, NONE of which link — they're bare years / prose numbers, not an author-date bibliography.
# This is a pure COUNTING signal (format-independent), so it lives once here and is reused by the audit.
# A 0/N citation "miss" under this signature is a CONFIDENT non-action, not a suspicion to chase — and it
# is SAFE: a real bibliography has many refs, so it is never suppressed (a genuine link failure still flags).
_READING_LIST_MAX_REFS = 2
_READING_LIST_MIN_CITATIONS = 20


def looks_like_reading_list(references_found, citations_total, citations_linked):
    return (int(references_found or 0) <= _READING_LIST_MAX_REFS
            and int(citations_total or 0) >= _READING_LIST_MIN_CITATIONS
            and int(citations_linked or 0) == 0)


# Human-readable `plain` note for the citation-linking tree node (one source — node_help + generator + LLM).
# Flag-not-verdict framing (README §0): we do NOT decide "is this really a citation" — we report raw facts
# and raise a SUSPICION for a human / the vibe loop to check.
_CITATION_PLAIN = (
    "Turn each in-text \"(Author Year)\" into a clickable link to its bibliography entry. Links only when a "
    "matching entry was extracted. We do NOT judge whether each bracketed year is 'really' a citation — if "
    "a bibliography exists but none of the bracketed-year candidates link to it, that is a SUSPICION worth "
    "checking (missing references upstream, OR they were prose-year parentheticals), not a proven bug. "
    "Both (Author YEAR) parentheses AND [Author YEAR] square brackets are recognised; numeric [N] STEM "
    "cites are handled separately in the PDF path (wrap_stem_citations). Numbered (N)/[N] cites are only "
    "linked against an ordinal-numbered bibliography, and a numbered LIST in prose — \"(1) x, (2) y, "
    "(3) z\" — is recognised as an enumeration and left alone. A parenthesised YEAR RANGE — \"(2014-2019)\", "
    "\"(1646–1716)\" — is a date span, not a citation, and is left alone too. Where one author is cited "
    "for several works at once — \"(Modi, 2019, 2023)\" — each year resolves to its OWN entry.")
from shared.link_base import LinkRule, run_link_rules
from shared.refkeys import (HISTORICAL_YEAR_MIN, _NAME_TOKEN_RE, _NON_SURNAME_WORDS,
                           generate_ref_keys, trailing_author_candidates)


class CitationLinkContext:
    """Shared state threaded through the citation-linking rules — the same locals the monolith
    carried (the accumulators, the skip gate, the anchor counts)."""

    def __init__(self, soup, bibliography_map, emit_progress=None):
        self.soup = soup
        self.bibliography_map = bibliography_map
        self.emit_progress = emit_progress if callable(emit_progress) else (lambda *a, **k: None)
        self.citation_candidates = 0   # every "(…YYYY…)" candidate scanned (== citations_found; kept for clarity)
        self.citations_found = 0       # every candidate counted (drives citations_total)
        self.citations_linked = 0
        self.citations_unlinked = []
        self.anchor_converted = 0
        self.anchor_unmatched = 0
        self.skip_citation_scan = False
        self.skip_reason = None
        self.enumerations_skipped = 0   # numbered groups left alone as prose lists, not citations
        self.year_ranges_skipped = 0    # "(2014-2019)" date spans left alone, not citations
        self.antecedent_links = 0       # linked only via the NON-ADJACENT author walk-back
        self.antecedent_sample = []     # (citation, key) — the heuristic's own audit trail
        self.ambiguous_links = 0        # walk-back links where >1 entry fit (data-candidates emitted)
        self.enum_cache = {}            # id(<p>) -> enumeration numbers (per-paragraph, computed once)
        self._bib_region = None         # lazy: id()s of <p> inside the reference list

    def bibliography_region(self):
        """id()s of the `<p>` elements that sit INSIDE the reference list — the paragraphs carrying a
        `bib-entry` anchor, PLUS any short gap of un-extracted entries wedged between two of them.

        Every linker guards with `p.find('a', class_='bib-entry')`, which only recognises references the
        extractor actually captured. An entry it MISSED (institutional author, title-first — 2c0544c4's
        "7. Transforming Our World … (United Nations General Assembly, 2015).") stays an ordinary `<p>`
        in the middle of the reference list, and the author-year scan then "links" that publication year
        to an unrelated entry via the fuzzy-year fallback. Sandwiching is the positional tell: a stray
        paragraph between two real bib entries is a reference, not prose. The gap cap is what keeps a
        document whose references sit MID-body from swallowing the whole text."""
        if self._bib_region is None:
            paras = self.soup.find_all('p')
            marked = [i for i, p in enumerate(paras) if p.find('a', class_='bib-entry')]
            region = set()
            for a, b in zip(marked, marked[1:]):
                if b - a - 1 <= _BIB_REGION_MAX_GAP:
                    region.update(id(paras[i]) for i in range(a + 1, b))
            self._bib_region = region
        return self._bib_region


# How many consecutive un-extracted paragraphs may sit between two bibliography entries and still
# count as part of the reference list. Small on purpose — a long run of prose between two bib
# anchors means the anchors are NOT one contiguous list, and nothing in between is a reference.
_BIB_REGION_MAX_GAP = 3


# A block that IS a bibliography entry the extractor never keyed ("Huntley, A. C. (1995). …",
# "Shum, S. B. and Sumner, T. (2001). …"): author-first opener + its year in the first line. The
# antecedent walk-back must not fire inside one — the "antecedent" is the entry's OWN author, so the
# entry links to itself in the reference list (3f202e8f, whose reference paragraphs the
# bibliography-region detector does not cover because the OCR glued several entries into one).
_ENTRY_OPENER_RE = re.compile(r"^\s*([A-ZÀ-Þ][A-Za-zÀ-ÿ'\u2019-]+),\s*(?:[A-Z]\.|[A-Z][a-zà-ÿ]+)")
_ENTRY_EARLY_YEAR_RE = re.compile(r"\(?(?:1[5-9]\d\d|20\d\d)[a-z]?\)?")


# Words a bare-year CITATION may contain besides its locator numbers: scholarly apparatus, nothing
# else. The walk-back resolves author-less parentheticals, and a PROSE parenthetical is exactly the
# same shape to a year-matching regex — "(which he had founded in late 1985)" linked to Stallman's
# 1985 entry because "Stallman" was the nearest name (f07b7fff). Any other word ⇒ it is prose, and
# prose gets no link (a wrong link is worse than a missing one). Roman-numeral pages are locators.
_CITE_LOCATOR_WORDS = frozenset("""
see also cf eg ie and forthcoming press chapter chap ch p pp page pages vol vols no nos fig figs
figure table tab section sec para paras passim emphasis added original mine trans transl repr orig
ed eds esp quoted cited note notes n nd ff sq id ibid
""".split())
_ROMAN_ONLY_RE = re.compile(r'^[ivxlcdm]+$')


# ---------------------------------------------------------------------------------------------
# YEAR RANGES are date spans, not citations.
# ---------------------------------------------------------------------------------------------
# "in Modi's first term (2014-2019), it intensified in its second term (2019-2024)" carries no
# citation at all — but to a year-matching regex each parenthesis is a perfect "(…YYYY…)" candidate,
# and the author's name sits right in front of it ("Modi's"), so key generation happily keyed
# modi2019 and minted TWO phantom links (book_1789025680384, found while human-adjudicating the
# citation-review study). A phantom link is the expensive kind of wrong: the citation review then
# pairs a claim with a source the author never cited (study claim chacko-2025-conspiracy/c130 was
# reviewed against Modi's Swachh Bharat speech purely via one of these anchors) and the hypercite
# graph grows an edge that does not exist.
#
# The tell is positional, not lexical: a year that has ANOTHER year and a dash on one side of it is
# one endpoint of a span. That is true whichever side it sits on, for hyphen / en dash / em dash /
# minus, and for the abbreviated tail form ("2014-19"). A LETTER-SUFFIXED year ("2024a") is a
# disambiguation marker and can never be a range endpoint, so it is exempt — which is what keeps
# "(Modi, 2024a, 2024b)" linking.
#
# A page or locator range is unaffected because BOTH endpoints must be year-shaped: "(Nord et al.,
# 2024: 24–25)" and "(Anderson and Clibbens, 2018: 1761–1764)" still link on their real year.
# The possessive ("Modi's") is deliberately NOT disqualified as an antecedent author — "Chacko's
# (2018) argument" is an ordinary narrative citation and killing the possessive would cost those.
_RANGE_DASH = r'[-‐‑‒–—―−]'
_YEAR_SHAPE = r'(?:1[5-9]\d\d|20\d\d)'
_YEAR_TOKEN_RE = re.compile(r'\d{4}[a-z]?')
_BARE_YEAR_RE = re.compile(r'\d{4}')
_RANGE_LEFT_RE = re.compile(r'(?<!\d)' + _YEAR_SHAPE + r'\s*' + _RANGE_DASH + r'\s*$')
_RANGE_RIGHT_RE = re.compile(r'^\s*' + _RANGE_DASH + r'\s*(?:' + _YEAR_SHAPE + r'|\d{2})(?!\d)')

# "Modi, 2019, 2023" — ONE author, several years, each naming a different work. `generate_ref_keys`
# reads such a citation as a single reference and takes its LAST plausible year (2023), while the
# linker paints the anchor over the FIRST one (2019) — so BOTH years pointed at the 2023 entry and
# the genuine Modi 2019 citation was never reviewed. Key generation must therefore see only the
# citation up TO the year being linked; the trailing years are already re-keyed one at a time by the
# extra-year loop below. Matches only a year directly followed by a comma and another year, so
# "(Author, 2018: 1761–1764)" and "(Marx [1867] 1976)" are untouched.
# (no `^`: this is used as `Pattern.match(text, pos)`, which anchors at `pos` — `^` would not.)
_MULTI_YEAR_TAIL_RE = re.compile(r'\s*,\s*' + _YEAR_SHAPE + r'[a-z]?(?![\w-])')


def _is_year_range_half(text, match):
    """True when the year token at `match` is one endpoint of a YEAR–YEAR span rather than a
    citation year."""
    token = match.group(0)
    if not token.isdigit():
        return False
    if not 1500 <= int(token) <= 2099:
        return False
    if _RANGE_LEFT_RE.search(text[:match.start()]):
        return True
    return bool(_RANGE_RIGHT_RE.match(text[match.end():]))


def _linkable_year(sub_cite):
    """The year token this sub-citation should resolve and anchor on — the first one that is not
    half of a year range. `None` when the sub-citation has no year, or when every year in it is a
    range endpoint (i.e. it is a date span, not a citation)."""
    for m in _YEAR_TOKEN_RE.finditer(sub_cite):
        if not _is_year_range_half(sub_cite, m):
            return m
    return None


def _is_locator_only(sub_cite):
    words = re.findall(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.]*", sub_cite or '')
    if len(words) > 4:
        return False
    for w in words:
        key = w.lower().strip('.')
        if key in _CITE_LOCATOR_WORDS or _ROMAN_ONLY_RE.match(key):
            continue
        return False
    return True


def _looks_like_a_reference_entry(block_text):
    t = (block_text or '').strip()
    m = _ENTRY_OPENER_RE.match(t)
    if not m or m.group(1) in _NON_SURNAME_WORDS:
        return False                    # "Similarly, Lévy anticipated…" is prose, not an entry
    return _ENTRY_EARLY_YEAR_RE.search(t[:160]) is not None


def _in_bibliography(ctx, text_node):
    """True when this text node lives in a reference-list paragraph (extracted entry or a gap entry
    the extractor missed). Text with no `<p>` parent at all is NOT excluded — the scans have always
    covered headings/list items/table cells."""
    p = text_node.find_parent('p')
    if p is None:
        return False
    return bool(p.find('a', class_='bib-entry')) or id(p) in ctx.bibliography_region()


def _link_citations_in_text_node(ctx, text_node, pattern, open_delim, close_delim):
    """Link every `pattern`-delimited in-text citation inside one text node (the body shared by the
    parenthesized and square-bracket scans — only `pattern`/delimiters differ). Mutates the soup and
    the ctx accumulators in place."""
    soup = ctx.soup
    bibliography_map = ctx.bibliography_map
    if not _in_bibliography(ctx, text_node):
        text = str(text_node)
        matches = list(re.finditer(pattern, text))
        if matches:
            new_content = []
            last_index = 0

            def _emit_trailing_years(remaining, author_part, preceding_text):
                """Comma-separated additional years after the one already emitted ("2010a, 2010b",
                "Merton 1968, 1988"). Each names a DIFFERENT work by the same author, so each is
                re-keyed on its own — and this runs whether or not the FIRST year resolved: an
                unlinkable 1968 must not take the linkable 1988 down with it (it used to, because
                this loop lived inside the first year's success branch — so the only reason the
                1988 link existed was the wrong 1968 one carrying it)."""
                while remaining:
                    extra_year = re.match(r'([\s,]+)(\d{4}[a-z]?)', remaining)
                    if not extra_year:
                        new_content.append(NavigableString(remaining))
                        return
                    separator = extra_year.group(1)
                    extra_year_str = extra_year.group(2)
                    rest = remaining[extra_year.end(0):]
                    # …but not the opening half of a span: "(Smith, 2001, 1990-1994)". (The closing
                    # half is unreachable here — the separator class holds no dash.)
                    if _RANGE_RIGHT_RE.match(rest):
                        ctx.year_ranges_skipped += 1
                        new_content.append(NavigableString(separator + extra_year_str))
                        remaining = rest
                        continue
                    extra_keys = generate_ref_keys(author_part + extra_year_str,
                                                   context_text=preceding_text,
                                                   min_year=HISTORICAL_YEAR_MIN)
                    extra_linked = False
                    for ek in extra_keys:
                        if ek in bibliography_map:
                            new_content.append(NavigableString(separator))
                            ea_tag = soup.new_tag("a", href=f"#{bibliography_map[ek]}")
                            ea_tag['class'] = 'in-text-citation'
                            ea_tag.string = extra_year_str
                            new_content.append(ea_tag)
                            extra_linked = True
                            ctx.citations_found += 1
                            ctx.citations_linked += 1
                            break
                    if not extra_linked:
                        new_content.append(NavigableString(separator + extra_year_str))
                    remaining = rest

            for match in matches:
                preceding_text = text[last_index : match.start()]
                new_content.append(NavigableString(preceding_text))
                citation_block = match.group(1)
                new_content.append(NavigableString(open_delim))
                sub_citations = re.split(r";\s*", citation_block)
                # Further split comma-separated citations: "Author1, 2020, Author2, 2021"
                refined = []
                for _sub in sub_citations:
                    _years = list(re.finditer(r'\d{4}[a-z]?', _sub))
                    if len(_years) > 1:
                        parts = re.split(r',\s*(?=[A-Z])', _sub)
                        for part in parts:
                            if re.search(r'\d{4}', part):
                                refined.append(part.strip())
                            elif refined:
                                refined[-1] += ', ' + part.strip()
                    else:
                        refined.append(_sub.strip())
                sub_citations = refined
                for i, sub_cite_raw in enumerate(sub_citations):
                    sub_cite = sub_cite_raw.strip()
                    if not sub_cite: continue
                    # A DATE SPAN is not a citation candidate at all. Every year in "(2014-2019)" is
                    # a range endpoint, so there is nothing here to resolve — leave the text alone
                    # and do not count it (same contract as the numbered-enumeration guard).
                    link_year = _linkable_year(sub_cite)
                    if link_year is None and _YEAR_TOKEN_RE.search(sub_cite):
                        ctx.year_ranges_skipped += 1
                        new_content.append(NavigableString(sub_cite))
                        if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                        continue
                    # Count every "(…YYYY…)" candidate: some are author-year, some bare year, some
                    # STEM/journal refs — all technically citations, all kept and link-attempted. We do NOT
                    # classify which "really" are citations; the assessment reports raw facts and raises a
                    # SUSPICION (bib present + 0 linked) for a human / the vibe loop to check (README §0).
                    ctx.citation_candidates += 1
                    ctx.citations_found += 1
                    context_for_keys = preceding_text
                    if not re.search(r'[A-Z]', preceding_text):
                        # Author name may be in a preceding sibling element (e.g. <em>Author</em> (Year))
                        sibling_texts = []
                        for sibling in text_node.previous_siblings:
                            if hasattr(sibling, 'get_text'):
                                sibling_texts.append(sibling.get_text())
                            elif isinstance(sibling, str):
                                sibling_texts.append(str(sibling))
                        if sibling_texts:
                            context_for_keys = ''.join(reversed(sibling_texts)) + preceding_text
                    # An in-text citation is a few words long, so the historical floor is safe here in a
                    # way it is not for a long bibliography entry — see HISTORICAL_YEAR_MIN.
                    # A MULTI-YEAR list ("Modi, 2019, 2023") is keyed on the year being anchored, not
                    # on the last year in the group — see _MULTI_YEAR_TAIL_RE.
                    _is_year_list = bool(link_year is not None
                                         and _MULTI_YEAR_TAIL_RE.match(sub_cite, link_year.end()))
                    # Key generation takes the LAST plausible year it can see, so anything
                    # year-shaped sitting after the real one steals the key. Cut the citation at
                    # the year actually being anchored when what follows is either another work's
                    # year (the list above) or a SPAN — "(Smith, 2001: 1990-1994)" is a page range,
                    # and keying it smith1994 lost the link entirely.
                    _trailing_span = bool(link_year is not None and any(
                        _is_year_range_half(sub_cite, m)
                        for m in _YEAR_TOKEN_RE.finditer(sub_cite, link_year.end())))
                    keys_text = (sub_cite[:link_year.end()]
                                 if (_is_year_list or _trailing_span) else sub_cite)
                    keys = generate_ref_keys(keys_text, context_text=context_for_keys,
                                             min_year=HISTORICAL_YEAR_MIN)
                    # LAST RESORT — the author is not adjacent to the year. Academic prose separates
                    # them constantly: "Similarly, Lévy anticipated … 'quote' argues the philosopher
                    # (2002: 33)", or the authors open the sentence with the quotation in between
                    # ("Häyhtio and Rinne consider that '…' (2008: 26)"). Key generation can only see
                    # the words immediately before the paren, so those citations produced no usable
                    # key at all (46c0fbb5). Walk back through the paragraph for name-shaped tokens,
                    # NEAREST first, and let the BIBLIOGRAPHY decide: a candidate is only tried as
                    # <surname><year>, so a name that isn't a cited author resolves to nothing.
                    # …but ONLY for a citation that names no author of its own. "(Vanobbergen, 2007)"
                    # whose entry is missing must stay unlinked: walking back found "Castells" and
                    # linked Vanobbergen's citation to Castells' entry — a confident wrong link, which
                    # is worse than the miss. A bare year (optionally + page locator) is the only
                    # shape whose author legitimately lives in the surrounding prose.
                    # …and never inside a BIBLIOGRAPHY ENTRY: "Ostrom, E. (1990)." is the entry
                    # itself, and walking back finds its own author, so the entry would link to
                    # itself in the reference list.
                    # The entry's id lives on an ANCHOR inside the paragraph
                    # (`<p><a class="bib-entry" id="huntley1995"></a>Huntley, A. C. (1995)…`), so the
                    # guard has to look at the block, not just at ancestors' classes.
                    _blk = (text_node.find_parent(['p', 'li', 'div', 'td', 'section'])
                            if getattr(text_node, 'find_parent', None) else None)
                    _in_bib_entry = bool(
                        _blk is not None
                        and ('bib-entry' in (_blk.get('class') or [])
                             or _blk.find(class_='bib-entry') is not None
                             or _looks_like_a_reference_entry(_blk.get_text(' ', strip=True))))
                    _antecedent_keys = set()
                    _ambiguous_targets = []       # ≥2 distinct entries fit — emitted as evidence
                    if (not any(k in bibliography_map for k in keys)
                            and not _NAME_TOKEN_RE.search(sub_cite)
                            and _is_locator_only(sub_cite)
                            and not _in_bib_entry):
                        _year = link_year
                        if _year:
                            # A SELF-LINK guard for the walk-back: the block this citation sits in
                            # may BE the entry it would resolve to. Journal styles that print their
                            # references as numbered notes (9bb2f3aa) put "Bell, S (2008), …" inside
                            # the note itself, and the nearest antecedent name is then the entry's
                            # own author.
                            _blk_ids = set()
                            if _blk is not None:
                                if _blk.get('id'):
                                    _blk_ids.add(_blk.get('id'))
                                _blk_ids.update(e.get('id') for e in _blk.find_all(attrs={'id': True}))
                            # Every name the walk-back could mean, nearest first — including the
                            # LETTER-SUFFIXED siblings of each candidate: a bare "(2009)" cannot
                            # choose between infoadex2009a and infoadex2009b, so both are targets.
                            _seen_targets = set()
                            _yr = _year.group(0)
                            _sfx = '' if _yr[-1].isalpha() else 'abcdef'
                            for c in trailing_author_candidates(context_for_keys):
                                for k in [c + _yr] + [c + _yr + x for x in _sfx]:
                                    tgt = bibliography_map.get(k)
                                    if tgt is None or tgt in _blk_ids or tgt in _seen_targets:
                                        continue
                                    _seen_targets.add(tgt)
                                    _ambiguous_targets.append(tgt)
                                    _antecedent_keys.add(k)
                            # The GUESS the pipeline is allowed to act on is the nearest name; the
                            # rest are not discarded — they ride along as data-candidates so a
                            # human can be ASKED instead of silently overruled. Only the first key
                            # joins the resolution list.
                            if _ambiguous_targets:
                                _first = next(k for k in _antecedent_keys
                                              if bibliography_map[k] == _ambiguous_targets[0])
                                keys = keys + [_first]
                                _antecedent_keys = {_first}
                    linked = False
                    for key in keys:
                        if key in bibliography_map:
                            if key in _antecedent_keys:
                                ctx.antecedent_links += 1
                                if len(ctx.antecedent_sample) < 8:
                                    ctx.antecedent_sample.append(
                                        {'citation': sub_cite[:60], 'key': key})
                            year_match = link_year
                            if year_match:
                                author_part = sub_cite[:year_match.start(0)]
                                year_part = year_match.group(0)
                                trailing_part = sub_cite[year_match.end(0):]
                                if author_part:
                                    new_content.append(NavigableString(author_part))
                                a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                a_tag['class'] = 'in-text-citation'
                                if key in _antecedent_keys:
                                    # PROVENANCE. This link is the one resolution in the pipeline that
                                    # GUESSES: the author was not in the parentheses, so the nearest
                                    # preceding name in the paragraph was used. Marking it in the
                                    # stored HTML is what makes a corpus-scale audit possible later
                                    # (`php artisan citations:audit-antecedent`) — the assessment's
                                    # 8-entry sample only covers the book in front of you, and the
                                    # artifact dir may be long gone.
                                    #
                                    # And when MORE THAN ONE entry fits, the guess is stored AS A
                                    # QUESTION: data-resolved="ambiguous" + the ranked candidate ids
                                    # in data-candidates. The link still points at the best one (a
                                    # probably-right link beats a dead year), but downstream — the
                                    # maintainer console, the reader — can present the alternatives
                                    # and record a human answer instead of trusting the pick.
                                    if len(_ambiguous_targets) > 1:
                                        a_tag['data-resolved'] = 'ambiguous'
                                        a_tag['data-candidates'] = '|'.join(_ambiguous_targets[:4])
                                        ctx.ambiguous_links += 1
                                    else:
                                        a_tag['data-resolved'] = 'antecedent'
                                a_tag.string = year_part
                                new_content.append(a_tag)
                                if trailing_part:
                                    _emit_trailing_years(trailing_part, author_part, preceding_text)
                            else:
                                a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                a_tag['class'] = 'in-text-citation'
                                a_tag.string = sub_cite
                                new_content.append(a_tag)

                            linked = True
                            ctx.citations_linked += 1
                            break
                    # Fuzzy year fallback: try ±1, ±2, ±3 year variants for OCR year errors
                    if not linked and keys:
                        # Anchored at the year the resolution used, so the fallback can never paint
                        # a link over a range endpoint the guard above just refused.
                        year_in_cite = (_BARE_YEAR_RE.match(sub_cite, link_year.start())
                                        if link_year is not None else None)
                        if year_in_cite:
                            orig_year = year_in_cite.group(0)
                            for offset in [1, -1, 2, -2, 3, -3]:
                                if linked: break
                                alt_year = str(int(orig_year) + offset)
                                for key in keys:
                                    alt_key = key.replace(orig_year, alt_year)
                                    if alt_key in bibliography_map:
                                        author_part = sub_cite[:year_in_cite.start(0)]
                                        year_part = year_in_cite.group(0)
                                        trailing_part = sub_cite[year_in_cite.end(0):]
                                        if author_part:
                                            new_content.append(NavigableString(author_part))
                                        a_tag = soup.new_tag("a", href=f"#{bibliography_map[alt_key]}")
                                        a_tag['class'] = 'in-text-citation'
                                        a_tag.string = year_part
                                        new_content.append(a_tag)
                                        if trailing_part:
                                            _emit_trailing_years(trailing_part, author_part,
                                                                 preceding_text)
                                        linked = True
                                        ctx.citations_linked += 1
                                        break
                    if not linked:
                        if _is_year_list:
                            # Only the FIRST year failed; the rest of the list still gets its own
                            # shot ("(Merton 1968, 1988)" — no merton1968 entry, but merton1988 is
                            # right there).
                            new_content.append(NavigableString(sub_cite[:link_year.end()]))
                            _emit_trailing_years(sub_cite[link_year.end():],
                                                 sub_cite[:link_year.start()], preceding_text)
                        else:
                            new_content.append(NavigableString(sub_cite))
                        ctx.citations_unlinked.append({"citation": sub_cite, "generated_keys": keys})
                    if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                new_content.append(NavigableString(close_delim))
                last_index = match.end()
            new_content.append(NavigableString(text[last_index:]))
            text_node.replace_with(*new_content)


# Elements that can BE a single bibliography entry (the thing a publisher's biblioref points at).
_ENTRY_TAGS = ('p', 'li', 'dd', 'div')


def _entry_id_for_dom_anchor(id_index, anchor_id):
    """Resolve a publisher's in-text anchor (`href="#index_CIT0061"`) to OUR bibliography entry id,
    by asking the DOM what that id actually points at.

    Takes a PREBUILT `{id: element}` index, not the soup: one real book carries 84,499 internal
    anchors over a 245,329-element tree, and a `soup.find(id=…)` per anchor is a full document walk
    each time — that alone blew the conversion's 300s budget.

    A real publisher EPUB/HTML arrives already linked — every citation is an
    `<a epub:type="biblioref" href="#index_CIT0061">1974a</a>` aimed at `<p id="index_CIT0061">` in
    the reference list. That is the strongest citation evidence there is (the publisher's own
    typesetting, immune to every author-year ambiguity our key generator has to guess at), and it
    was thrown away: the converter only looked the href up in `bibliography_map`, which is keyed by
    GENERATED author-year keys, so a publisher id matched nothing. PASS 1A has already stamped
    `<a class="bib-entry" id="unga1974a">` into that very paragraph, so the mapping is sitting in
    the DOM — read it instead of demanding the publisher had guessed our key scheme.

    Deliberately narrow: the id must land ON a bibliography entry (or on a marker inside one),
    NOT on a section wrapper — otherwise a link to "#references" would resolve to whichever entry
    happened to be first. Returns None when the target is not a reference entry, which leaves the
    anchor untouched and counted as unmatched.
    """
    el = id_index.get(anchor_id)
    if el is None or not getattr(el, 'name', None):
        return None
    if el.name == 'a' and 'bib-entry' in (el.get('class') or []):
        return el.get('id')
    # The id sits on the entry itself, or on an empty marker anchor just inside it. Climb at most
    # two levels so a container further up can never stand in for one of its entries.
    candidates = [el] + [p for p in el.parents if getattr(p, 'name', None) in _ENTRY_TAGS][:2]
    for cand in candidates:
        if cand.name not in _ENTRY_TAGS:
            continue
        bib = cand.find('a', class_='bib-entry')
        if bib is not None and bib.get('id'):
            return bib.get('id')
    return None


class PreLinkedAnchorConverter(LinkRule):
    """2A-pre: convert existing links that point at a bibliography entry into in-text citations
    (skipping anchors already classed citation/bib-entry/footnote, hrefs that name no fragment, and
    anchors inside bibliography paragraphs). The href is matched against the generated key map
    FIRST, then resolved through the DOM — see `_entry_id_for_dom_anchor` for why the second lookup
    is the one that matters on a publisher's own file.

    A fragment counts whether it arrives bare (`#bib24`) or inside a self-referential absolute URL
    (`https://elifesciences.org/articles/60080#bib24`) — see `_target_fragment`. Both are the
    publisher's own typesetting and are the strongest citation evidence available; the resolution
    step, not the URL's shape, is what keeps genuine outbound links out."""

    name = 'pre_linked_anchor_converter'
    description = 'Convert existing #id anchors into in-text-citation links.'

    @staticmethod
    def _target_fragment(href):
        """The in-document id an href targets, or None if it does not name one.

        Accepts a bare `#id` and a fully-qualified URL carrying a fragment (`https://host/path#id`),
        because a publisher's own page routinely links its citations back into itself absolutely.
        Returns None for an href with no fragment, an empty fragment, or a fragment that cannot be
        an id — those are ordinary navigation and must be left alone.

        This only narrows the CANDIDATE set; whether the id really names a reference entry is
        decided afterwards by `bibliography_map` / `_entry_id_for_dom_anchor`, which is what keeps a
        coincidental outbound `…#bib24` from being captured.
        """
        if not href or '#' not in href:
            return None
        fragment = href.split('#', 1)[1].strip()
        # A second '#' or whitespace means this is not a plain id reference.
        if not fragment or '#' in fragment or any(c.isspace() for c in fragment):
            return None

        return fragment

    def apply(self, ctx, log=None):
        soup = ctx.soup
        bibliography_map = ctx.bibliography_map
        anchor_converted = 0
        anchor_unmatched = 0
        # {id: element} for every id this document carries. Serves both lookups below — "does this
        # target exist at all" and "what entry does it name" — and is built ONCE: a per-anchor
        # `soup.find(id=…)` is a full document walk, and one real book has 84,499 internal anchors
        # over 245,329 elements, which on its own exhausted the 300s conversion budget.
        id_index = None
        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            # Reduce the href to the fragment it targets, accepting a SELF-REFERENTIAL ABSOLUTE
            # URL as well as a bare `#id`.
            #
            # A publisher's own page frequently writes its in-text citations as fully-qualified
            # links back into itself — eLife emits
            # `<a href="https://elifesciences.org/articles/60080#bib24">Sword, 2012</a>`, which is
            # functionally identical to `#bib24`. Requiring `startswith('#')` discarded all 32 of
            # barnett-2020's citations as "external", and because they were ALREADY anchors the
            # plain-text author-year linkers would not touch them either: the citations fell
            # between the two rules and the book converted with ZERO linked citations while its
            # PDF twin linked 39. That book then failed its whole citation review ("no claims
            # were extracted") even though the reference list had parsed perfectly.
            #
            # What makes this safe is NOT the URL's shape — we cannot know the document's own
            # address, since a pasted fragment carries no <head> or canonical link. It is that the
            # fragment must resolve onto a BIBLIOGRAPHY ENTRY IN THIS DOCUMENT, which is the same
            # gate `_entry_id_for_dom_anchor` already applies to relative anchors. An ordinary
            # outbound link cannot pass it: its fragment either names nothing here or names
            # something that is not a reference entry, and it is left completely untouched.
            anchor_id = self._target_fragment(href)
            if anchor_id is None:
                continue
            if 'in-text-citation' in a_tag.get('class', []):
                # Already classed — normally our own output, so leave it. BUT when the SOURCE is
                # itself previously-converted output (study_phase1_aczel-2021-billion: 48
                # `class="in-text-citation"` anchors and zero bib-entries in its original.html),
                # those hrefs were written by an OLDER key generator and name ids this conversion
                # no longer mints. Skipping them unconditionally left 33 permanently dead links
                # even though the map still knew where 15 of them belonged. So: skip only while
                # the target resolves; a STALE one falls through and is re-pointed below.
                if id_index is None:
                    id_index = {t['id']: t for t in soup.find_all(attrs={'id': True})}
                if anchor_id in id_index:
                    continue
            if 'bib-entry' in a_tag.get('class', []):
                continue
            if 'footnote-ref' in a_tag.get('class', []):
                continue
            # Skip anchors inside bibliography/reference section paragraphs
            parent_p = a_tag.find_parent('p')
            if parent_p and parent_p.find('a', class_='bib-entry'):
                continue

            primary_id = bibliography_map.get(anchor_id)
            if not primary_id:
                if id_index is None:
                    id_index = {t['id']: t for t in soup.find_all(attrs={'id': True})}
                primary_id = _entry_id_for_dom_anchor(id_index, anchor_id)
            if primary_id:
                a_tag['href'] = f'#{primary_id}'
                classes = a_tag.get('class', [])
                if 'in-text-citation' not in classes:        # a re-pointed stale one already has it
                    a_tag['class'] = classes + ['in-text-citation']
                anchor_converted += 1
            else:
                anchor_unmatched += 1

        print(f"  - Pre-linked anchors converted: {anchor_converted}")
        print(f"  - Pre-linked anchors unmatched: {anchor_unmatched}")
        ctx.anchor_converted = anchor_converted
        ctx.anchor_unmatched = anchor_unmatched


class CitationPatternGate(LinkRule):
    """Guard: skip the expensive per-node scan when there's nothing to link against (no
    bibliography) or no parenthesized "(...YYYY...)" pattern appears in the full text. Sets
    `ctx.skip_citation_scan` / `ctx.skip_reason` for the linkers and the assessment recorder."""

    name = 'citation_pattern_gate'
    description = 'Gate the text-node scan on bibliography presence + a citation-pattern pre-check.'

    # A parenthesized "(…YYYY…)" citation, OR a square-bracket AUTHOR-DATE "[…letter…YYYY…]" citation.
    # The bracket check requires BOTH a letter AND a 4-digit year so it fires on "[Baldwin, 2018]" but NOT
    # on numeric STEM cites "[36]" / "[6-8]" (handled separately by the PDF wrap_stem_citations) or bare
    # bracketed dates "[2013]" — those have no author letter. This is what lets a bracket-ONLY source
    # (no parens) reach SquareBracketCitationLinker instead of being skipped.
    _PAREN_RE = re.compile(r"\([^)]*?\d{4}[^)]*?\)")
    _BRACKET_RE = re.compile(r"\[(?=[^\]]*[A-Za-z])(?=[^\]]*\d{4})[^\]]+\]")

    def apply(self, ctx, log=None):
        ctx.skip_citation_scan = False
        ctx.skip_reason = None
        if not ctx.bibliography_map:
            print("  ⏭️ No bibliography entries — skipping in-text citation scan")
            ctx.skip_citation_scan = True
            ctx.skip_reason = 'no_bibliography'
        else:
            # Quick pre-check on full text before walking every DOM node
            _full_text = ctx.soup.get_text()
            _has_citation_patterns = bool(self._PAREN_RE.search(_full_text)
                                          or self._BRACKET_RE.search(_full_text))
            del _full_text  # free memory
            if not _has_citation_patterns:
                print("  ⏭️ No (Author YEAR) / [Author YEAR] citation patterns found — skipping text node scan")
                ctx.skip_citation_scan = True
                ctx.skip_reason = 'no_citation_patterns'
            else:
                print(f"  📝 Found citation patterns, scanning text nodes against {len(ctx.bibliography_map)} bibliography keys...")


class ParenthesizedCitationLinker(LinkRule):
    """2A: link `(Author 2009)` parenthesized citations, emitting scan progress (68% → 75%) as it
    walks the text nodes. No-op when the gate set `skip_citation_scan`."""

    name = 'parenthesized_citation_linker'
    description = 'Link (Author YEAR) parenthesized in-text citations.'

    def apply(self, ctx, log=None):
        if ctx.skip_citation_scan:
            return
        soup = ctx.soup
        _all_text_nodes = soup.find_all(string=True)
        _total_text_nodes = len(_all_text_nodes)
        _last_progress_pct = 68
        for _tn_idx, text_node in enumerate(_all_text_nodes):
            # Emit progress every ~1% of text nodes scanned
            if _total_text_nodes > 100:
                _pct = 68 + int((_tn_idx / _total_text_nodes) * 7)  # 68% → 75%
                if _pct > _last_progress_pct:
                    _last_progress_pct = _pct
                    ctx.emit_progress(_pct, "doc_linking", f"Scanning text nodes ({_tn_idx}/{_total_text_nodes})")
            _link_citations_in_text_node(ctx, text_node, r"\(([^)]*?\d{4}[^)]*?)\)", "(", ")")


class SquareBracketCitationLinker(LinkRule):
    """2A-bracket: link `[Author 2009]` square-bracket citations. Runs against a fresh text-node
    walk (so it sees the post-paren-scan soup). No-op when the gate set `skip_citation_scan`. The gate
    now fires on `[Author YEAR]` brackets too, so a bracket-ONLY source reaches this scan."""

    name = 'square_bracket_citation_linker'
    description = 'Link [Author YEAR] square-bracket in-text citations.'

    def apply(self, ctx, log=None):
        if ctx.skip_citation_scan:
            return
        for text_node in ctx.soup.find_all(string=True):
            _link_citations_in_text_node(ctx, text_node, r"\[([^\]]*?\d{4}[^\]]*?)\]", "[", "]")


class NumberedParenCitationLinker(LinkRule):
    """2A-numparen: link `(4)` / `(1-3)` / `(4, 7)` PARENTHESIZED-NUMBER citations against an
    ORDINAL-numbered bibliography (PNAS style — 965f6773 cites "(1-3)" and "Dewatripont et al.
    (4)" into a "1. Bergstrom TC (2001)…" list). Bare parenthesized numbers are wildly ambiguous
    in general prose (equation numbers, years, counts), so the rule self-gates hard:
      • the extracted bibliography must itself be ordinal-numbered, DENSE (>= 80% of 1..max)
        and non-trivial (>= 5 entries) — no such bibliography, no scan;
      • a paren group links only when EVERY number in it resolves to an entry (years and
        equation numbers overflow the ordinal range and drop the whole group);
      • runs regardless of the author-year pattern gate — numbered citations carry no year.
    A range links as one anchor to its first entry; comma members link individually."""

    name = 'numbered_paren_citation_linker'
    description = 'Link (N) / (N-M) parenthesized-number citations to an ordinal-numbered bibliography.'

    _GROUP_RE = re.compile(r'\((\d{1,3}(?:\s*[-–]\s*\d{1,3})?(?:\s*,\s*\d{1,3})*)\)')
    _OPEN, _CLOSE = '(', ')'

    # ---- enumeration guard -------------------------------------------------------------------
    # "…the political impact of the SDGs on (1) global governance, (2) domestic political systems,
    # (3) the integration…" is a five-item LIST, not five citations — but against a dense ordinal
    # bibliography every member resolves, so the linker happily minted five wrong anchors
    # (2c0544c4, a Nature paper that actually cites by superscript; those five parentheses were the
    # only parenthesised numbers in the whole document).
    #
    # Shape is what separates the two. A citation attaches to what PRECEDES it — a phrase boundary
    # ("…on a finite planet (1).") or an author ("Dewatripont et al. (4) found…", "Varian (10)
    # pointed out…"). An enumerator introduces what FOLLOWS it: it sits after a comma / colon /
    # lowercase connective ("on", "and") and is followed by the item's own words.
    #
    # Neither test is safe alone — PNAS's "the web site journalprices.com (5) reports that…" is
    # enumerator-SHAPED yet is a real citation. So a group is only left alone when the
    # enumerator-shaped members of its paragraph ALSO count 1, 2, 3 … : a consecutive ascending run
    # from 1 is a list, and no citation order looks like that by accident.
    _ENUM_BEFORE_RE = re.compile(r'(?:^|[,;:(]|\b[a-z]{1,12})\s*$')
    _ENUM_AFTER_RE = re.compile(r'^\s+[A-Za-z]')
    _ENUM_MIN_RUN = 2

    def _enumeration_numbers(self, ctx, p):
        """The numbers in `p` that belong to a prose enumeration — resolvable groups matching those
        numbers must be left as plain text. Empty set for every ordinary paragraph."""
        cached = ctx.enum_cache.get(id(p))
        if cached is not None:
            return cached
        text = p.get_text()
        seq = []
        for m in self._GROUP_RE.finditer(text):
            token = m.group(1).strip()
            if not token.isdigit():
                continue                                  # ranges / comma groups are never list markers
            if (self._ENUM_BEFORE_RE.search(text[:m.start()])
                    and self._ENUM_AFTER_RE.match(text[m.end():])):
                seq.append(int(token))
        run = seq[:1]
        for n in seq[1:]:
            if n == run[-1] + 1:
                run.append(n)
            else:
                break
        nums = set(run) if (len(run) >= self._ENUM_MIN_RUN and run[0] == 1) else set()
        ctx.enum_cache[id(p)] = nums
        return nums

    def _ordinal_map(self, ctx):
        omap = {}
        for anchor in ctx.soup.find_all('a', class_='bib-entry'):
            p = anchor.find_parent('p')
            if not p:
                continue
            m = re.match(r'\s*(\d{1,3})[.)]\s', p.get_text())
            if m and anchor.get('id'):
                omap.setdefault(int(m.group(1)), anchor['id'])
        if len(omap) < 5:
            return None
        span = max(omap)
        if span <= 0 or len(omap) / span < 0.8:
            return None
        return omap

    def apply(self, ctx, log=None):
        if not ctx.bibliography_map:
            return
        omap = self._ordinal_map(ctx)
        if not omap:
            return
        span = max(omap)
        for text_node in list(ctx.soup.find_all(string=True)):
            if text_node.find_parent('a'):
                continue
            p = text_node.find_parent('p')
            if not p or _in_bibliography(ctx, text_node):
                continue
            text = str(text_node)
            matches = [m for m in self._GROUP_RE.finditer(text)]
            if not matches:
                continue
            enum_nums = self._enumeration_numbers(ctx, p)
            new_content, last = [], 0
            changed = False
            for m in matches:
                nums = [int(n) for n in re.findall(r'\d{1,3}', m.group(1))]
                is_range = bool(re.search(r'[-–]', m.group(1)))
                expanded = list(range(nums[0], nums[1] + 1)) if (is_range and len(nums) == 2) else nums
                if not expanded or not all(1 <= n <= span and n in omap for n in expanded):
                    continue                      # a year / equation number / gap — leave the group
                if len(nums) == 1 and not is_range and nums[0] in enum_nums:
                    ctx.enumerations_skipped += 1
                    continue                      # "(1) x, (2) y, (3) z" — a prose list, not citations
                new_content.append(NavigableString(text[last:m.start()] + self._OPEN))
                if is_range and len(nums) == 2:
                    a = ctx.soup.new_tag('a', href=f'#{omap[nums[0]]}')
                    a['class'] = 'in-text-citation'
                    # Same contract as wackSTEM range cites: data-refs carries EVERY member so
                    # the popup renders all of them, not just the first (detection.ts splits it).
                    a['data-refs'] = ','.join(omap[n] for n in expanded)
                    a.string = m.group(1)
                    new_content.append(a)
                else:
                    # display tokens keep any print annotation (Current Opinion marks papers
                    # of special interest with */** — "[8*]", "[52*,31*]"); resolution is
                    # digits-only.
                    tokens = re.findall(r'\d{1,3}\*{0,2}', m.group(1))
                    for k, n in enumerate(nums):
                        if k:
                            new_content.append(NavigableString(', '))
                        a = ctx.soup.new_tag('a', href=f'#{omap[n]}')
                        a['class'] = 'in-text-citation'
                        a.string = tokens[k] if k < len(tokens) else str(n)
                        new_content.append(a)
                new_content.append(NavigableString(self._CLOSE))
                ctx.citations_found += len(expanded)
                ctx.citations_linked += len(expanded)
                last = m.end()
                changed = True
            if changed:
                new_content.append(NavigableString(text[last:]))
                text_node.replace_with(*new_content)


class NumberedBracketCitationLinker(NumberedParenCitationLinker):
    """2A-numbracket: the SQUARE-BRACKET sibling of NumberedParenCitationLinker — links `[50]` /
    `[35,36]` / `[43--45]` bracketed-number citations against the same ordinal-numbered
    bibliography, under the same hard self-gates (dense ordinal list, every member resolves).
    Current Opinion / Vancouver papers cite this way into a "1. Adger W, …: Title…" list
    (6c4e7d58). Non-wackSTEM only in practice: on a wackSTEM doc the brackets were already
    wrapped as wackSTEMcite anchors at assembly, and anchored text is skipped here. The extra
    `--` range separator is Mistral's double-hyphen rendering of an en-dash."""

    name = 'numbered_bracket_citation_linker'
    description = 'Link [N] / [N-M] / [N,M] bracketed-number citations to an ordinal-numbered bibliography.'

    # \*{0,2} after each number: Current Opinion annotates special-interest papers with
    # stars on the CITATION ("[8*]", "[52*,31*]") — matched and displayed, resolved by digits.
    _GROUP_RE = re.compile(
        r'\[(\d{1,3}\*{0,2}(?:\s*(?:--|[-–])\s*\d{1,3})?(?:\s*,\s*\d{1,3}\*{0,2})*)\]')
    _OPEN, _CLOSE = '[', ']'


class UnresolvedCitationDemoter(LinkRule):
    """Last line of defence: a citation whose anchor does not EXIST is returned to plain text.

    Every linker above resolves through `bibliography_map`, so in principle an href always names a
    real entry id — but the map and the anchors are built in separate steps and can drift, and a
    dead link is worse than no link: it looks live, goes nowhere, and (because the linkers count it
    as linked) inflates the quality score that the maintainer loop reads. Observed live on
    study_phase1_aczel-2021-billion, where 26 of 48 hrefs named key-shaped ids that were never
    assigned as an entry id. The remedy is shape-agnostic, so it also covers future variants.

    Runs BEFORE AssessmentRecorder so the recorded linked-count is the corrected one. Note it does
    NOT run for STEM documents — `citation_pass.py` returns early for those — which is why the STEM
    branch existence-checks its own hrefs at the point of creation instead.

    Uses BeautifulSoup id lookup, never a regex over the serialised HTML: an ordered
    `class="…" … id="…"` pattern silently misses `<p id="CR1" class="bib-entry">`.
    """

    name = 'unresolved_citation_demoter'
    description = 'Unwrap in-text citations whose target anchor is absent from the document.'

    def apply(self, ctx, log=None):
        soup = ctx.soup
        resolved_ids = None
        demoted = []
        for a_tag in list(soup.find_all('a', class_='in-text-citation')):
            href = (a_tag.get('href') or '').strip()
            if not href.startswith('#') or len(href) < 2:
                continue
            target = href[1:]
            if resolved_ids is None:
                # Build once, and only if there is something to check.
                resolved_ids = {t['id'] for t in soup.find_all(attrs={'id': True})}
            if target in resolved_ids:
                continue
            demoted.append(a_tag.get_text(strip=True) or target)
            a_tag.unwrap()
            if ctx.citations_linked > 0:
                ctx.citations_linked -= 1
            ctx.citations_unlinked.append({'citation': demoted[-1],
                                           'generated_keys': [target],
                                           'reason': 'anchor_absent'})
        if demoted:
            print(f"  ⚠️ Unlinked {len(demoted)} citation(s) whose reference anchor is missing: "
                  + ', '.join(demoted[:5]) + (' …' if len(demoted) > 5 else ''))


class AssessmentRecorder(LinkRule):
    """Record the citation-linking pass to the assessment trace. AGGREGATE fork: the "roads not
    taken" are the citations we could NOT link (their tried keys), plus the two known SKIP gates."""

    name = 'citation_assessment_recorder'
    description = 'Record the citation-linking pass (linked rate / skip gates) to ASSESSMENT.'

    def apply(self, ctx, log=None):
        bibliography_map = ctx.bibliography_map
        anchor_converted = ctx.anchor_converted
        citations_found = ctx.citations_found
        citations_linked = ctx.citations_linked
        citations_unlinked = ctx.citations_unlinked
        if ctx.skip_reason == 'no_bibliography':
            ASSESSMENT.record(
                module='citation_link_audit', code_ref='citations.py:link_citations',
                node_help=_CITATION_PLAIN,
                decision='citation scan skipped — no bibliography entries',
                rationale='no references were extracted (PASS 1A), so there is nothing for in-text '
                          'citations to link against',
                evidence={'bibliography_entries': 0, 'anchor_converted': anchor_converted},
                question='Were in-text citations linked to the bibliography?',
                considered=[{'option': 'scan and link in-text citations',
                             'rejected_because': 'bibliography_map is empty',
                             'would_need': 'a detected references/bibliography section (PASS 1A)'}],
                confidence=1.0, margin='no bibliography to link against — nothing to do')
        elif ctx.skip_reason == 'no_citation_patterns':
            ASSESSMENT.record(
                module='citation_link_audit', code_ref='citations.py:link_citations',
                node_help=_CITATION_PLAIN,
                decision='citation scan skipped — no (Author YEAR) / [Author YEAR] patterns',
                rationale='the citation scan is gated on a "(...YYYY...)" OR "[...Author...YYYY...]" '
                          'pre-check; neither parenthesized nor square-bracket author-date patterns '
                          'were found in the text',
                evidence={'bibliography_entries': len(bibliography_map), 'anchor_converted': anchor_converted},
                question='Were in-text citations linked to the bibliography?',
                considered=[{'option': 'scan and link in-text citations',
                             'rejected_because': 'no (Author YEAR) or [Author YEAR] citation patterns in the text',
                             'would_need': 'author-date citations in parentheses or square brackets — a '
                                           'references list with NO matching in-text style is the usual cause'}],
                confidence=0.6,
                margin=(f'0 of {len(bibliography_map)} bibliography entries linked from the body — '
                        f'expected IF the source cites via footnotes/superscripts/numeric [N] markers, '
                        f'but a SUSPICION if it uses author-date citations we did not recognise'))
        else:
            candidates = ctx.citation_candidates
            bib_n = len(bibliography_map)
            unlinked_n = len(citations_unlinked)
            rate = (citations_linked / citations_found) if citations_found else 1.0
            sample = [{'citation': u['citation'][:60], 'keys_tried': u['generated_keys'][:6]}
                      for u in citations_unlinked[:8]]
            # SUSPICION, not verdict (README §0). We do NOT classify which bracketed years are "really"
            # citations — we report raw facts. The one falsifiable contradiction worth raising: a
            # bibliography exists, yet NONE of the bracketed-year candidates linked to it. That MIGHT be
            # missing references upstream OR prose-year parentheticals — a human / the vibe loop reads the
            # text to decide. (A partial miss is a softer version of the same question.)
            #
            # BUT citations can arrive two ways: via the text "(Author Year)" scan (this branch's counts)
            # OR pre-wired in the source as id/class anchors (PreLinkedAnchorConverter → anchor_converted).
            # If the doc was cited via markup, the text scan linking 0 is EXPECTED — not a miss — so the
            # full-miss suspicion must NOT fire.
            markup_cited = (anchor_converted > 0 and citations_linked == 0)
            full_miss = (bib_n >= 1 and citations_found > 0 and citations_linked == 0
                         and anchor_converted == 0)
            if markup_cited:
                _confidence = 0.8
                _margin = (f'{anchor_converted} citation(s) were wired via source markup (id/class anchors); '
                           f'the text "(Year)" scan linked 0, which is EXPECTED for a markup-cited document '
                           f'— not a miss.')
            elif full_miss and looks_like_reading_list(bib_n, citations_found, citations_linked):
                # Reading-list / footnote-cited source — there is NO author-date bibliography to link
                # against (a handful of "references" but dozens of bare-year candidates). A CONFIDENT
                # non-action, so the vibe loop is NOT routed here to chase a non-problem.
                _confidence = 1.0
                _margin = (f'{citations_found} bracketed-year candidate(s) but only {bib_n} bibliography '
                           f'entr(y/ies) — a reading-list / footnote-cited source, not an author-date '
                           f'bibliography; nothing to link (the candidates are bare years / prose numbers).')
            elif full_miss:
                _confidence = 0.3
                _margin = (f'{citations_found} bracketed-year candidate(s) but 0 linked to the {bib_n}-entry '
                           f'bibliography — MIGHT be missing references / key drift (upstream), OR these are '
                           f'prose-year parentheticals, not citations. Please read the text to decide.')
            elif unlinked_n:
                _confidence = round(rate, 2)
                _margin = (f'{unlinked_n} of {citations_found} candidate(s) did not match a bibliography '
                           f'entry — MIGHT be missing references / key-generation drift; please check')
            else:
                _confidence = round(rate, 2)
                _margin = f'all {citations_linked} citation(s) matched a bibliography entry'
            ASSESSMENT.record(
                module='citation_link_audit', code_ref='citations.py:link_citations',
                node_help=_CITATION_PLAIN,
                decision=f'linked {citations_linked} of {citations_found} bracketed-year candidate(s)',
                rationale='every bracketed-year candidate is counted and link-attempted (a ref-key match '
                          'against the bibliography, bounded ±3yr fuzzy fallback); unmatched ones stay plain '
                          'text. We do NOT classify which are "really" citations — we report the facts and '
                          'raise a suspicion (bib present + 0 linked) for a human / the vibe loop to check',
                evidence={'candidates': candidates, 'found': citations_found, 'linked': citations_linked,
                          'unlinked': unlinked_n, 'anchor_converted': anchor_converted,
                          'bibliography_entries': bib_n, 'full_miss': full_miss,
                          'markup_cited': markup_cited, 'unlinked_sample': sample,
                          'numbered_enumerations_skipped': ctx.enumerations_skipped,
                          'year_ranges_skipped': ctx.year_ranges_skipped,
                          'antecedent_author_links': ctx.antecedent_links,
                          'antecedent_author_sample': ctx.antecedent_sample,
                          'ambiguous_candidate_links': ctx.ambiguous_links},
                question='Did in-text citations link to the bibliography (and if not — real miss or prose-years)?',
                considered=([{'option': 'link the remaining unmatched citations',
                              'rejected_because': 'their generated keys matched no bibliography entry '
                                                  '(even with the ±3yr fuzzy-year fallback)',
                              'would_need': 'a bibliography entry whose key matches, or different key '
                                            'generation — see evidence.unlinked_sample for the keys tried'}]
                            if unlinked_n else []),
                confidence=_confidence,
                margin=_margin)


# Ordered registry — the linking sequence the monolith ran top-to-bottom. ORDER MATTERS: the gate
# must precede the scans; the paren scan must precede the bracket scan (the bracket walk re-reads the
# post-paren soup); the assessment recorder runs last. Absorb a new citation shape by ADDING a rule.
CITATION_LINK_RULES = [
    PreLinkedAnchorConverter(),
    CitationPatternGate(),
    ParenthesizedCitationLinker(),
    SquareBracketCitationLinker(),
    NumberedParenCitationLinker(),
    NumberedBracketCitationLinker(),
    UnresolvedCitationDemoter(),   # must precede the recorder — it corrects citations_linked
    AssessmentRecorder(),
]


def link_citations_rules(soup, bibliography_map, emit_progress=None, stats=None):
    """Entry point: build a `CitationLinkContext`, run `CITATION_LINK_RULES`, return the
    (found, linked, unlinked) tuple `link_citations` has always returned. An optional `stats` dict
    is filled with the markup-wired counts, which the tuple has no room for."""
    ctx = CitationLinkContext(soup, bibliography_map, emit_progress)
    run_link_rules(CITATION_LINK_RULES, ctx)
    if stats is not None:
        stats['anchor_converted'] = ctx.anchor_converted
        stats['anchor_unmatched'] = ctx.anchor_unmatched
    return ctx.citations_found, ctx.citations_linked, ctx.citations_unlinked

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

# Human-readable `plain` note for the citation-linking tree node (one source — node_help + generator + LLM).
_CITATION_PLAIN = (
    "Turn each in-text \"(Author Year)\" into a clickable link to its bibliography entry. Links only when "
    "a matching entry was extracted — 0/N against a near-empty bibliography is usually a non-problem "
    "(those were parenthetical years in prose, not real citations), NOT a bug. Known limitation: a source "
    "that cites ONLY with [Author YEAR] square brackets is skipped by the parenthesis pre-check.")
from shared.link_base import LinkRule, run_link_rules
from shared.refkeys import generate_ref_keys


# --- Citation SHAPE detection (an ADDITIVE assessment signal, NOT a gate) --------------------------
# `_is_citation_shaped` does NOT change the count or the linking — every "(…YYYY…)" candidate is still
# counted and link-attempted (see _link_citations_in_text_node). It is an INDEPENDENT bit: of those
# candidates, how many LOOK author-year (`(Smith 1999)`, `(1994, 5)`) vs prose-dates (`(November 2000)`,
# `(by 1990 the FSF…)`). The assessment uses it to tell "0 linked because it's all prose-year noise"
# (don't flag) from "0 linked but they ARE citation-shaped" (a real miss — suspect upstream bibliography
# extraction). Flag suspicion, never assert failure — see tests/conversion/README.md §0.

_MONTHS = (r'(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|'
           r'Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)')
_MONTH_WORD = re.compile(r'^(?:' + _MONTHS + r')\.?$', re.I)
_YEAR_RE = re.compile(r'\b\d{4}[a-z]?\b')          # a real 4-digit year, on a word boundary (not "P162679")
_WORD_RE = re.compile(r"[^\W\d_][\w.'’\-]*", re.UNICODE)   # a word; UNICODE so "Villaseñor" counts


def _is_citation_shaped(sub_cite):
    """Is ONE sub-citation (a `;`/`,`-split segment of a parenthetical) actually citation-shaped?

    The discriminator is what sits BEFORE the year — NOT what trails it (real citations carry page
    locators and asides: `Babb 2009, 6`, `Robinson 2015, 17–18`, `Nielson and Tierney 2003, 242 emphasis
    added`, `see Bond 2016 for a summary`). So:
      • bare year (`1999`, `1994, 5`) → True — a WEAK candidate, only counted if it links downstream;
      • a real author surname before the year (`Smith 1999`, `see Copeland 2006`, `Villaseñor 1941`) → True;
      • only lowercase prose or a MONTH name before the year (`by 1990 the FSF…`, `early September 1996,
        about six weeks…`, `November 2000`) → False — a date / sentence, not a citation;
      • a LONG run of words before the year (`When I gave my talk at the first Perl Conference in August
        1997…`) → False — a real author phrase is short and ADJACENT to the year, not a sentence;
      • no 4-digit year at all (`P162679`) → False.
    """
    s = (sub_cite or '').strip()
    if not s:
        return False
    ym = _YEAR_RE.search(s)
    if not ym:
        return False                       # no real year → not a citation (e.g. an OCR id "P162679")
    before = s[:ym.start()].strip()
    if not before:
        return True                        # bare "(1999)" / "(1994, 5)" → weak; link-gated downstream
    words_before = _WORD_RE.findall(before)
    if len(words_before) > 6:
        return False                       # too many words before the year ⇒ a prose sentence, not a
                                           # tight "[short author phrase] YEAR" citation
    # a real author = a Capitalised word before the year that is NOT a month name (a month in the author
    # slot ⇒ a date). Lowercase-only prose ("by", "early") or a lone month ⇒ no author ⇒ not a citation.
    return any(w[:1].isupper() and not _MONTH_WORD.match(w) for w in words_before)


class CitationLinkContext:
    """Shared state threaded through the citation-linking rules — the same locals the monolith
    carried (the accumulators, the skip gate, the anchor counts)."""

    def __init__(self, soup, bibliography_map, emit_progress=None):
        self.soup = soup
        self.bibliography_map = bibliography_map
        self.emit_progress = emit_progress if callable(emit_progress) else (lambda *a, **k: None)
        self.citation_candidates = 0   # every "(…YYYY…)" candidate scanned (== citations_found; kept for clarity)
        self.citations_found = 0       # every candidate counted (unchanged semantics — drives citations_total)
        self.citation_shaped = 0       # ADDITIVE signal: of those, how many LOOK author-year (not prose/date)
        self.citations_linked = 0
        self.citations_unlinked = []
        self.anchor_converted = 0
        self.anchor_unmatched = 0
        self.skip_citation_scan = False
        self.skip_reason = None


def _link_citations_in_text_node(ctx, text_node, pattern, open_delim, close_delim):
    """Link every `pattern`-delimited in-text citation inside one text node (the body shared by the
    parenthesized and square-bracket scans — only `pattern`/delimiters differ). Mutates the soup and
    the ctx accumulators in place."""
    soup = ctx.soup
    bibliography_map = ctx.bibliography_map
    if not text_node.find_parent("p") or not text_node.find_parent("p").find("a", class_="bib-entry"):
        text = str(text_node)
        matches = list(re.finditer(pattern, text))
        if matches:
            new_content = []
            last_index = 0
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
                    # Count every "(…YYYY…)" candidate (unchanged): some are author-year, some bare year,
                    # some STEM/journal refs — all technically citations, all kept and linked as before.
                    # `_is_citation_shaped` is a SEPARATE, additive signal (it does NOT gate the count or the
                    # linking): it tells the assessment how many candidates LOOK like author-year citations,
                    # so "0 linked" over a pile of prose-year/date parentheticals reads as not-a-fault.
                    ctx.citation_candidates += 1
                    ctx.citations_found += 1
                    if _is_citation_shaped(sub_cite):
                        ctx.citation_shaped += 1
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
                    keys = generate_ref_keys(sub_cite, context_text=context_for_keys)
                    linked = False
                    for key in keys:
                        if key in bibliography_map:
                            year_match = re.search(r'(\d{4}[a-z]?)', sub_cite)
                            if year_match:
                                author_part = sub_cite[:year_match.start(0)]
                                year_part = year_match.group(0)
                                trailing_part = sub_cite[year_match.end(0):]
                                if author_part:
                                    new_content.append(NavigableString(author_part))
                                a_tag = soup.new_tag("a", href=f"#{bibliography_map[key]}")
                                a_tag['class'] = 'in-text-citation'
                                a_tag.string = year_part
                                new_content.append(a_tag)
                                if trailing_part:
                                    # Check for comma-separated additional years e.g. "2010a, 2010b"
                                    remaining = trailing_part
                                    while remaining:
                                        extra_year = re.match(r'([\s,]+)(\d{4}[a-z]?)', remaining)
                                        if extra_year:
                                            separator = extra_year.group(1)
                                            extra_year_str = extra_year.group(2)
                                            extra_keys = generate_ref_keys(author_part + extra_year_str, context_text=preceding_text)
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
                                            remaining = remaining[extra_year.end(0):]
                                        else:
                                            new_content.append(NavigableString(remaining))
                                            break
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
                        year_in_cite = re.search(r'(\d{4})', sub_cite)
                        if year_in_cite:
                            orig_year = year_in_cite.group(1)
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
                                            new_content.append(NavigableString(trailing_part))
                                        linked = True
                                        ctx.citations_linked += 1
                                        break
                    if not linked:
                        new_content.append(NavigableString(sub_cite))
                        ctx.citations_unlinked.append({"citation": sub_cite, "generated_keys": keys})
                    if i < len(sub_citations) - 1: new_content.append(NavigableString("; "))
                new_content.append(NavigableString(close_delim))
                last_index = match.end()
            new_content.append(NavigableString(text[last_index:]))
            text_node.replace_with(*new_content)


class PreLinkedAnchorConverter(LinkRule):
    """2A-pre: convert existing `<a href="#id">` links that point at a bibliography entry into
    in-text citations (skipping anchors already classed citation/bib-entry/footnote, external links,
    and anchors inside bibliography paragraphs)."""

    name = 'pre_linked_anchor_converter'
    description = 'Convert existing #id anchors into in-text-citation links.'

    def apply(self, ctx, log=None):
        soup = ctx.soup
        bibliography_map = ctx.bibliography_map
        anchor_converted = 0
        anchor_unmatched = 0
        for a_tag in soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            # Skip if already a citation, bib-entry, footnote, or external link
            if not href.startswith('#'):
                continue
            if 'in-text-citation' in a_tag.get('class', []):
                continue
            if 'bib-entry' in a_tag.get('class', []):
                continue
            if 'footnote-ref' in a_tag.get('class', []):
                continue
            # Skip anchors inside bibliography/reference section paragraphs
            parent_p = a_tag.find_parent('p')
            if parent_p and parent_p.find('a', class_='bib-entry'):
                continue

            anchor_id = href.lstrip('#')
            if anchor_id in bibliography_map:
                primary_id = bibliography_map[anchor_id]
                a_tag['href'] = f'#{primary_id}'
                a_tag['class'] = a_tag.get('class', []) + ['in-text-citation']
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
    description = 'Gate the text-node scan on bibliography presence + a paren-pattern pre-check.'

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
            _has_citation_patterns = bool(re.search(r"\([^)]*?\d{4}[^)]*?\)", _full_text))
            del _full_text  # free memory
            if not _has_citation_patterns:
                print("  ⏭️ No parenthesized citation patterns found — skipping text node scan")
                ctx.skip_citation_scan = True
                ctx.skip_reason = 'no_paren_patterns'
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
    walk (so it sees the post-paren-scan soup). No-op when the gate set `skip_citation_scan` — this
    is the known limitation: a source citing ONLY with brackets is gated out by the paren pre-check."""

    name = 'square_bracket_citation_linker'
    description = 'Link [Author YEAR] square-bracket in-text citations.'

    def apply(self, ctx, log=None):
        if ctx.skip_citation_scan:
            return
        for text_node in ctx.soup.find_all(string=True):
            _link_citations_in_text_node(ctx, text_node, r"\[([^\]]*?\d{4}[^\]]*?)\]", "[", "]")


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
                module='citation_linking', code_ref='citations.py:link_citations',
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
        elif ctx.skip_reason == 'no_paren_patterns':
            ASSESSMENT.record(
                module='citation_linking', code_ref='citations.py:link_citations',
                node_help=_CITATION_PLAIN,
                decision='citation scan skipped — no parenthesized (Author YEAR) patterns',
                rationale='the citation scan is gated on a parenthesized "(...YYYY...)" pre-check; '
                          'none were found in the text',
                evidence={'bibliography_entries': len(bibliography_map), 'anchor_converted': anchor_converted},
                question='Were in-text citations linked to the bibliography?',
                considered=[{'option': 'scan and link in-text citations',
                             'rejected_because': 'no parenthesized (Author YEAR) citation patterns in the text',
                             'would_need': 'parenthesized citations — NOTE: a source citing ONLY with '
                                           '[Author YEAR] square brackets is skipped by this gate (known '
                                           'limitation; bracket linking lives behind the paren pre-check)'}],
                confidence=0.6,
                margin=(f'0 of {len(bibliography_map)} bibliography entries linked from the body — '
                        f'expected IF the source cites via footnotes/superscripts, but WRONG if it uses '
                        f'[Author YEAR] brackets (those are silently skipped here)'))
        else:
            candidates = ctx.citation_candidates
            shaped = ctx.citation_shaped
            unlinked_n = len(citations_unlinked)
            rate = (citations_linked / citations_found) if citations_found else 1.0
            sample = [{'citation': u['citation'][:60], 'keys_tried': u['generated_keys'][:6]}
                      for u in citations_unlinked[:8]]
            # SUSPICION, not verdict (see README §0). Every "(…YYYY…)" candidate is counted/linked; `shaped`
            # is the ADDITIVE bit — of those, how many LOOK author-year vs prose-date. We use it only to
            # decide whether "0 linked" deserves a flag:
            #   • noise_only — when the shaped ones are a TINY fraction (a narrative book full of
            #     parenthetical dates, at most a stray "(Paris 1928)") and none linked, the doc plainly
            #     isn't author-year-cited, so 0 links is expected — DON'T flag (high confidence).
            #   • else, shaped-but-unmatched IS the falsifiable contradiction worth flagging — and it points
            #     UPSTREAM (bibliography extraction / OCR), since the linker itself is unit-tested.
            noise_only = (candidates >= 3 and citations_linked == 0
                          and shaped <= max(1, round(candidates * 0.2)))
            # (kept for back-compat with hand-fed tests) a near-empty-bib 0-link is also expected-not-flagged.
            likely_not_citations = (len(bibliography_map) <= 1 and citations_found > 0
                                    and citations_linked == 0)
            if noise_only:
                _confidence = 0.9
                _margin = (f'only {shaped} of {candidates} parenthetical year(s) look author-year — the rest '
                           f'are dates / prose asides like "(November 2000)" or "(by 1990 the FSF…)", so 0 '
                           f'links is expected here, not a likely fault.')
            elif likely_not_citations:
                _confidence = 0.9
                _margin = (f'{citations_found} parenthetical-year pattern(s) but the bibliography has only '
                           f'{len(bibliography_map)} entr(y/ies) — probably NOT author-year citations, so 0 '
                           f'links is expected. IF the doc genuinely cites author-year, suspect upstream '
                           f'bibliography extraction (no targets to match).')
            else:
                _confidence = round(rate, 2)
                _margin = (f'{shaped} of {unlinked_n} unlinked candidate(s) look author-year but matched '
                           f'no bibliography entry — MIGHT be missing references / key-generation drift '
                           f'(upstream); please check the text' if unlinked_n
                           else f'all {citations_linked} citation(s) matched a bibliography entry')
            ASSESSMENT.record(
                module='citation_linking', code_ref='citations.py:link_citations',
                node_help=_CITATION_PLAIN,
                decision=f'linked {citations_linked} of {citations_found} parenthetical-year citation(s) '
                         f'({shaped} looked author-year-shaped)',
                rationale='every parenthetical-year candidate is counted and link-attempted (a ref-key match '
                          'against the bibliography, bounded ±3yr fuzzy fallback); unmatched ones stay plain '
                          'text. citation_shaped is an ADDITIVE signal — how many look author-year — used '
                          'only to judge whether 0-linked is real prose-year noise or a genuine miss',
                evidence={'candidates': candidates, 'citation_shaped': shaped,
                          'found': citations_found, 'linked': citations_linked, 'unlinked': unlinked_n,
                          'anchor_converted': anchor_converted, 'bibliography_entries': len(bibliography_map),
                          'noise_only': noise_only, 'likely_not_citations': likely_not_citations,
                          'unlinked_sample': sample},
                question='Were in-text citations linked to the bibliography?',
                considered=([{'option': 'link the remaining unmatched citations',
                              'rejected_because': 'their generated keys matched no bibliography entry '
                                                  '(even with the ±3yr fuzzy-year fallback)',
                              'would_need': 'a bibliography entry whose key matches, or different key '
                                            'generation — see evidence.unlinked_sample for the keys tried'}]
                            if unlinked_n and not noise_only and not likely_not_citations else []),
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
    AssessmentRecorder(),
]


def link_citations_rules(soup, bibliography_map, emit_progress=None):
    """Entry point: build a `CitationLinkContext`, run `CITATION_LINK_RULES`, return the
    (found, linked, unlinked) tuple `link_citations` has always returned."""
    ctx = CitationLinkContext(soup, bibliography_map, emit_progress)
    run_link_rules(CITATION_LINK_RULES, ctx)
    return ctx.citations_found, ctx.citations_linked, ctx.citations_unlinked

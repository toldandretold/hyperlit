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

from conversion.assessment import ASSESSMENT
from conversion.link_base import LinkRule, run_link_rules
from conversion.refkeys import generate_ref_keys


class CitationLinkContext:
    """Shared state threaded through the citation-linking rules — the same locals the monolith
    carried (the accumulators, the skip gate, the anchor counts)."""

    def __init__(self, soup, bibliography_map, emit_progress=None):
        self.soup = soup
        self.bibliography_map = bibliography_map
        self.emit_progress = emit_progress if callable(emit_progress) else (lambda *a, **k: None)
        self.citations_found = 0
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
            unlinked_n = len(citations_unlinked)
            rate = (citations_linked / citations_found) if citations_found else 1.0
            sample = [{'citation': u['citation'][:60], 'keys_tried': u['generated_keys'][:6]}
                      for u in citations_unlinked[:8]]
            # PLAUSIBILITY GUARD: "found N, linked 0" against a (near-)empty bibliography almost
            # certainly means these are NOT author-year citations — the paren scan over-matched
            # parenthetical years/dates in prose (e.g. "1875", "March, 1923"), and the one or two
            # "references" are reverse-scan false positives. That is a correct non-link, NOT a
            # linking fault — so record it at HIGH confidence (don't flag the loop onto a non-bug).
            # Real author-year docs have a populated bibliography; the threshold (<=1) is the floor.
            likely_not_citations = (len(bibliography_map) <= 1 and citations_found > 0
                                    and citations_linked == 0)
            if likely_not_citations:
                _confidence = 0.9
                _margin = (f'{citations_found} parenthesized "(…YYYY…)" pattern(s) matched but the '
                           f'bibliography has only {len(bibliography_map)} entr(y/ies) — these are '
                           f'almost certainly NOT author-year citations (years/dates in prose), so '
                           f'linking 0 is CORRECT, not a fault. If the document genuinely cites '
                           f'author-year, the upstream cause is bibliography extraction (no targets '
                           f'were found), not the linker.')
            else:
                _confidence = round(rate, 2)
                _margin = (f'{unlinked_n} citation(s) had keys generated but no bibliography match — '
                           f'possible missing references or key-generation drift' if unlinked_n
                           else f'all {citations_linked} citation(s) matched a bibliography entry')
            ASSESSMENT.record(
                module='citation_linking', code_ref='citations.py:link_citations',
                decision=f'linked {citations_linked} of {citations_found} in-text citation(s)',
                rationale='each citation links only when a generated ref-key matches a bibliography entry '
                          '(bounded ±3yr fuzzy fallback); unmatched citations are left as plain text',
                evidence={'found': citations_found, 'linked': citations_linked, 'unlinked': unlinked_n,
                          'anchor_converted': anchor_converted, 'bibliography_entries': len(bibliography_map),
                          'likely_not_citations': likely_not_citations,
                          'unlinked_sample': sample},
                question='Were in-text citations linked to the bibliography?',
                considered=([{'option': 'link the remaining unmatched citations',
                              'rejected_because': 'their generated keys matched no bibliography entry '
                                                  '(even with the ±3yr fuzzy-year fallback)',
                              'would_need': 'a bibliography entry whose key matches, or different key '
                                            'generation — see evidence.unlinked_sample for the keys tried'}]
                            if unlinked_n and not likely_not_citations else []),
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

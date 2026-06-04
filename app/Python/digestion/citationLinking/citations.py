"""Citation linking: wrap in-text references like (Author 2009) / [Author 2009] in
<a class="in-text-citation"> pointing at the matching bibliography entry. Extracted from
process_document.py PASS 2A. Mutates the soup; returns (found, linked, unlinked). The
modus operandi holds: a citation only links when a generated ref-key actually matches a
bibliography entry (with a bounded fuzzy-year fallback) — otherwise it is left as plain text.

This module is now a thin shell over the `CITATION_LINK_RULES` registry — the ~380-line monolith
was decomposed into ordered, independently-unit-tested `LinkRule` units so a new citation shape is
absorbed by ADDING a rule, not editing the scan. See `conversion/citation_link_rules.py`.
"""
from digestion.citationLinking.citation_link_rules import link_citations_rules


def link_citations(soup, bibliography_map, emit_progress=None):
    """Thin shell — delegates to the `CITATION_LINK_RULES` registry. Same signature and
    `(found, linked, unlinked)` return; behaviour is golden-identical (guarded by the regression
    suite). The rule sequence (anchor-convert → pattern gate → paren scan → bracket scan →
    assessment) lives in `conversion/citation_link_rules.py`."""
    return link_citations_rules(soup, bibliography_map, emit_progress)

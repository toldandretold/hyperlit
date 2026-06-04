"""Digestion — the single SHARED pipeline that processes the common HTML produced by ingestion:
extract (bibliography + footnotes) -> link (citations + footnote markers) -> audit -> emit. Format-
agnostic: every input format converges here. Orchestrated by process_document.py (DOC_PASSES). The
stage sub-folders mirror the decision tree's order. See README.md."""

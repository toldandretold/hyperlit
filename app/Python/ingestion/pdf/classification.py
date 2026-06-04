"""Phase ① — decide the PDF footnote LAYOUT. The first-match PDF_CLASSIFIERS cascade (none → wackSTEM → page_bottom → chapter_endnotes → document_endnotes → unknown) + classify_footnotes, which reads the per-page signals (co-location, reset-frequency, def-clustering, ref-spread) and picks a layout."""
import sys
import os
import json
import re
import argparse
import base64
from pathlib import Path
from statistics import median
from mistralai.client import Mistral
from pypdf import PdfReader, PdfWriter

from ingestion.pdf.pdf_shared import *  # noqa: F401,F403

_PDF_CLASSES = ('none', 'page_bottom', 'chapter_endnotes',
                'document_endnotes', 'wackSTEMbibliographyNotes', 'unknown')


_PDF_RATIONALE = {
    'none': 'no in-text footnote references found on any page',
    'page_bottom': 'refs and their definitions co-locate on the same pages (footnotes at page bottom)',
    'chapter_endnotes': 'definitions gathered in per-chapter Notes sections, separate from their refs',
    'document_endnotes': 'definitions clustered on a few trailing pages, refs scattered through the body',
    'wackSTEMbibliographyNotes': 'low ref-numbers recur across many pages (numbered bibliography-style citations)',
    'unknown': 'signals matched no specific classifier — fell through to unknown',
}


class NoneClassifier(PdfClassifier):
    name = 'none'
    plain = ('No in-text footnote/citation markers at all — nothing to link. If the book DID have '
             'footnotes, suspect they were lost in OCR (markers never survived) rather than here.')
    would_need = 'zero pages with in-text footnote references'

    def matches(self, sig):
        return sig['pages_with_refs'] == 0

    def confidence(self, sig):
        return 1.0

    def rejected_because(self, sig):
        refs = sig['pages_with_refs']
        return f'{refs} page(s) carry in-text references' if refs else 'no in-text references'

    def margin(self, sig):
        return f"{sig['pages_with_refs']} pages with refs — unambiguous"


class WackStemClassifier(PdfClassifier):
    name = 'wackSTEMbibliographyNotes'
    plain = ('STEM-style numbered citations: inline [1], [2] pointing to a reference list at the back. '
             'The same low numbers recur across many pages and their definitions live far away, never '
             'on the same page. Classic failure: mistaken for page-bottom footnotes when co-location is '
             'borderline.')
    would_need = 'the same low ref-numbers reappearing across many pages (bibliography citations)'

    def matches(self, sig):
        return (sig['ref_number_max_page_spread'] >= 3
                and sig['co_location_ratio'] < 0.2
                and sig['notes_page_count'] == 0
                and sig['reset_count'] <= 3
                and (sig['reset_frequency'] < 0.2 or sig['max_ref_number'] > 50))

    def confidence(self, sig):
        c = 0.0
        if sig['ref_number_max_page_spread'] >= 5:
            c += 0.3
        if sig['numbers_on_multiple_pages'] > 10:
            c += 0.3
        if sig['co_location_ratio'] < 0.1:
            c += 0.2
        if sig['notes_page_count'] == 0:
            c += 0.2
        return c

    def rejected_because(self, sig):
        return (f"ref-number page-spread {sig['ref_number_max_page_spread']} (need >=3) and "
                f"co-location {sig['co_location_ratio']:.2f} (need <0.2)")

    def margin(self, sig):
        return (f"ref-spread {sig['ref_number_max_page_spread']} (>=3 gate), "
                f"co-location {sig['co_location_ratio']:.2f} (<0.2 gate)")


class PageBottomClassifier(PdfClassifier):
    # Two gates (continuous + restart) — contiguous in the old tree, so OR-folding is identical.
    name = 'page_bottom'
    plain = ('Classic footnotes at the bottom of each page — the marker and its note sit on the SAME '
             'page (high co-location). Classic failure: numbering that restarts each page must be '
             'renumbered globally or definitions collide.')
    would_need = 'refs and their definitions sharing the same pages (high co-location)'

    def matches(self, sig):
        co = sig['co_location_ratio']; rf = sig['reset_frequency']
        return ((co > 0.4 and sig['pages_with_both'] >= 3 and rf < 0.1 and sig['max_ref_number'] > 10)
                or (co > 0.5 and rf > 0.4))

    def confidence(self, sig):
        co = sig['co_location_ratio']; rf = sig['reset_frequency']
        c = 0.0
        if co > 0.8:
            c += 0.3
        elif co > 0.4:
            c += 0.15
        if rf > 0.7:
            c += 0.3
        elif rf < 0.1 and sig['max_ref_number'] > 10:
            c += 0.25
        if sig['notes_page_count'] == 0:
            c += 0.2
        if sig['trailing_page_number_consistency'] > 0.5:
            c += 0.2
        return c

    def rejected_because(self, sig):
        return (f"co-location {sig['co_location_ratio']:.2f} / reset-freq {sig['reset_frequency']:.2f} "
                f"fit neither page_bottom rule "
                f"(continuous: co>0.4 & resets<0.1 & maxref>10; restart: co>0.5 & resets>0.4)")

    def margin(self, sig):
        return (f"co-location {sig['co_location_ratio']:.2f} (gate 0.4/0.5), "
                f"reset-freq {sig['reset_frequency']:.2f}, max-ref {sig['max_ref_number']}")


class ChapterEndnotesClassifier(PdfClassifier):
    # Three gates (notes-header / resets / well-separated) — contiguous in the old tree.
    name = 'chapter_endnotes'
    plain = ('Notes collected at the end of each CHAPTER (often under a "Notes" heading); the numbering '
             'restarts every chapter, so a per-chapter offset is applied for global uniqueness. Classic '
             'failure: a back-of-book Notes section split by chapter can still collide numbers across '
             'chapters if the offset is mis-applied (the fusion case — see test_pdf_fusion.py).')
    would_need = 'a "Notes" page header, OR per-chapter resets with separated definition pages (co-location < 0.3)'

    def matches(self, sig):
        co = sig['co_location_ratio']
        return ((sig['notes_page_count'] > 0 and co < 0.3)
                or (co < 0.3 and sig['pages_with_defs'] > 0 and sig['reset_frequency'] > 0.3)
                or (co < 0.15 and sig['pages_with_defs'] > 5 and sig['reset_count'] >= 3))

    def confidence(self, sig):
        c = 0.0
        if sig['notes_page_count'] > 0:
            c += 0.3
        if sig['co_location_ratio'] < 0.1:
            c += 0.3
        if sig['reset_count'] > 0:
            c += 0.2
        if sig['def_clustering_ratio'] < 0.2:
            c += 0.2
        return c

    def rejected_because(self, sig):
        return (f"no Notes-header page and co-location {sig['co_location_ratio']:.2f}/"
                f"reset-freq {sig['reset_frequency']:.2f} miss the endnote rules")

    def margin(self, sig):
        return (f"co-location {sig['co_location_ratio']:.2f} (<0.3 gate), "
                f"notes-pages {sig['notes_page_count']}, reset-freq {sig['reset_frequency']:.2f}")


class DocumentEndnotesClassifier(PdfClassifier):
    name = 'document_endnotes'
    plain = ('All the notes clustered on a few pages at the very END of the book, while the markers are '
             'scattered through the body (near-zero co-location). Classic failure: hard to tell from a '
             'per-chapter end-list when there are no chapter headers to split on.')
    would_need = 'definitions clustered on very few trailing pages with near-zero co-location'

    def matches(self, sig):
        return sig['co_location_ratio'] < 0.15 and sig['def_clustering_ratio'] < 0.1

    def confidence(self, sig):
        c = 0.0
        if sig['co_location_ratio'] < 0.05:
            c += 0.3
        if sig['def_clustering_ratio'] < 0.05:
            c += 0.3
        if sig['notes_page_count'] == 0:
            c += 0.2
        if sig['reset_count'] == 0:
            c += 0.2
        return c

    def rejected_because(self, sig):
        return (f"co-location {sig['co_location_ratio']:.2f} (need <0.15) and "
                f"def-clustering {sig['def_clustering_ratio']:.2f} (need <0.1)")

    def margin(self, sig):
        return (f"co-location {sig['co_location_ratio']:.2f} (<0.15 gate), "
                f"def-clustering {sig['def_clustering_ratio']:.2f} (<0.1 gate)")


class UnknownClassifier(PdfClassifier):
    # Fall-through default — consulted only after every specific classifier misses.
    name = 'unknown'
    plain = ('Fall-through: the signals matched no specific footnote layout, so assembly does generic '
             'cleanup only. Low confidence — a prime review candidate; the real layout is probably a '
             'near-miss of one of the others (check the margins).')
    would_need = 'signals that fail every specific classifier'

    def matches(self, sig):
        return True

    def confidence(self, sig):
        return 0.0

    def rejected_because(self, sig):
        return 'a specific classifier matched'

    def margin(self, sig):
        return (f"FALL-THROUGH: no classifier matched (co {sig['co_location_ratio']:.2f}, "
                f"reset-freq {sig['reset_frequency']:.2f}, notes-pages {sig['notes_page_count']}, "
                f"def-clustering {sig['def_clustering_ratio']:.2f}). LOW confidence — prime review candidate.")


PDF_CLASSIFIERS = [
    NoneClassifier(),
    WackStemClassifier(),
    PageBottomClassifier(),
    ChapterEndnotesClassifier(),
    DocumentEndnotesClassifier(),
]


_UNKNOWN_CLASSIFIER = UnknownClassifier()


# By-name lookup for the fork-story (covers all _PDF_CLASSES incl. the fall-through unknown).
_PDF_CLASSIFIERS_BY_NAME = {c.name: c for c in PDF_CLASSIFIERS}
_PDF_CLASSIFIERS_BY_NAME[_UNKNOWN_CLASSIFIER.name] = _UNKNOWN_CLASSIFIER


def _pdf_classification_story(chosen, sig):
    """Build the falsifiable fork-story for the PDF footnote-layout decision: why each OTHER layout
    was rejected, what evidence would flip it, and a near-miss margin. Now sourced from the per-class
    PdfClassifier units (each owns its rejected_because / would_need / margin). Iterates _PDF_CLASSES
    so the `considered` order is unchanged. Mirrors strategy.py:_strategy_considered. Pure read of
    the already-computed (rounded) signals."""
    considered = [{'option': k,
                   'rejected_because': _PDF_CLASSIFIERS_BY_NAME[k].rejected_because(sig),
                   'would_need': _PDF_CLASSIFIERS_BY_NAME[k].would_need}
                  for k in _PDF_CLASSES if k != chosen]
    return _PDF_RATIONALE[chosen], considered, _PDF_CLASSIFIERS_BY_NAME[chosen].margin(sig)


def classify_footnotes(response_dict):
    """Classify footnote style from raw OCR JSON before assembly.

    Returns a dict with classification, confidence, signals, page_summary, and the
    fork-story fields (rationale, considered, margin) consumed by assessment.json.
    """
    pages = response_dict["pages"]
    total_pages = len(pages)

    # --- Step 1: Per-page signal collection ---
    page_data = []  # list of {refs, defs, trailing_number}
    for page in pages:
        md = page.get("markdown", "")
        header = page.get("header") or ""
        md = convert_footnotes(md)

        # Inline refs: [^N] or [N] NOT at start of a line
        # Filter out numbers > 500 to avoid matching years like [2015]
        refs = set()
        for m in re.finditer(r'\[\^?(\d+)\]', md):
            num = int(m.group(1))
            if num > 500:
                continue
            pos = m.start()
            if pos == 0:
                continue
            if md[pos - 1] == '\n':
                # start of a line — likely a definition, not an inline ref
                continue
            refs.add(num)

        # Definitions: [^N] at start of line, or numbered list "1. Text" format,
        # or "N Text" format (no period — common in document endnotes)
        defs = set(int(n) for n in re.findall(r'^\[\^(\d+)\]', md, re.MULTILINE))
        defs |= set(int(n) for n in re.findall(r'^(\d{1,3})\. \S', md, re.MULTILINE))
        defs |= set(int(n) for n in re.findall(r'^(\d{1,3}) [A-Z\u2018\u201c\'"]', md, re.MULTILINE))

        # Trailing standalone number (page number candidate)
        trailing_num = None
        last_line = md.rstrip().rsplit('\n', 1)[-1].strip()
        if re.match(r'^\d{1,4}$', last_line):
            trailing_num = int(last_line)

        # Notes header detection
        has_notes_header = bool(
            re.search(r'\bNotes\b', header) or re.search(r'\bNOTES\b', header)
        )

        page_data.append({
            "refs": refs,
            "defs": defs,
            "trailing_number": trailing_num,
            "has_notes_header": has_notes_header,
        })

    # --- Step 2: Aggregate signals ---
    pages_with_refs = sum(1 for p in page_data if p["refs"])
    pages_with_defs = sum(1 for p in page_data if p["defs"])
    pages_with_both = sum(
        1 for p in page_data if p["refs"] & p["defs"]
    )

    co_location_ratio = (
        pages_with_both / pages_with_refs if pages_with_refs > 0 else 0.0
    )
    def_clustering_ratio = pages_with_defs / total_pages if total_pages > 0 else 0.0

    # Reset detection: when the lowest ref number on a page <= previous page's lowest ref
    reset_count = 0
    prev_min_ref = None
    for p in page_data:
        if p["refs"]:
            cur_min = min(p["refs"])
            if prev_min_ref is not None and cur_min <= prev_min_ref:
                reset_count += 1
            prev_min_ref = cur_min

    reset_frequency = reset_count / pages_with_refs if pages_with_refs > 0 else 0.0

    # Notes pages
    notes_page_indices = [i for i, p in enumerate(page_data) if p["has_notes_header"]]
    notes_page_count = len(notes_page_indices)

    # Page number detection via trailing numbers
    trailing_offsets = []
    for i, p in enumerate(page_data):
        if p["trailing_number"] is not None:
            trailing_offsets.append(p["trailing_number"] - i)

    if trailing_offsets:
        trailing_page_number_offset = median(trailing_offsets)
        matching = sum(
            1 for off in trailing_offsets if off == trailing_page_number_offset
        )
        trailing_page_number_consistency = matching / len(trailing_offsets)
    else:
        trailing_page_number_offset = None
        trailing_page_number_consistency = 0.0

    # Bibliography signal: how many pages does each ref number appear on?
    ref_page_spread = {}  # ref_number -> set of page indices
    for i, p in enumerate(page_data):
        for r in p["refs"]:
            ref_page_spread.setdefault(r, set()).add(i)

    ref_number_max_page_spread = (
        max(len(pgs) for pgs in ref_page_spread.values()) if ref_page_spread else 0
    )
    numbers_on_multiple_pages = sum(
        1 for pgs in ref_page_spread.values() if len(pgs) >= 2
    )

    all_refs = set()
    for p in page_data:
        all_refs |= p["refs"]
    max_ref_number = max(all_refs) if all_refs else 0

    signals = {
        "total_pages": total_pages,
        "pages_with_refs": pages_with_refs,
        "pages_with_defs": pages_with_defs,
        "pages_with_both": pages_with_both,
        "co_location_ratio": round(co_location_ratio, 4),
        "def_clustering_ratio": round(def_clustering_ratio, 4),
        "reset_count": reset_count,
        "reset_frequency": round(reset_frequency, 4),
        "notes_page_count": notes_page_count,
        "notes_page_indices": notes_page_indices,
        "trailing_page_number_offset": trailing_page_number_offset,
        "trailing_page_number_consistency": round(trailing_page_number_consistency, 4),
        "ref_number_max_page_spread": ref_number_max_page_spread,
        "numbers_on_multiple_pages": numbers_on_multiple_pages,
        "max_ref_number": max_ref_number,
    }

    # --- Step 3+4: Classification + confidence via the PDF_CLASSIFIERS registry ---
    # The decision tree is now an ordered registry of self-describing classifier units (first match
    # wins; UnknownClassifier is the fall-through). matches()/confidence() read the UNROUNDED signals
    # (the original tree + confidence used these raw locals), so this is behaviour-identical.
    _raw = {
        "pages_with_refs": pages_with_refs,
        "pages_with_both": pages_with_both,
        "pages_with_defs": pages_with_defs,
        "co_location_ratio": co_location_ratio,
        "def_clustering_ratio": def_clustering_ratio,
        "reset_count": reset_count,
        "reset_frequency": reset_frequency,
        "notes_page_count": notes_page_count,
        "ref_number_max_page_spread": ref_number_max_page_spread,
        "numbers_on_multiple_pages": numbers_on_multiple_pages,
        "max_ref_number": max_ref_number,
        "trailing_page_number_consistency": trailing_page_number_consistency,
    }
    chosen_classifier = _UNKNOWN_CLASSIFIER
    for _clf in PDF_CLASSIFIERS:
        if _clf.matches(_raw):
            chosen_classifier = _clf
            break
    classification = chosen_classifier.name
    confidence = chosen_classifier.confidence(_raw)

    # --- Build page summary (only pages with refs or defs) ---
    page_summary = []
    for i, p in enumerate(page_data):
        if p["refs"] or p["defs"]:
            page_summary.append({
                "index": i,
                "refs": sorted(p["refs"]),
                "defs": sorted(p["defs"]),
                "trailing_number": p["trailing_number"],
            })

    rationale, considered, margin = _pdf_classification_story(classification, signals)

    return {
        "version": 1,
        "classification": classification,
        "confidence": round(confidence, 2),
        "signals": signals,
        "page_summary": page_summary,
        "rationale": rationale,
        "considered": considered,
        "margin": margin,
    }

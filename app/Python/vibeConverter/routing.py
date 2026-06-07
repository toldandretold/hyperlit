"""vibeConverter.routing — which source modules to send the model + how to narrate the problem (issue routing)."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.runtime import (REPO_ROOT)




# Human phrasing for the uncertain decision(s) — for the user-facing progress narration.
_MODULE_PHRASE = {
    'pdf_footnote_classification': "how this PDF lays out its footnotes",
    'strategy_selection': "how this document's footnotes are structured",
    'footnote_linking_guard': "whether its footnotes can be linked safely",
    'citation_link_audit': "how to link its in-text citations",
    'footnote_audit': "its footnote linking",
    'epub_footnote_detection': "how this EPUB marks its footnotes",
    'bibliography_extraction': "its bibliography",
}




def _flagged_phrase(flagged):
    parts = []
    for r in flagged:
        p = _MODULE_PHRASE.get(r.get('module'))
        if p and p not in parts:
            parts.append(p)
    if not parts:
        return "how to handle this file"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]




_REAL_PATHS = None




def _real_path(basename):
    """Repo path of the REAL module with this basename, wherever it now lives under app/Python — the
    reorg moved the per-format readers into ingestion/<format>/ and the shared stages into
    digestion/<stage>/ + shared/, leaving thin re-export shims at the old flat paths. This skips the
    shims (so a fix patches the real registry, not the shim) and recurses the package tree. Cached."""
    global _REAL_PATHS
    if _REAL_PATHS is None:
        _REAL_PATHS = {}
        base = os.path.join(REPO_ROOT, 'app', 'Python')
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d != '__pycache__']
            for fn in files:
                if not fn.endswith('.py') or fn == '__init__.py':
                    continue
                full = os.path.join(root, fn)
                try:
                    if 'Compatibility shim' in open(full, encoding='utf-8').read(300):
                        continue
                except Exception:
                    pass
                _REAL_PATHS.setdefault(fn, os.path.relpath(full, REPO_ROOT).replace(os.sep, '/'))
    return _REAL_PATHS.get(basename, f'app/Python/conversion/{basename}')




def _code_ref_to_path(code_ref):
    """'strategy.py:foo' -> the repo path of the REAL strategy.py, wherever it now lives."""
    fname = (code_ref or '').split(':', 1)[0].strip()
    if not fname.endswith('.py'):
        return None
    return _real_path(fname)




# A module that was decomposed into a sibling rule/pass registry: sending the original (now often a
# thin shell or front-end orchestrator) must ALSO send the module that now holds the real logic, or
# the loop can't see — let alone op:add into — the rules/passes it's meant to extend. Keyed by repo
# path; values are extra repo paths to include alongside it.
# Keyed by BASENAME (resolved to the real path at use time, so it follows the reorg): a module that was
# decomposed into a sibling rule registry must be sent ALONGSIDE the module that now holds the real logic.
_DECOMPOSITION_SIBLINGS = {
    'citations.py': ['citation_link_rules.py'],
    'footnotes.py': ['footnote_link_rules.py'],
    # A bibliography that can't find its reference section is OFTEN a heading bug: the 'Bibliography'/
    # 'References' header is a styled <p>, not an <h*>, so the scan misses it (see structural_coverage).
    # Send heading detection alongside so the loop can fix the section HEADER, not just the matcher.
    'bibliography.py': ['headingMatching.py'],
    # EPUB + the shared front-end both route footnote linking through footnote_link_rules.py now.
    'epub_normalizer.py': ['footnote_link_rules.py'],
    'process_document.py': ['footnote_link_rules.py'],
    # EPUB phase-split: the footnote detectors + FootnoteConverter live in footnoteMatching.py; a fix
    # there usually needs the TRANSFORM_PIPELINE registration point (epub_normalizer.py) + the linker.
    'footnoteMatching.py': ['epub_normalizer.py', 'footnote_link_rules.py'],
    # PDF phase-split: a classification fix usually needs a matching assembler (a new layout = a new
    # classifier + its assembler); both lean on the pdf_shared.py helpers/bases. assemble_markdown runs
    # the recovery passes, so an assembly fix should see recovery.py too.
    'classification.py': ['assembly.py', 'pdf_shared.py'],
    'assembly.py': ['pdf_shared.py', 'recovery.py'],
    'recovery.py': ['pdf_shared.py'],
}




def _with_siblings(paths):
    """Expand each path with its decomposition siblings (see _DECOMPOSITION_SIBLINGS), preserving
    order and dropping duplicates — so a fix always sees the module that holds the real logic. Siblings
    are named by basename and resolved to their real (post-reorg) path."""
    out = []
    for p in paths:
        sibs = [_real_path(s) for s in _DECOMPOSITION_SIBLINGS.get(os.path.basename(p), [])]
        for q in [p] + sibs:
            if q not in out:
                out.append(q)
    return out




# Human-reported issue categories (the toast picker) → the module(s) to send + a one-line routing gloss.
# Used TWO ways: modules_for() includes these files EVEN WHEN the system flagged nothing — a WRONG link or
# bad heading is invisible to self-assessment, so the human is the only signal — and build_diagnostic_context
# renders the gloss as a high-priority "what the reader reports" section. Basenames resolve to real
# (post-reorg) paths via _real_path. Keep the FIVE keys in sync with the JS chips + the PHP enum.
_ISSUE_CATEGORY_MODULES = {
    'citations_not_matched':     ['bibliography.py', 'citation_link_rules.py', 'refkeys.py'],
    'citations_wrongly_matched': ['bibliography.py', 'refkeys.py', 'citation_link_rules.py'],
    'footnotes_not_matched':     ['footnotes.py', 'footnote_link_rules.py', 'strategy.py'],
    'footnotes_wrongly_matched': ['footnote_link_rules.py', 'footnotes.py'],
    'headings_wrong':            ['headingMatching.py', 'epub_normalizer.py', 'finalNormalisation.py'],
}



_ISSUE_CATEGORY_GLOSS = {
    'citations_not_matched':     ('in-text citations did NOT link to the bibliography — suspect the link '
                                  'TARGETS (bibliography extraction) or citation-style detection, OR that '
                                  'they were never real citations. Read the actual text before changing anything.'),
    'citations_wrongly_matched': ('a citation linked to the WRONG entry (not missing — WRONG). The pipeline '
                                  'CANNOT self-detect this; trust the human. Suspect key generation / '
                                  'author+year collision-suffixing (bibliography.py + refkeys.py) — a bare '
                                  '"(Author Year)" resolves to the LAST same-key entry.'),
    'footnotes_not_matched':     ('footnote markers did NOT reach their definitions. FIRST suspect '
                                  'DETECTION: does the pipeline even RECOGNISE this book\'s marker scheme? '
                                  'Compare the ACTUAL markers in the source (e.g. a bare or anchored '
                                  '"<sup>N</sup>", "<a href=#..><sup>N</sup></a>", or "[^N]") against the '
                                  'schemes the footnote DETECTOR handles (EPUB: footnoteMatching.py\'s '
                                  'detectors cover epub:type=noteref / role=doc-noteref / class=footnote-ref '
                                  '— note a bare <sup> numeral is NOT among them). If the scheme is '
                                  'unrecognised, teach the detector/strategy to see it. THEN consider '
                                  'extraction and the marker linker. Look UPSTREAM of the audit, which only '
                                  'MEASURES the gap — it never creates a link.'),
    'footnotes_wrongly_matched': ('a footnote marker opened the WRONG definition. The pipeline CANNOT '
                                  'self-detect this; trust the human. Suspect NUMBER-based pairing where '
                                  'numbering restarts/offsets — pair by EXPLICIT id, not number.'),
    'headings_wrong':            ('headings are missing / none are h1 / wrong hierarchy. Look at heading '
                                  'DETECTION (EPUB schemes in headingMatching.py) and level-gap normalisation '
                                  '(HeadingNormalizer in finalNormalisation.py), NOT the citation/footnote linkers.'),
}




# Short user-facing narration for a HUMAN-reported issue (issue_types). When the user picked a problem,
# the progress narration should describe THEIR report — not (only) what the pipeline self-flagged, which
# may be a different, chronic, or even false flag (e.g. "0/89 citations" firing while the user actually
# reported footnotes). Two forms: a noun for "you flagged {x}", a verb for "working out {x}".
_ISSUE_REPORT = {
    'citations_not_matched':     "in-text citations that didn't link to the bibliography",
    'citations_wrongly_matched': "citations that linked to the wrong entry",
    'footnotes_not_matched':     "footnotes that didn't reach their definitions",
    'footnotes_wrongly_matched': "footnote markers that opened the wrong definition",
    'headings_wrong':            "headings that are missing or wrongly structured",
}


_ISSUE_WORKING = {
    'citations_not_matched':     "how to link its in-text citations",
    'citations_wrongly_matched': "why its citations linked to the wrong entries",
    'footnotes_not_matched':     "how to link its footnotes to their definitions",
    'footnotes_wrongly_matched': "why its footnote markers opened the wrong definitions",
    'headings_wrong':            "how this document's headings are structured",
}




def _join_phrases(parts):
    """De-dup, drop blanks, and join with commas + a trailing 'and' (mirrors _flagged_phrase)."""
    out = []
    for p in parts:
        if p and p not in out:
            out.append(p)
    if not out:
        return None
    if len(out) == 1:
        return out[0]
    return ", ".join(out[:-1]) + " and " + out[-1]




def _issue_report_phrase(issue_types):
    return _join_phrases([_ISSUE_REPORT.get(c) for c in (issue_types or [])])




def _issue_working_phrase(issue_types):
    return _join_phrases([_ISSUE_WORKING.get(c) for c in (issue_types or [])])




def _issue_category_modules(issue_types):
    """Repo paths for the human-reported categories — sent EVEN when the system flagged nothing (a wrong
    link / bad heading is invisible to the pipeline's own assessment, so the report is the only signal).
    The lists are CURATED (no _with_siblings expansion) so a headings report doesn't drag in the footnote
    linker via an unrelated decomposition-sibling edge."""
    out = []
    for cat in (issue_types or []):
        for base in _ISSUE_CATEGORY_MODULES.get(cat, []):
            p = _real_path(base)
            if p not in out:
                out.append(p)
    return out




def _footnote_fix_modules(art):
    """A failing footnote_audit names audit.py — but audit.py only MEASURES the orphans; they're created
    upstream in the DETECTOR, and which detector depends on the PATHWAY this document took:
      • EPUB  → ingestion/epub/footnoteMatching.py — the EpubTransform detector registry that recognises a
        book's marker SCHEME (epub:type=noteref / role=doc-noteref / class=footnote-ref …); epub_normalizer
        is just the orchestrator, pulled in as a sibling for the TRANSFORM_PIPELINE registration point.
      • PDF   → ingestion/pdf/classification.py (PDF_CLASSIFIERS / classify_footnotes — picks the footnote
        LAYOUT) + assembly.py (turns that layout into the [^N] markers/defs). process_document only runs on
        the already-assembled markdown, so a PDF footnote MISS lives here, not downstream.
      • else (md/html/docx) → process_document.py — the shared orchestrator over the converted HTML.
    digestion/footnoteExtraction/footnotes.py (definition detection) is shared downstream, so always sent."""
    if art and art.get('is_epub'):
        front = [_real_path('footnoteMatching.py')]
    elif art and art.get('is_pdf'):
        front = [_real_path('classification.py'), _real_path('assembly.py')]
    else:
        front = [_real_path('process_document.py')]
    return _with_siblings([p for p in front if p] + [_real_path('footnotes.py')])




def _citation_fix_modules(art):
    """A citation_link_audit fork ("linked 0 of N") is usually NOT the linker's fault — a citation can
    only link if a matching bibliography entry exists. So the CAUSE is upstream: bibliography
    extraction (the link targets) or the citation-style detection. Send those alongside the linker so
    the model can fix the cause, not just the symptom (the Soviet-Marxism run wasted all 3 attempts on
    the orchestrator because bibliography.py — where references_found=1 came from — was never sent)."""
    return _with_siblings([_real_path('citations.py'), _real_path('bibliography.py')])




def modules_for(records, art=None, issue_types=None):
    """Module files named by the flagged forks' code_refs (the code to send the LLM), PLUS the modules a
    human reported via the issue picker (issue_types) — those are included even when the records are empty,
    because a wrong link / bad heading flags nothing in the system. A flagged footnote_audit is redirected
    to the detector/linker (see _footnote_fix_modules)."""
    paths = []

    def _add(p):
        if p and p not in paths and os.path.isfile(os.path.join(REPO_ROOT, p)):
            paths.append(p)

    # The HUMAN-reported categories LEAD — the user scoped the problem, so their files head the source dump
    # (build_prompt inlines in list order; the reader reads top-down). This keeps the chronic citation
    # red-herring self-flag from burying the footnote files the user actually asked about.
    for p in _issue_category_modules(issue_types):
        _add(p)
    # A footnote report ("not matched" / "wrongly matched") also needs the pathway's DETECTOR code — where
    # an unrecognised marker SCHEME (e.g. a bare/anchored <sup>N</sup>, which none of the EPUB detectors
    # catch) must be taught. _issue_category_modules sends the digestion extractor/linker; this adds the
    # scheme-detection registry (footnoteMatching.py for EPUB, process_document.py for the shared path) so
    # the model can SEE how detection currently works and extend it. Without it, a detection miss showed the
    # model only the linker — which can't link markers the detector never found.
    if set(issue_types or []) & {'footnotes_not_matched', 'footnotes_wrongly_matched'}:
        for p in _footnote_fix_modules(art):
            _add(p)
    # THEN the pipeline's own flagged forks (an additive signal that may corroborate the human OR be a red
    # herring — e.g. a chronic "0/N citations" that the reader knows is just an uncited reading list).
    for r in records:
        if r.get('module') == 'footnote_audit':
            for p in _footnote_fix_modules(art):
                _add(p)
            continue
        if r.get('module') == 'citation_link_audit':
            # Route the CAUSE (bibliography extraction = the link targets), not just the linker.
            for p in _citation_fix_modules(art):
                _add(p)
            continue
        # Send the code_ref's file AND any decomposition sibling that now holds the real logic
        # (e.g. citations.py is a thin shell over citation_link_rules.py).
        for p in _with_siblings([_code_ref_to_path(r.get('code_ref', ''))] if _code_ref_to_path(r.get('code_ref', '')) else []):
            _add(p)
    return paths

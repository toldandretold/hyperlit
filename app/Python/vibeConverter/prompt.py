"""vibeConverter.prompt — assemble the diagnostic prompt both engines send."""
import json
import os
import re
import sys
import subprocess
import shutil
import tempfile
import ast
import glob
from vibeConverter.diagnosis import (flagged_forks)
from vibeConverter.routing import (_ISSUE_CATEGORY_GLOSS, _code_ref_to_path)
from vibeConverter.runtime import (REGISTERABLE_LISTS, REPO_ROOT, _prompt_variant)
from vibeConverter.samplers import (_footnote_samples, _markup_in_context, _raw_footnote_markers, _reference_section)
from conversion import fix_categories




_PIPELINE_STRUCTURE = None




def _pipeline_structure():
    """The generated ingestion→digestion folder/file tree (tests/conversion/PIPELINE_STRUCTURE.generated.md,
    produced by gen_pipeline_tree.py from the actual folders). Folders mirror the decision tree, so this
    orients the model in the pipeline — which file holds which phase — BEFORE it reads the flagged node.
    Cached; '' if absent (e.g. a sandbox without tests/conversion)."""
    global _PIPELINE_STRUCTURE
    if _PIPELINE_STRUCTURE is None:
        path = os.path.join(REPO_ROOT, 'tests', 'conversion', 'PIPELINE_STRUCTURE.generated.md')
        try:
            raw = open(path, encoding='utf-8').read()
            # Drop the developer-facing front-matter (the "# Pipeline structure — GENERATED… / Built by
            # gen_pipeline_tree.py… no-drift test…" header). The model only needs the tree, not how it's
            # built; keep it from the first "## " section onward.
            i = raw.find('\n## ')
            _PIPELINE_STRUCTURE = (raw[i + 1:] if i != -1 else raw).strip()
        except Exception:
            _PIPELINE_STRUCTURE = ''
    return _PIPELINE_STRUCTURE




def _pathway_lines(records, flagged):
    """The ordered decision PATH this conversion took through the tree: each assessment record as
    `module → real file (code_ref)`, ⚑-marking the flagged node(s) and resolving each code_ref to the
    file that actually holds the logic — so "you are here, the flagged node is X, edit file Y" is explicit
    (and survives the phase-split: code_refs now name footnoteMatching.py / classification.py / etc.)."""
    out = []
    for r in records:
        mark = '⚑ ' if any(r is f for f in flagged) else '· '
        cr = r.get('code_ref', '')
        path = _code_ref_to_path(cr)
        out.append(f"{mark}{r.get('module', '?')} → {path or cr or '(no code_ref)'}")
    return out




# Each conversion stat, glossed: (what the number COUNTS, which pipeline step COMPUTES it). The file is a
# real tree node — the model can cross-reference the pipeline section. Read as a chain: a citation links
# only if its target was extracted; a footnote links only if its definition was detected + its marker survived.
_STAT_GLOSS = {
    'references_found': ("bibliography entries EXTRACTED from the reference/notes section — the LINK TARGETS a "
                         "citation can point at", "digestion/bibliographyExtraction/bibliography.py (extract_bibliography)"),
    'citations_total': ("in-text \"(Author Year)\" / \"[Author Year]\" citations FOUND in the body text",
                        "digestion/citationLinking/citations.py → citation_link_rules.py (link_citations)"),
    'citations_linked': ("of citations_total, how many matched a references_found entry by key — if "
                         "citations_total far exceeds references_found, most citations have NO target (the "
                         "bibliography is incomplete): look UPSTREAM at extraction, not the linker",
                         "digestion/citationLinking/citation_link_rules.py"),
    'footnotes_matched': ("footnote DEFINITIONS extracted and linked to an in-text marker",
                          "digestion/footnoteExtraction/footnotes.py + digestion/footnoteLinking/footnote_link_rules.py"),
    'footnote_strategy': ("how this document lays out footnotes — picked by the strategy selector (STRATEGY_RULES); "
                          "drives how markers get wired to definitions",
                          "digestion/strategySelection/strategy.py (analyze_document_structure)"),
    'citation_style': ("the detected in-text citation style driving the linker — a MIS-detection (e.g. "
                       "author-year on a numbered-footnote book) makes a \"0/N\" linked count NOISE, not a bug",
                       "digestion/process_document.py (the stats pass, from citationLinking signals)"),
}




def _render_stats(st):
    """The symptom, but legible: each stat with what it COUNTS and the file that COMPUTES it (a tree node).
    So '8 references / 24 citations / 0 linked' reads as a causal chain, not six opaque numbers."""
    lines = ["## What converted — and WHERE each number comes from",
             "Each line is `stat = value` — what it counts · the pipeline step that computes it (find that "
             "file in the pipeline tree below). They form a CHAIN: a citation links only if its target was "
             "extracted; a footnote links only if its definition was detected AND its marker survived."]
    for k in ('references_found', 'citations_total', 'citations_linked',
              'footnotes_matched', 'footnote_strategy', 'citation_style'):
        meaning, src = _STAT_GLOSS[k]
        lines.append(f"- {k} = {json.dumps(st.get(k))} — {meaning} · {src}")
    return "\n".join(lines)




# ---------------------------------------------------------------------------
# 2. Build the prompt
# ---------------------------------------------------------------------------
def build_diagnostic_context(art, modules, user_note=None, issue_types=None):
    """The SHARED diagnostic payload BOTH engines send (native + aider), so native-vs-aider —
    and model-vs-model — is a CONTROLLED experiment: the DIAGNOSIS is byte-identical; only the edit
    MECHANISM (JSON ops vs aider's diff+`--test-cmd` loop) and how the module SOURCE is delivered (native
    inlines it because an API completion can't read files; aider reads it via its repo-map) may differ.
    Returns a list of section strings (no leading newlines); each engine prepends its mechanism intro and
    appends its mechanism tail, then joins. Edit a diagnostic section HERE and both engines get it."""
    flagged = flagged_forks(art['assessment'])
    st = art['stats']
    parts = []

    # ── 1. WHAT THE HUMAN REPORTED (lead with it — weigh heavily) ─────────────────────────────────
    if user_note:
        parts.append("## What the reader says is wrong (human-spotted — weigh this heavily)\n"
                     + user_note.strip()[:1500])
    if issue_types:
        gl = ["## What the reader reports (structured signals — the human caught what the pipeline could "
              "NOT self-detect; weigh heavily and start here)"]
        for cat in issue_types:
            label = cat.replace('_', ' ')
            gloss = _ISSUE_CATEGORY_GLOSS.get(cat)
            gl.append(f"- **{label}** → {gloss}" if gloss else f"- **{label}**")
        parts.append("\n".join(gl))
    parts.append(_render_stats(st))
    flagged_block = ["## Flagged decisions (assessment.json — where the pipeline was unsure or dropped work)"]
    for r in flagged:
        flagged_block.append(json.dumps({k: r.get(k) for k in
                             ('module', 'code_ref', 'node_help', 'decision', 'rationale', 'margin',
                              'considered', 'evidence')  # evidence carries e.g. unlinked_sample / the counts
                             if r.get(k) is not None}, ensure_ascii=False, indent=2)[:2200])
    parts.append("\n".join(flagged_block))
    if art['assessment']:
        parts.append("## Where it happened — this conversion's PATHWAY through the pipeline\n"
                     "The ordered decisions this document took; ⚑ marks a node the pipeline flagged as "
                     "UNCERTAIN — a SUSPICION to verify, not a proven fault — and each line resolves to the "
                     "real file to inspect:\n"
                     + "\n".join(_pathway_lines(art['assessment'], flagged)))

    # ── 2. THE PIPELINE (orientation — every step is a file with a stated job) ────────────────────
    struct = _pipeline_structure()
    if struct:
        parts.append("## The conversion pipeline — every step is a file with a stated job (folders ARE the tree)\n"
                     "Don't read this as 'ingestion just converts to HTML' — ingestion does the hard, "
                     "format-specific work: PDF classifies the physical footnote LAYOUT; EPUB detects the "
                     "footnote markup SCHEME and recovers real headings + structure; etc. DIGESTION then selects "
                     "a footnote strategy, extracts the definitions + the bibliography, links every marker and "
                     "citation by ordered rules, and audits the result. The flagged node above lives in ONE of "
                     "these files — read its one-line job to confirm it's the right place to fix:\n" + struct)

    # ── 3. HOW TO LOCALIZE (reason before editing) ───────────────────────────────────────────────
    if art.get('is_pdf'):
        parts.append("## IMPORTANT — this is a PDF; the OCR is REPLAYED FROM CACHE\n"
                     "The Mistral OCR output (ocr_response.json) is fixed and replayed — your fix is "
                     "validated by re-running mistral_ocr.py's ASSEMBLY (classify_footnotes, "
                     "assemble_markdown, renumber_page_footnotes, etc.) → simple_md_to_html → "
                     "process_document. Do NOT change the OCR call itself (fetch_ocr / extract_footer / "
                     "extract_header) — those only affect a fresh OCR and CANNOT be validated or applied "
                     "to this document.")
    parts.append(
        "## How to localize the cause — read the stats as a CAUSAL CHAIN and, IF confirmed, fix the EARLIEST cause\n"
        "- `citations_linked` is DOWNSTREAM of `references_found`: a citation links ONLY if a matching "
        "bibliography entry exists. So `citations 0/158` with `references_found 1` means the link "
        "TARGETS are missing — the cause is bibliography extraction (bibliography.py) or a mis-detected "
        "citation_style, NOT the citation linker. Editing the linker cannot link to entries that were "
        "never extracted. (And `style=author-year-bracket` on a numbered-footnote book is likely a "
        "mis-detection — then `0/N` is NOISE, not a bug: prefer NO change over 'fixing' a non-problem.)\n"
        "- footnotes: a marker links only if its definition was DETECTED and the marker SURVIVED. A "
        "definition absent from the input/markdown can never be linked downstream — look upstream.\n"
        + ("- [PDF] the pipeline is OCR(cached) → main-text.md → simple_md_to_html → process_document. "
           "ASK: is the missing artifact ABSENT from the assembled markdown (→ cause is UPSTREAM in "
           "mistral_ocr ASSEMBLY: classify_footnotes / assemble_markdown) or PRESENT-but-unlinked (→ "
           "cause is the downstream linker)? Localize before editing.\n" if art.get('is_pdf') else "")
        + "- Prefer the SMALLEST edit to the DECISION function that made this call. Adding a new DocPass to "
        "DOC_PASSES is high-blast-radius and frequently crashes — reserve a NEW phase for a genuinely new "
        "phase, never as a way to patch a linking/extraction symptom.")

    # ── 4. EVIDENCE from THIS document ───────────────────────────────────────────────────────────
    parts.append("## Audit verdict (audit.json)\n" + json.dumps({k: art['audit'].get(k) for k in
                 ('total_refs', 'total_defs', 'gaps', 'unmatched_refs', 'unmatched_defs')},
                 ensure_ascii=False, default=str)[:2000])
    samples = _footnote_samples(art)
    if samples:
        parts.append("## Actual footnote ref/definition lines from THIS document (what must link)\n" + samples
                     + "\n\nLinking principle: if a marker carries an EXPLICIT target — href=\"#id\", or a "
                     "definition that back-links to the marker's id — pair them by that id correspondence, NOT "
                     "by number. Number-based pairing mis-aligns whenever numbering restarts or is offset across "
                     "segments. A mis-aligned link is worse than no link.")

    # When the RAW source is full of footnote-MARKER shapes but few were detected, the converter doesn't
    # recognise THIS book's marker scheme — show the model the actual shapes (what a human would paste from
    # dev-tools). Gate: footnotes were reported, OR raw markers vastly exceed detected definitions.
    det = st.get('footnotes_matched') or 0
    fn_reported = bool(set(issue_types or []) & {'footnotes_not_matched', 'footnotes_wrongly_matched'})
    raw_n, raw_samples = _raw_footnote_markers(art)
    if raw_samples and (fn_reported or raw_n >= max(10, det * 3)):
        parts.append(
            "## Footnote-marker shapes in the RAW source — the DETECTOR likely missed this book's scheme\n"
            f"The raw source contains ~{raw_n} footnote-marker-shaped element(s) (superscript numerals / "
            f"`#`-href note anchors), but only {det} footnote definition(s) were detected. When raw markers "
            f"far exceed detected footnotes the cause is footnote DETECTION / strategy selection — the "
            f"pipeline doesn't recognise THIS book's marker scheme (here it is NOT `epub:type=noteref` or "
            f"`class=footnote-ref` but a bare `<sup>N</sup>` / `<a href=\"#..\"><sup>N</sup></a>`). Confirm "
            f"the scheme against these VERBATIM samples from the source, then teach the EPUB footnote "
            f"detector / strategy selector to recognise it (look UPSTREAM of the linker and audit):\n- "
            + "\n- ".join(raw_samples))
        # The robust path for the common case: id-anchored markers. Instead of hand-writing a detector
        # (which can crash at runtime), register a DECLARATIVE scheme — the factory is tested + safe.
        if art.get('is_epub'):
            parts.append(
                "## EASIEST FIX for id-anchored EPUB footnotes — register a declarative scheme (no class to write)\n"
                "If the marker is an `<a href=\"#X\">` (usually carrying a `<sup>`) that points BY ID at a "
                "definition — an empty `<a id=X></a>` (note text in the following block) or an `<hN id=X>Note N</hN>` "
                "— do NOT write a detector. `AnchoredFootnoteScheme` already handles this family; just op:register "
                "ONE instance into `TRANSFORM_PIPELINE` (in epub_normalizer.py):\n"
                "  AnchoredFootnoteScheme(name='MySchemeFootnoteDetector', marker='sup-link', "
                "definition='empty-anchor', content='following-siblings', boundary='heading-or-anchor', "
                "strip_number=True)\n"
                "Pick the parameters from the VERBATIM samples above:\n"
                "  • marker:     'sup-link' (the <a href> carries a <sup>)  |  'any-href' (any <a href=#X>)\n"
                "  • definition: 'empty-anchor' (empty <a id=X></a> + note follows)  |  'note-heading' (<hN id=X>Note N</hN>)\n"
                "  • boundary:   'heading-or-anchor' (stop at the next note anchor)  |  'heading'\n"
                "  • strip_number: drop a leading '1 ' from the note text\n"
                "It pairs ONLY by id (never by number) and ignores targets with no following note block, so it "
                "won't over-match TOC/page links. If the scheme is NOT id-anchored (table layout, number-paired, "
                "etc.), fall back to op:add a bespoke EpubTransform (the add_epub_detector category).")
    ctx = _markup_in_context(art)
    if ctx:
        parts.append("## Markup in context (a reference + a definition INSIDE their block — the element "
                     "nesting a fixed excerpt hides; for an EPUB also the RAW pre-conversion markup)\n" + ctx)
    refsec = _reference_section(art)
    if refsec:
        parts.append("## The document's reference section (the RAW region the bibliography extractor scanned)\n"
                     "Count the entries HERE vs `references_found` above — if there are clearly more entries "
                     "than were extracted, the bug is upstream in extraction; if there are genuinely few, the "
                     "unlinked citations simply have no target (don't force a link).\n" + refsec)
    if art.get('source'):
        parts.append("## Converted document (head, truncated)\n" + art['source'][:5000])

    # ── 5. FIX SHAPES (variant-gated — `lean` drops the menu to A/B against the self-describing tree) ─
    if _prompt_variant() != 'lean':
        parts.append(fix_categories.render_prompt_block(modules))

    # ── 6. PRINCIPLE ─────────────────────────────────────────────────────────────────────────────
    parts.append("## Principle\nEvery item above is a SUSPICION, not a verdict. FIRST confirm it against the "
                 "actual text / evidence shown here. If a suspicion does NOT hold, proposing NO change (with "
                 "a one-line reason why it's fine) is a CORRECT, valued outcome — the gate credits "
                 "not-'fixing' a non-problem. Fix ONLY what you can confirm is genuinely wrong. Then uphold "
                 "the modus operandi: correct where determinable, NO link where ambiguous — a wrong/misaligned "
                 "link is WORSE than a missing one. Make the MINIMAL change that fixes the cause; don't "
                 "rewrite whole functions to change a few lines.")
    return parts




def build_prompt(art, module_paths, user_note=None, issue_types=None):
    """The NATIVE engine prompt = the shared diagnostic context + the module SOURCE inlined (an API
    completion can't read files) + the JSON-ops edit contract. The diagnosis is identical to the aider
    engine's (vibe_aider.build_aider_message) — see build_diagnostic_context. (The engine is model-
    agnostic: it runs whatever --model it's given; don't name it after a model.)"""
    parts = ["You are improving a document-conversion pipeline. A book's conversion was flagged for "
             "review. Below are the SUSPECTED issues (what converted + where each number comes from), the "
             "pipeline's own UNCERTAIN decisions, the pipeline structure, the audit verdict, and the module "
             "source. Each item is a suspicion to CONFIRM against the evidence, not a proven fault."]
    parts += build_diagnostic_context(art, module_paths, user_note, issue_types)
    parts.append("## Responsible module source (you may edit any function in these files)")
    for p in module_paths:
        parts.append(f"--- {p} ---\n" + open(os.path.join(REPO_ROOT, p), encoding='utf-8').read())
    parts.append(
        "## Your task\n"
        "Return STRICT JSON: {\"rationale\": str, \"functions\": [<edit>, ...]} where each <edit> is "
        "ONE change carrying an \"op\" (and an optional \"category\" = the fix-category id you used):\n"
        "  • op=\"edit\" — PREFER THIS for modifying existing code. {file, search, replace, name?}: "
        "replaces the first occurrence of `search` with `replace`. Copy `search` VERBATIM from the "
        "source shown above — a few UNIQUE lines with their exact indentation. Optional `name` "
        "(\"func\" or \"Class.method\") scopes the search to one function so an identical line "
        "elsewhere isn't matched. Change ONLY the lines that differ — do NOT resend the whole function.\n"
        "  • op=\"replace\" — {file, name, code}: full-body swap of an EXISTING function. Use ONLY for a "
        "SMALL function; for a big method use op:edit (resending 100 lines to change 3 keeps breaking it).\n"
        "  • op=\"add\" — {file, name, code}: a NEW top-level function or class (e.g. a new EpubTransform).\n"
        "  • op=\"register\" — {file, name, code}: append to a module-level list/tuple — `name` is the "
        f"LIST name (only {sorted(REGISTERABLE_LISTS)}), `code` is the expression to append (e.g. \"MyDetector()\").\n"
        "`file` may only be app/Python/conversion/*.py or a shown front-end module. Combine edits ONLY when "
        "one fix spans stages (op:add a detector + op:register it). Keep edits minimal.\n"
        "SINGLE-CONCERN: fix the ONE highest-confidence root cause in this patch. Do NOT bundle a second, "
        "unrelated edit (e.g. a bibliography fix alongside a footnote fix) — edits apply best-effort, but a "
        "shaky extra edit whose search text is slightly off just wastes the attempt and muddies the signal. "
        "Land the sure thing alone; the next attempt can tackle the next cause.")
    return "\n\n".join(parts)

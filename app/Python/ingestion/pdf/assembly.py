"""Phase ② — assemble the markdown per layout. The PDF_ASSEMBLERS registry (one FootnoteAssembler per classification) + assemble_markdown, which runs the chosen assembler then the recovery passes and writes main-text.md. Imports the recovery helpers it needs."""
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
from ingestion.pdf.recovery import (  # noqa: F401
    fix_mangled_urls, extract_pypdf_footnote_defs, recover_missing_defs,
)

# A footer line that opens a footnote DEFINITION, restricted to the marker shapes the shared
# normaliser (normalize_all_footnote_refs → the `^[^N] text` → `[^N]:` rule) reliably turns into a
# definition: unicode superscript (⁹), LaTeX ($^{25}$), or bracket ([^9] / [9]). A PLAIN leading
# number ("6 Engels…") is deliberately EXCLUDED — it is ambiguous with list items / page numbers and
# the normaliser leaves it as prose, so pulling it in would only inject an unlinked paragraph
# (page-bottom-plain-number defs stay the province of the notes-page conversion + pypdf recovery).
_FOOTER_FN_DEF_SIGNAL = re.compile(
    r'(?m)^\s*(?:'
    r'[¹²³⁰-⁹]'            # unicode superscript digit
    r'|\$\^\{?\d+\}?\$'                             # $^{N}$
    r'|\[\^?\d+\]'                                  # [^N] or [N]
    r')'
)

# The number-period-sentence footer form ("1. Abdellatif Ghissassi…") — how Mistral OCR 4 (and the
# OCR-4 aliases 2503/2505/-latest) emits page-bottom footnote defs into extract_footer's `footer`
# field. Deliberately KEPT SEPARATE from _FOOTER_FN_DEF_SIGNAL so it feeds ONLY the early fold
# (fold_footer_defs_into_markdown), never the legacy assemble-time append — that append runs AFTER
# renumber, where a page-local "1." no longer matches its already-globalised ref, so recognising `N.`
# there would inject unlinked prose (and drift the assembly snapshot). The fold runs BEFORE renumber,
# so the def travels the exact OCR-3 inline path and links. The `.` + sentence-case, inside the
# footer note-area, disambiguates from a bare "6 Engels…" list item; a stray numbered LIST folded in
# stays harmlessly unlinked (its 1,2,3 won't match the page's globalised ref numbers).
_FOOTER_NUMDOT_DEF_SIGNAL = re.compile(r'(?m)^\s*\d{1,3}\.[ \t]+(?=[A-Z‘“"\'])')

# A page-bottom footnote def Mistral emitted as a BARE number: "27 I am ignoring here…" (Barro
# fn 27/28). Only in a FOOTER is a line-start "N Sentence" unambiguously a footnote (the footer IS
# the page-bottom note area — not body, where a bare number is a list/citation). Require sentence
# case after the number ("27 There…", "27 I am…") so an ALL-CAPS running header ("27 THE JOURNAL
# OF…") or a lone page number is left alone.
_FOOTER_BARE_NUM_DEF = re.compile(r'(?m)^([ \t]*)(\d{1,3})[ \t]+(?=[A-Z][a-z]|[A-Z][ \t]+[a-z])')


def _footer_footnote_defs(footer):
    """Return the footer's text when it carries page-bottom footnote DEFINITIONS, else ''.

    Mistral OCR is called with extract_footer=True, so it splits page-bottom footnotes into
    each page's `footer` field. assemble_markdown historically read only `markdown`, silently
    dropping every footnote whose definition landed in the footer — the Calvo-Clause bug
    (58 defs collapsed to the 5 that happened to land inline, so every in-text marker rendered
    unmatched). We pull the footer back into the page body IN PAGE ORDER, so the definitions
    ascend into a single section that the sequential linker can match. Gated on a real def
    signal so pure page-chrome footers (page numbers, running journal lines) are left alone."""
    if not footer or not footer.strip():
        return ''
    return footer.strip() if _FOOTER_FN_DEF_SIGNAL.search(footer) else ''


def fold_footer_defs_into_markdown(response_dict):
    """Normalise an OCR-4-style response to the OCR-3 shape: fold each page's `footer` field
    (when it carries page-bottom footnote DEFINITIONS) onto the END of that page's `markdown`.

    Why early, not at assemble time: OCR 4 (extract_footer=True) lifts each definition OUT of the
    markdown into the `footer` field, still page-locally numbered ("1. Abdellatif …"). But for
    page_bottom books `renumber_chunk_footnotes` rewrites the IN-TEXT ref to a GLOBAL number
    ([^132]) before assembly — so a footer def appended later (still "1.") no longer matches its
    ref and the linker drops it (OCR 4 fell to ~22% def coverage vs OCR 3's ~92%). Folding the
    footer INTO the markdown before any renumbering means the def travels through the exact same
    passes as an OCR-3 inline def, so the whole downstream pipeline stays model-agnostic and OCR 4
    recovers to ~89%.

    Graceful + non-blocking: a no-op when `footer` is empty (OCR 3 leaves defs inline) or carries
    no def signal (pure page chrome). Clears the folded footer so the assemble-time footer append
    can't double it. Idempotent via `_footer_folded`. Returns the number of pages folded.

    Caller MUST gate to classification == 'page_bottom' — the ONLY layout where extract_footer yields
    page-bottom DEFINITIONS. For other layouts (none / author-year-bracket / endnotes) a populated
    `footer` is references / numbered lists / chrome, and folding it corrupts them (measured
    regressions when ungated: author-year-bracket references 16→3, a 'none' book footnotes 86→138).
    Re-classify on the richer markdown after folding."""
    if response_dict.get("_footer_folded"):
        return 0
    folded = 0
    for page in response_dict.get("pages", []):
        footer = page.get("footer") or ""
        if not footer.strip():
            continue
        # Fold when the footer opens a def in ANY recognised shape — the legacy signals
        # (superscript / LaTeX / [^N]) OR OCR 4's number-period form ("1. Abdellatif …").
        if not (_FOOTER_FN_DEF_SIGNAL.search(footer) or _FOOTER_NUMDOT_DEF_SIGNAL.search(footer)):
            continue
        md = page.get("markdown", "") or ""
        defs = footer.strip()
        page["markdown"] = f"{md}\n\n{defs}" if md.strip() else defs
        page["footer"] = ""  # folded — prevent the assemble-time append from re-adding it
        folded += 1
    response_dict["_footer_folded"] = 1
    return folded


def _footer_bare_num_defs(footer):
    """Extract page-bottom footnote defs Mistral emitted as a BARE number ("27 I am ignoring…")
    as {num: text}. A bare number is ambiguous (list item / page number / citation), so — unlike
    the [^N]/superscript defs above — these are only CANDIDATES: the caller injects one solely when
    an in-text marker [^N] is orphaned for that number (Barro fn 27/28 have markers; soviet_marxism's
    "6 Engels, Letter to Franz Mehring…" has none, so it must stay out — it can't be linked)."""
    out = {}
    if not footer or not footer.strip():
        return out
    for m in _FOOTER_BARE_NUM_DEF.finditer(footer):
        start = m.start()
        nl = footer.find('\n', m.end())
        line = footer[start:(nl if nl != -1 else len(footer))]
        num = m.group(2)
        out[num] = re.sub(r'^[ \t]*' + num + r'[ \t]+', '', line).strip()
    return out


# A paragraph that unambiguously OPENS a footnote definition, judged by its first line:
# caret-bracket ([^N]: / [^N] text), a line-start unicode superscript (¹ text), a line-start LaTeX
# superscript ($^{1}$ text), or a line-start bare caret (^23 text). Deliberately NOT the plain
# bracket form "[N] text" — at line start that is just as often a bibliography entry, and moving
# those away from their References heading would break the extraction stage's bibliography exclusion.
_DEF_PARAGRAPH_OPENER_RE = re.compile(
    r'^\s*(?:'
    r'\[\^\d+\][:.]?(?:\s|$)'          # [^N]: text / [^N] text
    r'|[¹²³⁰-⁹]+\s'         # ¹ text
    r'|\$\^\{?\d+(?:\s*,\s*\d+)*\}?\$\s'                # $^{1}$ text / $^{1,2}$ text
    r'|\^\d{1,3}\s'                                     # ^23 text
    r')'
)


_DEF_TRAILING_REF_RE = re.compile(r'(?:\s*\[\^\d+\])+\s*$')
_DEF_TERMINAL_PUNCT = ('.', '!', '?', ':', ';', '"', "'", '”', '’', ')', ']')


def _ends_mid_sentence(paragraph):
    """Does this (def) paragraph end mid-sentence — i.e. its note continues on the next page?

    True only when it ends in a LOWERCASE WORD with no terminal punctuation (Cox fn 12: "…of some
    major"). A trailing digit is NOT mid-sentence — citations routinely end in bare page/year
    numbers ("H. W. Briggs, Op.Cit. pp. 505-507"), and reading those as open made the gate absorb
    the next page's lowercase BODY continuation into the footnote (Calvo Clause)."""
    t = _DEF_TRAILING_REF_RE.sub('', (paragraph or '').strip()).rstrip()
    t = re.sub(r'<[^>]+>', '', t).rstrip()
    if not t or t.endswith(_DEF_TERMINAL_PUNCT):
        return False
    return bool(re.search(r'[a-z]{2,}$', t))


def _split_out_definition_paragraphs(md, open_tail=False):
    """Partition a page's markdown into (body, defs, still_open) at PARAGRAPH granularity.

    Any blank-line-separated paragraph whose first line is an unambiguous footnote-definition
    opener goes to `defs`; everything else stays in `body`, order preserved. Unlike
    split_body_and_footnotes (page_bottom's trailing-block split at the FIRST def line), this
    tolerates defs scattered mid-page and body text resuming after them — the 'unknown' layout
    makes no bottom-of-page promise.

    A page-spanning footnote (cut mid-sentence at the page turn, continuation opening the next
    page in lowercase — Cox 'Real Socialism' fn 12: "…of some major" / "capitalist countries…")
    must keep its continuation: while the def stream's tail ends MID-SENTENCE, a following
    lowercase-initial paragraph is routed to defs too. `open_tail` carries that state in from
    the previous page; `still_open` carries it out. A def that ends with terminal punctuation
    followed by lowercase body (Barro fn 1: "…tax liability.'" / "the relevant horizon…") is
    NOT continued — the completeness gate is what separates the two shapes."""
    body_parts, def_parts = [], []
    tail_open = open_tail       # the last def routed to `defs` ends mid-sentence
    after_def = open_tail       # the previous paragraph was routed to `defs`
    for para in re.split(r'\n\s*\n', md):
        p = para.strip()
        if not p:
            continue
        if _DEF_PARAGRAPH_OPENER_RE.match(p):
            def_parts.append(para.strip('\n'))
            after_def, tail_open = True, _ends_mid_sentence(p)
        elif after_def and tail_open and p[:1].islower():
            def_parts.append(para.strip('\n'))          # page/paragraph-spanning continuation
            tail_open = _ends_mid_sentence(p)
        else:
            body_parts.append(para.strip('\n'))
            after_def = tail_open = False
    return '\n\n'.join(body_parts), '\n\n'.join(def_parts), (after_def and tail_open)


# A GLUED line-start def: "[^1]Associate Professor…" — Mistral renders affiliation-block
# superscripts with no space, so the generic "[^N] text" → "[^N]: text" colon fix never sees them.
_GLUED_AFFIL_DEF_RE = re.compile(r'^\[\^(\d{1,2})\]([A-Za-z(“"\'].*)$')


def _resolve_affiliation_block(combined):
    """An author line ("Name[^1], Name[^2], … Name[^9]") followed by a run of GLUED line-start
    defs ("[^1]Associate Professor…") is an AFFILIATION block — a numbering universe of its own.
    Unglue the defs into [^N]: form so author→affiliation links work (book 2e9728f6 wants this) —
    UNLESS any of the block's numbers is ALSO defined elsewhere in the document (824c39fd: real
    footnotes ¹/² restart the same numbers for JIF notes): then author-marker→def-number is
    ambiguous, so DEMOTE the whole universe — strip the author-line markers, plain-text the def
    lines. A wrong link is worse than a missing one."""
    lines = combined.split('\n')
    author_idx, author_refs = None, []
    for i, line in enumerate(lines[:50]):
        if line.startswith('[^'):
            continue
        refs = re.findall(r'\[\^(\d{1,2})\]', line)
        if len(refs) >= 3:
            author_idx, author_refs = i, refs
            break
    if author_idx is None:
        return combined
    glued = []                                  # (line_idx, num_str, rest)
    for i in range(author_idx + 1, min(author_idx + 45, len(lines))):
        s = lines[i]
        if not s.strip():
            continue
        m = _GLUED_AFFIL_DEF_RE.match(s)
        if m:
            glued.append((i, m.group(1), m.group(2)))
        elif glued:
            break
        elif i > author_idx + 3:
            break                               # block must start right under the author line
    glued_nums = {n for _i, n, _r in glued}
    if len(glued) < 3 or len(set(author_refs) & glued_nums) < 3:
        return combined
    glued_line_idxs = {i for i, _n, _r in glued}
    other_defs = set()
    for i, line in enumerate(lines):
        if i in glued_line_idxs:
            continue
        m = re.match(r'^\[\^(\d+)\]', line)
        if m:
            other_defs.add(m.group(1))
    collides = bool(glued_nums & other_defs)
    seen = set()
    for i, n, rest in glued:
        if collides:
            lines[i] = f'{n}. {rest}'
        elif n in seen:
            lines[i] = rest                     # duplicate number inside the block (OCR misread) —
        else:                                   # a second [^N]: def would steal the link
            lines[i] = f'[^{n}]: {rest}'
            seen.add(n)
    if collides:
        lines[author_idx] = re.sub(r'\[\^\d{1,2}\]', '', lines[author_idx])
    return '\n'.join(lines)


# A paragraph that opens like a BIBLIOGRAPHY entry, not a footnote — author-first ("Pimm SL,
# Russell GJ", "Bailey, M. J.") or carrying an "(1995)" author-year cite near the front. Such a
# paragraph must never be pulled out as a "recovered" footnote def.
_BIB_OPENER_RE = re.compile(
    r"^[A-Z][A-Za-z'’-]+,\s+[A-Z]\.?"          # Bailey, M. J.
    r"|^[A-Z][a-z]+\s+[A-Z]{1,3},"             # Pimm SL,   Russell GJ,
)


def _looks_like_bibliography_entry(text):
    head = text[:90]
    return bool(_BIB_OPENER_RE.match(text) or re.search(r'\(\d{4}[a-z]?\)', head))


def _recover_orphan_plain_defs(combined, footer_candidates=None):
    """Recover footnote defs for ORPHANED in-text markers [^N] (a ref with no [^N]: definition).

    Two sources, both keyed on the orphan set so an unlinkable def is never injected:
      1. A bare-number FOOTER def candidate {N: text} the caller collected — a page-bottom note
         Mistral emitted as "27 I am ignoring…" (Barro fn 27/28). Injected only when [^N] is
         orphaned, so soviet_marxism's markerless "6 Engels, Letter…" stays out.
      2. A plain "N Text…" PARAGRAPH stranded in the body (Barro's "29 The usual fiscal analysis…"
         OCR'd into the References). A plain leading number is otherwise too ambiguous (numbered
         lists / Vancouver bibliographies), so this is gated hard: leading-number paragraphs must
         be RARE (a numbered biblio has many), the paragraph long PROSE, not author/'(year)'-shaped.
    """
    refs, defs = set(), set()
    for m in re.finditer(r'\[\^(\d+)\]', combined):
        (defs if (m.start() == 0 or combined[m.start() - 1] == '\n') else refs).add(m.group(1))
    orphans = refs - defs
    if not orphans:
        return combined
    recovered = []
    # Source 1: bare-number footer candidates for orphaned markers.
    for n in sorted(orphans, key=int):
        txt = (footer_candidates or {}).get(n)
        if txt:
            recovered.append(f'[^{n}]: ' + txt)
    still_orphan = orphans - {n for n in orphans if (footer_candidates or {}).get(n)}
    # Source 1.5: a RUN of consecutive plain "N Text" LINES continuing an already-converted def
    # sequence — Mistral drops the superscript style when a def block spans a page break ("⁶ Cagliari…"
    # on one page, plain "7 Goldsmiths…" on the next; book 2e9728f6's author affiliations 7–12).
    # Keyed hard so numbered LISTS never convert: numbers must ascend by exactly 1, EVERY number must
    # be an orphaned ref, and the run must continue a converted def ([^first-1]: exists) — a real list
    # restarts at 1 and its numbers aren't orphans. Runs BEFORE Source 2, which would otherwise
    # swallow the whole run as one long def-7 paragraph.
    if still_orphan:
        lines = combined.split('\n')
        run = []                                    # (line_idx, num, rest_of_line)

        def _flush_run(r):
            if len(r) >= 2 and str(r[0][1] - 1) in defs and \
                    all(str(n) in still_orphan for _i, n, _t in r):
                # MOVE the run to the recovered block at the document end, with the other defs —
                # rewriting in place left "[^7]: Goldsmiths…" paragraphs scattered mid-body
                # wherever the print page happened to put them (2e9728f6: affiliations 7-12 at
                # the top of page 2 while 1-6 sat in the end block, visibly out of order).
                for idx, n, rest in r:
                    lines[idx] = None
                    recovered.append(f'[^{n}]: {rest}')
                return {str(n) for _i, n, _t in r}
            return set()

        run_recovered = set()
        for i, ln in enumerate(lines):
            if not ln.strip():
                continue                            # blank lines neither extend nor break a run
            m = re.match(r'^(\d{1,3})[.)]?\s+(\S.*)', ln)
            if m and (not run or int(m.group(1)) == run[-1][1] + 1):
                run.append((i, int(m.group(1)), m.group(2)))
            else:
                run_recovered |= _flush_run(run)
                run = [(i, int(m.group(1)), m.group(2))] if m else []
        run_recovered |= _flush_run(run)
        if run_recovered:
            combined = '\n'.join(l for l in lines if l is not None)
            still_orphan = still_orphan - run_recovered
    # Source 2: a plain "N Text…" body paragraph — only when numbers aren't a structural device
    # here (Barro's References are author-first → leading-number paragraphs stay ~1).
    leading_num_paras = len(re.findall(r'(?m)^\d{1,3}\.?\s+[A-Z‘“"\'(]', combined))
    if still_orphan and leading_num_paras <= max(len(defs), 3):
        for n in sorted(still_orphan, key=int):
            m = re.search(r'(?m)^' + n + r'\.?\s+[A-Z‘“"\'(].*(?:\n(?![ \t]*\n).*)*', combined)
            if not m:
                continue
            body = re.sub(r'^' + n + r'\.?\s+', '', m.group(0).strip())
            if len(body) < 150 or _looks_like_bibliography_entry(body):
                continue                                # short list item / address / biblio entry
            combined = combined[:m.start()] + combined[m.end():]
            recovered.append(f'[^{n}]: ' + body)
    if recovered:
        # Numeric order — the recovered defs join the deferred block at the doc end, and the
        # Footnotes section should read 1..N regardless of which source rescued each def.
        recovered.sort(key=lambda s: int(re.match(r'\[\^(\d+)\]', s).group(1)))
        combined = combined.rstrip() + '\n\n' + '\n\n'.join(recovered)
    return combined


# Two reference entries the OCR glued together with no separator: a sentence-ending period (or a
# closing paren) followed IMMEDIATELY by "Surname, I." — the canonical author-first bibliography
# opener ("…1063-93.Blinder, A. S., and Solow…"). Only applied inside the References section.
_GLUED_REF_SEAM_RE = re.compile(r"(?<=[.)])(?=[A-Z][A-Za-z'’-]+, [A-Z]\.)")


def _unglue_reference_entries(combined):
    """Split OCR-glued bibliography entries inside the References/Bibliography section so each
    entry is its own paragraph (the reader renders them separately, and bibliography extraction
    can key each entry instead of swallowing a glued block as one)."""
    m = re.search(r'(?m)^#{1,6}\s*(References|Bibliography|Works Cited)\s*$', combined, re.IGNORECASE)
    if not m:
        return combined
    head, tail = combined[:m.end()], combined[m.end():]
    nxt = re.search(r'(?m)^#{1,6}\s', tail)
    section, rest = (tail[:nxt.start()], tail[nxt.start():]) if nxt else (tail, '')
    section = _GLUED_REF_SEAM_RE.sub('\n', section)
    return head + section + rest


class DefaultAssembler(FootnoteAssembler):
    """Generic / unknown path: per-page SPLITS definition paragraphs out of the body (deferred to a
    contiguous block at the document end, page order), post-combine normalizes refs + defs."""
    plain = ('No special layout — generic cleanup. Pulls unambiguous footnote-definition paragraphs '
             'out of each page into one block at the end (so body text never sits BETWEEN two '
             'definitions and page-spanning sentences rejoin cleanly), normalises whatever footnote '
             'refs/defs it finds, and stitches page-break splits. Used for "none" (no footnotes) and '
             '"unknown" (nothing matched).')

    def per_page(self, ctx, i, page, md, md_stripped):
        if not md_stripped:
            return
        body, defs, still_open = _split_out_definition_paragraphs(
            md, getattr(ctx, 'open_def_continuation', False))
        if body.strip():
            ctx.md_parts.append(body)
        if defs.strip():
            ctx.deferred_defs_parts.append(defs)
        ctx.open_def_continuation = still_open

    def post_combine(self, ctx, combined):
        combined = normalize_all_footnote_refs(combined)
        combined = normalize_footnote_defs(combined)
        # Fix footnote definitions: OCR produces [^N] Text but markdown expects [^N]: Text
        # Only at start of line (definitions), not inline references
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*“‘])', r'\1: ', combined, flags=re.MULTILINE)
        # Author-affiliation block: unglue "[^1]Associate Professor…" defs (link when unambiguous,
        # demote the whole universe when its numbers collide with real footnote defs).
        combined = _resolve_affiliation_block(combined)
        # An orphaned in-text ref whose def the OCR left as a plain "N Text…" paragraph (often
        # stranded mid-References) or dropped into a bare-number page footer → recover the def.
        combined = _recover_orphan_plain_defs(combined, ctx.footer_bare_candidates)
        # Reference entries the OCR glued together → one paragraph per entry.
        combined = _unglue_reference_entries(combined)
        combined = rejoin_page_breaks(combined)
        return combined


class WackStemAssembler(FootnoteAssembler):
    """wackSTEMbibliographyNotes: per-page keeps the body (base; the numbered-notes→def conversion is
    skipped for this class in the conductor), post-combine wraps the numbered citations + definitions."""
    plain = ('Wraps the numbered [1] citations and the reference-list entries in markup that the '
             'backend STEM pass then converts into links.')

    def post_combine(self, ctx, combined):
        # A mixed-style paper cites BOTH ways — brackets ("[18,19]") and superscripts
        # ("piracy⁷", "2011.¹¹,¹²"). Normalise the superscript runs to bracket form first,
        # or only the bracket half links (42be715c: 12 of 26 markers linked).
        combined = convert_superscript_citations_to_brackets(combined)
        # A naked-brace superscript ("en masse^{2}." — 79c3d8e4) is a real FOOTNOTE marker, not
        # a citation: MDPI papers carry BOTH universes (superscript notes + bracket citations).
        # Convert to [^N] so the footnote system owns it — wrap_stem_citations targets [N], so
        # the caret form can never be mistaken for a citation.
        combined = re.sub(r'\^\{(\d{1,3})\}', r'[^\1]', combined)
        # Its definition lives in the NOTES block hiding in the numbered-entry stream (the
        # "Notes" heading is dropped by OCR). A numbered line whose number matches an in-text
        # [^N] marker becomes that footnote's definition when it sits in a detected notes run
        # (stem_notes_block_lines) OR its content is not author-shaped — "2. i.e. if enough
        # papers…" opens lowercase, which a bibliography entry never does. The run detection
        # alone is not enough here: OCR ALSO dropped refs 1-4, so notes (1,2) + refs (5..34)
        # read as one ascending run with no restart. fn_refs only ever contains brace-derived
        # markers (citations are [N] bracket form), so bibliography numbers stay untouched.
        fn_refs = {m.group(1) for m in re.finditer(r'(?<!\n)\[\^(\d+)\]', combined)}
        if fn_refs:
            lines = combined.split('\n')
            notes_lines = stem_notes_block_lines(lines)
            for i, ln in enumerate(lines):
                m = re.match(r'^(\d{1,3})[.)]\s+(.+)$', ln)
                if not m or m.group(1) not in fn_refs:
                    continue
                body = m.group(2)
                authorish = re.match(r'^[A-ZÀ-ÖØ-Þ]', body) and not body.lower().startswith('http')
                if i in notes_lines or not authorish:
                    lines[i] = f'[^{m.group(1)}]: {body}'
            combined = '\n'.join(lines)
        # A reference list Mistral emitted as DASH BULLETS ("- [4] K. Kiefer, …" — 128ad69a)
        # or glued into one blob with " - [N] " seams: either way the brackets are NOT at line
        # start, so wrap_stem_citations eats the bibliography as citations and
        # wrap_stem_definitions finds nothing — every citation dangles. Normalise both to
        # line-start entries; >=3 occurrences = a real list, a lone prose dash never qualifies.
        if len(re.findall(r'(?m)^-\s+\[\d{1,3}\] ', combined)) >= 3:
            combined = re.sub(r'(?m)^-\s+(\[\d{1,3}\] )', r'\1', combined)
        if len(re.findall(r' - \[\d{1,3}\] ', combined)) >= 3:
            combined = re.sub(r' - (\[\d{1,3}\] )', r'\n\1', combined)
        combined = wrap_stem_citations(combined)
        combined = wrap_stem_definitions(combined)
        return combined


class PageBottomAssembler(FootnoteAssembler):
    """page_bottom: footnotes sit at each page's bottom — renumber per page, split body from defs;
    post-combine rejoins the body and appends the collected, reformatted definitions."""
    plain = ('Footnotes live at the bottom of each page: pull them off the body, renumber across pages '
             'so they stay globally unique, then re-attach them as a definition list at the end.')

    def per_page(self, ctx, i, page, md, md_stripped):
        md, ctx.global_fn_counter = renumber_page_footnotes(md, ctx.global_fn_counter)
        body, fn_text = split_body_and_footnotes(md)
        if body.strip():
            ctx.md_parts.append(body)
        if fn_text.strip():
            ctx.fn_defs_parts.append(fn_text)

    def post_combine(self, ctx, combined):
        # Rejoin body text only (footnotes were separated per-page)
        combined = rejoin_page_breaks(combined)
        # Format and append collected footnote definitions
        fn_defs = "\n\n".join(ctx.fn_defs_parts)
        fn_defs = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*“‘])', r'\1: ', fn_defs, flags=re.MULTILINE)
        if fn_defs.strip():
            combined = combined + "\n\n" + fn_defs
        return combined


# The heading that opens a trailing endnotes/references list. Case-insensitive, optional '#'s
# (Mistral renders it either as a heading or a bare line).
_ENDNOTE_LIST_HEADING_RE = re.compile(
    r'(?mi)^#{0,6}\s*(references|notes|endnotes|bibliography|works cited)\s*$')


def _convert_numbered_endnote_defs(combined):
    """document_endnotes: when the body cites [^N] and the ONLY definition material is a numbered
    'N. Text' list under a trailing References/Notes heading, that list IS the endnote-definition
    list (journal styles like UKSG Insights: superscript markers strictly in order → a numbered
    'References' section). Convert the ascending-from-1 run to '[^N]: Text' so the markers link as
    FOOTNOTES. Gated hard: no existing [^N]: defs anywhere (else this would create a colliding
    second universe), entries must ascend exactly from 1, and the run must cover at least half the
    in-text ref numbers — a bibliography that ISN'T cited by number fails the overlap test."""
    refs = {int(m.group(1)) for m in re.finditer(r'(?<!\n)\[\^(\d+)\]', combined)}
    if not refs or re.search(r'(?m)^\[\^\d+\]:', combined):
        return combined
    heading = None
    for m in _ENDNOTE_LIST_HEADING_RE.finditer(combined):
        heading = m                                   # LAST such heading (front-matter TOCs repeat them)
    if heading:
        head, tail = combined[:heading.end()], combined[heading.end():]
    else:
        # OCR routinely DROPS the Notes/References heading (f1aafdde: author bios flow straight
        # into "1. Aileen Fyfe, …"). The document-endnotes class itself promises a trailing def
        # list, so anchor on the LAST line-start "1." entry instead — the cited-by-half gate
        # below still decides whether the run really is the def list, so a stray body list
        # whose numbers the text never cites stays untouched.
        anchor = None
        for m in re.finditer(r'(?m)^1\. \S', combined):
            anchor = m
        if anchor is None:
            return combined
        head, tail = combined[:anchor.start()], combined[anchor.start():]
    lines = tail.split('\n')
    expected, converted_nums = 1, set()
    for i, ln in enumerate(lines):
        m = re.match(r'^(\d{1,3})\.\s+(\S.*)', ln)
        if not m:
            continue                                  # page footers etc. interleave — skip, don't abort
        n = int(m.group(1))
        if n != expected:
            # SMALL-GAP resync: an OCR-dropped entry must not strand the rest of the list —
            # f1aafdde lost a handful of numbers mid-list and the strict counter left ~20 defs
            # unconverted. A jump of <= 3 keeps the ascent; anything larger is a stray number.
            if not (expected < n <= expected + 3):
                continue
            expected = n
        # The per-page pass may have turned a number INSIDE the entry (a DOI tail
        # "etnografica.840", a year, a page range) into a bogus [^M] marker. Reference-entry text is
        # a DEFINITION, never a marker site — unwrap any such markers back to plain digits.
        body = re.sub(r'\[\^(\d+)\]', r'\1', m.group(2))
        lines[i] = f'[^{expected}]: {body}'
        converted_nums.add(expected)
        expected += 1
    # Convert only when at least HALF the numbered entries are actually cited by a body marker —
    # a bibliography that ISN'T cited by number (an author-year paper whose refs happen to be
    # numbered) leaves most entries un-referenced and must stay a plain list, not phantom footnotes.
    # (Keyed on len(converted_nums), NOT len(refs): a single stray [^1] must not justify converting
    # a 4-entry list.) The real books clear it comfortably even with OCR-dropped markers
    # (42be715c 23/29, 0fb751c1 24/39, 95a61ad0 25/29); the uncited case sits at 1/4.
    if len(converted_nums) < 2 or len(refs & converted_nums) * 2 < len(converted_nums):
        return combined                               # unconvincing — leave the list untouched
    combined = head + '\n'.join(lines)
    # A body footnote MARKER can never exceed the number of definitions — anything higher is a
    # stray from a body year/figure the per-page pass misfired on (e.g. "etnografica.840"). Unwrap
    # body [^M] where M is above the def ceiling (small margin for an OCR-dropped final def).
    ceiling = max(converted_nums)
    combined = re.sub(
        r'(?<!\n)\[\^(\d+)\]',
        lambda m: m.group(0) if int(m.group(1)) <= ceiling + 2 else m.group(1),
        combined,
    )
    return combined


_INLINE_REF_RE = re.compile(r'\[\^(\d+)\]')


def _repair_sequential_ref_misreads(combined):
    """document_endnotes ONLY: in-text markers run STRICTLY 1..N, once each — that is the class
    signature (a doc whose numbers recur across pages classifies wackSTEM instead). An OCR digit
    misread turns a marker into a DUPLICATE of a different number ("requirements,20" and
    "content.25" both read as 28 in 95a61ad0), and the linker then binds the misread marker to
    the WRONG definition — a confidently wrong link, plus the real def strands unmatched. Walk
    the in-text refs in document order with an expected counter; a ref that breaks the chain is
    rewritten to the expected value ONLY when all three hold:
      (a) its number is AHEAD of the chain (a later-list number appearing early),
      (b) a definition for the expected number exists (the repair has a real target),
      (c) the NEXT in-text ref confirms the chain (== expected+1) — a genuinely absent number
          fails this and the chain just resynchronises without rewriting anything."""
    defs = {int(n) for n in re.findall(r'(?m)^\[\^(\d+)\]:', combined)}
    refs = [(m.start(1), m.end(1), int(m.group(1)))
            for m in _INLINE_REF_RE.finditer(combined)
            if m.start() > 0 and combined[m.start() - 1] != '\n']
    if len(refs) < 3:
        return combined
    rewrites = []                       # (start, end, new_num)
    seen = {refs[0][2]}
    expected = refs[0][2] + 1
    for k in range(1, len(refs)):
        s, e, r = refs[k]
        if r == expected:
            seen.add(r)
            expected += 1
        elif (r > expected and expected in defs
                and k + 1 < len(refs) and refs[k + 1][2] == expected + 1):
            rewrites.append((s, e, expected))
            seen.add(expected)
            expected += 1
        elif (r < expected and r in seen and expected in defs
                and k + 1 < len(refs) and refs[k + 1][2] == expected + 1):
            # BEHIND-the-chain duplicate: the misread lowered a digit ("stalemate',27" read as
            # ²³ — 85542c5e p1), so the number re-appears where its true place is already taken.
            # Same triple gate as the ahead case; a strictly-once endnote chain never legally
            # repeats a number.
            rewrites.append((s, e, expected))
            seen.add(expected)
            expected += 1
        else:
            seen.add(r)
            expected = r + 1
    for s, e, n in reversed(rewrites):
        combined = combined[:s] + str(n) + combined[e:]
    if rewrites:
        print(f"  Repaired {len(rewrites)} sequence-breaking marker misread(s) "
              f"({', '.join(str(n) for _s, _e, n in rewrites)}) — strict-order endnote chain")
    return combined


class DocumentEndnotesAssembler(FootnoteAssembler):
    """document_endnotes: definitions clustered on trailing pages — convert refs to [^N] per page;
    post-combine fixes def formatting + rejoins."""
    plain = ('Definitions sit at the very end of the document: convert the scattered in-body markers '
             '(brackets / superscripts) to [^N], format the end definitions as [^N]:, and rejoin '
             'page breaks.')

    def per_page(self, ctx, i, page, md, md_stripped):
        # Convert all footnote ref formats to [^N] — shared per-page converter (document_endnotes also
        # unwraps *[2]* → [2] first).
        md = convert_inline_footnote_markers(md, strip_italic_brackets=True)
        if md_stripped:
            ctx.md_parts.append(md)

    def post_combine(self, ctx, combined):
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*“‘])', r'\1: ', combined, flags=re.MULTILINE)
        # A trailing numbered References/Notes list cited by in-order markers is the def list.
        combined = _convert_numbered_endnote_defs(combined)
        # A $-form comma-group superscript ("$^{13,16}$" — 0fb751c1) survives the per-page
        # expansion because that gate needs SAME-PAGE defs, which a document-endnotes book can
        # never satisfy. Post-combine the def list exists, so expand any group whose numbers
        # ALL have definitions; anything else really is math and stays.
        _defs_now = {m.group(1) for m in re.finditer(r'(?m)^\[\^(\d+)\]:', combined)}
        def _expand_group(m):
            nums = re.findall(r'\d{1,3}', m.group(1))
            if nums and all(n in _defs_now for n in nums):
                return ''.join(f'[^{n}]' for n in nums)
            return m.group(0)
        combined = re.sub(r'\$\^\{(\d{1,3}(?:\s*,\s*\d{1,3})+)\s*,?\}\$', _expand_group, combined)
        # A misread digit that duplicates a later marker breaks the strict 1..N chain AND
        # binds to the wrong definition — restore the expected value (95a61ad0: 20 and 25
        # both OCR'd as 28, so three markers merged onto the transparency-report note).
        combined = _repair_sequential_ref_misreads(combined)
        combined = rejoin_page_breaks(combined)
        return combined


class ChapterEndnotesAssembler(FootnoteAssembler):
    """chapter_endnotes: per-chapter footnote numbering restarts → setup precomputes per-page chapter
    offsets (incl. notes-section transition pages) for global uniqueness; per-page converts refs and
    applies the offset; post-combine fixes def formatting + rejoins."""
    plain = ('Numbering restarts per chapter, so it computes a per-chapter OFFSET to make every number '
             'globally unique, applies it, then fixes def formatting + rejoins. Each new notes-chapter '
             'is anchored above all numbers emitted so far, so collisions are provably impossible on '
             'clean restarts (test_pdf_fusion.py); residual collisions mean noisy per-page def detection.')

    def setup(self, ctx):
        footnote_meta = ctx.footnote_meta
        pages = ctx.pages
        # Build set of definition-heavy page indices from footnote_meta.
        # Two filters to avoid false positives (e.g., numbered lists in body text):
        # 1. Exclude pages that also have refs (body pages, not notes pages)
        # 2. Require a neighboring page also be def-heavy (notes pages cluster together)
        if footnote_meta:
            candidates = set()
            for entry in footnote_meta.get('page_summary', []):
                if len(entry.get('defs', [])) >= 3 and not entry.get('refs'):
                    candidates.add(entry['index'])
            for p in candidates:
                if (p - 1) in candidates or (p + 1) in candidates:
                    ctx.def_heavy_pages.add(p)

        # Pre-compute chapter offsets for chapter_endnotes renumbering.
        # Each chapter restarts footnote numbering at 1; we offset them to be globally unique.
        if footnote_meta:
            chapter_fn_offsets = [0] * len(pages)
            cumulative = 0
            ch_max = 0          # max footnote number in current chapter (refs + defs)
            ref_ch_max = 0      # max ref number in current chapter (for detecting resets)
            body_chapter_offsets = [0]   # the offset each BODY chapter received, in order

            for entry in footnote_meta.get('page_summary', []):
                refs = entry.get('refs', [])
                defs = entry.get('defs', [])

                if defs:
                    ch_max = max(ch_max, max(defs))

                if refs:
                    ref_max = max(refs)
                    if ref_ch_max > 10 and ref_max < ref_ch_max * 0.5:
                        # Number reset — new chapter
                        cumulative += ch_max
                        ch_max = ref_max
                        ref_ch_max = ref_max
                        body_chapter_offsets.append(cumulative)
                        for j in range(entry['index'], len(pages)):
                            chapter_fn_offsets[j] = cumulative
                    else:
                        ch_max = max(ch_max, ref_max)
                        ref_ch_max = max(ref_ch_max, ref_max)

            # --- Extend offsets into the notes section ---
            # Find last page with refs (notes section starts after this)
            last_ref_page = 0
            for entry in footnote_meta.get('page_summary', []):
                if entry.get('refs'):
                    last_ref_page = max(last_ref_page, entry['index'])

            # PAIRED MODE: when the notes walk detects the SAME number of sections as the body
            # detected chapters, section k simply takes body chapter k's offset — refs and defs
            # of a chapter then share one offset BY CONSTRUCTION and every marker binds its own
            # chapter's note. The previous running_max anchoring computed the two sides
            # INDEPENDENTLY, so any chapter holding more defs than its highest surviving ref
            # drifted the def side upward — compounding: f07b7fff's chapters 4-11 sat 1/2/6/9
            # above their bodies, so EVERY ref bound the wrong note ("Conceiving Open Systems"
            # note 1 opened the previous chapter's note 42). FALLBACK: when the section counts
            # DISAGREE (ref-reset detection under-counts on OCR noise — the Cox fusion case),
            # keep running_max anchoring: numbering gaps, but no within-notes collisions.
            # Dry-run the reset/transition decisions first to learn the section count (branch
            # choices depend only on the raw def numbers, never on the offsets).
            _sections = 0
            _ndm = 0
            for entry in footnote_meta.get('page_summary', []):
                if entry['index'] <= last_ref_page:
                    continue
                defs = entry.get('defs', [])
                if not defs:
                    continue
                if _sections == 0:
                    _sections = 1
                def_max, def_min = max(defs), min(defs)
                if _ndm > 5 and def_min < _ndm * 0.3:
                    _sections += 1
                    sd = sorted(set(defs))
                    gap, cut = 0, None
                    for k in range(len(sd) - 1):
                        if sd[k + 1] - sd[k] > gap:
                            gap, cut = sd[k + 1] - sd[k], sd[k + 1]
                    if cut is not None and gap >= _ndm * 0.3 and max(sd) >= _ndm * 0.7:
                        new_ch_defs = [d for d in defs if d < cut]
                        _ndm = max(new_ch_defs) if new_ch_defs else def_min
                    else:
                        _ndm = def_max
                else:
                    _ndm = max(_ndm, def_max)
            paired = _sections == len(body_chapter_offsets)
            notes_ch_idx = 0

            notes_offset = 0    # offset applied to the CURRENT notes chapter
            running_max = 0     # highest GLOBAL footnote number emitted in the notes so far
            notes_def_max = 0   # max RAW def number seen so far in the current chapter
            for entry in footnote_meta.get('page_summary', []):
                if entry['index'] <= last_ref_page:
                    continue
                defs = entry.get('defs', [])
                if not defs:
                    continue
                def_max = max(defs)
                def_min = min(defs)
                if notes_def_max > 5 and def_min < notes_def_max * 0.3:
                    # A new chapter's notes have started (numbering reset). DISTINGUISH two cases:
                    #  • TRUE transition page — it holds the END of the previous chapter (a high
                    #    cluster near the old running max) AND the START of the new one (a low
                    #    cluster), separated by a real gap → split per-def at that gap.
                    #  • PURE new-chapter page — a clean ascending restart (one contiguous run, no
                    #    high old-chapter tail) → apply ONE offset to the whole page.
                    sd = sorted(set(defs))
                    gap, cut = 0, None
                    for k in range(len(sd) - 1):
                        if sd[k + 1] - sd[k] > gap:
                            gap, cut = sd[k + 1] - sd[k], sd[k + 1]
                    is_true_transition = (cut is not None and gap >= notes_def_max * 0.3
                                          and max(sd) >= notes_def_max * 0.7)
                    notes_ch_idx += 1
                    if is_true_transition:
                        # old-chapter tail (>= cut) keeps the old offset; bank it into running_max
                        # first so the new chapter starts above it. New start (< cut) gets new offset.
                        old_tail = [d for d in defs if d >= cut]
                        if old_tail:
                            running_max = max(running_max, notes_offset + max(old_tail))
                        old_offset = notes_offset
                        new_offset = body_chapter_offsets[notes_ch_idx] if paired else running_max
                        notes_offset = new_offset
                        new_ch_defs = [d for d in defs if d < cut]
                        notes_def_max = max(new_ch_defs) if new_ch_defs else def_min
                        if new_ch_defs:
                            running_max = max(running_max, new_offset + max(new_ch_defs))
                        ctx.notes_transition_pages[entry['index']] = (cut, old_offset, new_offset)
                        for j in range(entry['index'] + 1, len(pages)):
                            chapter_fn_offsets[j] = new_offset
                    else:
                        # pure new chapter — ONE offset for the whole page (the paired body
                        # chapter's, else above everything emitted so far)
                        notes_offset = body_chapter_offsets[notes_ch_idx] if paired else running_max
                        notes_def_max = def_max
                        running_max = max(running_max, notes_offset + def_max)
                        for j in range(entry['index'], len(pages)):
                            chapter_fn_offsets[j] = notes_offset
                else:
                    notes_def_max = max(notes_def_max, def_max)
                    running_max = max(running_max, notes_offset + def_max)
                    for j in range(entry['index'], len(pages)):
                        chapter_fn_offsets[j] = notes_offset

            ctx.chapter_fn_offsets = chapter_fn_offsets

    def per_page(self, ctx, i, page, md, md_stripped):
        # Convert all footnote ref formats to [^N] (before offset) — shared per-page converter
        md = convert_inline_footnote_markers(md)

        # Apply chapter offset for global uniqueness
        if ctx.chapter_fn_offsets:
            if i in ctx.notes_transition_pages:
                # Transition page: old chapter tail + new chapter start need different offsets
                threshold, old_off, new_off = ctx.notes_transition_pages[i]
                def _apply_transition(m, _thr=threshold, _old=old_off, _new=new_off):
                    num = int(m.group(1))
                    off = _old if num >= _thr else _new
                    return f'[^{num + off}]' if off > 0 else m.group(0)
                md = re.sub(r'\[\^(\d+)\]', _apply_transition, md)
            else:
                offset = ctx.chapter_fn_offsets[i]
                if offset > 0:
                    md = re.sub(
                        r'\[\^(\d+)\]',
                        lambda m: f'[^{int(m.group(1)) + offset}]',
                        md
                    )

        if md_stripped:
            ctx.md_parts.append(md)

    def post_combine(self, ctx, combined):
        # Superscripts already converted per-page with chapter offsets applied.
        # Fix def formatting and rejoin page breaks.
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*“‘])', r'\1: ', combined, flags=re.MULTILINE)
        combined = rejoin_page_breaks(combined)
        return combined


PDF_ASSEMBLERS = {
    'page_bottom': PageBottomAssembler(),
    'chapter_endnotes': ChapterEndnotesAssembler(),
    'document_endnotes': DocumentEndnotesAssembler(),
    'wackSTEMbibliographyNotes': WackStemAssembler(),
}


_DEFAULT_ASSEMBLER = DefaultAssembler()


_CODE_FENCE_LINE_RE = re.compile(r'(?m)^[ \t]*```[^\n]*$')


def _strip_stray_code_fences(md):
    """Strip OCR-hallucinated ``` fences from a page whose fence count is ODD.

    A lone unpaired fence is catastrophic downstream: simple_md_to_html opens a <pre><code>
    at that point and never closes it, so the REST OF THE BOOK renders as one literal code
    block — footnote defs, blockquotes and headings all become inert text (3f202e8f: a single
    stray fence Mistral emitted at the page-29 break swallowed 92% of the document; 212
    footnote defs -> 3). A page with an odd fence count cannot contain a balanced code block,
    so its fences are OCR noise — drop them all. Worst case a REAL code block spanning the
    page turn is unwrapped to plain text, which is strictly cheaper than swallowing everything
    after it. Balanced pages (even count, incl. zero) are untouched.

    Returns (md, n_stripped)."""
    fences = _CODE_FENCE_LINE_RE.findall(md)
    if len(fences) % 2 == 0:
        return md, 0
    return _CODE_FENCE_LINE_RE.sub('', md), len(fences)


# Line-start LaTeX glyphs Mistral uses for a book's decorative list bullets.
_LATEX_BULLET_RE = re.compile(
    r'(?m)^\$\\(?:triangleright|blacktriangleright|rightarrow|bullet|square|diamond|ast)\$\s*')

_QUOTE_OPEN_CHARS = "'‘“\""
# A paragraph END that closes a quotation: closing quote, optional period, optional footnote
# marker ([^N] or a bare OCR'd number), optional page-number anchor, nothing else.
_QUOTE_PARA_END_RE = re.compile(
    r"['’”\"]\s*\.?\s*(?:\[\^\d+\]|\d{1,3})?\s*(?:<a class=\"pageNumber\"[^>]*></a>)?\s*$")
# An intro paragraph that ANNOUNCES a quotation: ends with a colon (optional footnote marker).
_QUOTE_INTRO_END_RE = re.compile(r':\s*(?:\[\^\d+\]|\d{1,3})?\s*$')


def _wrap_quote_blockquotes(md):
    """Mark block quotations Mistral emitted as PLAIN paragraphs (it gives no structural signal —
    no '>' and no indent) as markdown '>' blockquotes. Conservative shape: the previous paragraph
    ends with a COLON (an explicit quote introduction — "…as follows:") and this paragraph is
    fully wrapped in quote marks (opening quote first char, closing quote at the end, allowing a
    trailing period / footnote marker) and long enough to be a passage, not a quoted term.
    Runs on the JOINED document, not per page — a quotation routinely opens a fresh page while
    its "…conclude that:" intro sits at the bottom of the previous one."""
    paras = re.split(r'\n\s*\n', md)
    prev_stripped = ''
    for k, para in enumerate(paras):
        s = para.strip()
        if (s and s[0] in _QUOTE_OPEN_CHARS
                and not s.startswith('> ')
                and len(s) >= 80
                and '\n' not in s
                and _QUOTE_PARA_END_RE.search(s)
                and _QUOTE_INTRO_END_RE.search(prev_stripped)):
            paras[k] = '> ' + s
        prev_stripped = s
    # A PAGE-SPANNING quotation Mistral wrapped only half of: the continuation page arrives as a
    # native '> ' paragraph opening in lowercase, while the quote's first half (previous page)
    # sits unwrapped — it opens with a quote char but never closes (cut at the page turn). Pull
    # the first half into the same blockquote, with a '>' separator line so the converter renders
    # ONE <blockquote> ('‘Yet, while all of these changes…' / '> are omitted when…').
    for k, para in enumerate(paras):
        s = para.strip()
        if not s.startswith('> '):
            continue
        first_content = s[2:].lstrip()
        if not first_content[:1].islower():
            continue
        j = k - 1
        while j >= 0 and not paras[j].strip():
            j -= 1
        if j < 0:
            continue
        prev = paras[j].strip()
        if (prev and prev[0] in _QUOTE_OPEN_CHARS
                and not prev.startswith('> ')
                and '\n' not in prev
                and not _QUOTE_PARA_END_RE.search(prev)):
            paras[j] = '> ' + prev + '\n>\n' + s
            paras[k] = None
    return '\n\n'.join(p for p in paras if p is not None)

_HEADING_LINE_RE = re.compile(r'(?m)^#{1,6}[ \t]+(.+?)\s*$')
_LEADING_HEADING_RE = re.compile(r'^#{1,6}[ \t]+([^\n]+)')
# STRUCTURAL headings legitimately open a fresh page long after the same text appeared earlier
# (93d34a74: a mid-book '# References' section heading, then the real back-of-book bibliography
# opening its own page with '# References' — stripping that as a "leak" re-anchored bibliography
# extraction on the early heading and collapsed 590 entries to 54). For these, only the
# CONSECUTIVE-page repeat (the multi-page-section leak: '# Bibliography' opening 14 pages in a
# row) is stripped; the seen-anywhere rule applies to chapter/section titles only.
_STRUCTURAL_HEADING_RE = re.compile(
    r'(?i)^((foot|end)?notes|references|bibliography|works cited|index|appendix.*|acknowledg.*)$')


def _norm_heading(text):
    return re.sub(r'\s+', ' ', (text or '')).strip()


_TOC_ENTRY_RE = re.compile(r'^(.{2,80}?)\s+(?:\d{1,4}|[ivxlc]{1,7})$')


def _norm_title(t):
    t = t.replace('“', '"').replace('”', '"').replace('’', "'").replace('‘', "'")
    return re.sub(r'\s+', ' ', t).strip()


def _toc_key(t):
    """Matching key for a heading against the printed Contents: quote/whitespace-normalised,
    casefolded, leading chapter number stripped ('6. Writing…' and 'WRITING…' both key
    'writing copyright licenses')."""
    t = _norm_title(t)
    t = re.sub(r'^\d+[.)]?\s+', '', t)
    return t.casefold()


def _collect_toc_titles(pages):
    """The book's own printed CONTENTS page — the first front-matter page carrying >= 5
    'Title … N' lines — parsed into the authoritative structure. OCR routinely drops the big
    styled chapter-opening headings entirely (f07b7fff chapters 7-9 opened as PLAIN text with
    no heading anywhere in the body), and the print TOC is the one place the full structure
    reliably survives.

    Returns (titles, page_idx, numbered, all_keys, part_before):
      titles      — promotion set: every entry normalised + leading-number-stripped variant
      numbered    — {toc_key: full printed title} for NUMBERED chapter entries, so a body
                    heading that lost its number ('Geeks and Recursive Publics') can be
                    rewritten to the printed form ('1. Geeks and Recursive Publics')
      all_keys    — toc_key of every entry (level normalisation: an h1 matching none demotes)
      part_before — {successor toc_key: PART title} for 'PART …' divider entries, so a part
                    heading OCR dropped can be re-injected above its first chapter"""
    for idx, page in enumerate(pages[:15]):
        md = page.get('markdown', '') or ''
        lines = [re.sub(r'^#{1,6}\s+', '', l.strip()) for l in md.split('\n') if l.strip()]
        # A List of Tables/Figures page has the same 'Caption … N' shape but supplies CAPTIONS,
        # not section titles — never let it win the first-match over the real Contents.
        if lines and re.match(r'(?i)^list of (tables|figures|illustrations|maps)', lines[0]):
            continue
        entries = [l for l in lines if _TOC_ENTRY_RE.match(l)]
        if len(entries) >= 5:
            titles = set()
            ordered = []
            for l in lines:
                m = _TOC_ENTRY_RE.match(l)
                t = _norm_title(m.group(1) if m else l)
                if t:
                    ordered.append(t)
                    titles.add(t)
                    titles.add(re.sub(r'^\d+[.)]\s+', '', t))
            numbered = {}
            all_keys = set()
            part_before = {}
            pending_part = None
            for t in ordered:
                all_keys.add(_toc_key(t))
                if re.match(r'(?i)^part\b', t):
                    pending_part = t
                    continue
                if re.match(r'^\d+[.)]?\s+\S', t):
                    numbered.setdefault(_toc_key(t), t)
                    if pending_part:
                        part_before.setdefault(_toc_key(t), pending_part)
                        pending_part = None
            return titles, idx, numbered, all_keys, part_before
    return set(), -1, {}, set(), {}


def _collect_body_heading_texts(pages):
    """Every heading TEXT Mistral emitted anywhere in a page body, normalised — plus its
    leading-number-stripped form ('2 The development…' also as 'The development…') so it can be
    compared against extract_section_name output, which strips leading numbers. The trailing
    page number of a TOC-line heading ('4 The digitization… 129') is deliberately KEPT, so a
    TOC entry never masquerades as the real chapter heading and suppresses its injection."""
    texts = set()
    for page in pages:
        for h in _HEADING_LINE_RE.findall(page.get("markdown", "") or ""):
            t = _norm_heading(h)
            if t:
                texts.add(t)
                texts.add(re.sub(r'^\d+\s+', '', t))
    return texts


def assemble_markdown(response_dict, classification="unknown", footnote_meta=None, pdf_path=None,
                       segment_boundaries=None, footnote_warnings=None):
    """Assemble pages into markdown, injecting section headings from headers. Thin conductor over the
    PDF_ASSEMBLERS registry: it runs the SHARED spine (running-header detection, sticky-notes
    tracking, page-number anchors, heading injection, numbered-notes→defs) and the SHARED tail
    (URL fixes, pypdf def-recovery, image reordering, the Footnotes heading); the per-classification
    assembler owns setup + per_page + post_combine.

    segment_boundaries (optional list[int]): page indices where a new paper
        begins in a multi-paper PDF. Each segment after the first gets a
        footnote-number offset so IDs stay globally unique.
    footnote_warnings (optional list[dict]): mojibake warnings from
        scan_footnote_mojibake. When non-empty, the pypdf def-recovery pass
        runs regardless of classification.
    """
    ctx = AssemblyContext(response_dict, classification, footnote_meta)
    pages = ctx.pages

    # Extract page number offset for stripping trailing page numbers
    if footnote_meta and footnote_meta.get('signals', {}).get('trailing_page_number_consistency', 0) > 0.5:
        ctx.page_number_offset = footnote_meta['signals'].get('trailing_page_number_offset')

    # Track repeated headers to identify running headers (book title etc.)
    header_counts = {}
    for page in pages:
        header = page.get("header") or ""
        for line in header.split('\n'):
            name = extract_section_name(line)
            if name:
                header_counts[name] = header_counts.get(name, 0) + 1
    # Headers appearing on >40% of pages are likely running headers (book title)
    threshold = max(3, len(pages) * 0.4)
    running_headers = {name for name, count in header_counts.items() if count >= threshold}

    # Headings Mistral emitted in page BODIES, document-wide. Injection consults this: when the
    # header-field section name already exists as a body heading somewhere, injecting a copy just
    # plants a duplicate at a PAGE top (usually mid-paragraph), so the body's own heading wins.
    body_heading_texts = _collect_body_heading_texts(pages)
    toc_titles, toc_page_idx, toc_numbered, toc_all_keys, toc_part_before = _collect_toc_titles(pages)
    fence_lines_stripped = fence_pages = 0

    # The per-classification assembler owns setup (e.g. the chapter-offset precompute) + per_page +
    # post_combine; the default handles the generic/unknown path.
    assembler = PDF_ASSEMBLERS.get(classification, _DEFAULT_ASSEMBLER)
    assembler.setup(ctx)

    # Sticky notes section tracking: once we enter "Notes" at the end of the
    # book, stay in notes mode until we hit Acknowledgements/Bibliography/etc.
    if footnote_meta:
        for entry in footnote_meta.get('page_summary', []):
            if entry.get('refs'):
                ctx.last_ref_page_idx = max(ctx.last_ref_page_idx, entry['index'])

    for i, page in enumerate(pages):
        md = page.get("markdown", "")
        header = page.get("header") or ""
        md, _n_fences = _strip_stray_code_fences(md)
        if _n_fences:
            fence_lines_stripped += _n_fences
            fence_pages += 1
        # A book's triangle/arrow bullets OCR as LaTeX glyph commands at line start
        # ("$\triangleright$ increased user involvement…") — downstream that renders as a <latex>
        # element in a <p>, not a list item. Normalise to a markdown bullet so the list survives.
        md = _LATEX_BULLET_RE.sub('- ', md)
        md_stripped = md.strip()

        # A blank page OCR'd as bare punctuation (3f202e8f p276: an empty verso rendered as
        # '.') would otherwise become a lone '.' paragraph node in the reader — skip it.
        if md_stripped and re.fullmatch(r'[.,;:·•*\-–—]{1,3}', md_stripped):
            continue

        # Sticky notes section — only triggers once all body refs are done; mid-book "Notes" headings
        # (chapter-endnote books like Road from Mont Pelerin) sit BEFORE last_ref_page_idx, so they
        # stay excluded. For the classifier FALL-THROUGH ('unknown') the generic path is the ONLY
        # chance to find the notes section (there is no layout-specific assembler to harvest them), so
        # we detect its heading PERMISSIVELY: case-insensitively (an all-caps "# NOTES"), anywhere on
        # the page (MULTILINE — the heading routinely trails body prose on the transition page), and
        # INCLUDING the last-ref page (>=, because in a document-endnotes book the final in-text marker
        # and the "# NOTES" heading that opens the end-notes share one page — Cox 'Real Socialism':
        # ref 39 and "# NOTES" both on page 21, so a strict > skipped it and every numbered definition
        # stayed a dropped list item). Classified layouts keep the STRICT original detection so their
        # established output (goldens) is unperturbed — their own assembler owns definition harvesting.
        _permissive_notes = (classification == 'unknown')
        _notes_gate = (i >= ctx.last_ref_page_idx) if _permissive_notes else (i > ctx.last_ref_page_idx)
        _notes_re = r'^#+ *(Foot)?notes\b' if _permissive_notes else r'^#+ *(Foot)?[Nn]otes\b'
        _notes_flags = (re.IGNORECASE | re.MULTILINE) if _permissive_notes else 0
        if not ctx.in_notes_section and _notes_gate:
            if "Notes" in header or "NOTES" in header or "Footnotes" in header:
                ctx.in_notes_section = True
            elif re.search(_notes_re, md_stripped, _notes_flags):
                ctx.in_notes_section = True

        # Detect leaving notes section (Acknowledgements, Bibliography, Index, etc.)
        if ctx.in_notes_section:
            if re.search(r'^#+ *(Acknowledg|Bibliograph|Index|Appendi|General Bibliography)', md_stripped):
                ctx.in_notes_section = False

        is_notes_page = ("Notes" in header or "NOTES" in header
                          or i in ctx.def_heavy_pages
                          or ctx.in_notes_section)

        # Replace trailing page number with inline anchor tag
        if ctx.page_number_offset is not None:
            expected = i + ctx.page_number_offset
            last_line = md_stripped.rsplit('\n', 1)[-1].strip() if md_stripped else ''
            if re.match(r'^\d{1,4}$', last_line) and int(last_line) == expected:
                md = md.rstrip()
                md = md[:md.rfind('\n')].rstrip() if '\n' in md else ''
                md += f' <a class="pageNumber" data-page="{int(expected)}"></a>'
                md_stripped = md.strip()

        # A page whose body OPENS with a heading text we have already seen is the print running
        # header leaking into content: extract_header failed on this page (its `header` field got
        # only the page number) and Mistral emitted the chapter/section title as a fresh '# '
        # heading instead ('# 1 Introduction' opened 8 pages of 3f202e8f, '# Bibliography' 14).
        # Keep the first occurrence — the real chapter/section opening — and strip the repeats.
        # Structural headings only dedupe against the LAST 2 content pages' opening headings
        # (see _STRUCTURAL_HEADING_RE) — a window of 2 because running headers leak on RECTO
        # pages only in many books ('# Bibliography' opened pages 275/277/278/280/… of
        # 3f202e8f; a strictly-previous-page rule caught 1 of the 14). A genuine second
        # References section hundreds of pages later (93d34a74) is far outside the window.
        # Chapter/section titles dedupe against everything seen.
        _lead = _LEADING_HEADING_RE.match(md_stripped)
        _lead_text = _norm_heading(_lead.group(1)) if _lead else None
        if _lead_text and not ctx.in_notes_section:
            # in_notes_section exempt: a back-of-book Notes section legitimately REUSES the
            # chapter titles as its per-chapter subheadings (f07b7fff: notes p326 opens
            # '# Introduction' — the dedupe ate it and the TOC lost the section).
            if _STRUCTURAL_HEADING_RE.match(_lead_text):
                _is_leak = _lead_text in ctx.recent_opening_headings
            else:
                _is_leak = _lead_text in ctx.seen_sections
            if _is_leak:
                md = re.sub(r'^\s*#{1,6}[ \t]+[^\n]*\n?', '', md, count=1)
                md_stripped = md.strip()
        elif md_stripped:
            # The same leak in PLAIN-text form: Mistral sometimes emits the running header as a
            # bare page-opening LINE, not a '#' heading ("2 The development of scientific
            # communication" landing mid-quote on 3f202e8f p27). A first line that verbatim
            # equals an already-seen heading (or a header-field section name) is page chrome.
            _plain = _norm_heading(md_stripped.split('\n', 1)[0])
            if (_plain and not _STRUCTURAL_HEADING_RE.match(_plain)
                    and (_plain in ctx.seen_sections
                         or _plain in header_counts
                         or re.sub(r'^\d+\s+', '', _plain) in header_counts)):
                md = re.sub(r'^\s*[^\n]*\n?', '', md, count=1)
                md_stripped = md.strip()
        if md_stripped:
            ctx.recent_opening_headings = (ctx.recent_opening_headings + [_lead_text])[-2:]

        # TOC-guided heading PROMOTION: a chapter whose big styled opening OCR'd as plain text
        # (f07b7fff chapters 7-9 — no heading anywhere in the body) gets it back when the line
        # opening this page matches a printed-Contents title. Once per title, page-opening only,
        # and never for a line whose heading form was already seen — a plain running-header
        # LEAK matching a TOC title has its real heading in seen_sections (and was stripped
        # above), so it can never be promoted into a duplicate.
        if toc_titles and i != toc_page_idx and md_stripped and not md_stripped.startswith('#'):
            _first_line = md_stripped.split('\n', 1)[0].strip()
            if (len(_first_line) <= 80
                    and _norm_title(_first_line) in toc_titles
                    and _norm_heading(_first_line) not in ctx.seen_sections
                    and _norm_title(_first_line) not in ctx.promoted_toc_titles):
                ctx.promoted_toc_titles.add(_norm_title(_first_line))
                md = re.sub(r'^\s*' + re.escape(_first_line), f'# {_first_line}', md, count=1)
                md_stripped = md.strip()

        # Extract section name from header
        section_name = None
        for line in header.split('\n'):
            name = extract_section_name(line)
            if name and name not in running_headers:
                section_name = name
                break

        # Only inject a heading from the header when ALL of:
        # 1. We got a real section name (not a running header / page number)
        # 2. This section hasn't been seen before
        # 3. The markdown body doesn't already start with a # heading — EXCEPT when the section
        #    name is STRUCTURAL (Notes/Bibliography/…) and differs from that opening heading:
        #    OCR loses those divider headings constantly, and the body heading is the section's
        #    first SUBSECTION, which the divider belongs above (f07b7fff: notes open directly
        #    with '# Introduction'; without this the book has no Notes heading at all).
        # 4. The body starts with uppercase (new section, not a paragraph continuation)
        # 5. Mistral didn't emit the same heading in ANY page body (else the body's own copy at
        #    the real section start wins, and the injected one would sit at a page top duplicating
        #    it — 3f202e8f grew both '# The development of scientific communication' (injected)
        #    and Mistral's '# 2 The development of scientific communication').
        _sec_norm = _norm_heading(section_name) if section_name else None
        _body_opens_heading = md_stripped.startswith('#')
        _structural_over_subsection = (_sec_norm and _body_opens_heading
                                       and _STRUCTURAL_HEADING_RE.match(_sec_norm)
                                       and _lead_text != _sec_norm)
        if (section_name
                and _sec_norm not in ctx.seen_sections
                and (not _body_opens_heading or _structural_over_subsection)
                and md_stripped
                and (md_stripped[0].isupper() or _structural_over_subsection)
                and _sec_norm not in body_heading_texts):
            ctx.seen_sections.add(_sec_norm)
            md = f"# {section_name}\n\n{md}"

        # TOC-guided structure NORMALISATION (printed-Contents books only, outside the notes
        # section, never on the Contents page or the front matter before it). Runs AFTER the
        # header-field injection so injected headings are normalised too (this book's
        # '# The Movement' / '# WRITING COPYRIGHT LICENSES' h1s exist ONLY via injection):
        #  • the FIRST body heading matching a NUMBERED chapter entry is rewritten to the full
        #    printed form at h1 ('Geeks and Recursive Publics' → '# 1. Geeks and Recursive
        #    Publics'); number-stripped matching is H1-ONLY, so a genuine SUBSECTION reusing a
        #    chapter's words ('## Coordinating Collaborations' inside chapter 3) never steals
        #    chapter 7's slot — an h2 matches only when it carries the number itself;
        #  • LATER matches of an already-used chapter are running-header leaks the exact-match
        #    dedupe missed (case variants: 'WRITING COPYRIGHT LICENSES') — stripped;
        #  • a PART divider the OCR dropped is re-injected above its first chapter;
        #  • an h1 matching NO Contents entry (ad captions, pull quotes read as headings)
        #    demotes to h2 — prefix-matching keeps 'CONCLUSION' under the printed
        #    'Conclusion: The Cultural Consequences…' at h1.
        if toc_numbered and not ctx.in_notes_section and i > toc_page_idx:
            _lines = md.split('\n')
            _changed = False
            for _li, _line in enumerate(_lines):
                _hm = re.match(r'^(#{1,6})\s+(.+?)\s*$', _line)
                if not _hm:
                    continue
                _text = _hm.group(2)
                _key = _toc_key(_text)
                _numbered_self = bool(re.match(r'^\d+[.)]?\s+\S', _norm_title(_text)))
                _full = toc_numbered.get(_key) if (_hm.group(1) == '#' or _numbered_self) else None
                if _full:
                    if _key not in ctx.toc_chapters_used:
                        ctx.toc_chapters_used.add(_key)
                        _part = toc_part_before.get(_key)
                        if (_part and _norm_heading(_part) not in ctx.seen_sections
                                and _norm_title(_part) not in ctx.promoted_toc_titles):
                            _lines[_li] = f'# {_part}\n\n# {_full}'
                        else:
                            _lines[_li] = f'# {_full}'
                    else:
                        _lines[_li] = None
                    _changed = True
                elif (_hm.group(1) == '#' and _key in toc_all_keys
                        and _STRUCTURAL_HEADING_RE.match(_key)):
                    # CASE-VARIANT structural duplicate: '# BIBLIOGRAPHY' right after
                    # '# Bibliography' is the divider page re-stating the injected heading in
                    # caps — a repeat the case-sensitive dedupe can't see. ONLY a case variant
                    # strips; an IDENTICAL-text repeat is genuine structure (93d34a74 has seven
                    # legitimate per-chapter '# References' sections) and stays.
                    _first = ctx.toc_structural_seen.get(_key)
                    if _first is None:
                        ctx.toc_structural_seen[_key] = _text
                    elif _first != _text:
                        _lines[_li] = None
                        _changed = True
                elif _hm.group(1) == '#':
                    _matches_toc = (_key in toc_all_keys
                                    or (len(_key) >= 8 and any(k.startswith(_key) for k in toc_all_keys)))
                    if not _matches_toc:
                        _lines[_li] = '## ' + _text
                        _changed = True
            if _changed:
                md = '\n'.join(l for l in _lines if l is not None)
                md_stripped = md.strip()

        # Track sections from EVERY heading in this page's body (page-opening AND mid-page —
        # a mid-page section heading must also arm the running-header dedupe above)
        for _h in _HEADING_LINE_RE.findall(md):
            ctx.seen_sections.add(_norm_heading(_h))

        # Convert numbered notes to footnote definitions on Notes pages
        if is_notes_page and classification != "wackSTEMbibliographyNotes":
            # OCR sometimes prepends a spurious ordered-list counter to an endnote's real printed
            # number ("40. 13. The concept…" — 40 is Mistral's running list index, 13 is the actual
            # note number). A footnote definition never legitimately opens with two "N. " markers, so
            # drop the leading counter and key the def on the real (second) number. Without this the
            # note is harvested but mis-keyed and can never link to its in-text marker (Cox notes
            # 13–22 landed at [^40]–[^49]). Runs before the single-number rule so it wins the line.
            md = re.sub(r'^\d{1,3}\. (\d{1,3})\. (.+)', r'[^\1]: \2', md, flags=re.MULTILINE)
            md = re.sub(r'^(\d{1,3})\. (.+)', r'[^\1]: \2', md, flags=re.MULTILINE)
            # Also handle N text format (no period) — common in document endnotes
            md = re.sub(r'^(\d{1,3}) ([A-Z\u2018\u201c\'"])', r'[^\1]: \2', md, flags=re.MULTILINE)
            # Also handle [N] text format — bracket-wrapped definitions
            md = re.sub(r'^\[(\d{1,3})\] (.+)', r'[^\1]: \2', md, flags=re.MULTILINE)

        # Page-bottom footnote DEFINITIONS the OCR split into `footer` (extract_footer=True).
        # Without this they are dropped entirely (assembly reads only `markdown`); append them to
        # the page body so per_page + post_combine normalise them like inline footnotes. Page order
        # keeps the [^N] ascending → one def section that matches the single ref section, instead of
        # relying on the pypdf fallback (which needs the original PDF and so never runs on replay).
        # Skipped for chapter_endnotes / wackSTEM: those apply a per-chapter/per-section number
        # OFFSET, so a stray page-bottom def would be re-keyed to the wrong note (a confident wrong
        # link). Their own assemblers + the pypdf pass own definition recovery.
        footer_defs = ''
        if classification not in ("chapter_endnotes", "wackSTEMbibliographyNotes"):
            footer_defs = _footer_footnote_defs(page.get("footer") or "")
            if footer_defs and assembler is not _DEFAULT_ASSEMBLER:
                md = f"{md}\n\n{footer_defs}" if md_stripped else footer_defs
                md_stripped = md.strip()

        # Per-classification per-page footnote handling (renumber / convert / offset + append).
        assembler.per_page(ctx, i, page, md, md_stripped)

        # Default path: footnote defs never sit inline in the body. per_page has already split this
        # page's inline definition paragraphs into ctx.deferred_defs_parts; the footer-recovered defs
        # (physically the very bottom of the page) follow them, so [^N] numbering stays ascending and
        # a page-spanning body sentence is never wedged apart by a definition (Barro 1974 fn 1 —
        # rejoin_page_breaks used to glue the next page's body onto the def, rendering it inside the
        # footnote popup).
        if footer_defs and assembler is _DEFAULT_ASSEMBLER:
            ctx.deferred_defs_parts.append(footer_defs)
            # A page-bottom note cut at the page turn continues at the TOP of the next page's
            # markdown — hand the open-tail state to the next page's split so the lowercase
            # continuation follows its def into the deferred block instead of stranding in body.
            last_para = re.split(r'\n\s*\n', footer_defs.strip())[-1]
            ctx.open_def_continuation = _ends_mid_sentence(last_para)

        # Collect BARE-number footer defs ("27 I am ignoring…") as candidates — injected in
        # post_combine only where an in-text marker [^N] is orphaned (Default path only).
        if assembler is _DEFAULT_ASSEMBLER and classification not in ("chapter_endnotes", "wackSTEMbibliographyNotes"):
            for num, txt in _footer_bare_num_defs(page.get("footer") or "").items():
                ctx.footer_bare_candidates.setdefault(num, txt)

    if fence_lines_stripped:
        print(f"  Stripped {fence_lines_stripped} stray code-fence line(s) on {fence_pages} page(s) "
              f"(odd fence count = OCR noise; an unpaired fence swallows the rest of the document)")
    if ctx.promoted_toc_titles:
        print(f"  TOC-promoted {len(ctx.promoted_toc_titles)} heading(s) from the printed Contents "
              f"(page {toc_page_idx}): {', '.join(sorted(ctx.promoted_toc_titles)[:6])}"
              + (' …' if len(ctx.promoted_toc_titles) > 6 else ''))

    combined = "\n\n".join(ctx.md_parts)
    # Block quotations arrive as plain paragraphs (Mistral gives no structural signal) — mark the
    # colon-introduced, fully quote-wrapped ones as '>' blockquotes so they render as
    # <blockquote>, not <p>. On the joined body, before the deferred defs are appended.
    combined = _wrap_quote_blockquotes(combined)
    # Append every deferred def (inline splits + footer recoveries, page order) as ONE contiguous
    # block at the end, BEFORE post_combine so its ref/def normalisation still runs over them.
    if ctx.deferred_defs_parts:
        combined = combined + "\n\n" + "\n\n".join(ctx.deferred_defs_parts)
    combined = assembler.post_combine(ctx, combined)

    # --- Fix mangled URLs from OCR ---
    if pdf_path:
        combined = fix_mangled_urls(combined, pdf_path)

    # --- pypdf fallback: recover missing footnote definitions ---
    # Skip for chapter_endnotes — renumbered offsets don't match pypdf's original numbers,
    # UNLESS we have explicit mojibake warnings (in which case we target only the affected pages).
    has_warnings = bool(footnote_warnings)
    skip_recovery = classification in ("wackSTEMbibliographyNotes", "chapter_endnotes") and not has_warnings
    pypdf_rejected_mojibake = []  # list of {page, fn_num, ratio}
    if pdf_path and not skip_recovery:
        # Collect definition numbers already in the assembled text
        ocr_def_nums = set(int(n) for n in re.findall(r'^\[\^(\d+)\]\s*:', combined, re.MULTILINE))
        # Collect all inline ref numbers
        ref_nums = set(int(n) for n in re.findall(r'\[\^(\d+)\]', combined))
        # Find refs that have no definition
        missing = ref_nums - ocr_def_nums
        if missing:
            max_ref = max(ref_nums) if ref_nums else 0
            try:
                pypdf_defs = extract_pypdf_footnote_defs(pdf_path, running_headers)
            except Exception as e:
                print(f"  pypdf fallback skipped (cannot read PDF: {e.__class__.__name__})")
                pypdf_defs = {}
            # Build per-page offsets map so pypdf-extracted numbers (always
            # originals) line up with the shifted IDs we wrote into `combined`.
            renumber_offsets = response_dict.get("_footnote_renumber_page_offsets") or []
            page_offsets_map = {i: off for i, off in enumerate(renumber_offsets) if off}

            # Reject pypdf defs whose text is mojibake (broken font CMap) —
            # injecting them just spreads garbage. Record them as warnings so
            # the user knows the source PDF needs a different OCR pass.
            MOJIBAKE_THRESHOLD = 0.85
            clean_pypdf_defs = {}
            for page_idx, page_defs in pypdf_defs.items():
                clean = []
                for fn_num, fn_text in page_defs:
                    ratio = compute_printable_ratio(fn_text)
                    if ratio < MOJIBAKE_THRESHOLD:
                        pypdf_rejected_mojibake.append({
                            "page": page_idx,
                            "fn_num": fn_num + page_offsets_map.get(page_idx, 0),
                            "printable_ratio": round(ratio, 3),
                        })
                    else:
                        clean.append((fn_num, fn_text))
                if clean:
                    clean_pypdf_defs[page_idx] = clean

            recovered = recover_missing_defs(
                ocr_def_nums, clean_pypdf_defs, max_ref,
                page_offsets=page_offsets_map,
            )
            if recovered:
                recovered_lines = [f'[^{num}]: {text}' for num, text in recovered]
                combined = combined.rstrip() + "\n\n" + "\n\n".join(recovered_lines)
                print(f"  pypdf fallback: recovered {len(recovered)} missing footnote definitions")
            if pypdf_rejected_mojibake:
                # These are "candidate" defs pypdf pattern-matched (^N + Uppercase)
                # on the source PDF — but the text payload was unreadable glyphs.
                # On excerpt/selection PDFs this is usually a false match on
                # non-def content (cover art, decoration, page metadata), not
                # actual broken footnote defs. So report it conservatively.
                print(f"  pypdf fallback: skipped {len(pypdf_rejected_mojibake)} unreadable candidate def(s) "
                      f"— either source omits def pages, or those pages use non-Unicode font encodings.")
                if footnote_warnings is None:
                    footnote_warnings = []
                for entry in pypdf_rejected_mojibake:
                    footnote_warnings.append({
                        "page": entry["page"],
                        "fn_numbers": [entry["fn_num"]],
                        "printable_ratio": entry["printable_ratio"],
                        "recovered": [],
                        "unrecovered": [entry["fn_num"]],
                        "reason": "unreadable_pypdf_candidate",
                    })

    # --- Convert <url> autolinks to clickable links ---
    # Angle-bracket URLs like <https://example.com> get stripped by HTML parsers.
    # Use <a> tags directly since footnote content is stored as HTML.
    combined = re.sub(
        r'<(https?://[^>]+)>',
        r'<a href="\1" target="_blank">\1</a>',
        combined
    )

    # --- Reorder image-before-caption → caption-before-image ---
    # OCR places images before their figure/table captions.  Swap so the
    # caption (e.g. "FIGURE 4 …") sits above its image for readability.
    combined = re.sub(
        r'^(!\[[^\]]*\]\([^)]+\))\n+((?:FIGURE|TABLE|CHART|GRAPH)\s.+)',
        r'\2\n\1',
        combined,
        flags=re.MULTILINE | re.IGNORECASE,
    )

    # --- Add ## Footnotes heading before definitions ---
    # Find the first footnote definition and insert heading before it
    fn_heading_match = re.search(r'^(\[\^\d+\]\s*:)', combined, re.MULTILINE)
    if fn_heading_match:
        pos = fn_heading_match.start()
        combined = combined[:pos].rstrip() + "\n\n## Footnotes\n\n" + combined[pos:]

    return combined


def save_images(response_dict, media_dir):
    """Extract and save base64-encoded images from the OCR response."""
    media_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for page in response_dict["pages"]:
        for img in page.get("images", []):
            img_id = img.get("id", "")
            img_b64 = img.get("image_base64", "")
            if not img_b64 or not img_id:
                continue
            # Strip data URI prefix if present
            if img_b64.startswith("data:"):
                img_b64 = img_b64.split(",", 1)[1]
            img_path = media_dir / img_id
            img_path.write_bytes(base64.b64decode(img_b64))
            count += 1
    return count

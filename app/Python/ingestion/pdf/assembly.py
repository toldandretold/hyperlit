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
    extract_pypdf_page_texts, resurrect_glued_markers_from_pypdf,
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


# An embedded "  [^N] Text" segment INSIDE a def paragraph — the OCR glued a whole
# affiliation/def list into ONE line ("[^1]: Copernicus…  [^2] Department…  [^3] German…",
# 2c0544c4). The two-plus-space separator + no colon distinguishes an embedded def opener
# from an inline ref glued to a word.
_EMBEDDED_GLUED_DEF_RE = re.compile(r'\s{2,}\[\^(\d{1,3})\](?!:)[ \t]+(?=\S)')


# A parenthesized footnote ref GLUED to the preceding word or punctuation — "…the Bangalore
# Outcome Document.(5)", "the existing literature(1)", "involvement,(28)" (9bb2f3aa: IIED/E&U
# journal style, notes printed in a side column). A spaced "equation (5)" never matches: the
# paren must ride the preceding character. Mistral also renders some of these superscripted as
# "^(14)^" / "^{(33)}" — normalised to plain "(N)" before the scan.
_PAREN_FN_REF_RE = re.compile(r"(?<=[\w.!?,'\"”’])\((\d{1,2})\)")
_PAREN_SUP_WRAP_RE = re.compile(r'\^\{?\((\d{1,2})\)\}?\^?')
_NUMDOT_DEF_LINE_RE = re.compile(r'(?m)^(\d{1,2})\.\s+(\S.*)$')
# A numbered line that reads like a citation NOTE (year / URL / cross-reference apparatus) —
# the document's OTHER numbered lists (9bb2f3aa carries the 17 SDG goals as "1. End poverty…")
# share the "N. Text" shape but never this content.
_NOTE_SHAPE_RE = re.compile(
    r'(?:19|20)\d\d|https?://|www\.|\bSee reference\b|\baccessed\b|\bIbid\b|\bop\.\s*cit|\bpage \d')


def _convert_sidecolumn_paren_footnotes(combined):
    """Side-column-notes layout: body refs are "(N)" parenthesized numbers glued to the
    preceding word/punctuation; the notes arrive interleaved as line-start "N. Text" entries
    (Mistral flattens the side column into the page flow). Convert refs to [^N] and their defs
    to [^N]: — gated HARD on the document-level shape so ordinary numbered lists, equation
    references and bibliographies never convert: >= 5 glued paren refs, the ref sequence
    ascending in document order (at most one descent), defs ascending, and >= 80% of the refs
    must have a matching def entry."""
    norm = _PAREN_SUP_WRAP_RE.sub(r'(\1)', combined)
    refs = [(m.start(), int(m.group(1))) for m in _PAREN_FN_REF_RE.finditer(norm)]
    if len(refs) < 5:
        return combined
    ref_nums = [n for _pos, n in refs]
    if sum(1 for a, b in zip(ref_nums, ref_nums[1:]) if b <= a) > 1:
        return combined                    # not an ascending footnote sequence
    # One candidate LINE per number, not number-blind conversion: prefer the note-shaped line
    # (year/URL/cross-ref apparatus); a plain line qualifies only when its number is unique in
    # the document — this keeps the SDG-goals list ("5. Achieve gender equality…") from being
    # converted over the real note 5, while still admitting a rare apparatus-free note.
    cands = {}
    for m in _NUMDOT_DEF_LINE_RE.finditer(norm):
        n = int(m.group(1))
        cands.setdefault(n, []).append((m.start(), m.end(), m.group(2),
                                        bool(_NOTE_SHAPE_RE.search(m.group(2)))))
    chosen = {}
    for n, lst in cands.items():
        shaped = [c for c in lst if c[3]]
        if shaped:
            chosen[n] = shaped[0]
        elif len(lst) == 1:
            chosen[n] = lst[0]
    if sum(1 for n in ref_nums if n in chosen) < len(ref_nums) * 0.8:
        return combined                    # the numbered lines are not these refs' notes
    linked = {n for n in ref_nums if n in chosen}
    # DEFER the defs to one contiguous block at the document END — the pipeline's standard
    # contract (the '## Footnotes' heading is inserted before the FIRST def, so defs left
    # interleaved where the side column was flattened would split the body with a
    # mid-document Footnotes section AND render 30+ note paragraphs inside the text flow).
    # Splice each chosen note line OUT of the flow (descending offsets)…
    deferred = []
    for n in sorted(linked, key=lambda n: chosen[n][0], reverse=True):
        start, end, text, _shaped = chosen[n]
        deferred.append((n, text))
        norm = norm[:start] + norm[end:]
    norm = re.sub(r'\n{3,}', '\n\n', norm)
    # …convert the refs regex-wise (position-independent)…
    norm = _PAREN_FN_REF_RE.sub(
        lambda m: f'[^{m.group(1)}]' if int(m.group(1)) in linked else m.group(0), norm)
    # …and append the defs ascending at the end.
    defs_block = '\n\n'.join(f'[^{n}]: {text}'
                             for n, text in sorted(deferred, key=lambda d: d[0]))
    return norm.rstrip() + '\n\n' + defs_block


def _demote_defless_citation_refs(combined):
    """2c0544c4: a doc whose ONLY footnote defs are a small author-affiliation universe
    (defs 1..N, N small) but whose body carries superscript VANCOUVER citations that the
    caret converters turned into footnote refs. Two demotion classes, both to BRACKET
    citations ("[13]") that the digestion-side NumberedBracketCitationLinker links to the
    ordinal bibliography (verified: a bracket single citation-links correctly even when a
    same-number affiliation def exists — 6c4e7d58's [4]):
    - numbers BEYOND the def universe matching a '^N. ' bibliography line ([^27]/[^74]);
    - numbers INSIDE the def universe but sitting OUTSIDE the author block — in this doc
      shape an affiliation marker only ever attaches to an author NAME in the front matter;
      a body superscript 13 cites bibliography entry 13, never the Potsdam Institute
      (the body-[^13]→affiliation link was the wrong-link failure the maintainer caught).
      Because the SAME numbers serve BOTH regimes (continuous ascending citations vs
      repeating affiliations), in-universe demotion additionally requires EVIDENCE that
      the body's superscripts are the citation regime: at least two beyond-universe
      bib-covered refs must exist. No evidence → in-universe body refs keep their markers.
    Unprefixed latex superscript RANGES ($^{2-4}$) under the same gates become [2-4] range
    citations, and adjacent demoted singles merge ([30][31] → [30,31]).
    Guards keep real footnote docs untouched: needs a contiguous-from-1, small (<=30) def
    universe AND a numbered bibliography covering the demoted number; def LINES are never
    touched; author-block occurrences keep their markers so affiliations stay linked."""
    defs = sorted({int(n) for n in re.findall(r'(?m)^\s*\[\^(\d+)\]\s*:', combined)})
    # NEAR-contiguous small universe: pypdf recovery can add genuine discursive footnotes
    # with a gap (6c4e7d58: affiliations 1-5 + recovered notes 7,8 — def 6's text was never
    # found), so strict contiguity would turn the whole pass off exactly when the number
    # spaces collide hardest. Coverage >= 70% of 1..max keeps random def sets excluded.
    if (len(defs) < 3 or defs[0] != 1 or defs[-1] > 30
            or len(defs) < defs[-1] * 0.7):
        return combined
    max_def = defs[-1]
    bib_nums = {int(n) for n in re.findall(r'(?m)^(\d{1,3})\.\s+\S', combined)}
    if not bib_nums:
        return combined

    # The author ZONE ends with the last actual author line: >= 2 markers, name-list shaped
    # (no sentence-terminal punctuation — body prose paragraphs are single md lines ending
    # '.', so they never qualify). Window is generous (60 lines) because repository cover
    # sheets push the real author line deep (2e9728f6: line 29); the SHAPE check is what
    # keeps abstract/body citations unshielded, not the window.
    zone_end = 0
    offset = 0
    for line in combined.split('\n')[:60]:
        line_end = offset + len(line) + 1
        stripped = line.strip()
        if (len(re.findall(r'\[\^\d{1,2}\]', stripped)) >= 2
                and not re.search(r'[.!?]\s*$', stripped)):
            zone_end = line_end
        offset = line_end

    def eligible(m, n):
        if n not in bib_nums:
            return False
        # def lines stay defs; author-block refs stay affiliation markers
        if m.start() == 0 or combined[m.start() - 1] == '\n':
            return False
        if combined[m.end():m.end() + 1] == ':':
            return False
        if n <= max_def and m.start() < zone_end:
            return False
        return True

    # EVIDENCE gate for the in-universe class: the regimes share numbers, so demoting an
    # in-universe body ref is only safe when the doc demonstrably cites by number — either
    # beyond-universe bib-covered [^N] refs exist, OR the body carries a real population of
    # LITERAL bracket citations ([4], [8*], [10,11] — 6c4e7d58's citation regime survives as
    # brackets wherever the sequence validator declined to promote them).
    beyond = sum(1 for m in re.finditer(r'\[\^(\d+)\]', combined)
                 if int(m.group(1)) > max_def and eligible(m, int(m.group(1))))
    literal_brackets = sum(
        1 for m in re.finditer(r'(?<!\^)\[(\d{1,3})\*{0,2}(?:\s*,\s*\d{1,3}\*{0,2})*\]',
                               combined)
        if m.start() > 0 and combined[m.start() - 1] != '\n'
        and int(m.group(1)) in bib_nums)
    demote_in_universe = beyond >= 2 or literal_brackets >= 5

    def repl(m):
        n = int(m.group(1))
        if not eligible(m, n):
            return m.group(0)
        if n <= max_def and not demote_in_universe:
            return m.group(0)
        return f'[{n}]'
    out = re.sub(r'\[\^(\d+)\]', repl, combined)

    if out != combined:
        # unprefixed latex superscript ranges ("$^{2-4}$") are the same citation regime
        def range_repl(m):
            a, b = int(m.group(1)), int(m.group(2))
            if a < b and a in bib_nums and b in bib_nums and b - a <= 10:
                return f'[{a}-{b}]'
            return m.group(0)
        out = re.sub(r'\$\^\{(\d{1,3})\s*[-–−]+\s*(\d{1,3})\}\$', range_repl, out)
        # merge adjacent demoted singles into one citation group
        prev = None
        while prev != out:
            prev = out
            out = re.sub(r'\[(\d{1,3}(?:,\d{1,3})*)\]\[(\d{1,3})\]', r'[\1,\2]', out)
    return out


# A def-shaped entry opening a page FOOTER: "1 As examined in section 2: …" / "1. Text…".
_FOOTER_RESCUE_DEF_RE = re.compile(r'(?m)^\s*(\d{1,2})[.)]?[ \t]+(?=[A-Z(‘“"\'])')


def _rescue_refless_footer_footnotes(combined, response_dict, pdf_path):
    """A footnote whose in-text marker Mistral dropped ENTIRELY and whose definition landed in
    the page FOOTER (5c548774: printed "…interventions were reviewed¹." OCR'd with no marker at
    all — zero refs, so classification fell to 'none' and no recovery path ever ran, while the
    def sat in the footer field). For each footer def-shaped entry whose number has no in-text
    ref: use the PDF TEXT LAYER as the marker witness — the print seam survives there in one of
    two conventions, "reviewed1. The" (marker before the sentence period) or "risk.9 This"
    (after it) — insert the marker at the seam (which must match EXACTLY ONCE in the whole
    document; ambiguity skips) and fold the def in. The marker gets a FRESH number when the
    printed one is already taken (this doc's author affiliations occupy [^1..14] — reusing the
    printed 1 would wrong-link to an affiliation). Returns (combined, rescued_count)."""
    # Candidate set 1 — FOOTER defs (def stranded in the footer field, no def in combined).
    candidates = []
    for page in response_dict.get('pages', []):
        footer = (page.get('footer') or '').strip()
        if not footer:
            continue
        starts = list(_FOOTER_RESCUE_DEF_RE.finditer(footer))
        for k, m in enumerate(starts):
            end = starts[k + 1].start() if k + 1 < len(starts) else len(footer)
            text = re.sub(r'\s+', ' ', footer[m.end():end]).strip()
            if len(text) >= 20:
                candidates.append((page.get('index'), int(m.group(1)), text))
    # Candidate set 2 — ORPHANED defs already IN combined (c2d6bdb1: the Notes-section defs
    # converted fine, only the in-text superscripts were dropped). def_text None = marker-only
    # rescue, and the marker MUST keep the def's own number to link to it.
    for m in re.finditer(r'(?m)^\[\^(\d{1,2})\]:', combined):
        candidates.append((None, int(m.group(1)), None))

    if not pdf_path:
        return combined, 0
    try:
        page_texts = extract_pypdf_page_texts(pdf_path)
    except Exception:
        return combined, 0

    def _norm_head(t):
        return re.sub(r'[^a-z0-9]+', ' ', (t or '').lower()).strip()[:30]

    # Candidate set 3 — DOUBLE LOSS (cece961b): Mistral dropped the markers AND the page-bottom
    # defs wholesale, but the TEXT LAYER holds both. Defs render as a digit ALONE on its line
    # followed by the note text ("4⏎Including a distinction between CRZ1a and b…"). The body
    # MARKER renders identically ("2017).⏎4⏎The regulation states…"), so the decisive gate is
    # that a candidate's text must be ABSENT from the OCR body — a body continuation exists in
    # the markdown; a wholesale-dropped def does not.
    for page_idx, ptext in page_texts.items():
        lines = ptext.split('\n')
        for k, line in enumerate(lines):
            lm = re.match(r'^\s*(\d{1,2})\s*$', line)
            if not lm or int(lm.group(1)) > 30:
                continue
            body_lines = []
            for nxt in lines[k + 1:]:
                if re.match(r'^\s*\d{1,2}\s*$', nxt):
                    break
                if re.match(r'^[A-Z]\.\s*[A-Z][a-zA-Z\-]+ et al\.\s*$', nxt.strip()):
                    break                      # running author footer
                body_lines.append(nxt.strip())
                if sum(len(b) for b in body_lines) > 600:
                    break
            text = re.sub(r'\s+', ' ', ' '.join(body_lines)).strip()
            if len(text) < 20:
                continue
            if _norm_head(text) and _norm_head(text) in re.sub(r'[^a-z0-9]+', ' ',
                                                               combined.lower()):
                continue                       # body continuation, not a lost def
            candidates.append((page_idx, int(lm.group(1)), text))

    if not candidates:
        return combined, 0
    used = {int(n) for n in re.findall(r'\[\^(\d{1,3})\]', combined)}

    # Insertions must land in the BODY: a seam matching inside the References/Bibliography
    # region would decorate a bibliography entry with a phantom marker.
    refs_m = None
    for m in re.finditer(r'(?mi)^#{1,6}\s*(?:references|bibliography|works cited|notes)\b.*$',
                         combined):
        refs_m = m
    body_end = refs_m.start() if refs_m else len(combined)

    next_free = max(used, default=0) + 1
    rescued_defs = []
    rescued = 0
    for page_idx, num, def_text in candidates:
        # A number that already has an IN-TEXT ref is linked material — EXCEPT a FOOTER def
        # under a page-LOCAL number that collides with a DIFFERENT globally-linked note
        # (699314f1: footer "2 Briefing note documents…" vs the linked [^2] "What
        # administration constituted…"). A distinct-text footer def proceeds and takes a
        # fresh number; everything else with a live ref is skipped.
        if any(mm.start() > 0 and combined[mm.start() - 1] != '\n'
               for mm in re.finditer(rf'\[\^{num}\](?!:)', combined)):
            if def_text is None:
                continue                # orphan-def marker hunt: this number is linked
            existing = re.search(rf'(?m)^\[\^{num}\]:\s*(.+)$', combined)
            def _head(t):
                return re.sub(r'[^a-z0-9]+', ' ', (t or '').lower()).strip()[:30]
            if not existing:
                # ref exists but NO def anywhere — this candidate IS the missing definition
                # (the classic pypdf missing-def recovery, via the split-line shape): attach
                # it under the ref's own number, no marker insertion needed.
                if num not in {int(n) for r in rescued_defs
                               for n in re.findall(r'\[\^(\d+)\]', r)}:
                    rescued_defs.append(f'[^{num}]: {def_text}')
                    used.add(num)
                    rescued += 1
                continue
            if _head(existing.group(1)) == _head(def_text):
                continue                # same note already linked — nothing to rescue
        ptexts = ([page_texts.get(page_idx)] if page_idx is not None
                  else list(page_texts.values()))
        seam = None
        for ptext in ptexts:
            if not ptext:
                continue
            # marker renderings in the pypdf layer, tightest first:
            #   glued digit-first   "reviewed1. The"
            #   glued punct-first   "risk.9 This"
            #   line-start marker   "ESD.\n1 For"   (the superscript opened a new text run)
            #   line-end marker     "2010). 2\nThis" (the superscript closed one)
            m = re.search(rf'([A-Za-z]{{3,}})\s?{num}([.,;:!?])\s+([A-Za-z]{{2,}})', ptext)
            if m:
                seam = (m.group(1), m.group(2), m.group(3))
                break
            # glued punct-first also after digits/parens: "…Aniekwe et al. (2012).2 The"
            m = re.search(rf'([A-Za-z0-9)\]]{{2,}}[.,;:!?]){num}\s+([A-Za-z]{{2,}})', ptext)
            if m:
                seam = (m.group(1), '', m.group(2))
                break
            m = re.search(rf'([A-Za-z]{{2,}}[.!?)])\n{num} ([A-Za-z]{{2,}})', ptext)
            if m:
                seam = (m.group(1), '', m.group(2))
                break
            m = re.search(rf'([A-Za-z0-9)\]]{{2,}}[.!?]) {num}\n([A-Za-z]{{2,}})', ptext)
            if m:
                seam = (m.group(1), '', m.group(2))
                break
            # digit ALONE on its own line between the punct line and the continuation —
            # cece961b: "…(Chouhan et al., 2017).⏎4⏎The regulation states…"
            m = re.search(rf'([A-Za-z0-9)\]]{{2,}}[.,;!?])\s*\n{num} ?\n\s*([A-Za-z]{{2,}})',
                          ptext)
            if m:
                seam = (m.group(1), '', m.group(2))
                break
        if seam is None:
            continue                    # no witness in the PDF text layer — never guess
        # follow_tail: further words after the seam in the SAME text-layer context (m/ptext
        # hold the breaking iteration's match), used to extend an ambiguous witness
        # ("2017). The" matches twice in the md; "2017). The regulation" matches once —
        # cece961b's [^4]).
        follow_tail = re.sub(r'\s+', ' ', ptext[m.end():m.end() + 60]).strip() if m else ''
        word, punct, follow = (re.escape(s) for s in seam)
        pattern = rf'{word}{punct}\s+{follow}'
        # The DIGITLESS seam must not exist anywhere in the text layer itself: if the PDF
        # carries both "study10 :" (the marker site) and "case study: over" (plain prose,
        # possibly pages away), the markdown's unique match can be the WRONG site — the
        # witness and the insertion would be different locations (ad752a46: a law-review
        # abstract got a phantom [^10] from a seam witnessed 40 pages later).
        if any(re.search(pattern, pt) for pt in page_texts.values() if pt):
            continue
        hits = list(re.finditer(pattern, combined))
        if len(hits) > 1 and follow_tail:
            # ambiguous with one follow word — extend the witness word by word until unique
            extra_words = follow_tail.split()
            for w in extra_words[:3]:
                if not re.match(r'^[A-Za-z]{2,}[.,;:]?$', w):
                    break
                pattern += rf'\s+{re.escape(w.rstrip(".,;:"))}'
                hits = list(re.finditer(pattern, combined))
                if len(hits) <= 1:
                    break
        if len(hits) != 1 or hits[0].start() >= body_end:
            continue                    # reworded, ambiguous, or in the back matter — skip
        if def_text is None:
            target = num                # marker-only: must link to the EXISTING def
        else:
            target = num if num not in used else next_free
            if target == next_free:
                next_free += 1
        used.add(target)
        h = hits[0]
        word_len = len(seam[0])
        insert_at = h.start() + word_len
        combined = combined[:insert_at] + f'[^{target}]' + combined[insert_at:]
        if def_text is not None:
            rescued_defs.append(f'[^{target}]: {def_text}')
        rescued += 1
    if rescued_defs:
        combined = combined.rstrip() + '\n\n' + '\n\n'.join(rescued_defs)
    if rescued:
        print(f"  Footnote-marker rescue: re-injected {rescued} dropped marker(s) via the PDF "
              f"text layer ({len(rescued_defs)} def(s) folded from page footers)")
    return combined, rescued


_AUTHOR_LINE_MARKER_RE = re.compile(r'\[\^(\d{1,2})\]')


def _demote_defless_author_markers(combined):
    """Strip [^N] markers from an author name-list line when NO marker on the line has a
    definition anywhere in the document (a280cf5b: Mistral never captured the affiliation
    block, so the markers are permanently unlinkable literal junk). Shape guards: first 50
    lines, >= 2 markers, uppercase opener, list punctuation (comma / 'and'), and not a
    sentence-shaped line — a body paragraph with genuinely missing footnotes keeps its
    markers (that loss must stay visible in the audit)."""
    def_nums = set(re.findall(r'(?m)^\s*\[\^(\d+)\]\s*:', combined))
    lines = combined.split('\n')
    changed = False
    for i, line in enumerate(lines[:50]):
        refs = _AUTHOR_LINE_MARKER_RE.findall(line)
        if len(refs) < 2 or any(n in def_nums for n in refs):
            continue
        stripped = _AUTHOR_LINE_MARKER_RE.sub('', line).strip()
        if not stripped or not stripped[0].isupper():
            continue
        if ',' not in stripped and ' and ' not in stripped:
            continue                     # not a name list
        if re.search(r'[.!?]\s*$', stripped):
            continue                     # sentence-shaped — body prose, keep the markers
        lines[i] = _AUTHOR_LINE_MARKER_RE.sub('', line)
        changed = True
    return '\n'.join(lines) if changed else combined


def _split_glued_inline_defs(combined):
    """Split a single def LINE carrying multiple glued '[^N] Text' segments into one definition
    per line. Applies only to a line that already IS a definition ('[^1]: …') whose embedded
    [^N] markers continue the leader's number in a strictly ascending run — a body paragraph's
    inline refs never look like that."""
    lines = combined.split('\n')
    changed = False
    for i, line in enumerate(lines):
        lead = re.match(r'^\[\^(\d{1,3})\]\s*:', line)
        if not lead:
            continue
        embedded = _EMBEDDED_GLUED_DEF_RE.findall(line)
        if len(embedded) < 2:
            continue
        nums = [int(lead.group(1))] + [int(n) for n in embedded]
        if any(b <= a for a, b in zip(nums, nums[1:])):
            continue                     # not an ascending def run — leave untouched
        parts = _EMBEDDED_GLUED_DEF_RE.split(line)
        # parts = [lead-def, num, text, num, text, …]
        rebuilt = [parts[0].rstrip()]
        for n, text in zip(parts[1::2], parts[2::2]):
            rebuilt.append(f'[^{n}]: {text.rstrip()}')
        lines[i] = '\n\n'.join(rebuilt)
        changed = True
    return '\n'.join(lines) if changed else combined


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
        # Side-column-notes shape (".(5)" refs + interleaved "N. Text" notes) — must convert
        # BEFORE the generic normalisers, which cannot see either form.
        combined = _convert_sidecolumn_paren_footnotes(combined)
        combined = normalize_all_footnote_refs(combined)
        combined = normalize_footnote_defs(combined)
        # Fix footnote definitions: OCR produces [^N] Text but markdown expects [^N]: Text
        # Only at start of line (definitions), not inline references
        combined = re.sub(r'^(\[\^\d+\])\s+(?=[A-Za-z\d"\'(*“‘])', r'\1: ', combined, flags=re.MULTILINE)
        # A whole affiliation list OCR-glued into ONE def line → one definition per line.
        combined = _split_glued_inline_defs(combined)
        # Re-run the def-gated latex expansion: comma groups ($^{7,8}$ author-affiliation
        # markers) that failed the gate while defs 2..N were still glued mid-line now see
        # every def at line start (2c0544c4). Idempotent on already-converted text.
        combined = expand_latex_superscripts(combined)
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
        page_map = {}
        pypdf_nums = {n for n, _t in (getattr(ctx, 'pypdf_page_defs', None) or {}).get(i, [])}
        # Markers Mistral dropped ENTIRELY (no digit left to license) — resurrect from the PDF
        # text layer's glued-superscript seams before renumbering, so they enter the page map
        # and the missing-def recovery can pair them.
        ptext = (getattr(ctx, 'pypdf_page_texts', None) or {}).get(i)
        if pypdf_nums and ptext:
            md, _n = resurrect_glued_markers_from_pypdf(md, ptext, pypdf_nums, f' (page {i})')
        md, ctx.global_fn_counter = renumber_page_footnotes(
            md, ctx.global_fn_counter, page_map, pypdf_licensed=pypdf_nums)
        if page_map:
            ctx.page_local_to_global[i] = page_map
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
    # Prefer the LAST heading actually FOLLOWED by a numbered "1. " run — a doc can carry both
    # "## Notes" (the numbered endnote list) and a later "## References" (author-year
    # bibliography, 80bb62b6); blindly taking the last heading anchors on the bibliography and
    # the endnote list never converts. Falling back to the last match keeps the original
    # behaviour for front-matter TOC repeats.
    candidates = list(_ENDNOTE_LIST_HEADING_RE.finditer(combined))
    heading = None
    for m in reversed(candidates):
        if re.search(r'(?m)^1\. \S', combined[m.end():m.end() + 400]):
            heading = m
            break
    if heading is None and candidates:
        heading = candidates[-1]
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
# A colon intro that ATTRIBUTES the quote — a reporting verb right before the colon
# ("As Neocleous (2013: np) argues:"). Gates the quote-dense heuristic below.
_QUOTE_INTRO_REPORTING_RE = re.compile(
    r"(?i)\b(?:argue[sd]?|writes?|wrote|note[sd]?|state[sd]?|observe[sd]?|explain(?:s|ed)?|"
    r"puts?\s+it|remark(?:s|ed)?|assert(?:s|ed)?|claim(?:s|ed)?|suggest(?:s|ed)?|"
    r"describe[sd]?|says?|said|conclude[sd]?|recall(?:s|ed)?|discuss(?:es|ed)?)\s*(?:that)?\s*:\s*$")
# An intro that ANNOUNCES a passage: "…in the following account from *Custer Died for Your
# Sins*:" — the "following"/"follows" vocabulary, anywhere before the colon.
_QUOTE_INTRO_FOLLOWING_RE = re.compile(r"(?i)\bfollow(?:ing|s)\b[^:]*:\s*$")
# An author-first bibliography entry opener ("Rabinow, Paul. Anthropos Today…") — a paragraph
# shaped like this is a REFERENCE, never a quotation (guards the epigraph heuristic against
# em-dash repeat-author entry pairs in a bibliography, f07b7fff).
_BIB_AUTHOR_FIRST_RE = re.compile(r"^[A-ZÀ-Þ][a-zA-Z'’-]+,\s+[A-Z]")
# A paragraph END of the form "…sentence terminal, then a parenthetical citation": the
# block-quote attribution convention ("…inhabitants. (Deloria, 1998, p.5)" — some typesetters
# add a period AFTER the paren too: "…landscape. (Lawrence, as quoted in Deloria, 1998, p. 4).").
# The load-bearing discriminator is the sentence punctuation BEFORE the paren — an inline
# citation sits INSIDE its sentence, so a word precedes the paren ("…remaining Indians
# (as quoted in Hastings, 2007)."). The terminal must be REAL sentence punctuation (optionally
# inside a closing quote) — a bare closing quote before the paren is a mid-sentence quoted term
# ("…'feeling rules' (Hochschild, 1983)"), not a sentence end.
_QUOTE_CITE_TERMINAL_RE = re.compile(
    r"[.?!…][\"'’”]?\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.?\s*(?:\[\^\d+\])?\s*"
    r"(?:<a class=\"pageNumber\"[^>]*></a>)?\s*$")
_QUOTE_CITE_YEARISH_RE = re.compile(r"\b(?:1[5-9]\d\d|20\d\d)[a-z]?\b|\bp{1,2}\.\s*\d")
# An EPIGRAPH attribution line — a standalone dash-led paragraph naming the source
# ("-Franz Fanon, The Wretched of the Earth, 1963, p. 36", 244ae673). The dash + a comma-
# separated citation carrying a year/page is the print convention; a markdown BULLET is a
# LIST (consecutive dash lines), which the caller checks before wrapping.
_QUOTE_DASH_ATTRIBUTION_RE = re.compile(r"^[-–—]\s?[A-ZÀ-Þ][^\n]{5,120}$")
_QUOTE_CITE_ASIDE_RE = re.compile(
    r"(?i)^\s*(?:see|cf|e\.g|i\.e|for (?:example|a review)|compare|but see|as noted|also)\b")
_QUOTE_DQUOTE_SPAN_RE = re.compile(r'[“"][^”"]{2,}?[”"]')


def _quote_cite_terminal(s):
    """The paragraph ends in a standalone parenthetical citation (year or page ref inside,
    not a '(see also …)' aside, not a full parenthesized sentence ending in its own period)."""
    m = _QUOTE_CITE_TERMINAL_RE.search(s)
    if not m:
        return False
    cite = m.group(1).strip()
    return (len(cite) <= 120
            and _QUOTE_CITE_YEARISH_RE.search(cite) is not None
            and not _QUOTE_CITE_ASIDE_RE.match(cite)
            and not re.search(r'[.!?]$', cite))


def _plain_prose_para(s):
    """A single-paragraph candidate for quote wrapping: not a heading/list/table/def/native
    blockquote, one line of prose."""
    return bool(s) and '\n' not in s and not s.startswith(('>', '#', '-', '*', '|', '[', '!', '<')) \
        and not re.match(r'^\d+[.)]\s', s)


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
        # Citation-terminated quote (244ae673 / 68252cc2): a substantial plain paragraph whose
        # final characters are ". (Author, 1998, p.5)" — terminal punctuation BEFORE the paren
        # and no period after it. That ordering only occurs when the paren is a block-quote
        # attribution; an inline citation keeps its period after the paren. Needs no intro.
        # Must open uppercase/quote — a lowercase opener is a page-break continuation of a
        # body paragraph, not a quotation.
        elif (_plain_prose_para(s) and len(s) >= 150
                and (s[0].isupper() or s[0] in _QUOTE_OPEN_CHARS)
                and _quote_cite_terminal(s)):
            paras[k] = '> ' + s
        # Attributed-colon quote (3fbb92da): the intro ends in a reporting verb + colon
        # ("As Neocleous (2013: np) argues:") and the paragraph itself is quote-DENSE (>= 2
        # internal double-quoted spans) — a quotation typeset without wrapping quote marks.
        # A quoteless paragraph after a plain colon intro stays a paragraph (pinned negative).
        elif (_plain_prose_para(s) and len(s) >= 80
                and _QUOTE_INTRO_END_RE.search(prev_stripped)
                and (_QUOTE_INTRO_REPORTING_RE.search(prev_stripped)
                     or _QUOTE_CITE_YEARISH_RE.search(prev_stripped))
                and len(_QUOTE_DQUOTE_SPAN_RE.findall(s)) >= 2
                and re.search(r"[.?!…\"'’”]\s*(?:\[\^\d+\])?\s*$", s)):
            paras[k] = '> ' + s
        prev_stripped = s
    # EPIGRAPH shape (244ae673's Fanon quotes): a plain quote paragraph followed by a standalone
    # dash-led attribution line ("-Franz Fanon, The Wretched of the Earth, 1963, p. 36"). The
    # attribution must carry a comma-separated citation with a year/page, and must not be a
    # markdown BULLET (a list is consecutive dash lines — neighbours are checked). Quote and
    # attribution wrap as ONE blockquote via the '>' connector line.
    for k, para in enumerate(paras):
        if para is None or k == 0 or paras[k - 1] is None:
            continue
        s = para.strip()
        if (not _QUOTE_DASH_ATTRIBUTION_RE.match(s)
                or ',' not in s
                or ':' in s
                or not _QUOTE_CITE_YEARISH_RE.search(s)):
            continue                              # ':' = publisher colon — a repeat-author
                                                  # bibliography entry, not an attribution
        nxt = next((paras[j].strip() for j in range(k + 1, len(paras))
                    if paras[j] is not None and paras[j].strip()), '')
        if nxt and nxt[0] in '-–—' and not _QUOTE_CITE_YEARISH_RE.search(nxt):
            continue                              # consecutive dash lines — a bullet list
        quote = paras[k - 1].strip()
        if (_plain_prose_para(quote) and len(quote) >= 60
                and quote[:1] not in '-–—'
                and not _BIB_AUTHOR_FIRST_RE.match(quote)
                and (quote[0].isupper() or quote[0] in _QUOTE_OPEN_CHARS)):
            paras[k - 1] = '> ' + quote + '\n>\n> ' + s
            paras[k] = None
    # A PAGE-SPANNING quotation Mistral wrapped only half of: the continuation page arrives as a
    # native '> ' paragraph opening in lowercase, while the quote's first half (previous page)
    # sits unwrapped — it opens with a quote char but never closes (cut at the page turn). Pull
    # the first half into the same blockquote, with a '>' separator line so the converter renders
    # ONE <blockquote> ('‘Yet, while all of these changes…' / '> are omitted when…').
    for k, para in enumerate(paras):
        if para is None:
            continue
        s = para.strip()
        if not s.startswith('> '):
            continue
        first_content = s[2:].lstrip()
        if not first_content[:1].islower():
            continue
        j = k - 1
        while j >= 0 and (paras[j] is None or not paras[j].strip()):
            j -= 1
        if j < 0 or paras[j] is None:
            continue
        prev = paras[j].strip()
        if (prev and prev[0] in _QUOTE_OPEN_CHARS
                and not prev.startswith('> ')
                and '\n' not in prev
                and not _QUOTE_PARA_END_RE.search(prev)):
            paras[j] = '> ' + prev + '\n>\n' + s
            paras[k] = None
    return '\n\n'.join(p for p in paras if p is not None)

_BOX_HEADING_PARA_RE = re.compile(r'^#{1,6}[ \t]+\S')

# A BREAKOUT-BOX title — the BMJ-family vocabulary for boxed summaries. Only sections with
# these titles get the box RENDERING below; a genuine body section that merely got relocated
# keeps its ordinary paragraphs.
_BOX_TITLE_RE = re.compile(
    r'(?i)^#{1,6}[ \t]+(?:summary points?|key (?:points?|messages?|findings?)|'
    r'learning points?|practice points?|what this (?:study|paper) adds|'
    r'policy implications?|box \d+[.:]?)\b')


def _relocate_sentence_interrupting_boxes(md):
    """A boxed side-section (BMJ 'Summary points', 63817b36) that print layout drops into the
    MIDDLE of a body sentence: Mistral emits '…they seek and' → '## Summary points' → the box
    paragraphs → 'compete for the best…'. Detect the interruption (paragraph before a heading
    ends mid-sentence; a LOWERCASE-opening paragraph within the next few resumes it), rejoin
    the split sentence, and move the box after it. Bounded to 8 paragraphs and aborted at the
    next heading, so a genuine long section is never dragged around; a real heading should
    never sit mid-sentence, so relocation is safe whenever the shape matches."""
    paras = re.split(r'\n\s*\n', md)
    moved = 0
    i = 0
    while i < len(paras):
        p = paras[i].strip()
        if i > 0 and _BOX_HEADING_PARA_RE.match(p):
            prev = paras[i - 1].strip()
            if (prev and len(prev) >= 40                  # a short label ("Review") is page
                    and not _BOX_HEADING_PARA_RE.match(prev)   # chrome, not a split sentence
                    and not prev.startswith(('>', '|', '!', '['))
                    and re.search(r'[a-z,;–—-]$', prev)):
                for j in range(i + 1, min(i + 9, len(paras))):
                    q = paras[j].strip()
                    if not q:
                        continue
                    if _BOX_HEADING_PARA_RE.match(q):
                        break                     # another heading — not a bounded box
                    if q[0].islower():
                        box = paras[i:j]
                        paras[i - 1] = prev + ' ' + q
                        del paras[i:j + 1]
                        paras[i:i] = box
                        # BREAKOUT-BOX rendering: when the relocated section carries a
                        # box-vocabulary title ("Summary points", "Key messages", …), its
                        # statements render as ONE inset blockquote under the heading — the
                        # closest reader primitive to the bordered box in print. A relocated
                        # section with an ordinary title keeps ordinary paragraphs.
                        body = [b.strip() for b in box[1:]]
                        if (_BOX_TITLE_RE.match(box[0].strip())
                                and 2 <= len(body) <= 8
                                and all(0 < len(b) < 500
                                        and not b.startswith(('>', '#', '|', '!', '['))
                                        for b in body)):
                            # the box TITLE goes INSIDE the inset as bold text — exactly how
                            # print renders it (bold label inside the bordered box), so the
                            # whole unit reads as one secondary block; and it never touches
                            # the heading machinery (TOC, chapter structure, m4b chapters)
                            title = re.sub(r'^#{1,6}[ \t]+', '', box[0].strip())
                            members = [f'**{title}**'] + body
                            joined = '\n>\n'.join(
                                '> ' + b.replace('\n', '\n> ') for b in members)
                            paras[i:i + len(box)] = [joined]
                            moved += 1
                            i += 1
                            break
                        moved += 1
                        i += len(box)
                        break
        i += 1
    if moved:
        print(f"  Relocated {moved} sentence-interrupting boxed section(s) after the sentence "
              f"they split (side-box flattened into the body mid-sentence)")
    return '\n\n'.join(paras)


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


_TOC_ENTRY_RE = re.compile(r'^(.{2,130}?)(?:\s*\.{2,}\s*|\s+)(?:\d{1,4}|[ivxlc]{1,7})$')


def _norm_title(t):
    t = t.replace('“', '"').replace('”', '"').replace('’', "'").replace('‘', "'")
    t = t.replace('&amp;', '&')
    t = re.sub(r'[‒–—―]', '-', t)
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
    def _page_lines(page):
        md = page.get('markdown', '') or ''
        return [re.sub(r'^#{1,6}\s+', '', l.strip()) for l in md.split('\n') if l.strip()]

    for idx, page in enumerate(pages[:15]):
        lines = _page_lines(page)
        # A List of Tables/Figures page has the same 'Caption … N' shape but supplies CAPTIONS,
        # not section titles — never let it win the first-match over the real Contents.
        if lines and re.match(r'(?i)^list of (tables|figures|illustrations|maps)', lines[0]):
            continue
        entries = [l for l in lines if _TOC_ENTRY_RE.match(l)]
        if len(entries) >= 5:
            # A long Contents CONTINUES onto following pages (ad752a46's III/IV/CONCLUSION sat
            # on page 2 and were never harvested) — keep consuming while a page still carries
            # >= 2 entry-shaped lines.
            toc_pages = [idx]
            for nxt in range(idx + 1, min(idx + 4, len(pages))):
                nlines = _page_lines(pages[nxt])
                if sum(1 for l in nlines if _TOC_ENTRY_RE.match(l)) >= 2:
                    toc_pages.append(nxt)
                    lines = lines + nlines
                else:
                    break
            titles = set()
            ordered = []
            for l in lines:
                m = _TOC_ENTRY_RE.match(l)
                if m:
                    t = _norm_title(m.group(1))
                else:
                    # Non-entry lines on the Contents page are titles only in DIVIDER shape
                    # (short + 'PART …' or ALL CAPS) — a Contents block embedded mid-page
                    # (law-review abstracts) must not leak its prose paragraphs into the
                    # title set (ad752a46 promoted an abstract paragraph to h1).
                    t = _norm_title(l)
                    if not (len(t) <= 60 and (re.match(r'(?i)^part\b', t) or t.isupper())):
                        continue
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
                # Sectioning grammars, each with its target LEVEL: arabic chapters ('1. Title')
                # and roman sections ('IV. FROM TAXI WORK…' — law-review style) are top-level;
                # DOTTED-DECIMAL entries nest by depth ('1.1 …' → h2, '2.1.5 …' → h3);
                # single-LETTER entries ('A. The Chauffeurs' Union…') are subsections at h2;
                # an ALL-CAPS unnumbered entry (INTRODUCTION, CONCLUSION) is a top-level
                # division. 'I.' is roman, not the letter I; other single letters (incl.
                # V/X/C) read as letters — a lone 'C.' section is a subsection in every book.
                _dotted = re.match(r'^\d+(\.\d+)+\s+\S', t)
                if _dotted:
                    level = min(1 + t.split(' ')[0].count('.'), 4)
                elif re.match(r'^\d+[.)]?\s+\S', t) or re.match(r'^(?:I|[IVX]{2,})[.)]\s+\S', t):
                    level = 1
                elif re.match(r'^[A-Z][.)]\s+\S', t):
                    level = 2
                elif t.isupper() and len(t) >= 6 and not _STRUCTURAL_HEADING_RE.match(_toc_key(t)):
                    level = 1
                else:
                    continue
                numbered.setdefault(_toc_key(t), (t, level))
                if pending_part and level == 1:
                    part_before.setdefault(_toc_key(t), pending_part)
                    pending_part = None
            return titles, set(toc_pages), numbered, all_keys, part_before
    return set(), set(), {}, set(), {}


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


# Scholarly section dividers OCR routinely emits as PLAIN text (they are set in bold rather than
# a larger face, so Mistral sees no heading). Exact, whole-line matches only — these are titles,
# never sentence openings. Kept deliberately tight: a name here promotes a bare line to a heading,
# so anything that could legitimately open a paragraph ('Background', 'Summary') stays out.
_PLAIN_SECTION_NAMES = frozenset({
    'introduction', 'conclusion', 'conclusions', 'discussion', 'results', 'methods',
    'methodology', 'materials and methods', 'references', 'bibliography', 'works cited',
    'notes', 'endnotes', 'footnotes', 'acknowledgement', 'acknowledgements',
    'acknowledgment', 'acknowledgments', 'conflict of interest', 'conflicts of interest',
    'competing interests', 'declaration of competing interest', 'funding',
    'data availability', 'data availability statement', 'author contributions',
    'ethics statement', 'abstract', 'key messages', 'limitations',
})


def _promote_plain_sections(md, level, seen_norm):
    """Promote standalone scholarly section names OCR left as plain text into headings.

    Mistral loses these constantly: they are bold-but-not-bigger in most journal layouts, so the
    heading never reaches the markdown (e938f76f lost 'Introduction' this way — it survived as a
    bare line, while 'Conflict of interest' and 'References' were dropped from the OCR text
    outright and are beyond recovery here).

    A line qualifies only when it IS the whole block: exact match against the curated name set,
    no trailing prose, and blank-line separated. Returns (md, [promoted names]).
    """
    if not md or '\n' not in md and not md.strip():
        return md, []

    lines = md.split('\n')
    out, promoted = [], []
    for idx, line in enumerate(lines):
        bare = line.strip().rstrip(':').strip()
        key = re.sub(r'\s+', ' ', bare).lower()
        prev_blank = idx == 0 or not lines[idx - 1].strip()
        next_blank = idx + 1 >= len(lines) or not lines[idx + 1].strip()
        if (key in _PLAIN_SECTION_NAMES
                and not line.strip().startswith('#')
                and prev_blank and next_blank
                and _norm_heading(bare) not in seen_norm):
            seen_norm.add(_norm_heading(bare))
            promoted.append(bare)
            out.append(f"{'#' * level} {bare}")
        else:
            out.append(line)
    return '\n'.join(out), promoted


def _body_section_level(pages):
    """The heading level this document uses for TOP-LEVEL sections, so promoted dividers
    ('References', 'Funding') sit as siblings of the sections they divide.

    The SHALLOWEST tier that occurs more than once — not the most common one. Documents with a
    numbered hierarchy ('3. Sanctions' h3 → '4.1.1 …' h5) have their deepest tier as the most
    common, and a divider promoted there would be buried under the subsections it should follow.
    Requiring 2+ occurrences ignores a lone h1 that is really the article title. Clamped to h3:
    a structural divider is never a sub-subsection.
    """
    counts = {}
    for page in pages[1:]:
        for m in re.finditer(r'^(#{1,6})\s+\S', page.get('markdown', '') or '', re.M):
            lvl = len(m.group(1))
            counts[lvl] = counts.get(lvl, 0) + 1
    tiers = [lvl for lvl, n in counts.items() if n >= 2] or list(counts)
    return min(min(tiers), 3) if tiers else 2


def _front_matter_chrome(pages, header_names):
    """Header-field names that merely restate the document's OWN title or byline — page chrome
    at any repeat count, never a section divider.

    A journal article's running heads alternate verso=authors / recto=short-title. With patchy
    extract_header those can each surface on a single page, sliding under the repeat threshold
    and getting injected as headings (e938f76f: '# More than a metaphor' + '# Gurminder K.
    Bhambra and Peter Newell' landed inside the reference list). Both are recoverable from the
    first page alone: the short-title is a prefix of the title heading, and every author named
    in a verso head appears in the byline.

    Returns the subset of header_names to treat as running headers.
    """
    if not pages:
        return set()

    first_md = pages[0].get('markdown', '') or ''
    if not first_md.strip():
        return set()

    # A Contents page lists every chapter verbatim; this rule would then suppress the very
    # chapter-name injections books depend on. Leave those documents alone. (toc_pages is a
    # SET of page indices — comparing it to 0 silently disabled this guard.)
    _, toc_pages, _, _, _ = _collect_toc_titles(pages)
    if 0 in toc_pages:
        return set()

    def _norm(t):
        t = _norm_title(t) if '_norm_title' in globals() else _norm_heading(t)
        return re.sub(r'[^a-z0-9 ]+', '', (t or '').lower()).strip()

    first_norm = _norm(re.sub(r'^#{1,6}\s+', '', first_md, flags=re.M))
    if not first_norm:
        return set()

    chrome = set()
    for name in header_names:
        key = _norm(name)
        # Too short to be distinctive ('II', 'Notes') — the repeat threshold governs those.
        if len(key) < 8:
            continue
        # Title / short-title: the header text appears verbatim in the front matter.
        if key in first_norm:
            chrome.add(name)
            continue
        # Byline: every person named in the header appears on the first page.
        parts = [p for p in re.split(r'\s+and\s+|\s*&\s*|\s*,\s*', name) if p.strip()]
        if len(parts) >= 2 and all(len(_norm(p)) >= 6 and _norm(p) in first_norm for p in parts):
            chrome.add(name)

    return chrome


def assemble_markdown(response_dict, classification="unknown", footnote_meta=None, pdf_path=None,
                       segment_boundaries=None, footnote_warnings=None, geometry_blocks=None):
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
    pages_with_header = 0
    for page in pages:
        header = page.get("header") or ""
        if header.strip():
            pages_with_header += 1
        for line in header.split('\n'):
            name = extract_section_name(line)
            if name:
                header_counts[name] = header_counts.get(name, 0) + 1
    # Headers appearing on >40% of the pages that HAVE a header are likely running headers
    # (book title / article short-title). The denominator is deliberately the header-bearing
    # population, not len(pages): Mistral's extract_header is patchy — on e938f76f it populated
    # `header` on 4 of 9 pages — and against the full page count an every-header-page running
    # head (2 of those 4) fell under the bar, got treated as a fresh section name, and was
    # INJECTED as a heading into the middle of the reference list.
    header_population = pages_with_header or len(pages)
    threshold = max(2, header_population * 0.4)
    running_headers = {name for name, count in header_counts.items() if count >= threshold}

    # Front-matter chrome: a header naming the article's own title or authors is a running head
    # at ANY count. Journal articles alternate verso=authors / recto=short-title, so with patchy
    # extraction each side can legitimately appear once — below any sane repeat threshold — yet
    # neither is ever a section divider. Both are recoverable from page 1 without any metadata:
    # the title heading contains the short-title as a prefix, and the byline lists each author.
    # Skipped when page 1 is a table of contents, where every chapter name appears verbatim and
    # this rule would suppress the legitimate chapter-name injections books rely on.
    running_headers |= _front_matter_chrome(pages, header_counts.keys())

    # Headings Mistral emitted in page BODIES, document-wide. Injection consults this: when the
    # header-field section name already exists as a body heading somewhere, injecting a copy just
    # plants a duplicate at a PAGE top (usually mid-paragraph), so the body's own heading wins.
    body_heading_texts = _collect_body_heading_texts(pages)
    toc_titles, toc_pages, toc_numbered, toc_all_keys, toc_part_before = _collect_toc_titles(pages)
    _section_level = _body_section_level(pages)
    promoted_plain_sections = []
    fence_lines_stripped = fence_pages = 0

    # The per-classification assembler owns setup (e.g. the chapter-offset precompute) + per_page +
    # post_combine; the default handles the generic/unknown path.
    assembler = PDF_ASSEMBLERS.get(classification, _DEFAULT_ASSEMBLER)
    assembler.setup(ctx)

    # page_bottom + real PDF: extract the PDF text layer's per-page defs ONCE, up front. Two
    # consumers: per_page marker licensing (a line-end bare digit whose number the PDF's own
    # note area carries IS a marker, even when Mistral dropped/mis-numbered the def — deloitte
    # p9) and the missing-def recovery tail below (which otherwise re-extracts).
    ctx.pypdf_page_defs = None
    ctx.pypdf_page_texts = None
    if pdf_path and classification == 'page_bottom':
        try:
            ctx.pypdf_page_defs = extract_pypdf_footnote_defs(pdf_path, running_headers)
            ctx.pypdf_page_texts = extract_pypdf_page_texts(pdf_path)
        except Exception as e:
            print(f"  pypdf pre-extraction skipped (cannot read PDF: {e.__class__.__name__})")

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
        if toc_titles and i not in toc_pages and md_stripped and not md_stripped.startswith('#'):
            _first_line = md_stripped.split('\n', 1)[0].strip()
            if (len(_first_line) <= 80
                    and _norm_title(_first_line) in toc_titles
                    and _norm_heading(_first_line) not in ctx.seen_sections
                    and _norm_title(_first_line) not in ctx.promoted_toc_titles):
                ctx.promoted_toc_titles.add(_norm_title(_first_line))
                md = re.sub(r'^\s*' + re.escape(_first_line), f'# {_first_line}', md, count=1)
                md_stripped = md.strip()

        # Structural-divider PROMOTION: 'Introduction' / 'References' / 'Conflict of interest'
        # and friends that OCR left as bare lines (bold-not-bigger in most journal layouts).
        # Skipped on the Contents page, where these names are TOC entries, not dividers.
        if i not in toc_pages:
            md, _promoted_plain = _promote_plain_sections(md, _section_level, ctx.seen_sections)
            if _promoted_plain:
                promoted_plain_sections.extend(_promoted_plain)
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
        if toc_numbered and not ctx.in_notes_section and toc_pages and i > max(toc_pages):
            _lines = md.split('\n')
            _changed = False
            for _li, _line in enumerate(_lines):
                _hm = re.match(r'^(#{1,6})\s+(.+?)\s*$', _line)
                if not _hm:
                    continue
                _text = _hm.group(2)
                _key = _toc_key(_text)
                _numbered_self = bool(re.match(r'^(?:\d+(?:\.\d+)*|[IVXLC]+|[A-Z])[.)]?\s+\S', _norm_title(_text)))
                _entry = toc_numbered.get(_key) if (_hm.group(1) == '#' or _numbered_self) else None
                if _entry:
                    _full, _level = _entry
                    _hashes = '#' * _level
                    if _key not in ctx.toc_chapters_used:
                        ctx.toc_chapters_used.add(_key)
                        _part = toc_part_before.get(_key)
                        if (_part and _norm_heading(_part) not in ctx.seen_sections
                                and _norm_title(_part) not in ctx.promoted_toc_titles):
                            _lines[_li] = f'# {_part}\n\n{_hashes} {_full}'
                        else:
                            _lines[_li] = f'{_hashes} {_full}'
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
    if promoted_plain_sections:
        print(f"  Promoted {len(promoted_plain_sections)} plain-text section divider(s) to h{_section_level}: "
              + ', '.join(promoted_plain_sections[:6])
              + (' …' if len(promoted_plain_sections) > 6 else ''))
    if ctx.promoted_toc_titles:
        print(f"  TOC-promoted {len(ctx.promoted_toc_titles)} heading(s) from the printed Contents "
              f"(page {min(toc_pages)}): {', '.join(sorted(ctx.promoted_toc_titles)[:6])}"
              + (' …' if len(ctx.promoted_toc_titles) > 6 else ''))

    combined = "\n\n".join(ctx.md_parts)
    # Block quotations arrive as plain paragraphs (Mistral gives no structural signal) — mark the
    # colon-introduced, fully quote-wrapped ones as '>' blockquotes so they render as
    # <blockquote>, not <p>. On the joined body, before the deferred defs are appended.
    combined = _wrap_quote_blockquotes(combined)
    # GEOMETRIC blockquotes — the universal detector: per-line indentation read from the source
    # PDF (or replayed from the quote_geometry.json cache when the PDF is absent — the fixture
    # suite) and matched back to markdown paragraphs. Catches indentation-only quotes the
    # typographic heuristics can never see; absorbs typographically-wrapped members into one
    # blockquote.
    try:
        from ingestion.pdf.quote_geometry import (
            detect_indented_quote_blocks, wrap_geometry_blockquotes)
        geo_blocks = geometry_blocks
        if geo_blocks is None and pdf_path:
            geo_blocks = detect_indented_quote_blocks(pdf_path)
        if geo_blocks:
            combined, geo_wrapped = wrap_geometry_blockquotes(combined, geo_blocks)
            if geo_wrapped:
                print(f"  Geometry blockquotes: wrapped {geo_wrapped} paragraph(s) from "
                      f"{len(geo_blocks)} indented block(s) in the source PDF")
    except Exception as e:
        print(f"  Geometry blockquote pass skipped ({e.__class__.__name__})")
    # A boxed side-section dropped mid-sentence by the print layout → rejoin the sentence and
    # move the box after it.
    combined = _relocate_sentence_interrupting_boxes(combined)
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
            if ctx.pypdf_page_defs is not None:
                pypdf_defs = ctx.pypdf_page_defs     # extracted once before the page loop
            else:
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

            # page_bottom docs are renumbered PER PAGE (local print numbers → global sequential),
            # so pypdf's print-space numbers mean nothing globally — matching them raw is how a
            # TOC line ("01 Executive Summary 05", pypdf page 3) became the definition of marker
            # [^1] (deloitte2025independent). Translate each pypdf def through that page's
            # recorded local→global map instead: page-anchored, so only a def sitting on a page
            # that actually carries the marker's number can pair with it; pages with no markers
            # (covers, TOCs) have no map and can never contribute.
            if classification == 'page_bottom':
                translated = {}
                for page_idx, page_defs in clean_pypdf_defs.items():
                    page_map = ctx.page_local_to_global.get(page_idx) or {}
                    kept = [(page_map[n], t) for n, t in page_defs if n in page_map]
                    if kept:
                        translated[page_idx] = kept
                clean_pypdf_defs = translated
                page_offsets_map = {}

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

    # --- Demote Vancouver-citation refs (bracket citations mis-promoted to footnote markers)
    # BEFORE the marker rescue: demotion returns bracket-regime tokens to citations, and the
    # rescue then re-injects genuine footnote markers at their text-layer-witnessed seams —
    # run the other way round, demotion would eat the rescue's freshly inserted markers
    # (6c4e7d58's TRIPLE number space: affiliations 1-5, discursive footnotes 6-8, bracket
    # citations 1-53). ---
    combined = _demote_defless_citation_refs(combined)

    # --- Rescue refless footer footnotes (marker dropped by OCR, def stranded in the footer,
    # marker witnessed in the PDF text layer) ---
    if pdf_path:
        combined, _n_footer_rescued = _rescue_refless_footer_footnotes(
            combined, response_dict, pdf_path)

    # --- Demote author-line markers whose defs the OCR never captured ---
    # a280cf5b: "Roger Few[^1], Daniel Morchain[^2], … and Ramkumar Bendapudi[^5]" with the
    # affiliation block absent from the ENTIRE OCR response — nothing to link, and the literal
    # [^N] junk survives into the reader. Runs AFTER pypdf recovery so recovered defs keep
    # their markers. Narrow shape: a name-list line near the top, every marker defless.
    combined = _demote_defless_author_markers(combined)

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

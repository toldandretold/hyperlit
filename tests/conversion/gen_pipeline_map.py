"""Generate pipeline_map_data.js — the decision-tree DIAGRAM + node metadata, derived FROM the code:
the PDF classifier ladder from `PDF_CLASSIFIERS` (ordered), the assembler boxes from `PDF_ASSEMBLERS`,
the recovery group + fidelity from those functions, and the backend forks from the `ASSESSMENT.record`
sites — spliced into a small fixed flow skeleton (import → ingestion formats → digestion). Add a
classifier (op:register into PDF_CLASSIFIERS) or move a file and the diagram updates on the next run.

The viewer (`pipeline_map.html`) loads `window.PIPELINE_MAP = { mermaid, nodes }` from here, merges the
hand-authored deep prose from `pipeline_map_overlay.js`, and the per-unit notes from `pipeline_notes.js`.
A no-drift test (unit/test_pipeline_map.py) fails if the committed data.js falls out of sync with code.

Run:  python3 tests/conversion/gen_pipeline_map.py     # rewrites pipeline_map_data.js
"""
import ast
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..'))
_PY = os.path.join(_REPO, 'app', 'Python')
sys.path.insert(0, _PY)

import mistral_ocr as M                       # noqa: E402
from gen_pipeline_notes import collect_notes  # noqa: E402

# --- code_ref / question per backend fork, scanned from the ASSESSMENT.record(...) call sites --------
_FORK_SCAN_MODULES = [
    'digestion/strategySelection/strategy.py',
    'digestion/bibliographyExtraction/bibliography.py',
    'digestion/citationLinking/citation_link_rules.py',
    'digestion/finalAudit/audit.py',
    'digestion/process_document.py',
]


def _scan_assessment_records():
    """{module_name: {'code_ref':…, 'question':…}} from every ASSESSMENT.record(...) literal call."""
    out = {}
    for rel in _FORK_SCAN_MODULES:
        try:
            tree = ast.parse(open(os.path.join(_PY, rel), encoding='utf-8').read())
        except Exception:
            continue
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'record':
                kw = {k.arg: k.value for k in n.keywords if k.arg}
                mod = kw.get('module')
                if isinstance(mod, ast.Constant) and isinstance(mod.value, str):
                    rec = out.setdefault(mod.value, {})
                    for field in ('code_ref', 'question'):
                        v = kw.get(field)
                        if isinstance(v, ast.Constant) and isinstance(v.value, str) and field not in rec:
                            rec[field] = v.value
    return out


# --- the backend fork chain (fixed skeleton order; metadata derived where possible) -----------------
# id -> (note_key, assessment-module the record uses, fallback code_ref)
_BACKEND_FORKS = [
    ('BIB', 'bibliography', 'bibliography_extraction', 'bibliography.py:extract_bibliography'),
    ('STRAT', 'strategy', 'strategy_selection', 'strategy.py:analyze_document_structure'),
    ('GUARD', 'guard', 'footnote_linking_guard', 'strategy.py:_footnote_numbering_is_linkable'),
    ('LINK', 'citation', 'citation_linking', 'citations.py:link_citations'),
    ('AUDIT', 'audit', 'footnote_audit', 'audit.py:compute_footnote_audit'),
]
_RECOVERY = [
    ('REC1', 'recovery:markers', M.normalize_all_footnote_refs, '① markers · normalize_all_footnote_refs',
     'superscript / $^5$ / [N] / bare .46 → [^N] · sequence-validated · NO pdf'),
    ('REC2', 'recovery:mojibake', M.scan_footnote_mojibake, '② mojibake defs · scan_footnote_mojibake',
     're-OCR garbled def pages via pypdf · NEEDS pdf'),
    ('REC3', 'recovery:missingdefs', M.recover_missing_defs, '③ missing defs · recover_missing_defs',
     'ref with no def → pull from pypdf · NEEDS pdf'),
]


def _slug(name):
    return name.replace('-', '_')


def build():
    """Return (mermaid_expanded, mermaid_collapsed, nodes_dict)."""
    scanned = _scan_assessment_records()
    nodes = {}

    # ---- PDF classifier ladder (from PDF_CLASSIFIERS order) + the unknown fall-through --------------
    classifiers = list(M.PDF_CLASSIFIERS)
    unknown = M.UnknownClassifier()
    none_c, middle = classifiers[0], classifiers[1:]   # classifiers[0] is the 'none' (absence) check

    asm_lines, ladder = [], []
    seen_asm = set()

    def asm_node(cls_name):
        """Emit/return the assembler box id for a classification name (default for none/unknown)."""
        a = M.PDF_ASSEMBLERS.get(cls_name)
        key = cls_name if a is not None else 'default'
        a = a if a is not None else M.DefaultAssembler()
        aid = 'A_' + _slug(key)
        if aid not in seen_asm:
            seen_asm.add(aid)
            label = f'{type(a).__name__}<br/>{cls_name}'
            asm_lines.append(f'      {aid}["{label}"]')
            nodes[aid] = {'kind': 'assembler', 'name': type(a).__name__, 'for': key,
                          'noteKey': 'assembler:' + key,
                          'codeRef': f'mistral_ocr.py:PDF_ASSEMBLERS["{key}"]'}
        return aid

    # First-match-wins ladder. none is the inverted "any refs?" check (no → none); each real classifier
    # is "matches? yes → its assembler, no → the next classifier"; the tail falls through to unknown.
    none_aid = asm_node('none')
    ladder.append('      SIG --> C_none{"any in-text footnote/citation refs?"}')
    ladder.append(f'      C_none -.->|"no ∅"| {none_aid}')
    nodes['C_none'] = {'kind': 'classifier', 'name': 'none', 'noteKey': 'classifier:none',
                       'codeRef': 'mistral_ocr.py:classify_footnotes',
                       'wouldNeed': getattr(none_c, 'would_need', '')}

    prev, prev_branch = 'C_none', 'yes'        # C_none CONTINUES on yes (refs exist → keep classifying)
    for c in middle:
        cid = 'C_' + _slug(c.name)
        ladder.append(f'      {prev} -->|{prev_branch}| {cid}{{"{c.name}?"}}')
        aid = asm_node(c.name)
        ladder.append(f'      {cid} -->|yes| {aid}')
        nodes[cid] = {'kind': 'classifier', 'name': c.name, 'noteKey': 'classifier:' + c.name,
                      'codeRef': 'mistral_ocr.py:classify_footnotes', 'wouldNeed': c.would_need}
        prev, prev_branch = cid, 'no'          # subsequent classifiers CONTINUE on no (didn't match)
    # fall-through → unknown (served by the default assembler)
    ladder.append(f'      {prev} -.->|"no ✗"| {none_aid}')

    # all assemblers → the recovery group
    for aid in sorted(seen_asm):
        ladder.append(f'      {aid} --> REC1')

    # ---- recovery group + fidelity -----------------------------------------------------------------
    rec_lines = ['      subgraph RECOV["footnote RECOVERY — resurrect mangled / missed notes"]',
                 '        direction TB']
    for rid, notekey, fn, title, sub in _RECOVERY:
        rec_lines.append(f'        {rid}["{title}<br/>{sub}"]')
        nodes[rid] = {'kind': 'recovery', 'name': title, 'noteKey': notekey,
                      'codeRef': f'mistral_ocr.py:{fn.__name__}'}
    rec_lines.append('        REC1 --> REC2 --> REC3')
    rec_lines.append('      end')
    nodes['FID'] = {'kind': 'fidelity', 'noteKey': 'fidelity',
                    'codeRef': 'mistral_ocr.py:assess_harvest_fidelity',
                    'question': 'Whose bug is a missing/duplicated footnote — ours (harvest/numbering) or upstream OCR?'}
    fid_lines = [
        '      REC3 --> FID{"harvest-fidelity check<br/>assess_harvest_fidelity — whose bug is it?"}',
        '      FID -.->|"clean · no_footnotes · not_applicable"| PDFMD',
        '      FID -->|"harvest_gap ⚑ · assembly_collisions ⚑"| PDFMD',
        '      FID -.->|"fidelity_loss (only after pypdf also failed)"| PDFMD',
    ]
    pdf_expanded = '\n'.join(
        ['      EXT -->|.pdf| OCR["mistral_ocr.py · Mistral OCR → ocr_response.json"]',
         '      OCR --> SIG["classify_footnotes → PDF_CLASSIFIERS<br/>signals: co-location · reset-freq · def-clustering · ref-spread"]']
        + ladder + asm_lines + rec_lines + fid_lines)
    pdf_collapsed = ('      EXT -->|.pdf| OCRC["mistral_ocr.py — decide the footnote LAYOUT<br/>'
                     'classify → assemble → recover → fidelity<br/>(tick the box to expand)"]\n'
                     '      OCRC --> PDFMD')

    # ---- backend forks (fixed chain; metadata from the scanned ASSESSMENT.record sites) ------------
    for nid, notekey, module, fallback_ref in _BACKEND_FORKS:
        rec = scanned.get(module, {})
        nodes[nid] = {'kind': 'fork', 'noteKey': notekey, 'module': module,
                      'codeRef': rec.get('code_ref', fallback_ref),
                      'question': rec.get('question', '')}
    nodes['STRAT']['options'] = [r.strategy for r in __import__(
        'digestion.strategySelection.strategy', fromlist=['STRATEGY_RULES']).STRATEGY_RULES]
    # the PDF classification overview node (SIG / collapsed OCRC) — the fork as a whole
    classify_q = 'What is the PDF footnote layout? (drives renumbering + assembly)'
    for nid in ('SIG', 'OCRC'):
        nodes[nid] = {'kind': 'fork', 'noteKey': 'classify', 'module': 'pdf_footnote_classification',
                      'codeRef': 'mistral_ocr.py:classify_footnotes', 'question': classify_q,
                      'options': [c.name for c in classifiers] + ['unknown']}

    # ---- EPUB ingestion blocks (structural "open up" + the run-all detector fan) -------------------
    epub_exp, epub_col, epub_exp_clicks, epub_col_clicks = _epub_blocks(nodes)

    clicks = {
        'core': [f[0] for f in _BACKEND_FORKS],
        'pdf_expanded': ['SIG'] + [k for k in nodes if k.startswith('C_')] + sorted(seen_asm)
                        + ['REC1', 'REC2', 'REC3', 'FID'],
        'pdf_collapsed': ['OCRC'],
        'epub_expanded': epub_exp_clicks,
        'epub_collapsed': epub_col_clicks,
    }
    blocks = {'pdf_expanded': pdf_expanded, 'pdf_collapsed': pdf_collapsed,
              'epub_expanded': epub_exp, 'epub_collapsed': epub_col}
    return {'skeleton': _SKELETON, 'blocks': blocks, 'clicks': clicks, 'nodes': nodes}


def _epub_blocks(nodes):
    """The EPUB ingestion sub-tree from TRANSFORM_PIPELINE: structural cleanup (E_OPEN) → the HEADING-
    detection fan (Phase 1, publisher markup → h1/h2/h3) → the FOOTNOTE-detection fan (Phase 2). Both
    fans are run-all, NOT first-match — every detector runs and fires if its markup is present — so they
    are ordered fans, not yes/no ladders. Faithful to the code: headings are detected before footnotes."""
    import epub_normalizer as E
    needs = E.EpubNormalizer._DETECTOR_NEEDS
    head_needs = E.EpubNormalizer._HEADING_NEEDS
    pipeline = E.TRANSFORM_PIPELINE
    first_det = next(i for i, t in enumerate(pipeline) if type(t).__name__ in needs)
    # structural cleanup = Phase-1 transforms that are NEITHER a heading nor a footnote detector.
    structural = [t.name for t in pipeline[:first_det] if type(t).__name__ not in head_needs]
    headings = [t for t in pipeline if type(t).__name__ in head_needs]   # Phase-1 heading strategies
    detectors = [t for t in pipeline if type(t).__name__ in needs]       # Phase-2 footnote schemes

    def short(name):
        for suf in ('FootnoteDetector', 'HeadingDetector', 'Detector', 'Converter'):
            name = name.replace(suf, '')
        return name or 'x'

    def fan(items, prefix, kind, need_map, note_prefix):
        ids, defs = [], []
        for t in items:
            name = type(t).__name__
            nid = prefix + name
            ids.append(nid)
            defs.append(f'        {nid}["{short(name)}"]')
            nodes[nid] = {'kind': kind, 'name': short(name), 'fullName': name,
                          'needs': need_map[name], 'description': t.description,
                          'noteKey': note_prefix + name, 'codeRef': f'epub_normalizer.py:{name}'}
        return ids, defs

    head_ids, head_defs = fan(headings, 'EH_', 'epub_heading', head_needs, 'epub:heading:')
    det_ids, det_defs = fan(detectors, 'E_', 'epub_detector', needs, 'epub:detector:')

    nodes['E_OPEN'] = {'kind': 'epub_structural', 'noteKey': 'epub:structural', 'structural': structural,
                       'codeRef': 'epub_normalizer.py:TRANSFORM_PIPELINE (Phase 1)'}
    nodes['EPUBOUT'] = {'kind': 'epub_overview', 'noteKey': 'epub:detection',
                        'module': 'epub_footnote_detection',
                        'codeRef': 'epub_normalizer.py:TRANSFORM_PIPELINE',
                        'options': [short(type(t).__name__) for t in detectors]}

    expanded = '\n'.join(
        ['      EXT -->|.epub| E_OPEN["① structural normalisation<br/>open up the publisher\'s HTML '
         '(Calibre · spans · images · sections)"]',
         f'      E_OPEN --> {head_ids[0]}',
         '      subgraph EPUBHEAD["② heading detection — publisher markup → h1/h2/h3 (each fires if its '
         'markup is present)"]',
         '        direction TB']
        + head_defs + ['        ' + ' --> '.join(head_ids), '      end',
                       f'      {head_ids[-1]} --> {det_ids[0]}',
                       '      subgraph EPUBDET["③ footnote SCHEME detection — every detector RUNS; fires '
                       'if its markup is present (multiple can; Heuristic = fallback)"]',
                       '        direction TB']
        + det_defs + ['        ' + ' --> '.join(det_ids), '      end',
                      f'      {det_ids[-1]} --> EPUBOUT(["main-text.html"])'])
    collapsed = ('      EXT -->|.epub| EPUBOUT["ingestion/epub · epub_normalizer.py<br/>'
                 'structural normalise → heading detection → footnote SCHEME detection<br/>'
                 '(tick the box to expand)"]')
    return expanded, collapsed, ['E_OPEN'] + head_ids + det_ids, ['EPUBOUT']


# Fixed flow skeleton with ${EPUB} / ${PDF} / ${CLICKS} placeholders the viewer splices the generated
# blocks into (two independent expand toggles). NOT an f-string — the {…} diamonds + placeholders are literal.
_SKELETON = """flowchart TD
    IMPORT([Import a file]) --> EXT{file extension?}
    subgraph CONV["① ingestion — turn the file into common HTML"]
      direction TB
${EPUB}
      EXT -->|".html / .htm"| HTMLP["ingestion/html · ar5iv_preprocessor.py<br/>arXiv only; else raw HTML"]
      EXT -->|".docx / .doc"| DOCXP["ingestion/word · strip_docx_metadata.py + pandoc"]
      EXT -->|".md / .zip"| MDIN(["markdown input"])
${PDF}
      PDFMD(["main-text.md"]) --> M2H["ingestion/markdown_and_pdf_to_html · simple_md_to_html.py"]
      MDIN --> M2H
    end
    EPUBOUT -->|main-text.html| BIB
    M2H -->|intermediate.html| BIB
    HTMLP -->|html| BIB
    DOCXP -->|html| BIB
    subgraph CORE["② digestion — shared processing · process_document.py · DOC_PASSES"]
      direction TB
      BIB["bibliographyExtraction · extract_bibliography"]
      BIB --> STRAT{"strategySelection · STRATEGY_RULES<br/>analyze_document_structure"}
      STRAT -->|"sequential · whole_document · sectioned"| EXFN["footnoteExtraction · footnotes.py"]
      STRAT -.->|"no_footnotes ✗ · pre_processed ∅"| EXFN
      EXFN --> GUARD{"linkability guard<br/>_footnote_numbering_is_linkable"}
      GUARD -.->|"no ∅ — extract notes, emit NO links"| EMIT
      GUARD -->|yes| LINK["citationLinking + footnoteLinking<br/>CITATION_LINK_RULES · MARKER_LINK_RULES"]
      LINK --> AUDIT["finalAudit · compute_footnote_audit — the verdict"]
      AUDIT --> EMIT["nodes.jsonl · footnotes.jsonl · references.json<br/>audit.json · conversion_stats.json · assessment.json"]
    end
${CLICKS}"""


def render():
    payload = build()
    return ('// GENERATED by gen_pipeline_map.py from the registries + folders — do not hand-edit.\n'
            'window.PIPELINE_MAP = '
            + json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + ';\n')


def main():
    body = render()
    with open(os.path.join(_HERE, 'pipeline_map_data.js'), 'w', encoding='utf-8') as f:
        f.write(body)
    print(f'wrote pipeline_map_data.js ({len(build()["nodes"])} nodes)')
    return body


if __name__ == '__main__':
    main()

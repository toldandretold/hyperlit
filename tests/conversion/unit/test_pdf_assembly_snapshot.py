"""Characterization snapshot for the PDF frontend's two monoliths — classify_footnotes +
assemble_markdown (mistral_ocr.py). These are being decomposed into the PDF_CLASSIFIERS /
PDF_ASSEMBLERS registries; this test pins their EXACT output byte-for-byte so the refactor stays a
pure relocation.

For every available `ocr_response.json` (the synthetic regression fixtures, the richer fixtures-local
set, and the 280-page Soviet Marxism corpus PDF) PLUS two crafted inputs covering the
chapter_endnotes / wackSTEM classes (which have no live fixture), it records the classification +
confidence + signals + a sha256 of the assembled markdown, and asserts they match the captured
baseline. assemble_markdown is run with pdf_path=None so the snapshot depends only on the OCR JSON
(deterministic; the pdf-only fix_mangled_urls / pypdf-recovery tail is guarded separately).

First run (no baseline file) CAPTURES the baseline and passes; later runs COMPARE. To re-baseline
after an intentional behaviour change, delete pdf_assembly_snapshot.baseline.json.
"""

import glob
import hashlib
import json
import os

import mistral_ocr as M

_HERE = os.path.dirname(__file__)
_REPO = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
_BASELINE = os.path.join(_HERE, 'pdf_assembly_snapshot.baseline.json')


def _page(md, header=""):
    return {"markdown": md, "header": header}


# Crafted inputs for the two classes with no live fixture (verified to hit their gates).
_SYNTHETIC = {
    'synthetic:chapter_endnotes': {"pages": [
        _page("Chapter One opens here with a claim[^1] and another point[^2] and more[^3].", "The Book"),
        _page("The argument continues[^4] across this page[^5] with detail[^6] and nuance[^7].", "The Book"),
        _page("A further chapter develops[^1] new ideas[^2] that restart numbering[^3] here[^4].", "The Book"),
        _page("More body prose develops the case[^5] at length[^6] and concludes[^7] the section[^8].", "The Book"),
        _page("1. First note text here.\n2. Second note text.\n3. Third note.\n4. Fourth note text.\n5. Fifth.\n6. Sixth note.\n7. Seventh note.", "Notes"),
        _page("1. Second chapter note one.\n2. Note two text.\n3. Note three.\n4. Four.\n5. Five.\n6. Six.\n7. Seven.\n8. Eight note.", "Notes"),
    ]},
    'synthetic:wackSTEM': {"pages": [
        _page("Body one cites [10] and also [50] in this paragraph."),
        _page("Body two cites [15] then [50] again here."),
        _page("Body three refers to [20] and [50] once more."),
        _page("Body four uses [25] alongside [50] in text."),
        _page("Body five mentions [30] and finally [50] here."),
    ]},
}


def _discover_cases():
    """All ocr_response.json fixtures (excluding /converted/ copies) keyed by a stable repo-relative
    label, plus the crafted synthetic inputs."""
    cases = {}
    roots = [
        os.path.join(_REPO, 'tests/conversion/fixtures/pdf'),
        os.path.join(_REPO, 'tests/conversion/fixtures-local/pdf'),
        os.path.join(_REPO, 'tests/conversion/corpus'),
    ]
    for root in roots:
        for path in sorted(glob.glob(os.path.join(root, '**', 'ocr_response.json'), recursive=True)):
            if os.sep + 'converted' + os.sep in path:
                continue
            label = os.path.relpath(path, _REPO)
            try:
                cases[label] = json.loads(open(path, encoding='utf-8').read())
            except Exception:
                continue
    cases.update(_SYNTHETIC)
    return cases


def _snapshot_one(response_dict):
    meta = M.classify_footnotes(response_dict)
    segments = M.detect_segment_boundaries(response_dict, meta)
    md = M.assemble_markdown(
        response_dict,
        classification=meta['classification'],
        footnote_meta=meta,
        pdf_path=None,
        segment_boundaries=segments,
        footnote_warnings=[],
    )
    return {
        'classification': meta['classification'],
        'confidence': meta['confidence'],
        'signals': meta['signals'],
        'segments': segments,
        'md_len': len(md),
        'md_sha256': hashlib.sha256(md.encode('utf-8')).hexdigest(),
    }


def _compute_all():
    return {label: _snapshot_one(rd) for label, rd in sorted(_discover_cases().items())}


def test_pdf_assembly_snapshot_matches_baseline():
    current = _compute_all()
    if not os.path.exists(_BASELINE):
        with open(_BASELINE, 'w', encoding='utf-8') as f:
            json.dump(current, f, ensure_ascii=False, indent=2, sort_keys=True)
        # Captured the baseline this run — nothing to compare against yet.
        assert current, "no PDF fixtures discovered to snapshot"
        return
    baseline = json.loads(open(_BASELINE, encoding='utf-8').read())
    # Every baselined case must still produce identical classification + assembled-markdown hash.
    mismatches = []
    for label, want in baseline.items():
        got = current.get(label)
        if got is None:
            mismatches.append(f"{label}: MISSING from current run")
            continue
        for key in ('classification', 'confidence', 'md_sha256', 'md_len', 'signals', 'segments'):
            if got.get(key) != want.get(key):
                mismatches.append(f"{label}.{key}: {want.get(key)!r} -> {got.get(key)!r}")
    assert not mismatches, "PDF assembly drift vs baseline:\n  " + "\n  ".join(mismatches)


def test_snapshot_covers_all_six_classes():
    classes = {s['classification'] for s in _compute_all().values()}
    for want in ('none', 'page_bottom', 'chapter_endnotes', 'document_endnotes',
                 'wackSTEMbibliographyNotes', 'unknown'):
        assert want in classes, f"snapshot does not exercise class {want!r} (have {sorted(classes)})"

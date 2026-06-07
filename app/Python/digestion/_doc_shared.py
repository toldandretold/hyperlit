"""Zero-orchestrator-import leaf: small helpers shared by the digestion DocPasses, kept OUT of
process_document.py so a pass module can import them without importing the orchestrator (which
imports the passes back → a cycle). Mirrors ingestion's epub_base.py / pdf_shared.py leaves."""
import json
import os


def emit_progress(pct, stage, detail=""):
    """Emit a machine-readable progress line for the PHP job runner."""
    print("PROGRESS:" + json.dumps({"percent": pct, "stage": stage, "detail": detail}), flush=True)


def _detect_file_type(output_dir):
    """The SOURCE file type of this conversion, for the user-facing import toast ('EPUB imported: …').
    Read from the source artifacts the converter left in the book dir — PDF replays a cached OCR
    (ocr_response.json), EPUB extracts to epub_original/ (+ original.epub), DOCX keeps original.docx.
    Falls back to 'Document' when the source isn't identifiable (e.g. a raw .html/.md upload)."""
    if os.path.isfile(os.path.join(output_dir, 'ocr_response.json')):
        return 'PDF'
    if (os.path.isfile(os.path.join(output_dir, 'original.epub'))
            or os.path.isdir(os.path.join(output_dir, 'epub_original'))):
        return 'EPUB'
    if os.path.isfile(os.path.join(output_dir, 'original.docx')):
        return 'DOCX'
    return 'Document'

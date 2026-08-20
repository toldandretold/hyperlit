// Zero-import leaf: human labels for the conversion pipeline's progress.json
// `stage` values. Shared by the in-form import card (SPA/navigation/pathways/
// ImportBookTransition) and the import-queue widget (components/importQueue) —
// those two may not import each other (cycle-free invariant), so the map
// lives here.

export const IMPORT_STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting to start...',
  starting: 'Starting document processing...',
  pdf_splitting: 'Splitting large PDF for OCR...',
  ocr: 'Reading pages with OCR...',
  ocr_chunk: 'Reading pages with OCR...',
  ocr_analyze: 'Analyzing document structure...',
  ocr_assemble: 'Assembling document...',
  metadata: 'Checking metadata...',
  retrying: 'Retrying...',
  epub_load: 'Loading EPUB content...',
  epub_transforms: 'Normalizing document structure...',
  epub_footnotes: 'Detecting footnotes...',
  epub_sanitize: 'Sanitizing HTML...',
  epub_write: 'Writing output files...',
  epub_complete: 'EPUB normalization complete',
  doc_parse: 'Parsing document...',
  doc_bibliography: 'Scanning bibliography...',
  doc_footnotes: 'Processing footnotes...',
  doc_linking: 'Linking citations...',
  doc_footnote_linking: 'Linking footnotes...',
  doc_audit: 'Validating footnotes...',
  doc_json_gen: 'Building content...',
  doc_sanitize: 'Sanitizing output...',
  doc_json_written: 'Output files written',
  docx_converting: 'Converting document...',
  db_write: 'Saving to database...',
  db_footnotes: 'Saving footnotes...',
  db_references: 'Saving references...',
  complete: 'Import complete!',
};

/** Label for a stage, falling back to the raw stage string. */
export function importStageLabel(stage: string | null | undefined): string {
  if (!stage) return '';
  return IMPORT_STAGE_LABELS[stage] || stage;
}

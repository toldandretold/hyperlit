/**
 * Shared helpers for the file-import pipeline.
 *
 * Used by:
 *   - The inline dropzone in `showImportForm()` (newBookButton.js)
 *   - The page-level drop overlay (homepageDropTarget.js)
 *
 * Both entry points feed dropped files into the existing `#markdown_file` input
 * so the existing change-event pipeline (validateFile → validateForm →
 * handleFileMetadataExtraction → PDF.js / extractFileMetadata) handles the
 * rest unchanged.
 */

// Mirrors the form input's `accept` attribute (newBookButton.js around line 305)
// and the server-side allowed list (ImportController.php).
export const ALLOWED_IMPORT_EXTENSIONS = Object.freeze([
  'md', 'epub', 'doc', 'docx', 'html',
  'pdf',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
]);

/**
 * True if the file's extension is in the import allowlist.
 */
export function isAcceptableImportExt(file) {
  if (!file || !file.name) return false;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0 || dot === file.name.length - 1) return false;
  const ext = file.name.slice(dot + 1).toLowerCase();
  return ALLOWED_IMPORT_EXTENSIONS.includes(ext);
}

/**
 * Programmatically populate a file <input> with a FileList-like and fire a
 * `change` event so any listeners (validators, autofillers) run.
 *
 * Uses DataTransfer — the only cross-browser way to assign files to a file
 * input from JS. Works in Chrome/Edge/Firefox/Safari.
 */
export function attachFilesToInput(inputEl, files) {
  if (!inputEl || !files || !files.length) return false;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  inputEl.files = dt.files;
  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

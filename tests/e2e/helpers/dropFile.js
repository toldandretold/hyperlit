/**
 * Synthetic file drop on the window. Mirrors what an OS file drag triggers —
 * the same dataTransfer.types/files surface that window listeners read in
 * fileDropTarget.js. Lifted from file-import-drag-drop.spec.js so other
 * specs can reuse it (book-import via drag-drop).
 */
export async function dropFileOnWindow(page, { name, type, content }) {
  await page.evaluate(({ name, type, content }) => {
    const dt = new DataTransfer();
    const file = new File([content], name, { type });
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, type, content });
}

/**
 * Multi-file synthetic drop (the import-batch / vault path). Same event
 * surface as above, but with N files; binary payloads travel as base64
 * (`contentBase64`) so images survive the Node→page hop. Note synthetic
 * DataTransfer items have no webkitGetAsEntry() directory entries, so this
 * exercises the LOOSE-files routing (vault image matching is basename-based,
 * so folder structure is not required).
 */
export async function dropFilesOnWindow(page, files) {
  await page.evaluate((fileSpecs) => {
    const dt = new DataTransfer();
    for (const spec of fileSpecs) {
      let payload;
      if (spec.contentBase64) {
        const bin = atob(spec.contentBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        payload = bytes;
      } else {
        payload = spec.content;
      }
      dt.items.add(new File([payload], spec.name, { type: spec.type || '' }));
    }
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

/**
 * Synthetic file drop on the window. Mirrors what an OS file drag triggers —
 * the same dataTransfer.types/files surface that window listeners read in
 * homepageDropTarget.js. Lifted from file-import-drag-drop.spec.js so other
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

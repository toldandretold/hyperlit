// renderOpenBooks.js
import { openDatabase } from './cache-indexedDB.js';
import { formatBibtexToCitation } from './bibtexProcessor.js';

async function getAllRecords(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function renderOpenBooks() {
  if (document.body.getAttribute('data-page') !== 'home') return;
  console.log('🚀 renderOpenBooks starting…');

  const db     = await openDatabase();
  const chunks = await getAllRecords(db, 'nodeChunks');
  const bookIds = [...new Set(chunks.map(c => c.book))];

  const items = await Promise.all(bookIds.map(async (id) => {
    const rec = await new Promise((res, rej) => {
      const tx  = db.transaction('library','readonly');
      const req = tx.objectStore('library').get(id);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    if (!rec?.bibtex) return '';

    // 1) get the full citation HTML
    const citationHtml = formatBibtexToCitation(rec.bibtex).trim();

    // 2) build your link suffix; here we use ↗ but you can use “[:]” or an icon
    const href      = `/${encodeURIComponent(id)}`;
    const linkIcon  = '<span class="open-icon">↗</span>';
    const linkHtml  = `<a href="${href}" title="Open book">${linkIcon}</a>`;

    // 3) append the link to the end of the citation
    return `<li>${citationHtml} ${linkHtml}</li>`;
  }));

  const para = document.querySelector('p[data-block-id="3"]');
  if (!para) return;

  const valid = items.filter(Boolean);
  para.innerHTML = valid.length
    ? `<ul class="open-books-list">\n  ${valid.join('\n  ')}\n</ul>`
    : '<em>No open books.</em>';
}

document.addEventListener('pageReady', () => {
  renderOpenBooks().catch(console.error);
});

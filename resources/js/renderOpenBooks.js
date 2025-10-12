// renderOpenBooks.js
import { openDatabase } from './indexedDB.js';
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
  console.log("LOOKING FOR BOOKS OPEN IN INDEXEDdb");
  if (document.body.getAttribute('data-page') !== 'home') return;
  console.log('🚀 renderOpenBooks starting…');

  let db;
  try {
    db = await openDatabase();
    console.log('IndexedDB opened:', db);
  } catch (e) {
    console.error('Failed to open IndexedDB:', e);
    return;
  }

  let chunks;
  try {
    chunks = await getAllRecords(db, 'nodeChunks');
    console.log('Chunks:', chunks);
  } catch (e) {
    console.error('Failed to get nodeChunks:', e);
    return;
  }

  const bookIds = [...new Set(chunks.map(c => c.book))];
  console.log('Book IDs:', bookIds);

  const items = await Promise.all(bookIds.map(async (id) => {
    // ... keep as before
  }));

  const para = document.querySelector('p[data-block-id="3"]');
  if (!para) {
    console.warn('No <p data-block-id="3"> found!');
    return;
  }

  const valid = items.filter(Boolean);
  para.innerHTML = valid.length
    ? `<ul class="open-books-list">\n  ${valid.join('\n  ')}\n</ul>`
    : '<em>No open books.</em>';
  console.log('Rendered open books:', para.innerHTML);
}


document.addEventListener('pageReady', () => {
  renderOpenBooks().catch(console.error);
});

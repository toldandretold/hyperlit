import { initializeReaderView } from './viewInitializers.js';
import { setCurrentBook } from './app.js';

export async function transitionToReaderView(bookId) {
  try {
    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error('Failed to fetch reader page HTML');
    const htmlString = await response.text();

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    const currentPageWrapper = document.getElementById('page-wrapper');
    const newPageWrapper = newDoc.getElementById('page-wrapper');

    if (!currentPageWrapper || !newPageWrapper) {
      console.error('Critical error: #page-wrapper not found. Falling back to full reload.');
      window.location.href = `/${bookId}/edit?target=1&edit=1`;
      return;
    }

    // This is now 100% reliable because the templates are consistent.
    currentPageWrapper.innerHTML = newPageWrapper.innerHTML;

    // We get the data from the new document's body tag...
    const newBody = newDoc.body;
    // ...and apply it to the *real* body tag.
    document.body.dataset.page = newBody.dataset.page || 'reader';
    document.body.dataset.editMode = newBody.dataset.editMode || '0';
    document.title = newDoc.title;

    setCurrentBook(bookId);
    history.pushState({}, '', `/${bookId}/edit?target=1&edit=1`);
    await initializeReaderView();

  } catch (error) {
    console.error('SPA Transition Failed:', error);
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}
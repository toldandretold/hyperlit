// In resources/js/viewManager.js

import { initializeReaderView } from './viewInitializers.js';
import { setCurrentBook } from './app.js';

export async function transitionToReaderView(bookId) {
  // ... (show loading overlay if you have one) ...

  try {
    // 1. Fetch the HTML of the destination page (Correct)
    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error('Failed to fetch reader page HTML');
    const htmlString = await response.text();

    // 2. Parse the fetched HTML into a full document (Correct)
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // =================================================================
    // THE FIX: SURGICAL DOM UPDATE INSTEAD OF BODY SWAP
    // =================================================================

    // 3. Find the main app container on the current page and in the new HTML.
    const currentAppContainer = document.getElementById('app-container');
    const newAppContainer = newDoc.getElementById('app-container');

    // 4. Add a safety check. If we can't find the containers, fall back to a full reload.
    if (!currentAppContainer || !newAppContainer) {
      console.error('Could not find #app-container. Falling back to full reload.');
      window.location.href = `/${bookId}/edit?target=1&edit=1`;
      return;
    }

    // 5. Replace ONLY the content of the app container. This is much safer
    //    and preserves the <body> tag, which prevents SVG rendering issues.
    currentAppContainer.innerHTML = newAppContainer.innerHTML;

    // 6. Update the page title and body's data attributes from the new document.
    document.title = newDoc.title;
    document.body.dataset.page = newDoc.body.dataset.page;
    document.body.dataset.editMode = newDoc.body.dataset.editMode;

    // =================================================================
    // END FIX
    // =================================================================

    // 7. Update the global state (Correct)
    setCurrentBook(bookId);

    // 8. Update the URL without reloading (Correct)
    history.pushState({}, '', `/${bookId}/edit?target=1&edit=1`);

    // 9. Run the JavaScript for the new view (Correct)
    //    This will now correctly find and attach listeners to the new buttons
    //    (like #cloudRef and #editButton) that we just injected.
    await initializeReaderView();

  } catch (error) {
    console.error('SPA Transition Failed:', error);
    // Fallback to a hard reload (Correct)
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}
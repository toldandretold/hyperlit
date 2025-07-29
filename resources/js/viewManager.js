// In resources/js/viewManager.js

import { initializeReaderView } from './viewInitializers.js';
import { setCurrentBook } from './app.js';

export async function transitionToReaderView(bookId) {
  // ... (show loading overlay if you have one) ...

  try {
    // 1. Fetch the HTML of the destination page (This line is correct as is)
    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error('Failed to fetch reader page HTML');
    const htmlString = await response.text();

    // 2. Parse the fetched HTML
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // 3. Swap the entire body content
    document.body.innerHTML = newDoc.body.innerHTML;
    document.body.dataset.page = newDoc.body.dataset.page;
    document.body.dataset.editMode = newDoc.body.dataset.editMode;

    // 4. Update the global state
    setCurrentBook(bookId);

    // 5. Update the URL without reloading
    // ✅ FIX #1: Add `&edit=1` to the URL for the client-side script to read.
    history.pushState({}, '', `/${bookId}/edit?target=1&edit=1`);

    // 6. Run the JavaScript for the new view
    await initializeReaderView(); // This no longer needs the bookId passed in

  } catch (error) {
    console.error('SPA Transition Failed:', error);
    // Fallback to a hard reload
    // ✅ FIX #2: Also add `&edit=1` to the fallback URL for consistency.
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}
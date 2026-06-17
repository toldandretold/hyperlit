// anonymousTransfer.ts - Anonymous → account content migration. Holds the
// in-panel "bring your anonymous content in?" prompt (showAnonymousContentTransfer,
// takes the manager as `self`) plus the pure transfer helpers (was
// userContainer/anonymousContentManager.js): book ownership reassignment,
// the associate-content API call, and the content-summary builder.
import { getAnonymousToken, ensureCsrfToken } from '../../utilities/auth/index';
import { getTransferConfirmationHTML, getTransferPromptHTML } from './forms';
import { clearAllCachedData } from './cache';

/**
 * In-panel prompt offering to migrate content created while logged out.
 * Takes the SourceContainerManager-style `self` (the UserContainerManager).
 */
export function showAnonymousContentTransfer(self: any, anonymousContent: any) {
  // Clean up any existing alert boxes
  const customAlert = document.querySelector(".custom-alert");
  if (customAlert) {
    const overlay = document.querySelector(".custom-alert-overlay");
    if (overlay) overlay.remove();
    customAlert.remove();
  }

  if (!self.isOpen) {
    self.openContainer("transfer-prompt");
  }

  const contentSummary = buildContentSummary(anonymousContent);
  self.container.innerHTML = getTransferPromptHTML(contentSummary);

  // Add event listeners
  const confirmButton = document.getElementById('confirmContentTransfer');
  const skipButton = document.getElementById('skipContentTransfer');

  if (confirmButton) {
    (confirmButton as any).onclick = async () => {
      await transferAnonymousContent(anonymousContent.token);
      await clearAllCachedData();
      const pageType = document.body.getAttribute('data-page');
      if (pageType === 'reader' || pageType === 'user') {
        window.location.reload();
        return;
      }
      setTimeout(() => self.showUserProfile(), 500);
    };
  }

  if (skipButton) {
    (skipButton as any).onclick = async () => {
      try {
        await clearAllCachedData();
        const pageType = document.body.getAttribute('data-page');
        if (pageType === 'reader' || pageType === 'user') {
          window.location.reload();
          return;
        }
        self.showUserProfile();
      } catch (error) {
        console.error("❌ Error during cache clearing:", error);
        window.location.reload();
      }
    };
  }
}

/** Handles the anonymous book transfer flow */
export async function handleAnonymousBookTransfer(user: any) {
  if (!user) return;

  const anonId = await getAnonymousToken();
  if (!anonId) return;

  try {
    const anonymousBooks = await getAnonymousBooks(anonId);

    if (anonymousBooks.length > 0) {
      const shouldTransfer = await confirmBookTransfer(anonymousBooks);

      if (shouldTransfer) {
        await transferBooksToUser(anonymousBooks, anonId, user.name);
        localStorage.removeItem('authorId');
      }
    }
  } catch (error) {
    console.error('Error transferring anonymous books:', error);
  }
}

/** Gets all books created anonymously with the given token */
export async function getAnonymousBooks(anonId: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MarkdownDB');
    request.onsuccess = (event: any) => {
      const db = event.target.result;
      const transaction = db.transaction(['library'], 'readonly');
      const store = transaction.objectStore('library');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = () => {
        const allBooks = getAllRequest.result;
        const books = allBooks.filter((book: any) => {
          const hasMatchingToken = book.creator_token === anonId;
          const hasNoCreator = !book.creator || book.creator === null;
          return hasMatchingToken && hasNoCreator;
        });
        resolve(books);
      };

      getAllRequest.onerror = () => reject(getAllRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Shows confirmation dialog for book transfer */
export async function confirmBookTransfer(books: any[]): Promise<boolean> {
  return new Promise((resolve) => {
    const bookTitles = books.map(book => book.title || 'Untitled').join(', ');
    const message = `You have ${books.length} book(s) created while not logged in: ${bookTitles}. Would you like to transfer ownership to your account?`;

    showTransferConfirmation(message, resolve);
  });
}

/** Creates and displays the transfer confirmation modal */
export function showTransferConfirmation(message: string, callback: (result: boolean) => void) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); z-index: 2000; display: flex;
    align-items: center; justify-content: center;
  `;

  modal.innerHTML = getTransferConfirmationHTML(message);

  document.body.appendChild(modal);

  (modal.querySelector('#confirmTransfer') as any).onclick = () => {
    document.body.removeChild(modal);
    callback(true);
  };

  (modal.querySelector('#cancelTransfer') as any).onclick = () => {
    document.body.removeChild(modal);
    callback(false);
  };
}

/** Transfers books to user account */
export async function transferBooksToUser(books: any[], anonId: any, userName: any) {
  for (const bookRecord of books) {
    try {
      const bookId = bookRecord.book;

      if (!bookId) {
        console.error('No valid ID found for book:', bookRecord);
        continue;
      }

      await updateBookOwnership(bookId, userName);
      await updateBookOwnershipBackend(bookId, anonId);
    } catch (error) {
      console.error(`Failed to transfer book:`, error);
    }
  }
}

/** Updates book ownership in local IndexedDB */
export async function updateBookOwnership(bookId: any, userName: any) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('MarkdownDB');
    request.onsuccess = (event: any) => {
      const db = event.target.result;
      const transaction = db.transaction(['library'], 'readwrite');
      const store = transaction.objectStore('library');

      if (!bookId) {
        reject(new Error('Invalid book ID provided'));
        return;
      }

      const getRequest = store.get(bookId);
      getRequest.onsuccess = () => {
        const book = getRequest.result;

        if (book) {
          book.creator = userName;
          book.updated_at = new Date().toISOString();

          const putRequest = store.put(book);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          reject(new Error(`Book not found with ID: ${bookId}`));
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Updates book ownership on the backend */
export async function updateBookOwnershipBackend(bookId: any, anonId: any) {
  const csrfToken = await ensureCsrfToken();
  if (!csrfToken) {
    throw new Error('Backend transfer failed: could not obtain CSRF token');
  }

  const response = await fetch(`/books/${bookId}/transfer-ownership`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': csrfToken as any,
    },
    credentials: 'include',
    body: JSON.stringify({ anonymous_token: anonId })
  });

  if (!response.ok) {
    throw new Error(`Backend transfer failed: ${response.status}`);
  }
}

/** Associates anonymous content with logged-in user via API */
export async function transferAnonymousContent(token: any) {
  try {
    const csrfToken = await ensureCsrfToken();
    if (!csrfToken) {
      console.error("❌ Content association skipped: could not obtain CSRF token");
      return;
    }
    const response = await fetch('/api/auth/associate-content', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken as any,
      },
      credentials: 'include',
      body: JSON.stringify({ anonymous_token: token })
    });

    if (!response.ok) {
      console.error("❌ API Error during content association:", await response.text());
    }
  } catch (error) {
    console.error("❌ Fetch error during content association:", error);
  }
}

/** Builds content summary from anonymous content data */
export function buildContentSummary(anonymousContent: any): string[] {
  const totalBooks = anonymousContent.books?.length || 0;
  const totalHighlights = anonymousContent.highlights?.length || 0;
  const totalCites = anonymousContent.cites?.length || 0;

  const contentSummary: string[] = [];
  if (totalBooks > 0) contentSummary.push(`${totalBooks} book${totalBooks > 1 ? 's' : ''}`);
  if (totalHighlights > 0) contentSummary.push(`${totalHighlights} highlight${totalHighlights > 1 ? 's' : ''}`);
  if (totalCites > 0) contentSummary.push(`${totalCites} citation${totalCites > 1 ? 's' : ''}`);

  return contentSummary;
}

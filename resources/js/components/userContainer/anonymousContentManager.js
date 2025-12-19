// anonymousContentManager.js - Anonymous content transfer utilities

import { getAnonymousToken } from '../../utilities/auth.js';
import { getTransferConfirmationHTML } from './formTemplates.js';

/**
 * Gets CSRF token from cookie
 * @returns {string|null}
 */
function getCsrfTokenFromCookie() {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; XSRF-TOKEN=`);
  if (parts.length === 2) {
    return decodeURIComponent(parts.pop().split(";").shift());
  }
  return null;
}

/**
 * Handles the anonymous book transfer flow
 * @param {object} user - Current logged-in user
 * @returns {Promise<void>}
 */
export async function handleAnonymousBookTransfer(user) {
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

/**
 * Gets all books created anonymously with the given token
 * @param {string} anonId - Anonymous token
 * @returns {Promise<object[]>}
 */
export async function getAnonymousBooks(anonId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MarkdownDB');
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(['library'], 'readonly');
      const store = transaction.objectStore('library');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = () => {
        const allBooks = getAllRequest.result;
        const books = allBooks.filter(book => {
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

/**
 * Shows confirmation dialog for book transfer
 * @param {object[]} books - Array of books to transfer
 * @returns {Promise<boolean>}
 */
export async function confirmBookTransfer(books) {
  return new Promise((resolve) => {
    const bookTitles = books.map(book => book.title || 'Untitled').join(', ');
    const message = `You have ${books.length} book(s) created while not logged in: ${bookTitles}. Would you like to transfer ownership to your account?`;

    showTransferConfirmation(message, resolve);
  });
}

/**
 * Creates and displays the transfer confirmation modal
 * @param {string} message - Confirmation message
 * @param {Function} callback - Callback with boolean result
 */
export function showTransferConfirmation(message, callback) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); z-index: 2000; display: flex;
    align-items: center; justify-content: center;
  `;

  modal.innerHTML = getTransferConfirmationHTML(message);

  document.body.appendChild(modal);

  modal.querySelector('#confirmTransfer').onclick = () => {
    document.body.removeChild(modal);
    callback(true);
  };

  modal.querySelector('#cancelTransfer').onclick = () => {
    document.body.removeChild(modal);
    callback(false);
  };
}

/**
 * Transfers books to user account
 * @param {object[]} books - Array of books to transfer
 * @param {string} anonId - Anonymous token
 * @param {string} userName - Username to transfer to
 */
export async function transferBooksToUser(books, anonId, userName) {
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

/**
 * Updates book ownership in local IndexedDB
 * @param {string} bookId - Book ID
 * @param {string} userName - New owner username
 */
export async function updateBookOwnership(bookId, userName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MarkdownDB');
    request.onsuccess = (event) => {
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

/**
 * Updates book ownership on the backend
 * @param {string} bookId - Book ID
 * @param {string} anonId - Anonymous token
 */
export async function updateBookOwnershipBackend(bookId, anonId) {
  const csrfToken = getCsrfTokenFromCookie();

  const response = await fetch(`/books/${bookId}/transfer-ownership`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': csrfToken
    },
    credentials: 'include',
    body: JSON.stringify({ anonymous_token: anonId })
  });

  if (!response.ok) {
    throw new Error(`Backend transfer failed: ${response.status}`);
  }
}

/**
 * Associates anonymous content with logged-in user via API
 * @param {string} token - Anonymous token
 */
export async function transferAnonymousContent(token) {
  try {
    const csrfToken = getCsrfTokenFromCookie();
    const response = await fetch('/api/auth/associate-content', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken
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

/**
 * Builds content summary from anonymous content data
 * @param {object} anonymousContent - Object with books, highlights, cites arrays
 * @returns {string[]}
 */
export function buildContentSummary(anonymousContent) {
  const totalBooks = anonymousContent.books?.length || 0;
  const totalHighlights = anonymousContent.highlights?.length || 0;
  const totalCites = anonymousContent.cites?.length || 0;

  const contentSummary = [];
  if (totalBooks > 0) contentSummary.push(`${totalBooks} book${totalBooks > 1 ? 's' : ''}`);
  if (totalHighlights > 0) contentSummary.push(`${totalHighlights} highlight${totalHighlights > 1 ? 's' : ''}`);
  if (totalCites > 0) contentSummary.push(`${totalCites} citation${totalCites > 1 ? 's' : ''}`);

  return contentSummary;
}

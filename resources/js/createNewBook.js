// createNewBook.js
import { openDatabase, updateBookTimestamp, addNewBookToIndexedDB } from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser, getAnonymousToken } from "./auth.js"; // Changed import

// your existing helper (you could move this to utils.js)
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] &
        (15 >> (c / 4)))).toString(16)
  );
}

// REMOVED: getCreatorId() function - no longer needed

export async function createNewBook() {
  try {
    // 1) Get auth info using new system
    const user = await getCurrentUser();
    const anonymousToken = await getAnonymousToken(); // This handles auth initialization
    
    // Determine creator info
    const creator = user
      ? (user.name || user.username || user.email)
      : null;
    const creator_token = user ? null : anonymousToken;

    console.log("Creating new book with", {
      creator,
      creator_token: creator_token ? 'present' : 'null',
      user_authenticated: !!user
    });

    // Validate that we have some form of auth
    if (!creator && !creator_token) {
      throw new Error('No valid authentication - cannot create book');
    }

    // 2) open IndexedDB
    const db = await openDatabase();
    const bookId = "book_" + Date.now();

    const newLibraryRecord = {
      book: bookId,
      citationID: bookId,
      title: "Untitled",
      author: null,
      type: "book",
      timestamp: new Date().toISOString(),
      creator,
      creator_token
    };
    newLibraryRecord.bibtex = buildBibtexEntry(newLibraryRecord);

    // 3) write into IndexedDB
    const tx = db.transaction(["library"], "readwrite");
    const store = tx.objectStore("library");
    store.put(newLibraryRecord);

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("New book created in IndexedDB:", newLibraryRecord);
        try {
          // seed initial nodes
          await addNewBookToIndexedDB(
            bookId,
            1,
            '<h1 id="1">Untitled</h1>',
            0
          );
          console.log("Initial nodes created");

          // sync up to server (backend will use cookie-based auth)
          await updateBookTimestamp(bookId);
          await syncIndexedDBtoPostgreSQL(bookId);

          // go edit!
          window.location.href = `/${bookId}/edit?target=1`;
          resolve(newLibraryRecord);
        } catch (err) {
          console.error("Failed post-indexedDB steps:", err);
          reject(err);
        }
      };
      tx.onerror = e => {
        console.error("IndexedDB transaction failed:", e.target.error);
        reject(e.target.error);
      };
    });
  } catch (err) {
    // catches any errors *before* the tx.promise is returned
    console.error("createNewBook() failed:", err);
    throw err;
  }
}
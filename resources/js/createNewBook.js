// createNewBook.js
import { openDatabase, updateBookTimestamp, addNewBookToIndexedDB } from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser, getAuthorId } from "./auth.js";

// your existing helper (you could move this to utils.js)
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] &
        (15 >> (c / 4)))).toString(16)
  );
}

async function getCreatorId() {
  const user = await getCurrentUser();
  
  if (user) {
    // User is logged in, use their username or name
    return user.name || user.username || user.email;
  } else {
    // User not logged in, use persistent UUID
    const AUTHOR_KEY = "authorId";
    let authorId = localStorage.getItem(AUTHOR_KEY);
    if (!authorId) {
      authorId = generateUUID();
      localStorage.setItem(AUTHOR_KEY, authorId);
    }
    return authorId;
  }
}

export async function createNewBook() {
  try {
    // 1) who are we?
    const user   = await getCurrentUser();
    // if logged in → creator=username, token=null
    // if anon      → creator=null,    token=UUID
    const creator       = user
      ? (user.name || user.username || user.email)
      : null;
    const creator_token = user ? null : getAuthorId();

    console.log("Creating new book with", {
      creator,
      creator_token
    });

    // 2) open IndexedDB
    const db     = await openDatabase();
    const bookId = "book_" + Date.now();

    const newLibraryRecord = {
      book:           bookId,
      citationID:     bookId,
      title:          "Untitled",
      author:         null,
      type:           "book",
      timestamp:      new Date().toISOString(),
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
          await addNewBookToIndexedDB(
            bookId,
            2,
            '<p id="2"><br/></p>',
            0
          );
          console.log("Initial nodes created");

          // sync up to server (will include creator_token)
          await updateBookTimestamp(bookId);
          await syncIndexedDBtoPostgreSQL(bookId);

          // go edit!
          window.location.href = `/${bookId}/edit`;
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

// createNewBook.js
import { openDatabase, updateBookTimestamp, addNewBookToIndexedDB } from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser } from "./auth.js";

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
    const creatorId = await getCreatorId();
    console.log("Creating new book with creator:", creatorId);

    const db = await openDatabase();
    
    // Generate a unique book identifier
    const bookId = "book_" + Date.now();
    
    // Create the library record
    const newLibraryRecord = {
      book: bookId,
      citationID: bookId,
      title: "Update Title",
      author: null,
      type: "book",
      timestamp: new Date().toISOString(),
      creator: creatorId, // Now uses either username or UUID
    };

    newLibraryRecord.bibtex = buildBibtexEntry(newLibraryRecord);

    // Start transaction for library store only
    const tx = db.transaction(["library"], "readwrite");
    const libraryStore = tx.objectStore("library");

    // Add library record
    libraryStore.put(newLibraryRecord);

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("New book created:", newLibraryRecord);
        
        try {
          console.log("Creating first nodeChunk...");
          await addNewBookToIndexedDB(bookId, 1, '<h1 id="1">Untitled</h1>', 0);
          
          console.log("Creating second nodeChunk...");
          await addNewBookToIndexedDB(bookId, 2, '<p id="2"><br/></p>', 0);
          
          console.log("Initial nodes created successfully");

          await updateBookTimestamp(bookId);
          await syncIndexedDBtoPostgreSQL(bookId);
          
          window.location.href = `/${bookId}/edit`;
          resolve(newLibraryRecord);
          
        } catch (err) {
          console.error("Failed to create initial nodes:", err);
          reject(err);
        }
      };
      
      tx.onerror = (e) => {
        console.error("Transaction failed:", e.target.error);
        reject(e.target.error);
      };
    });
  } catch (err) {
    console.error("Failed to create new book:", err);
    throw err;
  }
}

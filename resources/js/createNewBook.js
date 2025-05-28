// createNewBook.js
import { openDatabase, addNodeChunkToIndexedDB } from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";

// your existing helper (you could move this to utils.js)
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] &
        (15 >> (c / 4)))).toString(16)
  );
}

// 1) ensure a single, persistent authorId
const AUTHOR_KEY = "authorId";
let authorId = localStorage.getItem(AUTHOR_KEY);
if (!authorId) {
  authorId = generateUUID();
  localStorage.setItem(AUTHOR_KEY, authorId);
}
console.log("Using authorId =", authorId);

export async function createNewBook() {
  console.log("Creating new book with authorId:", authorId);

  try {
    const db = await openDatabase();
    
    // Generate a unique book identifier
    const bookId = "book_" + Date.now();
    
    // Create the library record
    const newLibraryRecord = {
      book: bookId, // This matches the keyPath for library store
      citationID: bookId, // Keep this for compatibility if needed elsewhere
      title: "Update Title",
      author: authorId,
      type: "book",
      timestamp: new Date().toISOString(),
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
          // Create the two initial nodeChunks using the new function
          console.log("Creating first nodeChunk...");
          await addNodeChunkToIndexedDB(bookId, 1, '<h1 id="1">Untitled</h1>', 0);
          
          console.log("Creating second nodeChunk...");
          await addNodeChunkToIndexedDB(bookId, 2, '<p id="2"><br/></p>', 0);
          
          console.log("Initial nodes created successfully");
          
          // Navigate to edit page
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

// createNewBook.js
import { openDatabase } from "./cache-indexedDB.js";

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
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");

    const newLibraryRecord = {
      citationID: "book_" + Date.now(), // unchanged
      title: "Update Title",
      author: authorId,                 // always the same
      type: "book",
      timestamp: new Date().toISOString(),
    };

    store.put(newLibraryRecord);

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("New book created:", newLibraryRecord);
        try {
          const res = await fetch("/create-main-text-md", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-TOKEN": document
                .querySelector('meta[name="csrf-token"]')
                ?.getAttribute("content"),
            },
            body: JSON.stringify({
              citation_id: newLibraryRecord.citationID,
              title: newLibraryRecord.title,
            }),
          });
          const result = await res.json();
          if (res.ok && result.success) {
            window.location.href = `/${newLibraryRecord.citationID}/edit`;
            resolve(newLibraryRecord);
          } else {
            reject(result.error || "Backend error");
          }
        } catch (err) {
          reject(err);
        }
      };
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    console.error(err);
    throw err;
  }
}

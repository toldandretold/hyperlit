// createNewBook.js
import { openDatabase } from "./cache-indexedDB.js";

export async function createNewBook() {
  console.log("Creating new book...");
  
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");

    // Create an initial record with default values
    const newLibraryRecord = {
      citationID: "book_" + Date.now(),
      title: "New Book Title",
      author: "Author Name",
      type: "book",
      timestamp: new Date().toISOString(),
      // Add any other default fields you need
    };

    // Save the record
    store.put(newLibraryRecord);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log("New book created successfully.");
        resolve(newLibraryRecord);
      };

      tx.onerror = (event) => {
        console.error("Error during transaction:", event.target.error);
        reject(event.target.error);
      };
    });
  } catch (error) {
    console.error("Failed to create new book:", error);
    throw error;
  }
}

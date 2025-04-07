// annotationSaver.js
import { openDatabase } from "./cache-indexedDB.js";
import { showSpinner, showTick } from "./editIndicator.js";


// Debounce timer variable for the highlight container.
let annotationDebounceTimer = null;



/**
 * Extracts the current HTML content from within the annotation element.
 * Assumes .annotation is found inside the highlight container.
 * @param {HTMLElement} container
 * @returns {string} HTML string
 */
function getAnnotationHTML(container) {
  const annotationEl = container.querySelector(".annotation");
  return annotationEl ? annotationEl.innerHTML : "";
}

/**
 * Save the annotation HTML to the hyperlights record in IndexedDB.
 * Uses the same schema as your existing addToHighlightsTable function.
 * @param {string} highlightId - Unique id for the highlight.
 * @param {string} annotationHTML - The annotation HTML to be saved.
 */
export async function saveAnnotationToIndexedDB(highlightId, annotationHTML) {
  try {
    const db = await openDatabase();
    // Open a readwrite transaction on the hyperlights table.
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    // Assume the hyperlight_id is indexed.
    const index = store.index("hyperlight_id");
    const getRequest = index.get(highlightId);

    getRequest.onsuccess = () => {
      const record = getRequest.result;
      if (!record) {
        console.error("❌ No record found for highlight id:", highlightId);
        return;
      }
      // Set the new annotation value.
      record.annotation = annotationHTML;
      // Update the record.
      const updateRequest = store.put(record);
      updateRequest.onsuccess = () => {
        console.log("✅ Annotation saved for highlight id:", highlightId);
        showTick();
      };
      updateRequest.onerror = (e) => {
        console.error("❌ Error updating annotation:", e.target.error);
      };
    };

    getRequest.onerror = (e) => {
      console.error("❌ Error retrieving highlight record:", e.target.error);
    };
  } catch (error) {
    console.error("❌ Error in saveAnnotationToIndexedDB:", error);
  }
}

/**
 * Attaches an input listener to the highlight container.
 * This listener is added only if the container is visible.
 *
 * As the user types a spinner is shown;
 * after a debounce period (e.g. 2 seconds of no input),
 * the annotation content is saved to IndexedDB.
 *
 * @param {string} highlightId - Unique highlight id.
 */
// Assuming "container" and "highlightId" are available
// annotationSaver.js (or wherever you manage the listener)
export function attachAnnotationListener(highlightId) {
  console.log(`listening for ${highlightId}`);
  const container = document.getElementById("highlight-container");
  if (!container) {
    console.error("❌ Highlight container not found");
    return;
  }
  if (container.classList.contains("hidden")) return;

  // Create a manager-scoped variable to store the latest annotation.
  // You can use a global variable, or attach it to the container for example:
  container.dataset.lastAnnotation = "";

  // Define the event handler, which updates the stored annotation.
  const updateLastAnnotation = () => {
    // Immediately update the stored annotation.
    container.dataset.lastAnnotation = getAnnotationHTML(container);
  };

  // The debounced autosave remains unchanged if you wish.
  const onAnnotationInput = () => {
    console.log("Input event fired");
    showSpinner(); // Show your global spinner
    updateLastAnnotation(); // Update stored value

    if (annotationDebounceTimer) {
      clearTimeout(annotationDebounceTimer);
    }
    annotationDebounceTimer = setTimeout(() => {
      // Use the currently stored value for autosave.
      const annotationHTML = container.dataset.lastAnnotation;
      saveAnnotationToIndexedDB(highlightId, annotationHTML)
        .then(() => {
          console.log("Autosave successful for highlightId:", highlightId);
        })
        .catch((err) => {
          console.error("Autosave error:", err);
        });
    }, 1000);
  };

  // Also listen for keyup events to update the stored text immediately.
  container.removeEventListener("keyup", updateLastAnnotation, true);
  container.addEventListener("keyup", updateLastAnnotation, true);

  // Remove and add the input listener using capturing.
  container.removeEventListener("input", onAnnotationInput, true);
  container.addEventListener("input", onAnnotationInput, true);
}


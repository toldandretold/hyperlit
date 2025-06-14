

console.log('App.js is loaded');

if ("serviceWorker" in navigator) {
	
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/build/serviceWorker.js")
      .then((registration) => {
        console.log(
          "Service Worker registered successfully with scope:",
          registration.scope
        );
      })
      .catch((error) => {
        console.error("Service Worker registration failed:", error);
      });
  });
}

// app.js — top of file

// 1) Grab cleaned path segments, e.g. "/book11/HL_123" → ["book11","HL_123"]
const pathSegments = window.location.pathname
  .replace(/^\/|\/$/g, "")
  .split("/")
  .filter(Boolean);

// 2) Initialize exports
let _hyperlightId = null;      // second-segment HL_… → scroll-to highlight in book


// 3) If exactly two segments and second starts with "HL_", that's our OpenHyperlightID
if (
  pathSegments.length === 2 &&
  pathSegments[1].startsWith("HL_")
) {
  _hyperlightId = pathSegments[1];
}


// 5) Export the book ID (preferring your DOM‐rendered .main-content.id)
const domBook = document.querySelector(".main-content")?.id;
export const book = domBook || pathSegments[0] || null;
if (!book) {
  console.error("No book ID found in DOM or URL!");
}

// 6) Export the two HL constants
export const OpenHyperlightID = _hyperlightId;    

// 7) Debug
console.log("book →", book);
if (OpenHyperlightID) console.log("OpenHyperlightID →", OpenHyperlightID);



export const markdownContent = ""; // Store Markdown globally









import { log } from './utilities/logger.js';
import { initializeTheme } from './utilities/themeSwitcher.js';

// Initialize theme as early as possible to prevent flash
initializeTheme();

// Load navigation health check in development
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  import('./navigation/healthCheck.js').then(() => {
    console.log('🏥 Health check loaded. Run window.checkNavigationHealth() in console to diagnose issues.');
  }).catch(() => {
    // Silently fail if health check not available
  });
}

// Load latency monitor (available in all environments)
import('./utilities/latencyMonitor.js').then(() => {
  console.log('⚡ Latency monitor loaded. Use settings button or window.latency.start(true)');
}).catch(() => {
  // Silently fail if not available
});

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

// 1) Grab cleaned path segments
const pathSegments = window.location.pathname
  .replace(/^\/|\/$/g, "")
  .split("/")
  .filter(Boolean);

// 2) Initialize exports
let _hyperlightId = null;
let _footnoteId = null;

// 3) If exactly two segments and second starts with "HL_", that's our OpenHyperlightID
//    If it contains "_Fn", that's a footnote ID
if (pathSegments.length === 2) {
  if (pathSegments[1].startsWith("HL_")) {
    _hyperlightId = pathSegments[1];
  } else if (pathSegments[1].includes("_Fn")) {
    _footnoteId = pathSegments[1];
  }
}

// 5) Export the book ID (preferring your DOM‐rendered .main-content.id)
const domBook = document.querySelector(".main-content")?.id;

// ✅ CHANGED: Use 'let' instead of 'const' so we can update it during SPA transitions.
export let book = domBook || pathSegments[0] || "most-recent"; // Fallback to most-recent

if (!book) {
  console.error("No book ID found in DOM or URL!");
}

log.init(`Loading hypertext for: ${book}`, 'app.js');

// ✅ ADD THIS EXPORTED FUNCTION
// This allows our viewManager to update the global book state after an SPA transition.
export function setCurrentBook(newBookId) {
  book = newBookId;
  log.init(`Book updated to: ${book}`, 'app.js');
}

// 6) Export the hyperlight and footnote constants
export const OpenHyperlightID = _hyperlightId;
export const OpenFootnoteID = _footnoteId;

export const markdownContent = ""; // Store Markdown globally
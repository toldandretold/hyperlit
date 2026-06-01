import './integrity/logCapture.js';
import { log } from './utilities/logger.js';
import { seedFromServer } from './utilities/preferences.js';
import { initializeTheme } from './utilities/themeSwitcher.js';

// Seed localStorage from server-injected preferences before theme init
seedFromServer();

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

// Service Worker registration moved to layout.blade.php (root scope /sw.js)

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
//    Skip detection for /based/ standalone URLs — the DOM id provides the book ID
const isStandaloneMode = pathSegments[0] === 'based';

if (!isStandaloneMode && pathSegments.length === 2) {
  if (pathSegments[1].startsWith("HL_")) {
    _hyperlightId = pathSegments[1];
  } else if (pathSegments[1].includes("_Fn") || pathSegments[1].startsWith("Fn")) {
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

// This allows our viewManager to update the global book state after an SPA transition.
export function setCurrentBook(newBookId) {
  book = newBookId;
  log.init(`Book updated to: ${book}`, 'app.js');
}

// Slug support: URL alias for the current book
export let bookSlug = document.querySelector('.main-content')?.dataset?.slug || null;

export function setCurrentBookSlug(slug) {
  bookSlug = slug || null;
}

// 6) Export the hyperlight and footnote constants
export const OpenHyperlightID = _hyperlightId;
export const OpenFootnoteID = _footnoteId;

export const markdownContent = ""; // Store Markdown globally
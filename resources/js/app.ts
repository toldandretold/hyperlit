import './integrity/logCapture';
import { log, verbose } from './utilities/logger';
import { asBookId, type BookId } from './indexedDB/types';
import { seedFromServer } from './utilities/preferences';
import { initializeTheme } from './components/settingsContainer/themeSwitcher';
import { initializeReadingMode } from './components/settingsContainer/readingModeSwitcher';

// Seed localStorage from server-injected preferences before theme init
seedFromServer();

// Initialize theme as early as possible to prevent flash
initializeTheme();

// Reading-mode preference (scroll vs paginated) — body class before first paint
initializeReadingMode();

// Ask the browser not to evict our storage (IndexedDB is the offline book
// cache). Chrome/Firefox honor this; Safari mostly ignores it and can still
// wipe storage (ITP / disk pressure) — the integrity cache-loss modal covers
// that case. Fire-and-forget: denial is fine, we just get eviction-eligible.
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => { /* unsupported/denied — nothing to do */ });
}

// Load navigation health check in development
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  import('./SPA/navigation/healthCheck').catch(() => {
    // Silently fail if health check not available
  });
}

// 1) Grab cleaned path segments
const pathSegments = window.location.pathname
  .replace(/^\/|\/$/g, "")
  .split("/")
  .filter(Boolean);

// 2) Initialize exports
let _hyperlightId: string | null = null;
let _footnoteId: string | null = null;

// 3) If exactly two segments and second starts with "HL_", that's our OpenHyperlightID
//    If it contains "_Fn", that's a footnote ID
//    Skip detection for /based/ standalone URLs — the DOM id provides the book ID
const isStandaloneMode = pathSegments[0] === 'based';
const secondSegment = pathSegments[1];

if (!isStandaloneMode && pathSegments.length === 2 && secondSegment) {
  if (secondSegment.startsWith("HL_")) {
    _hyperlightId = secondSegment;
  } else if (secondSegment.includes("_Fn") || secondSegment.startsWith("Fn")) {
    _footnoteId = secondSegment;
  }
}

// 5) Export the book ID (preferring your DOM‐rendered .main-content.id)
const domBook = document.querySelector(".main-content")?.id;

// ✅ CHANGED: Use 'let' instead of 'const' so we can update it during SPA transitions.
export let book: BookId = asBookId(domBook || pathSegments[0] || "most-recent"); // Fallback to most-recent

if (!book) {
  log.error("No book ID found in DOM or URL!", 'app.js');
}

verbose.init(`Loading hypertext for: ${book}`, 'app.js');

// This allows our viewManager to update the global book state after an SPA transition.
export function setCurrentBook(newBookId: BookId): void {
  book = newBookId;
  verbose.init(`Book updated to: ${book}`, 'app.js');
}

// Slug support: URL alias for the current book
export let bookSlug: string | null = document.querySelector<HTMLElement>('.main-content')?.dataset?.slug || null;

export function setCurrentBookSlug(slug: string | null): void {
  bookSlug = slug || null;
}

// 6) Export the hyperlight and footnote constants
export const OpenHyperlightID: string | null = _hyperlightId;
export const OpenFootnoteID: string | null = _footnoteId;

export const markdownContent: string = ""; // Store Markdown globally

// In resources/js/readerDOMContentLoaded.js

// =================================================================
// THE KEY FIX: Import app.js first to set up initial state.
// This line ensures the 'book' variable is defined before anything else runs.
import { book } from "../app";
// =================================================================

import { log, verbose } from "../utilities/logger";
import { openDatabase, initializeDatabaseModules } from "../indexedDB/index.js";
import { fireAndForgetSync } from "../SPA/createNewBook";
import { universalPageInitializer } from "../SPA/viewManager";
import { initializeHomepage } from "../components/homepage/homepage";
// ✅ REMOVED: initializeFootnoteCitationListeners now managed by ButtonRegistry
import { withPending } from "../utilities/operationState";
import { trackNewBookEstablishment } from "../utilities/newBookEstablished";
import { getPendingNewBook, clearPendingNewBook } from "../utilities/pendingNewBook";
import { generateTableOfContents } from "../components/tocContainer/index";
import { hasVibeReviewMarker } from "../conversion/vibeReviewMarker";
// ✅ REMOVED: TogglePerimeterButtons now managed exclusively by ButtonRegistry
// import TogglePerimeterButtons from "./components/togglePerimeterButtons.js";
import { showNavigationLoading, hideNavigationLoading } from "../scrolling/index";
import { pendingFirstChunkLoadedPromise } from "./firstChunkPromise";
import { initializeUserProfileEditor } from "../components/userProfile/userProfileEditor";
import { initializeUserProfilePage } from "../components/userProfile/userProfilePage";
import { initializeLogoNav } from "../components/logoNav/logoNav";
import { asBookId } from "../indexedDB/types";
import {
  isReconvertHandoff, clearReconvertHandoff, showReconvertOverlay, hideReconvertOverlay,
} from "../utilities/reconvertHandoff";

// ═════════════════════════════════════════════════════════════════════
// PROGRESS BAR CONTROL - DELEGATED TO PROGRESSOVERLAYCONDUCTOR
// ═════════════════════════════════════════════════════════════════════
// LEGACY: These functions used to directly manipulate DOM, now delegate to Conductor
// This ensures all overlay management goes through the centralized state machine

// Page-load progress shims now live in the ./progress leaf (so loadHyperText imports them without
// importing this bootstrap entry). Re-export for existing importers.
export { updatePageLoadProgress, hidePageLoadProgress } from './progress';

// ✅ REMOVED: TogglePerimeterButtons instance creation moved to ButtonRegistry
// OLD CODE (caused conflict with ButtonRegistry):
// export const togglePerimeterButtons = new TogglePerimeterButtons({...});
// togglePerimeterButtons.init();
// NOW: ButtonRegistry handles initialization via registerComponents.ts

function handlePendingNewBookSync() {
  const pendingSync = getPendingNewBook();
  if (pendingSync) {
    // Ensure overlay is definitely hidden for new book creation
    const overlay = document.getElementById('initial-navigation-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }

    // Don't clear the marker here - let permission checks work until sync completes
    try {
      const { bookId, isNewBook } = pendingSync;
      if (bookId && isNewBook) {
        // ONE signal for "does the server have this book yet"
        // (utilities/newBookEstablished): it always settles, never rejects, and
        // retires itself — so a failed handshake can't gate a later push.
        void trackNewBookEstablishment(
          bookId,
          fireAndForgetSync(bookId, isNewBook, pendingSync),
        ).then(() => {
          // Clear the marker once the handshake has settled either way (the
          // permission checks read it until then).
          clearPendingNewBook(bookId);
        });
      } else {
        // Not a valid new book, clean up immediately
        clearPendingNewBook();
      }
    } catch (error: any) {
      log.error("Failed to handle pending book sync", "readerDOMContentLoaded.js", error);
      // Clean up on error
      clearPendingNewBook();
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  verbose.init("DOM ready", "readerDOMContentLoaded.js");

  const pageType = document.body.getAttribute("data-page");

  // Reconvert hand-off: this load is the auto-reload right after a "Reconvert from source". Cover
  // the reader immediately (before anything renders) so the user never sees the interim state, and
  // remember it so we force-fresh re-populate IDB in order before the first render (below).
  const isReconvertReload = !!book && pageType === 'reader' && isReconvertHandoff(book);
  if (isReconvertReload) showReconvertOverlay('Loading reconverted book…');

  handlePendingNewBookSync();
  await openDatabase();
  verbose.init("IndexedDB initialized", "readerDOMContentLoaded.js");

  // Initialize database modules with dependencies
  const { glowCloudGreen, glowCloudRed, glowCloudLocalSave } = await import('../components/cloudRef/editIndicator');
  initializeDatabaseModules({
    book,
    withPending,
    glowCloudGreen,
    glowCloudRed,
    glowCloudLocalSave,
  } as any);
  verbose.init("Database modules initialized", "readerDOMContentLoaded.js");

  // Time machine: fetch historical data and store in IndexedDB BEFORE NavigationManager
  // runs loadHyperText, so it finds the data in cache and renders normally.
  if (pageType === 'timemachine') {
    const { initializeTimeMachine } = await import('./timeMachine');
    await initializeTimeMachine();
  }

  // Reconvert hand-off (same trick as Time Machine): IDB was cleared before the reload, so
  // force-fresh re-populate it from the just-written JSON — IN ORDER — BEFORE NavigationManager
  // runs loadHyperText. loadHyperText then finds the data in cache and takes its single
  // deterministic ordered path (no fresh-load-vs-background-download race → no scramble). The
  // hand-off flag stays set across this so loadFromJSONFiles force-freshes and the background
  // chunk download stays paused; we clear it once the render completes.
  if (isReconvertReload) {
    try {
      const { loadFromJSONFiles } = await import('./loadHyperText');
      await loadFromJSONFiles(asBookId(book));
    } catch (e: any) {
      log.error('Reconvert re-populate failed; falling back to normal load', 'readerDOMContentLoaded.js', e);
    }
  }

  // De-cycle: features (newbookContainer/userContainer/viewManager/reconvert) trigger navigation
  // through the zero-import navigationRegistry leaf rather than dynamic-importing these orchestrators
  // (which statically reach back into the feature cluster — a cycle-masking "breaker"). The
  // orchestrators register their entry points at module-load, so they must be LOADED at boot.
  // LinkNavigationHandler must register before NavigationManager.navigate() below (it attaches the
  // global link handler via the leaf during universalPageInitializer) → await it. ImportBookTransition
  // is only needed for the rare reconvert flow → fire-and-forget. Both land as code-split 'lazy' edges
  // (neither statically reaches readerEntry).
  await import('../SPA/navigation/LinkNavigationHandler.js');
  import('../SPA/navigation/pathways/ImportBookTransition.js').catch(() => {});

  // ✅ UNIFIED: ALL page types go through NavigationManager for consistent initialization
  // NavigationManager handles ALL initialization including ButtonRegistry (also registers navigate()).
  const { NavigationManager } = await import('../SPA/navigation/NavigationManager.js');
  try {
    await NavigationManager.navigate('fresh-page-load');
  } finally {
    // Reconvert hand-off complete: the ordered render is done, so drop the flag (re-enabling
    // normal background download on subsequent loads) and lift the overlay. In a `finally` so a
    // navigate failure can't leave the opaque overlay stuck over the reader. Done AFTER navigate
    // so the chunk download stays paused for this whole first load.
    if (isReconvertReload) {
      clearReconvertHandoff();
      hideReconvertOverlay();
    }
  }

  // If a vibe-convert YOU ran auto-applied a fix to this book, surface the Keep/Revert toast after the
  // success path's forced reload. Gated on a per-book intent marker (set when a review is requested,
  // cleared when resolved) so we DON'T ping the review endpoint on every page load — that endpoint is
  // auth:sanctum, so for anonymous-session authors an unconditional poll 401s on every single load.
  const SYNTHETIC_BOOKS = ['most-recent', 'most-connected', 'most-lit'];
  if (book && pageType !== 'timemachine' && !SYNTHETIC_BOOKS.includes(book) && hasVibeReviewMarker(book)) {
    import('../conversion/feedbackToast.js')
      .then(m => m.checkPendingVibeReview(book))
      .catch(() => {});
  }

  // Page-specific initialization after NavigationManager completes
  // Note: footnoteCitationListeners now handled by ButtonRegistry
  if (pageType === "user") {
    // User-specific components (in addition to what NavigationManager initialized)
    initializeUserProfilePage();
  }

  // Note: The following are now handled by NavigationManager → universalPageInitializer → ButtonRegistry:
  // - initializeHomepage() (for home/user pages)
  // - initializeLogoNav() (all pages)
  // - initializeUserProfileEditor() (user pages)
  // - All ButtonRegistry components (togglePerimeterButtons, userContainer, etc.)
});

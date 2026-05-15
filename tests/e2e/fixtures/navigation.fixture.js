import { test as base, expect } from '@playwright/test';
import { listenerMonitorScript } from '../helpers/listenerMonitor.js';
import { restorationSpyScript } from '../helpers/restorationSpy.js';
import { integrityCaptureScript } from '../helpers/integrityCapture.js';
import {
  createNewBook,
  getStackDepth,
  typeAtEndOfActiveEditor,
  selectInActiveEditor,
  insertFootnoteAtCaret,
  hyperlightSelection,
  closeTopContainer,
  copyHyperciteFromActiveEditor,
  toggleEditModeInActiveContainer,
  clickIntoDeeperLevel,
  pasteEnvProbe,
  snapshotIntegrity,
  readNestText,
} from '../helpers/nestedAuthoring.js';
import {
  waitForSpaTransitionComplete,
  getPageStructure,
  runHealthCheck,
  assertHealthy,
  getRegistryStatus,
  assertRegistryHealthy,
  getPageGlobals,
  getListenerSnapshot,
  getListenerDelta,
  filterConsoleErrors,
  navigateToHome,
  navigateToUserPage,
  clickFirstBookLink,
  navigateViaHypercite,
  selectTextInElement,
  waitForEditMode,
  getCurrentBookId,
  waitForHyperlightButtons,
  closeHyperlitContainer,
  pasteHyperciteContent,
} from '../helpers/pageHelpers.js';
import { dropFileOnWindow } from '../helpers/dropFile.js';
import { importMarkdownBook, generateLongMarkdown } from '../helpers/bookContent.js';
import {
  openToc,
  closeToc,
  getTocEntries,
  clickTocEntry,
  isHeadingInViewportForHref,
} from '../helpers/tocNav.js';
import {
  snapshotPageState,
  summariseSnapshot,
  detectAnomalies,
  detectRestorationRace,
} from '../helpers/stateSnapshot.js';
import { openAndCloseFootnotes, openFootnoteStack, closeAllContainers } from '../helpers/stress.js';

/**
 * Extended test fixture that installs the listener monitor + restoration spy,
 * captures console errors, and provides SPA navigation helpers.
 */
export const test = base.extend({
  // Install init scripts + console capture before each test
  page: async ({ page }, use) => {
    // Inject the listener monitor and restoration spy before any page scripts run
    await page.addInitScript(listenerMonitorScript);
    await page.addInitScript(restorationSpyScript);
    await page.addInitScript(integrityCaptureScript);

    // Capture console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Capture uncaught exceptions
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Attach helpers to page object for easy access
    page.consoleErrors = consoleErrors;
    page.pageErrors = pageErrors;

    await use(page);
  },

  // Provide helper functions as a fixture
  spa: async ({}, use) => {
    await use({
      // Existing
      waitForTransition: waitForSpaTransitionComplete,
      getStructure: getPageStructure,
      healthCheck: runHealthCheck,
      assertHealthy,
      getRegistryStatus,
      assertRegistryHealthy,
      getGlobals: getPageGlobals,
      getListenerSnapshot,
      getListenerDelta,
      filterConsoleErrors,
      navigateToHome,
      navigateToUserPage,
      clickFirstBookLink,
      navigateViaHypercite,
      selectTextInElement,
      waitForEditMode,
      getCurrentBookId,
      waitForHyperlightButtons,
      closeHyperlitContainer,
      pasteHyperciteContent,
      // New: book + TOC + state snapshot + stress
      dropFileOnWindow,
      importMarkdownBook,
      generateLongMarkdown,
      openToc,
      closeToc,
      getTocEntries,
      clickTocEntry,
      isHeadingInViewportForHref,
      snapshotPageState,
      summariseSnapshot,
      detectAnomalies,
      detectRestorationRace,
      openAndCloseFootnotes,
      openFootnoteStack,
      closeAllContainers,
      // Nested authoring primitives
      createNewBook,
      getStackDepth,
      typeAtEndOfActiveEditor,
      selectInActiveEditor,
      insertFootnoteAtCaret,
      hyperlightSelection,
      closeTopContainer,
      copyHyperciteFromActiveEditor,
      toggleEditModeInActiveContainer,
      clickIntoDeeperLevel,
      pasteEnvProbe,
      snapshotIntegrity,
      readNestText,
    });
  },
});

export { expect };

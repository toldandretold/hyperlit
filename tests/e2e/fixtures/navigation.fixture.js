import { test as base, expect } from '@playwright/test';
import { listenerMonitorScript } from '../helpers/listenerMonitor.js';
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

/**
 * Extended test fixture that installs the listener monitor,
 * captures console errors, and provides SPA navigation helpers.
 */
export const test = base.extend({
  // Install listener monitor before each test
  page: async ({ page }, use) => {
    // Inject the listener monitor before any page scripts run
    await page.addInitScript(listenerMonitorScript);

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
    });
  },
});

export { expect };

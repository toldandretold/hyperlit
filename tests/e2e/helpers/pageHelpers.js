/**
 * Page Helpers — SPA navigation wait, structure detection, health assertions.
 */

/** Third-party error patterns to ignore in console error checks */
const IGNORED_ERROR_PATTERNS = [
  'cloudflareinsights.com',
  'cdn-cgi/rum',
  'net::ERR_FAILED',
];

/**
 * Filter console errors, removing known third-party noise.
 */
export function filterConsoleErrors(errors) {
  return errors.filter(msg =>
    !IGNORED_ERROR_PATTERNS.some(pattern => msg.includes(pattern))
  );
}

/**
 * Wait for an SPA transition to complete.
 * Watches for the navigation overlay to appear and then hide.
 */
export async function waitForSpaTransitionComplete(page, { timeout = 15000 } = {}) {
  // Wait for the overlay to become visible (transition started)
  try {
    await page.waitForFunction(
      () => {
        const overlay = document.getElementById('initial-navigation-overlay');
        if (!overlay) return false;
        const style = window.getComputedStyle(overlay);
        return style.display !== 'none' && style.visibility !== 'hidden';
      },
      null,
      { timeout: 5000 }
    );
  } catch {
    // Overlay may never appear for very fast transitions — that's OK
  }

  // Wait for the overlay to hide (transition finished)
  await page.waitForFunction(
    () => {
      const overlay = document.getElementById('initial-navigation-overlay');
      if (!overlay) return true; // no overlay means transition done
      const style = window.getComputedStyle(overlay);
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    },
    null,
    { timeout }
  );

  // Give the page a beat to finish initialization
  await page.waitForTimeout(300);
}

/**
 * Detect what page structure is currently loaded.
 * Returns 'reader' | 'home' | 'user' | 'unknown'.
 */
export async function getPageStructure(page) {
  return page.evaluate(() => {
    // Most reliable signal: body[data-page] is set by the server layout
    const dataPage = document.body.getAttribute('data-page');
    if (dataPage === 'reader' || dataPage === 'home' || dataPage === 'user') {
      return dataPage;
    }
    // Fallback heuristics
    if (window.isUserPage) return 'user';
    if (document.querySelector('.home-grid') || document.querySelector('.homepageShelf')) return 'home';
    if (document.querySelector('#book-content')) return 'reader';
    return 'unknown';
  });
}

/**
 * Run the built-in navigation health check and return results.
 */
export async function runHealthCheck(page) {
  return page.evaluate(() => {
    if (typeof window.checkNavigationHealth === 'function') {
      return window.checkNavigationHealth();
    }
    return { issues: [], warnings: [], info: ['Health check not available'] };
  });
}

/**
 * Assert that health check found no issues.
 */
export function assertHealthy(result) {
  if (result.issues.length > 0) {
    throw new Error(`Health check issues:\n${result.issues.join('\n')}`);
  }
}

/**
 * Get buttonRegistry status.
 */
export async function getRegistryStatus(page) {
  return page.evaluate(() => {
    if (window.buttonRegistry && typeof window.buttonRegistry.getStatus === 'function') {
      return window.buttonRegistry.getStatus();
    }
    return null;
  });
}

/**
 * Get globals relevant to page state.
 */
export async function getPageGlobals(page) {
  return page.evaluate(() => ({
    isUserPage: !!window.isUserPage,
    isOwner: !!window.isOwner,
    csrfToken: !!window.csrfToken,
    dataPage: document.body.getAttribute('data-page'),
  }));
}

/**
 * Get the listener monitor snapshot.
 */
export async function getListenerSnapshot(page) {
  return page.evaluate(() => {
    if (window.__listenerMonitor) {
      return window.__listenerMonitor.snapshot();
    }
    return {};
  });
}

/**
 * Get delta between a previous snapshot and current state.
 */
export async function getListenerDelta(page, prevSnapshot) {
  return page.evaluate((prev) => {
    if (window.__listenerMonitor) {
      return window.__listenerMonitor.delta(prev);
    }
    return {};
  }, prevSnapshot);
}

/**
 * Expected components per page type (mirrors registerComponents.js).
 */
const EXPECTED_COMPONENTS = {
  reader: [
    'logoNav', 'userContainer', 'perimeterButtons', 'settings', 'searchToolbar',
    'editButton', 'sourceButton', 'toc', 'footnoteCitationListeners', 'footnoteTapExtender',
  ],
  home: [
    'logoNav', 'userContainer', 'perimeterButtons', 'settings', 'searchToolbar',
    'newBookButton', 'homepageSearch', 'homepageDisplayUnit', 'homepageBookActions',
  ],
  user: [
    'logoNav', 'userContainer', 'perimeterButtons', 'settings', 'searchToolbar',
    'newBookButton', 'homepageDisplayUnit', 'homepageBookActions',
    'userProfilePage', 'shelfTabs',
  ],
};

/**
 * Assert that the buttonRegistry is healthy for the given page type.
 * Checks currentPage, isInitializing, and that all expected components are active.
 */
export async function assertRegistryHealthy(page, expectedPageType) {
  const status = await getRegistryStatus(page);
  if (!status) throw new Error('buttonRegistry not available');

  const errors = [];

  if (status.currentPage !== expectedPageType) {
    errors.push(`Registry currentPage is "${status.currentPage}", expected "${expectedPageType}"`);
  }

  if (status.isInitializing) {
    errors.push('Registry is still initializing');
  }

  const expected = EXPECTED_COMPONENTS[expectedPageType] || [];
  const missing = expected.filter(name => !status.activeComponents.includes(name));
  if (missing.length > 0) {
    errors.push(`Missing active components: ${missing.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new Error(`Registry health check failed:\n${errors.join('\n')}`);
  }
}

/**
 * Click the first available book link on a home or user page.
 * Book entries are .libraryCard elements containing an <a> with an arrow icon.
 */
export async function clickFirstBookLink(page) {
  // Wait for at least one book card to be rendered
  await page.waitForSelector('.libraryCard a', { timeout: 10000 });
  // Click the first one
  await page.locator('.libraryCard a').first().click();
}

/**
 * Open the logo nav menu if it's currently hidden.
 * On reader/user pages, nav buttons are inside #logoNavMenu which is toggled by #logoContainer.
 */
async function ensureLogoNavOpen(page) {
  const menuVisible = await page.locator('#logoNavMenu:not(.hidden)').isVisible().catch(() => false);
  if (!menuVisible) {
    await page.click('#logoContainer');
    await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 });
  }
}

/**
 * Navigate to the home page via #homeButtonNav.
 * On reader/user pages this is inside the logo nav menu (hidden by default).
 * On home pages the logo itself links home.
 */
export async function navigateToHome(page) {
  const homeButtonVisible = await page.locator('#homeButtonNav').isVisible().catch(() => false);

  if (!homeButtonVisible) {
    // Try opening logo nav menu first (reader/user pages)
    await ensureLogoNavOpen(page);
  }

  await page.click('#homeButtonNav');
}

/**
 * Navigate to the user's own page via the userButton → My Books flow.
 * This is the real SPA path — there's no direct <a> link to /u/username on reader pages.
 *
 * On reader pages, #userButton is hidden inside #logoNavMenu.
 * Must click #logoContainer first to expand the nav menu.
 */
export async function navigateToUserPage(page) {
  const userButtonVisible = await page.locator('#userButton').isVisible().catch(() => false);

  if (!userButtonVisible) {
    await ensureLogoNavOpen(page);
  }

  // Click the user button to open the user container
  await page.click('#userButton');

  // Wait for the "My Books" button to appear in the user container
  await page.waitForSelector('#myBooksBtn', { timeout: 5000 });

  // Click "My Books" to trigger SPA navigation to /u/username
  await page.click('#myBooksBtn');
}

/**
 * Programmatically select text within an element using Range/Selection APIs.
 * More reliable than click-and-drag in contenteditable.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector - CSS selector for the element containing the text
 * @param {number} startOffset - Character offset where selection starts
 * @param {number} endOffset - Character offset where selection ends
 */
export async function selectTextInElement(page, selector, startOffset, endOffset) {
  await page.evaluate(({ selector, startOffset, endOffset }) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);

    // Walk text nodes to find correct start/end positions
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    let charCount = 0;
    let startNode = null, startNodeOffset = 0;
    let endNode = null, endNodeOffset = 0;
    let node;

    while ((node = walker.nextNode())) {
      const nodeLength = node.textContent.length;
      if (!startNode && charCount + nodeLength > startOffset) {
        startNode = node;
        startNodeOffset = startOffset - charCount;
      }
      if (!endNode && charCount + nodeLength >= endOffset) {
        endNode = node;
        endNodeOffset = endOffset - charCount;
        break;
      }
      charCount += nodeLength;
    }

    if (!startNode || !endNode) {
      throw new Error(`Could not find text nodes for offsets ${startOffset}-${endOffset} in "${element.textContent.substring(0, 80)}"`);
    }

    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // Dispatch mouseup to trigger handleSelection (shows hyperlight buttons)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, { selector, startOffset, endOffset });
}

/**
 * Wait for edit mode to be active.
 * Checks window.isEditing === true and #edit-toolbar visibility.
 */
export async function waitForEditMode(page) {
  await page.waitForFunction(() => window.isEditing === true, null, { timeout: 10000 });
  await page.waitForSelector('#edit-toolbar', { state: 'visible', timeout: 5000 });
}

/**
 * Get the current book ID from the page.
 * Returns window.book or falls back to .main-content id.
 */
export async function getCurrentBookId(page) {
  return page.evaluate(() => {
    return window.book || document.querySelector('.main-content')?.id || null;
  });
}

/**
 * Wait for hyperlight buttons to become visible (display: flex).
 * They are hidden with display: none by default and shown when text is selected.
 */
export async function waitForHyperlightButtons(page) {
  await page.waitForFunction(() => {
    const buttons = document.getElementById('hyperlight-buttons');
    return buttons && window.getComputedStyle(buttons).display === 'flex';
  }, null, { timeout: 5000 });
}

/**
 * Close the hyperlit container.
 * Uses JavaScript to click the overlay (bypasses Playwright actionability checks
 * since the overlay may have visibility:hidden timing issues).
 * Falls back to direct DOM class manipulation if click doesn't work.
 */
export async function closeHyperlitContainer(page) {
  // Try clicking the overlay via JavaScript (bypasses visibility check)
  await page.evaluate(() => {
    const overlay = document.getElementById('ref-overlay');
    if (overlay) overlay.click();
  });

  // Wait for the container to lose .open class
  try {
    await page.waitForFunction(() => {
      const container = document.getElementById('hyperlit-container');
      return container && !container.classList.contains('open');
    }, null, { timeout: 5000 });
  } catch {
    // Fallback: force-close via DOM manipulation
    await page.evaluate(() => {
      const container = document.getElementById('hyperlit-container');
      if (container) {
        container.classList.remove('open');
        container.classList.add('hidden');
      }
      const overlay = document.getElementById('ref-overlay');
      if (overlay) overlay.classList.remove('active');
      document.body.classList.remove('hyperlit-container-open');
    });
    await page.waitForTimeout(300);
  }
}

/**
 * Dispatch a synthetic paste event with custom clipboard data.
 * Bypasses system clipboard issues in headless Chromium.
 * @param {import('@playwright/test').Page} page
 * @param {string} htmlContent - HTML content for text/html
 * @param {string} textContent - Plain text content for text/plain
 */
export async function pasteHyperciteContent(page, htmlContent, textContent) {
  await page.evaluate(({ htmlContent, textContent }) => {
    const activeElement = document.activeElement || document.querySelector('.main-content');

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/html', htmlContent);
    dataTransfer.setData('text/plain', textContent);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });

    activeElement.dispatchEvent(pasteEvent);
  }, { htmlContent, textContent });
}

/**
 * Navigate reader→reader via a hypercite link.
 * Clicks a hypercite open-icon (↗) or underlined .couple text to open the
 * hyperlit container, then clicks the citation-link inside it to navigate
 * to the linked book.
 */
export async function navigateViaHypercite(page) {
  // Click the first hypercite arrow link or underlined coupled text
  const hyperciteLink = page.locator('a.open-icon[id^="hypercite_"], u.couple[id^="hypercite_"]').first();
  await hyperciteLink.click();

  // Wait for the hyperlit container to open and the "See in source text" button to appear
  await page.waitForSelector('#hyperlit-container a.see-in-source-btn', { timeout: 10000 });

  // Click "See in source text" to navigate to the other book
  await page.locator('#hyperlit-container a.see-in-source-btn').first().click();
}

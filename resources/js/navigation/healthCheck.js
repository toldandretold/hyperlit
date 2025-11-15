/**
 * Navigation Health Check - Diagnostic tool for detecting resource leaks
 * Usage: window.checkNavigationHealth() in console
 */

export function checkNavigationHealth() {
  const results = {
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    info: []
  };

  // ========================================
  // 1. OVERLAY CHECKS
  // ========================================
  const overlays = document.querySelectorAll('.navigation-overlay');
  const overlayCount = overlays.length;
  results.info.push(`Navigation overlays: ${overlayCount}`);

  if (overlayCount === 0) {
    results.warnings.push('⚠️ No navigation overlay found - may affect loading UX');
  } else if (overlayCount > 2) {
    results.issues.push(`❌ LEAK: ${overlayCount} navigation overlays (expected 1-2)`);
    console.log('Overlay elements:', overlays);
  }

  // Check for visible overlays that should be hidden
  const visibleOverlays = Array.from(overlays).filter(el => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });

  if (visibleOverlays.length > 0) {
    results.issues.push(`❌ ${visibleOverlays.length} overlays are visible (should be hidden)`);
    console.log('Visible overlays:', visibleOverlays);
  }

  // ========================================
  // 2. EVENT LISTENER LEAK DETECTION
  // ========================================

  // Check for duplicate listener flags (indicates multiple bindings)
  const sourceListeners = document.querySelectorAll('[data-source-listener-attached="true"]');
  results.info.push(`Source button listeners: ${sourceListeners.length}`);
  if (sourceListeners.length > 1) {
    results.issues.push(`❌ LEAK: ${sourceListeners.length} source buttons with listeners (expected 1)`);
    console.log('Source buttons:', sourceListeners);
  }

  // Check for multiple instances of critical buttons
  const editButtons = document.querySelectorAll('#editToggle, [data-edit-button]');
  results.info.push(`Edit buttons: ${editButtons.length}`);
  if (editButtons.length > 1) {
    results.issues.push(`❌ LEAK: ${editButtons.length} edit buttons (expected 1)`);
    console.log('Edit buttons:', editButtons);
  }

  // Check for duplicate container managers
  const tocContainers = document.querySelectorAll('#toc-container');
  const hyperlitContainers = document.querySelectorAll('#hyperlit-container');
  const refContainers = document.querySelectorAll('#ref-container');
  const sourceContainers = document.querySelectorAll('#source-container');

  results.info.push(`Container counts: TOC=${tocContainers.length}, Hyperlit=${hyperlitContainers.length}, Ref=${refContainers.length}, Source=${sourceContainers.length}`);

  if (tocContainers.length > 1) {
    results.issues.push(`❌ LEAK: ${tocContainers.length} TOC containers (expected 1)`);
  }
  if (hyperlitContainers.length > 1) {
    results.issues.push(`❌ LEAK: ${hyperlitContainers.length} hyperlit containers (expected 1)`);
  }
  if (refContainers.length > 1) {
    results.issues.push(`❌ LEAK: ${refContainers.length} reference containers (expected 1)`);
  }
  if (sourceContainers.length > 1) {
    results.issues.push(`❌ LEAK: ${sourceContainers.length} source containers (expected 1)`);
  }

  // ========================================
  // 3. LAZY LOADER CHECKS
  // ========================================
  const lazyLoaderContainers = document.querySelectorAll('[data-lazy-loader]');
  const sentinels = document.querySelectorAll('[id$="-top-sentinel"], [id$="-bottom-sentinel"]');

  results.info.push(`Lazy loader containers: ${lazyLoaderContainers.length}`);
  results.info.push(`Sentinels: ${sentinels.length}`);

  if (lazyLoaderContainers.length > 1) {
    results.warnings.push(`⚠️ Multiple lazy loader containers: ${lazyLoaderContainers.length} (expected 1)`);
  }

  if (sentinels.length > 2) {
    results.warnings.push(`⚠️ Orphaned sentinels: ${sentinels.length} (expected 2: top + bottom)`);
    console.log('Sentinels:', sentinels);
  }

  // ========================================
  // 4. STYLE TAG POLLUTION
  // ========================================
  const styles = document.querySelectorAll('style');
  const navOverlayStyles = document.getElementById('navigation-overlay-styles');
  results.info.push(`Total <style> tags: ${styles.length}`);
  results.info.push(`Navigation overlay styles: ${navOverlayStyles ? 'present' : 'missing'}`);

  if (styles.length > 100) {
    results.warnings.push(`⚠️ High style tag count: ${styles.length} (potential memory leak)`);
  }

  // Check for duplicate style IDs
  const styleIds = Array.from(styles)
    .map(s => s.id)
    .filter(Boolean);
  const duplicateStyles = styleIds.filter((id, idx) => styleIds.indexOf(id) !== idx);
  if (duplicateStyles.length > 0) {
    results.issues.push(`❌ Duplicate style IDs: ${[...new Set(duplicateStyles)].join(', ')}`);
  }

  // ========================================
  // 5. DUPLICATE ID DETECTION
  // ========================================
  const ids = {};
  document.querySelectorAll('[id]').forEach(el => {
    if (ids[el.id]) {
      ids[el.id]++;
    } else {
      ids[el.id] = 1;
    }
  });

  const duplicates = Object.entries(ids).filter(([_, count]) => count > 1);
  if (duplicates.length > 0) {
    results.issues.push(`❌ Duplicate IDs found: ${duplicates.map(([id, count]) => `${id}(${count})`).join(', ')}`);
  }

  // ========================================
  // 6. MARK ELEMENT POLLUTION
  // ========================================
  const marks = document.querySelectorAll('mark');
  const hyperlinks = document.querySelectorAll('a[href*="HL_"]');
  results.info.push(`Highlight marks: ${marks.length}`);
  results.info.push(`Hyperlight links: ${hyperlinks.length}`);

  // ========================================
  // 7. GLOBAL VARIABLE CHECKS
  // ========================================
  if (window.NavigationManager?.navigationCount) {
    results.info.push(`SPA transitions completed: ${window.NavigationManager.navigationCount}`);
  }

  // Check for orphaned global listeners
  const globalChecks = {
    'window.currentLazyLoader': typeof window.currentLazyLoader !== 'undefined',
    'window.nodes': typeof window.nodes !== 'undefined',
    'window.book': typeof window.book !== 'undefined'
  };

  Object.entries(globalChecks).forEach(([name, exists]) => {
    results.info.push(`${name}: ${exists ? '✓' : '✗'}`);
  });

  // ========================================
  // 8. MEMORY ESTIMATION
  // ========================================
  if (performance.memory) {
    const memoryMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(2);
    const totalMB = (performance.memory.totalJSHeapSize / 1048576).toFixed(2);
    results.info.push(`JS Heap: ${memoryMB}MB / ${totalMB}MB`);

    if (performance.memory.usedJSHeapSize > 200 * 1048576) {
      results.warnings.push(`⚠️ High memory usage: ${memoryMB}MB`);
    }
  }

  // ========================================
  // 9. DOM NODE COUNT
  // ========================================
  const allElements = document.querySelectorAll('*').length;
  results.info.push(`Total DOM nodes: ${allElements}`);

  if (allElements > 5000) {
    results.warnings.push(`⚠️ High DOM node count: ${allElements} (may impact performance)`);
  }

  // ========================================
  // 10. ORPHANED TOOLBARS/BUTTONS
  // ========================================
  const editToolbars = document.querySelectorAll('#edit-toolbar');
  const undoButtons = document.querySelectorAll('#undoButton');
  const redoButtons = document.querySelectorAll('#redoButton');

  results.info.push(`Edit toolbars: ${editToolbars.length}`);

  if (editToolbars.length > 1) {
    results.issues.push(`❌ LEAK: ${editToolbars.length} edit toolbars (expected 1)`);
  }
  if (undoButtons.length > 1) {
    results.issues.push(`❌ LEAK: ${undoButtons.length} undo buttons (expected 1)`);
  }
  if (redoButtons.length > 1) {
    results.issues.push(`❌ LEAK: ${redoButtons.length} redo buttons (expected 1)`);
  }

  // ========================================
  // 11. EVENT LISTENER COUNTING (Chrome only)
  // ========================================
  if (typeof getEventListeners === 'function') {
    // This function is only available in Chrome DevTools console
    try {
      const body = document.body;
      const bodyListeners = getEventListeners(body);
      const listenerCounts = {};

      Object.entries(bodyListeners).forEach(([event, listeners]) => {
        listenerCounts[event] = listeners.length;
      });

      results.info.push(`Body event listeners: ${JSON.stringify(listenerCounts)}`);

      // Check specific critical elements
      const editButton = document.getElementById('editToggle');
      if (editButton) {
        const editListeners = getEventListeners(editButton);
        const clickCount = editListeners.click?.length || 0;
        results.info.push(`Edit button click listeners: ${clickCount}`);
        if (clickCount > 2) {
          results.warnings.push(`⚠️ Edit button has ${clickCount} click listeners (expected 1-2)`);
        }
      }
    } catch (e) {
      // getEventListeners available but failed
    }
  }

  // ========================================
  // 12. INTERSECTION OBSERVER CHECKS
  // ========================================
  // We can't directly count observers, but we can check for orphaned sentinel elements
  const allSentinels = document.querySelectorAll('[id*="sentinel"]');
  if (allSentinels.length > 2) {
    results.warnings.push(`⚠️ Found ${allSentinels.length} sentinel elements (expected 2)`);
  }

  // ========================================
  // 13. MUTATION OBSERVER HINTS
  // ========================================
  // Check for elements that typically have mutation observers
  const contentEditables = document.querySelectorAll('[contenteditable="true"]');

  // Filter out expected contenteditable elements (hyperlit container, annotations)
  const mainContentEditables = Array.from(contentEditables).filter(el => {
    // Expected: highlight text and annotations in hyperlit-container
    if (el.closest('#hyperlit-container')) return false;

    // Expected: main book content when in edit mode
    if (el.classList.contains('main-content')) return true;

    return true;
  });

  results.info.push(`Contenteditable elements: ${contentEditables.length} (${mainContentEditables.length} in main content)`);

  // Only warn if we have multiple main content editables (actual leak)
  if (mainContentEditables.length > 1) {
    results.warnings.push(`⚠️ Multiple main contenteditable elements: ${mainContentEditables.length} (may have duplicate mutation observers)`);
    console.log('Main contenteditable elements:', mainContentEditables);
  }

  // ========================================
  // 14. BROADCAST CHANNEL CHECKS
  // ========================================
  // Can't directly check BroadcastChannels, but we can look for indicators
  results.info.push(`BroadcastChannel supported: ${typeof BroadcastChannel !== 'undefined' ? '✓' : '✗'}`);

  // Generate report
  console.log('\n=== 🏥 Navigation Health Check ===\n');

  if (results.issues.length === 0 && results.warnings.length === 0) {
    console.log('✅ All systems healthy!');
  } else {
    if (results.issues.length > 0) {
      console.error('🔴 ISSUES FOUND:');
      results.issues.forEach(issue => console.error(issue));
    }
    if (results.warnings.length > 0) {
      console.warn('⚠️ WARNINGS:');
      results.warnings.forEach(warning => console.warn(warning));
    }
  }

  console.log('\nℹ️ INFO:');
  results.info.forEach(info => console.log(info));

  console.log('\n=================================\n');

  // Store results for comparison
  if (typeof window !== 'undefined') {
    window._lastHealthCheck = results;
  }

  return results;
}

/**
 * Compare current health with a previous snapshot
 */
export function compareHealth(previous) {
  if (!previous) {
    previous = window._lastHealthCheck;
  }

  if (!previous) {
    console.warn('⚠️ No previous health check to compare. Run window.checkNavigationHealth() first.');
    return;
  }

  const current = checkNavigationHealth();

  console.log('\n=== 📊 Health Comparison ===\n');

  // Compare issue counts
  const issuesDelta = current.issues.length - previous.issues.length;
  const warningsDelta = current.warnings.length - previous.warnings.length;

  if (issuesDelta > 0) {
    console.error(`🔴 +${issuesDelta} new issues since last check`);
  } else if (issuesDelta < 0) {
    console.log(`✅ ${Math.abs(issuesDelta)} issues resolved since last check`);
  }

  if (warningsDelta > 0) {
    console.warn(`⚠️ +${warningsDelta} new warnings since last check`);
  } else if (warningsDelta < 0) {
    console.log(`✅ ${Math.abs(warningsDelta)} warnings resolved since last check`);
  }

  console.log('\n=================================\n');

  return { previous, current, issuesDelta, warningsDelta };
}

/**
 * Monitor health over time and alert on degradation
 */
export function startHealthMonitoring(intervalSeconds = 30) {
  console.log(`🏥 Starting health monitoring (checking every ${intervalSeconds}s)`);

  let baseline = checkNavigationHealth();
  let checkCount = 0;

  const monitor = setInterval(() => {
    checkCount++;
    const current = checkNavigationHealth();

    const newIssues = current.issues.filter(i => !baseline.issues.includes(i));
    const newWarnings = current.warnings.filter(w => !baseline.warnings.includes(w));

    if (newIssues.length > 0 || newWarnings.length > 0) {
      console.error(`\n🚨 HEALTH DEGRADATION DETECTED (check #${checkCount}):`);
      if (newIssues.length > 0) {
        console.error('New issues:', newIssues);
      }
      if (newWarnings.length > 0) {
        console.warn('New warnings:', newWarnings);
      }
    }

    // Update baseline every 10 checks if no issues
    if (checkCount % 10 === 0 && current.issues.length === 0) {
      baseline = current;
      console.log(`✅ Health baseline updated (check #${checkCount})`);
    }
  }, intervalSeconds * 1000);

  // Return function to stop monitoring
  return () => {
    clearInterval(monitor);
    console.log('🏥 Health monitoring stopped');
  };
}

/**
 * Find and display duplicate IDs with full details
 */
export function findDuplicateIds() {
  const ids = {};
  document.querySelectorAll('[id]').forEach(el => {
    if (!ids[el.id]) {
      ids[el.id] = [];
    }
    ids[el.id].push(el);
  });

  const duplicates = Object.entries(ids).filter(([_, elements]) => elements.length > 1);

  if (duplicates.length === 0) {
    console.log('✅ No duplicate IDs found');
    return;
  }

  console.log(`\n🔍 Found ${duplicates.length} duplicate ID(s):\n`);

  duplicates.forEach(([id, elements]) => {
    console.group(`ID: "${id}" (${elements.length} instances)`);
    elements.forEach((el, idx) => {
      console.log(`Instance ${idx + 1}:`, {
        element: el,
        tagName: el.tagName,
        classes: el.className,
        parent: el.parentElement?.tagName,
        inSvg: !!el.closest('svg'),
        visible: el.offsetParent !== null,
        location: getElementPath(el)
      });
    });
    console.groupEnd();
  });

  return duplicates;
}

/**
 * Find and display duplicate contenteditable elements
 */
export function findContentEditables() {
  const editables = document.querySelectorAll('[contenteditable="true"]');

  console.log(`\n🔍 Found ${editables.length} contenteditable element(s):\n`);

  editables.forEach((el, idx) => {
    console.log(`Contenteditable ${idx + 1}:`, {
      element: el,
      id: el.id,
      tagName: el.tagName,
      classes: el.className,
      visible: el.offsetParent !== null,
      location: getElementPath(el),
      textLength: el.textContent.length
    });
  });

  if (editables.length > 1) {
    console.warn('⚠️ Multiple contenteditable elements detected - potential mutation observer leak');
  }

  return editables;
}

/**
 * Helper: Get DOM path to element
 */
function getElementPath(el) {
  const path = [];
  let current = el;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
    } else if (current.className) {
      selector += `.${Array.from(current.classList).join('.')}`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(' > ');
}

/**
 * Stress test helper - navigate rapidly and check health
 */
export async function stressTestNavigation(iterations = 20) {
  console.log(`🏋️ Starting stress test (${iterations} iterations)...`);

  const baseline = checkNavigationHealth();

  for (let i = 0; i < iterations; i++) {
    console.log(`Iteration ${i + 1}/${iterations}`);

    // Trigger a health check every 5 iterations
    if (i % 5 === 0 && i > 0) {
      const current = checkNavigationHealth();
      const issuesDelta = current.issues.length - baseline.issues.length;

      if (issuesDelta > 0) {
        console.error(`❌ Stress test FAILED at iteration ${i}: ${issuesDelta} new issues detected`);
        compareHealth(baseline);
        return false;
      }
    }

    // Wait for any pending transitions to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n✅ Stress test PASSED: No leaks detected');
  compareHealth(baseline);
  return true;
}

// Make everything globally accessible for console debugging
if (typeof window !== 'undefined') {
  window.checkNavigationHealth = checkNavigationHealth;
  window.compareHealth = compareHealth;
  window.startHealthMonitoring = startHealthMonitoring;
  window.stressTestNavigation = stressTestNavigation;
  window.findDuplicateIds = findDuplicateIds;
  window.findContentEditables = findContentEditables;
}

// Auto-run health check every 50 transitions in development
if (import.meta.env?.DEV) {
  let lastCheck = 0;

  setInterval(() => {
    if (window.NavigationManager?.navigationCount > 0) {
      const count = window.NavigationManager.navigationCount;

      if (count % 50 === 0 && count !== lastCheck) {
        lastCheck = count;
        console.log(`🏥 Auto health check after ${count} transitions:`);
        checkNavigationHealth();
      }
    }
  }, 5000);
}

/**
 * Edit Session Manager
 * Central registry for active editing sessions with built-in diagnostics
 */

// Session state
let activeSession = null;
let sessionHistory = []; // For debugging last 10 sessions
const MAX_HISTORY = 10;

// Debug flag - set true to enable console diagnostics
const DEBUG = true;

/**
 * Log with context - minimal console output
 */
function log(action, details = {}) {
  if (!DEBUG) return;
  const sessionInfo = activeSession ? 
    `${activeSession.containerId} (${activeSession.bookId})` : 'none';
  console.log(`[EditSession] ${action} | Active: ${sessionInfo}`, details);
}

/**
 * Register a new edit session
 * Automatically preempts any existing session
 */
export async function registerEditSession(containerId, divElement, bookId) {
  // Check for existing session
  if (activeSession && activeSession.containerId !== containerId) {
    log('PREEMPT', { from: activeSession.containerId, to: containerId });
    
    // Stop the current observer (await to ensure flush completes)
    const { stopObserving } = await import('./index.js');
    await stopObserving();
    
    // Record preemption for diagnostics
    recordEvent('preempt', {
      previous: activeSession.containerId,
      new: containerId,
      previousBookId: activeSession.bookId,
      newBookId: bookId
    });
  }
  
  // Register new session
  activeSession = {
    containerId,
    divElement,
    bookId,
    startTime: Date.now(),
    mutations: 0 // Track mutation count for diagnostics
  };
  
  log('START', { containerId, bookId });
  recordEvent('start', { containerId, bookId });
}

/**
 * Unregister current session
 */
export function unregisterEditSession(containerId) {
  if (!activeSession || activeSession.containerId !== containerId) {
    log('WARN: Unregister mismatch', { requested: containerId, active: activeSession?.containerId });
    return;
  }
  
  const duration = Date.now() - activeSession.startTime;
  log('END', { containerId, duration: `${duration}ms`, mutations: activeSession.mutations });
  recordEvent('end', { containerId, duration, mutations: activeSession.mutations });
  
  activeSession = null;
}

/**
 * Get current active session
 */
export function getActiveEditSession() {
  return activeSession;
}

/**
 * Check if specific container is currently editing
 */
export function isContainerEditing(containerId) {
  return activeSession?.containerId === containerId;
}

/**
 * Record event for history tracking
 */
function recordEvent(type, data) {
  sessionHistory.push({
    type,
    timestamp: Date.now(),
    ...data
  });
  
  // Keep only last N events
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory = sessionHistory.slice(-MAX_HISTORY);
  }
}

/**
 * DIAGNOSTIC: Verify mutations are from correct container
 * Call this from MutationObserver callback
 */
export function verifyMutationSource(mutation) {
  if (!activeSession) {
    console.warn('[EditSession] 🚨 REJECTED: No active session for mutation on', mutation.target?.id || mutation.target?.nodeName);
    return false;
  }
  
  const target = mutation.target;
  const isInActiveDiv = activeSession.divElement?.contains(target);
  
  if (!isInActiveDiv) {
    // This is the KEY TEST - if we see this, isolation FAILED
    const leakInfo = {
      mutationType: mutation.type,
      targetId: target.id || target.nodeName,
      targetText: target.textContent?.substring(0, 50), // Show what content was modified
      activeContainer: activeSession.containerId,
      activeBook: activeSession.bookId,
      timestamp: new Date().toISOString()
    };
    
    console.error('[EditSession] 🚨🚨🚨 ISOLATION BREACH 🚨🚨🚨', leakInfo);
    console.error('[EditSession] Mutation from WRONG CONTAINER was detected!');
    
    // Record leak for analysis
    recordEvent('isolation_breach', leakInfo);
    
    return false;
  }
  
  // Mutation accepted - log occasionally for verification
  const shouldLog = activeSession.mutations === 0 || activeSession.mutations % 20 === 0;
  if (shouldLog) {
    console.log(`[EditSession] ✓ ACCEPTED mutation #${activeSession.mutations} in ${activeSession.containerId} (${mutation.type} on ${target.id || target.nodeName})`);
  }
  
  // Track mutation count
  activeSession.mutations++;
  
  return true;
}

/**
 * DIAGNOSTIC: Check if event target is in active edit div
 * Use for selectionchange, input events, etc.
 */
export function isEventInActiveDiv(eventTarget) {
  if (!activeSession) return false;
  return activeSession.divElement?.contains(eventTarget);
}

/**
 * DIAGNOSTIC: Print session history
 */
export function printSessionHistory() {
  console.log('[EditSession] === HISTORY (last ' + MAX_HISTORY + ') ===');
  sessionHistory.forEach((event, i) => {
    const time = new Date(event.timestamp).toLocaleTimeString();
    console.log(`  ${i + 1}. [${time}] ${event.type}:`, 
      JSON.stringify(event, null, 2).slice(0, 100) + '...');
  });
  console.log('[EditSession] Active:', activeSession || 'none');
}

/**
 * DIAGNOSTIC: Force-leak test
 * Call from console to test if main-content can leak while hyperlit is active
 */
export function forceLeakTest() {
  const mainContent = document.getElementById('main-content');
  const testP = mainContent?.querySelector('p');
  
  if (!testP) {
    console.log('[EditSession] ⚠️ No paragraph found for test');
    return;
  }
  
  const originalText = testP.textContent;
  testP.textContent = `[LEAK TEST ${Date.now()}]`;
  
  console.log('[EditSession] 🧪 Leak test: Modified main-content paragraph');
  console.log('[EditSession] 🧪 Check console for "MUTATION LEAK" errors...');
  
  // Restore after 2 seconds
  setTimeout(() => {
    testP.textContent = originalText;
    console.log('[EditSession] 🧪 Test complete. If no leak errors above, isolation is working!');
  }, 2000);
}

/**
 * DIAGNOSTIC: Get diagnostic report
 */
export function getDiagnosticReport() {
  const report = {
    activeSession: activeSession ? {
      containerId: activeSession.containerId,
      bookId: activeSession.bookId,
      startTime: new Date(activeSession.startTime).toISOString(),
      duration: Date.now() - activeSession.startTime,
      mutations: activeSession.mutations
    } : null,
    recentHistory: sessionHistory.slice(-5),
    summary: {
      totalEvents: sessionHistory.length,
      preemptions: sessionHistory.filter(e => e.type === 'preempt').length,
      leaks: sessionHistory.filter(e => e.type === 'leak').length
    }
  };
  
  console.log('[EditSession] Diagnostic Report:', report);
  return report;
}

// Expose diagnostics to window for console access
if (typeof window !== 'undefined') {
  window.editSessionDiagnostics = {
    getActiveSession: getActiveEditSession,
    printHistory: printSessionHistory,
    forceLeakTest,
    getReport: getDiagnosticReport
  };
  
  console.log('[EditSession] 🔧 Diagnostics available: window.editSessionDiagnostics');
  console.log('[EditSession] 🔧 Try: window.editSessionDiagnostics.forceLeakTest()');
}

/**
 * Edit Session Manager
 * Central registry for active editing sessions with built-in diagnostics
 */
import type { BookId } from '../utilities/idHelpers';
import { log } from '../utilities/logger';

interface EditSession {
  containerId: string;
  divElement: HTMLElement;
  /** Sub-book id, or null for the main-book session. */
  bookId: BookId | null;
  startTime: number;
  mutations: number;
}

// Session state
let activeSession: EditSession | null = null;
let sessionHistory: any[] = []; // For debugging last 10 sessions
const MAX_HISTORY = 10;

// Injected preempt-stop (set by ./index at module load) — avoids a dynamic
// import('./index') inside registerEditSession, which created an index↔session cycle.
let preemptStop: (() => Promise<void>) | null = null;

/**
 * Inject the observer-stop used to preempt a previous session.
 * Called once by ./index so this module never imports back from index.
 */
export function setPreemptStop(fn: () => Promise<void>): void {
  preemptStop = fn;
}

/**
 * Register a new edit session
 * Automatically preempts any existing session
 */
export async function registerEditSession(containerId: string, divElement: HTMLElement, bookId: BookId | null): Promise<void> {
  // Check for existing session
  if (activeSession && activeSession.containerId !== containerId) {
    // Stop the current observer (await to ensure flush completes)
    await preemptStop?.();

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

  recordEvent('start', { containerId, bookId });
}

/**
 * Unregister current session
 */
export function unregisterEditSession(containerId: string): void {
  if (!activeSession || activeSession.containerId !== containerId) {
    return;
  }

  const duration = Date.now() - activeSession.startTime;
  recordEvent('end', { containerId, duration, mutations: activeSession.mutations });

  activeSession = null;
}

/**
 * Get current active session
 */
export function getActiveEditSession(): EditSession | null {
  return activeSession;
}

/**
 * Check if specific container is currently editing
 */
export function isContainerEditing(containerId: string): boolean {
  return activeSession?.containerId === containerId;
}

/**
 * Record event for history tracking
 */
function recordEvent(type: string, data: any): void {
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
export function verifyMutationSource(mutation: any): boolean {
  if (!activeSession) {
    return false;
  }

  const target = mutation.target;
  const isInActiveDiv = activeSession.divElement?.contains(target);

  if (!isInActiveDiv) {
    // Ghost mutation: node was removed from the DOM by contenteditable restructuring
    if (!target.isConnected) {
      return false;  // Skip silently — not a real breach
    }

    // Genuine isolation breach — node is still in the DOM but in the wrong container
    const leakInfo = {
      mutationType: mutation.type,
      targetId: target.id || target.nodeName,
      targetText: target.textContent?.substring(0, 50), // Show what content was modified
      activeContainer: activeSession.containerId,
      activeBook: activeSession.bookId,
      timestamp: new Date().toISOString()
    };

    log.error('[EditSession] ISOLATION BREACH: Mutation from WRONG CONTAINER was detected!', 'divEditor/editSessionManager.js', leakInfo);

    // Record leak for analysis
    recordEvent('isolation_breach', leakInfo);

    return false;
  }

  // Track mutation count
  activeSession.mutations++;

  return true;
}

/**
 * DIAGNOSTIC: Check if event target is in active edit div
 * Use for selectionchange, input events, etc.
 */
export function isEventInActiveDiv(eventTarget: Node | null): boolean {
  if (!activeSession) return false;
  return !!activeSession.divElement?.contains(eventTarget);
}

/**
 * Centralized Logging Utility for Hyperlit
 *
 * Purpose: Provide clean, minimal console output that helps developers understand
 * the logical flow of the application without drowning in verbose details.
 *
 * Features:
 * - Color-coded log levels (INIT, NAV, CONTENT, USER, ERROR)
 * - Full folder paths for easy file location
 * - Verbose mode toggle for debugging
 * - Production mode silencing
 *
 * Usage:
 *   import { log } from './utilities/logger';
 *   log.init('Database initialized', '/indexedDB/index');
 *   log.nav('Fresh page load pathway', '/navigation/NavigationManager.js');
 *   log.content('First chunk rendered (50 nodes)', 'lazyLoaderFactory.js');
 *   log.user('Text selected', '/hyperlights/selection.js');
 *   log.error('Failed to load book', 'initializePage.js', error);
 *
 * RULES (the verbose-mode tab-hang was real — see the noNewConsole review gate):
 * - NEVER call log.* or verbose.* — or build their arguments — in per-event /
 *   per-entry / per-mutation / per-iteration code (scroll or input handlers,
 *   IntersectionObserver/MutationObserver callbacks, sort comparators, per-node
 *   loops). Log state TRANSITIONS or per-flush summaries with counts instead.
 * - If a log's arguments are expensive to build (joins over big collections,
 *   JSON.stringify of large objects, DOM serialization), guard the whole
 *   statement with `if (isVerboseEnabled())` — arguments are evaluated even
 *   when the log itself is gated off.
 */

// Verbose flag is cached at module load and kept in sync by
// logger.enableVerbose()/disableVerbose() — reading localStorage on every log
// call is a synchronous storage hit in hot paths.
const readVerboseFlag = () => {
  try {
    return localStorage.getItem('hyperlit_verbose_logs') === 'true';
  } catch (e) {
    return false;
  }
};

let verboseCache = readVerboseFlag();

/**
 * Raw cached verbose-mode boolean (no console output, unlike logger.isVerbose()).
 * Use it to guard log statements whose ARGUMENTS are expensive to build.
 */
export const isVerboseEnabled = () => verboseCache;

// Production mode (silence all logs except errors) — hostname can't change
// mid-page, so compute once.
const IS_PROD =
  (import.meta as any).env?.MODE === 'production' ||
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost');

// ANSI color codes for console styling
const colors = {
  INIT: '#3B82F6',    // Blue - Initialization
  NAV: '#8B5CF6',     // Purple - Navigation
  CONTENT: '#10B981', // Green - Content/Data loading
  USER: '#F59E0B',    // Orange - User interactions
  ERROR: '#EF4444'    // Red - Errors
};

// Cheap HH:MM:SS.mmm timestamp (an Intl formatter per call is far too heavy).
const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n);
function formatTimestamp() {
  const d = new Date();
  const ms = d.getMilliseconds();
  const mmm = ms < 10 ? '00' + ms : ms < 100 ? '0' + ms : '' + ms;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${mmm}`;
}

/**
 * Core logging function
 * @param {string} level - Log level (INIT, NAV, CONTENT, USER, ERROR)
 * @param {string} message - The log message
 * @param {string} filePath - File path relative to resources/js/ (e.g., '/navigation/NavigationManager.js')
 * @param {*} details - Optional additional details (objects, errors, etc.)
 * @param {boolean} forceShow - Force show even in non-verbose mode
 */
function logMessage(level: any, message: any, filePath: any, details: unknown = null, forceShow = false) {
  // In production, only show errors
  if (IS_PROD && level !== 'ERROR') {
    return;
  }

  // In normal mode, only show if forced or if verbose mode is enabled
  if (!forceShow && !verboseCache && level !== 'ERROR') {
    // Skip verbose logs in normal mode
    return;
  }

  const color = (colors as any)[level] || '#6B7280';

  // Errors must emit via console.error so DevTools filters and the e2e
  // console-error gates (which only capture error-type messages) catch them.
  const emit = level === 'ERROR' ? console.error : console.log;

  // Format: HH:MM:SS.mmm [LEVEL] Message (filePath)
  emit(
    `%c${formatTimestamp()} %c[${level}]%c ${message} %c(${filePath})`,
    'color: #6B7280',
    `color: ${color}; font-weight: bold`,
    'color: inherit',
    'color: #6B7280; font-style: italic'
  );

  // If details provided, log them separately
  if (details !== null && details !== undefined) {
    emit('  └─', details);
  }
}

/**
 * Checkpoint logging - ALWAYS shown (major checkpoints only)
 * Use sparingly for critical initialization/navigation steps
 */
export const log = {
  /**
   * Initialization checkpoints (database, modules, components)
   */
  init: (message: any, filePath: any, details: unknown = null) => {
    logMessage('INIT', message, filePath, details, true);
  },

  /**
   * Navigation checkpoints (page loads, transitions, routing)
   */
  nav: (message: any, filePath: any, details: unknown = null) => {
    logMessage('NAV', message, filePath, details, true);
  },

  /**
   * Content/data loading checkpoints (chunks, books, data sync)
   */
  content: (message: any, filePath: any, details: unknown = null) => {
    logMessage('CONTENT', message, filePath, details, true);
  },

  /**
   * User interaction checkpoints (selections, clicks, pastes)
   */
  user: (message: any, filePath: any, details: unknown = null) => {
    logMessage('USER', message, filePath, details, true);
  },

  /**
   * Error logging (ALWAYS shown, even in production)
   */
  error: (message: any, filePath: any, error: unknown = null) => {
    logMessage('ERROR', message, filePath, error, true);

    // Also log full error stack if provided
    if (error && (error as any).stack) {
      console.error('Stack trace:', (error as any).stack);
    }
  }
};

/**
 * Verbose logging - only shown when verbose mode is enabled
 * Use for debugging details that clutter normal operation
 * (NEVER in per-event/per-entry/per-iteration code — see RULES above)
 */
export const verbose = {
  init: (message: any, filePath: any, details: unknown = null) => {
    logMessage('INIT', message, filePath, details, false);
  },

  nav: (message: any, filePath: any, details: unknown = null) => {
    logMessage('NAV', message, filePath, details, false);
  },

  content: (message: any, filePath: any, details: unknown = null) => {
    logMessage('CONTENT', message, filePath, details, false);
  },

  user: (message: any, filePath: any, details: unknown = null) => {
    logMessage('USER', message, filePath, details, false);
  },

  debug: (message: any, filePath: any, details: unknown = null) => {
    if (verboseCache) {
      console.log(`[DEBUG] ${message} (${filePath})`, details || '');
    }
  }
};

/**
 * Utility functions for developers
 */
export const logger = {
  /**
   * Enable verbose logging (effective immediately, persists via localStorage)
   */
  enableVerbose: () => {
    try {
      localStorage.setItem('hyperlit_verbose_logs', 'true');
      verboseCache = true;
      console.log('%c[LOGGER] Verbose mode enabled (effective immediately).', 'color: #10B981; font-weight: bold');
    } catch (e) {
      console.error('Failed to enable verbose mode:', e);
    }
  },

  /**
   * Disable verbose logging (effective immediately)
   */
  disableVerbose: () => {
    try {
      localStorage.removeItem('hyperlit_verbose_logs');
      verboseCache = false;
      console.log('%c[LOGGER] Verbose mode disabled (effective immediately).', 'color: #6B7280; font-weight: bold');
    } catch (e) {
      console.error('Failed to disable verbose mode:', e);
    }
  },

  /**
   * Check current verbose mode status
   */
  isVerbose: () => {
    console.log(`%c[LOGGER] Verbose mode: ${verboseCache ? 'ENABLED' : 'DISABLED'}`,
      verboseCache ? 'color: #10B981; font-weight: bold' : 'color: #6B7280');
    return verboseCache;
  },

  /**
   * Show help
   */
  help: () => {
    console.log(`%c
╔═══════════════════════════════════════════════════════════╗
║           Hyperlit Logger - Developer Guide               ║
╚═══════════════════════════════════════════════════════════╝

📖 USAGE:
  import { log, verbose } from './utilities/logger';

  // Checkpoint logs (always shown):
  log.init('Database initialized', '/indexedDB/index');
  log.nav('Fresh page load', '/navigation/NavigationManager.js');
  log.content('First chunk rendered', 'lazyLoaderFactory.js');
  log.user('Text selected', '/hyperlights/selection.js');
  log.error('Failed to load', 'initializePage.js', error);

  // Verbose logs (only in verbose mode):
  verbose.init('Detailed step...', '/path/to/file.js');

🔧 DEVELOPER COMMANDS:
  logger.enableVerbose()   - Enable verbose logging (instant)
  logger.disableVerbose()  - Disable verbose logging (instant)
  logger.isVerbose()       - Check current mode
  logger.help()            - Show this help

💡 TIP: Use verbose.* for debugging details that clutter
       normal operation. Use log.* sparingly for major
       checkpoints only. NEVER log per event/entry/mutation —
       log state transitions or per-flush summaries instead.
    `, 'color: #3B82F6');
  }
};

// Make logger utilities globally available for debugging
if (typeof window !== 'undefined') {
  (window as any).logger = logger;
}

// Startup banner is now in app.js to ensure it runs first

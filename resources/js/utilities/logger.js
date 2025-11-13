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
 *   import { log } from './utilities/logger.js';
 *   log.init('Database initialized', '/indexedDB/index.js');
 *   log.nav('Fresh page load pathway', '/navigation/NavigationManager.js');
 *   log.content('First chunk rendered (50 nodes)', 'lazyLoaderFactory.js');
 *   log.user('Text selected', '/hyperlights/selection.js');
 *   log.error('Failed to load book', 'initializePage.js', error);
 */

// Check if verbose mode is enabled
const isVerboseMode = () => {
  try {
    return localStorage.getItem('hyperlit_verbose_logs') === 'true';
  } catch (e) {
    return false;
  }
};

// Check if we're in production mode (silence all logs except errors)
const isProductionMode = () => {
  return import.meta.env?.MODE === 'production' || window.location.hostname !== 'localhost';
};

// ANSI color codes for console styling
const colors = {
  INIT: '#3B82F6',    // Blue - Initialization
  NAV: '#8B5CF6',     // Purple - Navigation
  CONTENT: '#10B981', // Green - Content/Data loading
  USER: '#F59E0B',    // Orange - User interactions
  ERROR: '#EF4444'    // Red - Errors
};

/**
 * Core logging function
 * @param {string} level - Log level (INIT, NAV, CONTENT, USER, ERROR)
 * @param {string} message - The log message
 * @param {string} filePath - File path relative to resources/js/ (e.g., '/navigation/NavigationManager.js')
 * @param {*} details - Optional additional details (objects, errors, etc.)
 * @param {boolean} forceShow - Force show even in non-verbose mode
 */
function logMessage(level, message, filePath, details = null, forceShow = false) {
  // In production, only show errors
  if (isProductionMode() && level !== 'ERROR') {
    return;
  }

  // In normal mode, only show if forced or if verbose mode is enabled
  if (!forceShow && !isVerboseMode() && level !== 'ERROR') {
    // Skip verbose logs in normal mode
    return;
  }

  const color = colors[level] || '#6B7280';
  const timestamp = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });

  // Format: [LEVEL] Message (filePath)
  console.log(
    `%c[${level}]%c ${message} %c(${filePath})`,
    `color: ${color}; font-weight: bold`,
    'color: inherit',
    'color: #6B7280; font-style: italic'
  );

  // If details provided, log them separately
  if (details !== null && details !== undefined) {
    console.log('  └─', details);
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
  init: (message, filePath, details = null) => {
    logMessage('INIT', message, filePath, details, true);
  },

  /**
   * Navigation checkpoints (page loads, transitions, routing)
   */
  nav: (message, filePath, details = null) => {
    logMessage('NAV', message, filePath, details, true);
  },

  /**
   * Content/data loading checkpoints (chunks, books, data sync)
   */
  content: (message, filePath, details = null) => {
    logMessage('CONTENT', message, filePath, details, true);
  },

  /**
   * User interaction checkpoints (selections, clicks, pastes)
   */
  user: (message, filePath, details = null) => {
    logMessage('USER', message, filePath, details, true);
  },

  /**
   * Error logging (ALWAYS shown, even in production)
   */
  error: (message, filePath, error = null) => {
    logMessage('ERROR', message, filePath, error, true);

    // Also log full error stack if provided
    if (error && error.stack) {
      console.error('Stack trace:', error.stack);
    }
  }
};

/**
 * Verbose logging - only shown when verbose mode is enabled
 * Use for debugging details that clutter normal operation
 */
export const verbose = {
  init: (message, filePath, details = null) => {
    logMessage('INIT', message, filePath, details, false);
  },

  nav: (message, filePath, details = null) => {
    logMessage('NAV', message, filePath, details, false);
  },

  content: (message, filePath, details = null) => {
    logMessage('CONTENT', message, filePath, details, false);
  },

  user: (message, filePath, details = null) => {
    logMessage('USER', message, filePath, details, false);
  },

  debug: (message, filePath, details = null) => {
    if (isVerboseMode()) {
      console.log(`[DEBUG] ${message} (${filePath})`, details || '');
    }
  }
};

/**
 * Utility functions for developers
 */
export const logger = {
  /**
   * Enable verbose logging
   */
  enableVerbose: () => {
    try {
      localStorage.setItem('hyperlit_verbose_logs', 'true');
      console.log('%c[LOGGER] Verbose mode enabled. Reload the page to see all logs.', 'color: #10B981; font-weight: bold');
    } catch (e) {
      console.error('Failed to enable verbose mode:', e);
    }
  },

  /**
   * Disable verbose logging
   */
  disableVerbose: () => {
    try {
      localStorage.removeItem('hyperlit_verbose_logs');
      console.log('%c[LOGGER] Verbose mode disabled. Reload the page to apply.', 'color: #6B7280; font-weight: bold');
    } catch (e) {
      console.error('Failed to disable verbose mode:', e);
    }
  },

  /**
   * Check current verbose mode status
   */
  isVerbose: () => {
    const verbose = isVerboseMode();
    console.log(`%c[LOGGER] Verbose mode: ${verbose ? 'ENABLED' : 'DISABLED'}`,
      verbose ? 'color: #10B981; font-weight: bold' : 'color: #6B7280');
    return verbose;
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
  import { log, verbose } from './utilities/logger.js';

  // Checkpoint logs (always shown):
  log.init('Database initialized', '/indexedDB/index.js');
  log.nav('Fresh page load', '/navigation/NavigationManager.js');
  log.content('First chunk rendered', 'lazyLoaderFactory.js');
  log.user('Text selected', '/hyperlights/selection.js');
  log.error('Failed to load', 'initializePage.js', error);

  // Verbose logs (only in verbose mode):
  verbose.init('Detailed step...', '/path/to/file.js');

🔧 DEVELOPER COMMANDS:
  logger.enableVerbose()   - Enable verbose logging
  logger.disableVerbose()  - Disable verbose logging
  logger.isVerbose()       - Check current mode
  logger.help()            - Show this help

💡 TIP: Use verbose.* for debugging details that clutter
       normal operation. Use log.* sparingly for major
       checkpoints only.
    `, 'color: #3B82F6');
  }
};

// Make logger utilities globally available for debugging
if (typeof window !== 'undefined') {
  window.logger = logger;
}

// Log initialization message
if (isVerboseMode()) {
  console.log('%c[LOGGER] Verbose mode enabled - showing all logs', 'color: #10B981; font-weight: bold');
} else {
  console.log('%c[LOGGER] Normal mode - showing checkpoints only (run logger.help() for commands)', 'color: #6B7280');
}

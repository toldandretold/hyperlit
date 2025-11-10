/**
 * Highlights Operations Module
 * Exports all highlight-related operations
 */

// PostgreSQL Sync
export {
  syncHyperlightToPostgreSQL,
  syncHyperlightDeletionsToPostgreSQL,
} from './syncHighlightsToPostgreSQL.js';

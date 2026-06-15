/**
 * Citations Module
 * Exports all citation-related functionality
 *
 * NOTE: the old citationSearch toolbar was removed — live citation search now
 * lives in editToolbar/citationMode.ts (it owns #citation-search-input /
 * #citation-toolbar-results and calls insertCitationAtCursor directly).
 */

export {
  generateReferenceId,
  parseAuthorYear,
  insertCitationAtCursor
} from './citationInserter';

/**
 * Citations Module
 * Exports all citation-related functionality
 */

export {
  initializeCitationSearch,
  destroyCitationSearch,
  openCitationSearchContainer,
  closeCitationSearchContainer
} from './citationSearch.js';

export {
  generateReferenceId,
  parseAuthorYear,
  insertCitationAtCursor
} from './citationInserter.js';

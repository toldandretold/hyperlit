/**
 * Hypercite System - Two-way automatic citation linking
 *
 * Module structure:
 * - utils.js: Helper functions ✅
 * - animations.js: Visual feedback & highlighting ✅
 * - copy.js: Clipboard operations & DOM wrapping (pending)
 * - database.js: IndexedDB CRUD operations (pending)
 * - navigation.js: Click handling & routing (pending)
 * - containers.js: UI generation & citation formatting (pending)
 * - deletion.js: Delink workflow & cleanup (pending)
 * - listeners.js: Event management (pending)
 */

// Extracted modules
export * from './utils.js';
export * from './animations.js';

// Temporary: re-export remaining functions from old location
export * from '../hyperCites.js';

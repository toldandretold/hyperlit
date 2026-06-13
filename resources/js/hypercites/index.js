/**
 * Hypercite System - Two-way automatic citation linking
 *
 * Module structure:
 * - utils.js: Helper functions ✅
 * - animations.js: Visual feedback & highlighting ✅
 * - deletion.js: Delink workflow & cleanup ✅
 * - database.js: IndexedDB CRUD operations ✅
 * - containers.js: UI generation & citation formatting ✅
 * - navigation.js: Click handling & routing ✅
 * - copy.js: Clipboard operations & DOM wrapping ✅
 * - listeners.js: Event management ✅
 */

// Extracted modules - single source of truth
export * from './utils';
export * from './animations';
export * from './deletion';
export * from './database';
export * from './containers';
export * from './navigation.js';
export * from './copy';
export * from './listeners.js';

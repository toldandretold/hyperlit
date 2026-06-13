/**
 * Hypercite System - Two-way automatic citation linking
 *
 * Module structure:
 * - utils.ts: Helper functions ✅
 * - animations.ts: Visual feedback & highlighting ✅
 * - deletion.ts: Delink workflow & cleanup ✅
 * - database.ts: IndexedDB CRUD operations ✅
 * - containers.ts: UI generation & citation formatting ✅
 * - navigation.ts: Click handling & routing ✅
 * - copy.ts: Clipboard operations & DOM wrapping ✅
 * - listeners.ts: Event management ✅
 */

// Extracted modules - single source of truth
export * from './utils';
export * from './animations';
export * from './deletion';
export * from './database';
export * from './containers';
export * from './navigation';
export * from './copy';
export * from './listeners';

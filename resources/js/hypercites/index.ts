/**
 * Hypercite System - Two-way automatic citation linking
 *
 * Module structure:
 * - utils.ts: Helper functions ✅
 * - animations.ts: Visual feedback & highlighting ✅
 * - deletion.ts: Delink workflow & cleanup (+ removeSpecificCitations) ✅
 * - database.ts: IndexedDB CRUD operations ✅
 * - healthCheck/: Does a hypercite citation still exist? (its own folder) ✅
 * - navigation.ts: Click handling & routing ✅
 * - copy.ts: Clipboard operations & DOM wrapping ✅
 * - listeners.ts: Event management ✅
 *
 * The "Cited By" panel is RENDERED by hyperlitContainer (buildHyperciteContent); the old
 * duplicate renderer (containers.ts) was removed.
 */

// Extracted modules - single source of truth
export * from './utils';
export * from './animations';
export * from './deletion';
export * from './database';
export * from './navigation';
export * from './copy';
export * from './listeners';

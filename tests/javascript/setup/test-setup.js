/**
 * Test environment setup for Vitest
 *
 * This file runs before all tests to set up global mocks and utilities
 */

// Mock rangy (text selection library used in hyperLights.js)
global.rangy = {
  init: () => {},
  createHighlighter: () => ({
    addClassApplier: () => {},
    highlightSelection: () => {},
    unhighlightSelection: () => {},
    removeAllHighlights: () => {},
  }),
  createClassApplier: () => ({
    applyToSelection: () => {},
    undoToSelection: () => {},
  }),
  getSelection: () => ({
    rangeCount: 0,
    getRangeAt: () => null,
  }),
};

// Mock window.location.origin for URL parsing tests
if (typeof window !== 'undefined' && !window.location.origin) {
  Object.defineProperty(window.location, 'origin', {
    writable: true,
    value: 'http://localhost:3000',
  });
}

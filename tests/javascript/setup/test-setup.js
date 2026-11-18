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

// ── happy-dom × DOMPurify ≥ 3.4.8: make Node.prototype.nodeName polymorphic ──
// DOMPurify (from 3.4.8, the cross-realm clobbering hardening) no longer reads
// `node.nodeName` off the instance. It caches the GETTER from `Node.prototype`
// once and calls it on every node, so a clobbered own-property cannot lie to it.
// In browsers and jsdom that getter is the only one and is polymorphic. happy-dom
// instead defines a base getter on Node.prototype that returns '' and OVERRIDES
// it on Element/Text/Comment/Document…, so DOMPurify's cached getter returns ''
// for every element, no tag name matches ALLOWED_TAGS, and the sanitizer strips
// EVERY element (KEEP_CONTENT leaves the text). Symptom: applyHighlights /
// sanitizeHtml return "aaa" instead of "<p id=…>aaa</p>", and
// overlapClick.characterization.test.js fails three SAVE cases with []
// (2026-11-18, dompurify 3.4.3 → 3.4.18 via `npm audit fix`). Real Chromium and
// jsdom were verified unaffected — this is a test-environment deviation only.
//
// Shim: re-point the Node.prototype getter at the nearest own `nodeName` getter
// on the instance's prototype chain, which is what the spec'd single getter does.
// Guard: tests/javascript/architecture/dompurifyHappyDomCompat.test.js.
if (typeof Node !== 'undefined' && Node.prototype) {
  const baseDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName');
  if (baseDesc && typeof baseDesc.get === 'function') {
    const baseGet = baseDesc.get;
    Object.defineProperty(Node.prototype, 'nodeName', {
      configurable: true,
      enumerable: baseDesc.enumerable,
      get() {
        let proto = Object.getPrototypeOf(this);
        while (proto && proto !== Node.prototype) {
          const own = Object.getOwnPropertyDescriptor(proto, 'nodeName');
          if (own && typeof own.get === 'function') return own.get.call(this);
          proto = Object.getPrototypeOf(proto);
        }
        return baseGet.call(this);
      },
    });
  }
}

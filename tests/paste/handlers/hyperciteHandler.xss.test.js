/**
 * @vitest-environment jsdom
 *
 * MUST run under jsdom (like tests/javascript/security/sanitizeConfig.test.js): the handler
 * calls DOMPurify, which needs a spec-complete DOM. Under happy-dom the sanitize step is
 * unreliable.
 *
 * SECURITY REGRESSION — hypercite paste DOM XSS.
 * ==============================================
 * handleHypercitePaste() sanitizes the clipboard HTML up front, but it used to then pull the
 * link's href back out with getAttribute() (which DECODES it) and splice it — plus the
 * extracted quoted text — into an HTML STRING that was re-parsed via `innerHTML`. That second
 * parse resurrected a `"`-escaped payload, e.g.
 *     <a href='/x#hypercite_y"><img src=x onerror=…>' class="open-icon">↗</a>
 * → after sanitize the `"`/`<img>` are inert data inside the href, but getAttribute + concat
 *   + innerHTML re-parse turned them into a live <img onerror>.
 *
 * The fix: reject any link whose id is not a well-formed hypercite id, rebuild the href from
 * validated parts, and build the inserted anchor with DOM APIs (setAttribute / textContent)
 * so nothing is ever re-parsed from a string. These tests drive the REAL handler and assert
 * no executable markup can materialise from a crafted clipboard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep sanitizeHtml, parseHyperciteHref, isHyperciteId, textExtraction, anchorSpacing REAL.
// Stub only the heavy data-layer / editor barrels the handler imports.
vi.mock('../../../resources/js/hyperlitContainer/utilities/activeContext', () => ({ getActiveBook: () => 'bookB' }));
vi.mock('../../../resources/js/hypercites/index', async () => {
  const utils = await import('../../../resources/js/hypercites/utils');
  return {
    parseHyperciteHref: utils.parseHyperciteHref, // REAL parser
    attachUnderlineClickListeners: vi.fn(),
    delinkHypercite: vi.fn(),
  };
});
vi.mock('../../../resources/js/editToolbar/index', () => ({ getEditToolbar: () => undefined }));
vi.mock('../../../resources/js/editToolbar/toolbarDOMUtils', () => ({ getTextOffsetInElement: vi.fn(() => 0) }));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({ broadcastToOpenTabs: vi.fn() }));
vi.mock('../../../resources/js/divEditor/index', () => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  updateCitationForExistingHypercite: vi.fn().mockResolvedValue(undefined),
  getNodesFromIndexedDB: vi.fn().mockResolvedValue([]),
  addCitationToHypercite: vi.fn().mockResolvedValue(undefined),
  getHyperciteFromIndexedDB: vi.fn().mockResolvedValue(null),
  updateHyperciteInIndexedDB: vi.fn().mockResolvedValue(true),
  getNodeFromIndexedDB: vi.fn().mockResolvedValue(null),
  toPublicNode: vi.fn((n) => n),
  syncHyperciteWithNodeImmediately: vi.fn().mockResolvedValue(undefined),
  queueForSync: vi.fn(),
  debouncedMasterSync: { flush: vi.fn().mockResolvedValue(undefined) },
}));

import { handleHypercitePaste } from '../../../resources/js/paste/handlers/hyperciteHandler';

/** Place a collapsed caret inside an editable <p id="100"> and return that block. */
function setupCaret() {
  document.body.innerHTML = '<div class="main-content"><p id="100">before </p></div>';
  const p = document.getElementById('100');
  const textNode = p.firstChild;
  const range = document.createRange();
  range.setStart(textNode, textNode.textContent.length);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return p;
}

/** A minimal paste event: the handler is given clipboardHtml directly, so it never reads
 *  clipboardData; it only calls preventDefault. */
function fakePasteEvent() {
  return { preventDefault: vi.fn(), clipboardData: { getData: () => '' } };
}

/** Assert the live document contains no executable markup that a payload would have created. */
function expectNoExecutableMarkup() {
  expect(document.querySelectorAll('img').length).toBe(0);
  expect(document.querySelectorAll('script').length).toBe(0);
  const withHandler = Array.from(document.querySelectorAll('*')).filter((el) =>
    Array.from(el.attributes).some((a) => /^on[a-z]+$/i.test(a.name)));
  expect(withHandler).toEqual([]);
  expect(window.__xss).toBeUndefined();
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.__xss = undefined;
  vi.clearAllMocks();
});

describe('handleHypercitePaste — XSS hardening', () => {
  it('SINK 1 (href): a payload smuggled through the href never executes and is rejected', async () => {
    setupCaret();
    // href breaks out of its attribute after sanitize→getAttribute→(old) re-parse.
    const clipboardHtml =
      `<a href='/x#hypercite_y"><img src=x onerror="window.__xss=1">' class="open-icon">↗</a>`;

    const handled = await handleHypercitePaste(fakePasteEvent(), 'bookB', clipboardHtml);

    // The malformed hypercite id fails validation → link rejected, nothing inserted.
    expect(handled).toBe(false);
    expectNoExecutableMarkup();
  });

  it('SINK 2 (quoted text): a payload in the text before the link is inserted as inert text', async () => {
    setupCaret();
    // The `<img>` arrives HTML-entity-encoded, so sanitize keeps it as literal text; the
    // handler extracts it as quotedText. It must be inserted via textContent, not re-parsed.
    const clipboardHtml =
      `&lt;img src=x onerror=window.__xss=1&gt;<a href='/bookA#hypercite_abc123' class="open-icon">↗</a>`;

    const handled = await handleHypercitePaste(fakePasteEvent(), 'bookB', clipboardHtml);

    expect(handled).toBe(true); // the link itself is valid
    expectNoExecutableMarkup();
    // the payload text survives as literal, escaped text (proves it was not parsed as markup)
    expect(document.querySelector('[id="100"]').textContent).toContain('<img src=x onerror=window.__xss=1>');
  });

  it('SINK 3 (book path): injection in the book segment is URL-encoded + set via setAttribute', async () => {
    setupCaret();
    const clipboardHtml =
      `<a href='/book"><img onerror=window.__xss=1>#hypercite_abc123' class="open-icon">↗</a>`;

    const handled = await handleHypercitePaste(fakePasteEvent(), 'bookB', clipboardHtml);

    expect(handled).toBe(true); // valid hypercite id → link is kept
    expectNoExecutableMarkup();
    const anchor = document.querySelector('[id="100"] a.open-icon');
    expect(anchor).not.toBeNull();
    // href was rebuilt + escaped; no raw < > " leaked into a live attribute
    expect(anchor.getAttribute('href')).not.toMatch(/[<>"]/);
    expect(anchor.getAttribute('href')).toContain('#hypercite_abc123');
  });

  it('benign hypercite paste still links correctly (guard against over-stripping)', async () => {
    setupCaret();
    const clipboardHtml =
      `'a quote'<a href="/bookA#hypercite_abc123" class="open-icon">↗</a>`;

    const handled = await handleHypercitePaste(fakePasteEvent(), 'bookB', clipboardHtml);

    expect(handled).toBe(true);
    const anchor = document.querySelector('[id="100"] a.open-icon');
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe('/bookA#hypercite_abc123');
    expect(anchor.textContent).toBe('↗');
    expectNoExecutableMarkup();
  });
});

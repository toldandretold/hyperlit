/**
 * The reader is framed by the maintainer harnesses (/maintainer/conversion and
 * /maintainer/journal-import) beside the source it was converted from.
 *
 * Session history is JOINT across a browsing context, so the reader's normal close behaviour —
 * `history.back()`, to consume the entry that opening a container pushed — steps whatever entry
 * happens to be last in the WHOLE context when it runs inside a frame. Observed live on
 * /maintainer/journal-import: closing a citation stepped the reader frame back to `about:blank`
 * (pane empties), and the same mechanism blanks the PDF pane or navigates the host page, which is
 * the "the whole page gets cooked and I have to refresh" report.
 *
 * `isEmbeddedReader()` is the switch every history write is gated on, so it must be exactly
 * "am I framed" — nothing to do with which page is hosting us.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isEmbeddedReader } from '../../../resources/js/utilities/embeddedReader';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isEmbeddedReader', () => {
  it('is false at top level, where history is ours to write', () => {
    // jsdom/happy-dom give a window whose top IS itself.
    expect(isEmbeddedReader()).toBe(false);
  });

  it('is true when framed', () => {
    vi.stubGlobal('top', { name: 'a-different-window' });

    expect(isEmbeddedReader()).toBe(true);
  });

  it('treats an unreachable ancestor as framed', () => {
    // A cross-origin host throws on access — which itself proves we are framed, so the safe
    // answer is "yes", not a crash that would leave the history writes ungated.
    vi.stubGlobal('top', {
      get name() { throw new DOMException('cross-origin'); },
    });
    Object.defineProperty(globalThis, 'top', {
      configurable: true,
      get() { throw new DOMException('blocked by cross-origin policy'); },
    });

    expect(isEmbeddedReader()).toBe(true);
  });
});

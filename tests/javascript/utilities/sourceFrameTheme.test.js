/**
 * The maintainer source panes paint a raw fetched publisher page in the app's theme
 * (resources/js/utilities/sourceFrameTheme.ts) so it isn't a white slab beside a dark reader.
 *
 * The subtle half is deciding WHAT may be restyled. It has to come from the artifacts on disk,
 * never from the loaded document: WebKit gives its PDF viewer a real `body`, so a
 * "does it have a body" check reports a PDF as skinnable and we inject a stylesheet into the
 * viewer. The endpoint's priority is pdf → html → md → binary, so an `original.pdf` on disk means
 * that is what is being served, whatever else sits beside it.
 */
import { describe, it, expect } from 'vitest';
import { skinnableContentType, sourceIsSkinnable } from '../../../resources/js/utilities/sourceFrameTheme';

describe('sourceIsSkinnable', () => {
  it('refuses a PDF lane even when html sits beside it on disk', () => {
    expect(sourceIsSkinnable(['original.pdf'])).toBe(false);
    // The PDF wins the endpoint's priority order, so the frame is showing the PDF.
    expect(sourceIsSkinnable(['original.pdf', 'fetched_page.html'])).toBe(false);
  });

  it('accepts the text sources the panes actually render', () => {
    expect(sourceIsSkinnable(['fetched_page.html'])).toBe(true);
    expect(sourceIsSkinnable(['original.html'])).toBe(true);
    expect(sourceIsSkinnable(['original.md'])).toBe(true);
    expect(sourceIsSkinnable(['pasted_page.html'])).toBe(true);
  });

  it('refuses binaries the browser downloads rather than frames, and empty lanes', () => {
    expect(sourceIsSkinnable(['original.epub'])).toBe(false);
    expect(sourceIsSkinnable(['original.docx'])).toBe(false);
    expect(sourceIsSkinnable([])).toBe(false);
    // Artifacts that aren't a source at all must not be mistaken for one.
    expect(sourceIsSkinnable(['nodes.json', 'fetch_trace.json'])).toBe(false);
  });
});

/**
 * The artifact list is a guess that can be MISSING: a book opened by deep link on
 * /maintainer/conversion isn't in the flag queue, so it arrives with `artifacts: []` — which read
 * as "not skinnable" and therefore left the frame UNSANDBOXED. Demonstrated with a planted hostile
 * page: its script ran, reached the parent DOM, and got HTTP 200 from the admin API as the logged-in
 * admin. The response's own Content-Type can't be missing, so it decides.
 */
describe('skinnableContentType', () => {
  it('refuses a PDF', () => {
    expect(skinnableContentType('application/pdf')).toBe(false);
  });

  it('accepts the framed text types, header parameters and casing included', () => {
    expect(skinnableContentType('text/html; charset=UTF-8')).toBe(true);
    expect(skinnableContentType('TEXT/HTML')).toBe(true);
    expect(skinnableContentType('text/plain; charset=UTF-8')).toBe(true);
  });

  it('refuses binaries the browser downloads rather than frames', () => {
    expect(skinnableContentType('application/octet-stream')).toBe(false);
    expect(skinnableContentType('application/epub+zip')).toBe(false);
  });

  // null, NOT false: "unknown" must fall through to the artifact list, because answering false
  // here would drop the sandbox — the exact failure this function exists to prevent.
  it('returns null when the header is absent so the caller falls back', () => {
    expect(skinnableContentType(null)).toBeNull();
    expect(skinnableContentType(undefined)).toBeNull();
    expect(skinnableContentType('')).toBeNull();
  });
});

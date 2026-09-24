/**
 * fetchHtml reports the URL it actually landed on.
 *
 * The server canonicalizes /u/{username} to the account's stored casing with a
 * 301, and fetch() follows that transparently. fetchHtml used to return only
 * the markup, so DifferentTemplateTransition swapped in the canonical page's
 * HTML while still believing the REQUESTED path — and it derives the book id
 * from that path (`toBook`), with `document.querySelector('.main-content')?.id`
 * as the only safety net. User pages render no server-side `.main-content`
 * (the deferred hero), so nothing caught it: `/u/james` seated a book id of
 * `james` for an account actually named `James`, then handed it to
 * setCurrentBook/updateDatabaseBookId while the DOM said `James`.
 *
 * Also pinned here: the body is drained even on a non-OK response. Throwing
 * without consuming it holds the connection open (6 per origin) and the page
 * never reaches network-idle — the recurring bug class the noUndrainedFetch
 * gate exists for.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { fetchHtml } from '../../../../resources/js/SPA/navigation/utils/contentSwapHelpers.js';

function response({ ok = true, status = 200, url = '', body = '<html></html>' } = {}) {
  return {
    ok,
    status,
    url,
    text: vi.fn().mockResolvedValue(body),
  };
}

describe('fetchHtml', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the post-redirect URL so a server canonicalization is visible', async () => {
    const res = response({ url: 'https://hyperlit.test/u/James', body: '<html>James</html>' });
    global.fetch = vi.fn().mockResolvedValue(res);

    const { html, finalUrl } = await fetchHtml('/u/james');

    expect(html).toBe('<html>James</html>');
    expect(finalUrl).toBe('https://hyperlit.test/u/James');
  });

  it('falls back to the requested URL when the response carries none', async () => {
    // Some synthetic/mocked responses leave `url` empty — the caller must
    // still get something it can parse rather than ''.
    global.fetch = vi.fn().mockResolvedValue(response({ url: '' }));

    const { finalUrl } = await fetchHtml('/u/james');

    expect(finalUrl).toBe('/u/james');
  });

  it('carries the query string through on a canonicalized URL', async () => {
    // The 301 preserves ?tab=…&sort=…, so response.url does too. The caller
    // rebuilds its URL from this — taking only the pathname would silently
    // drop the query string on the pushState.
    global.fetch = vi.fn().mockResolvedValue(
      response({ url: 'https://hyperlit.test/u/James?sort=connected&tab=shelves' })
    );

    const { finalUrl } = await fetchHtml('/u/james?tab=shelves&sort=connected');
    const parsed = new URL(finalUrl);

    expect(parsed.pathname).toBe('/u/James');
    expect(parsed.search).toBe('?sort=connected&tab=shelves');
  });

  it('drains the body before throwing on a non-OK response', async () => {
    const res = response({ ok: false, status: 500 });
    global.fetch = vi.fn().mockResolvedValue(res);

    await expect(fetchHtml('/u/james')).rejects.toThrow('Failed to fetch HTML: 500');
    expect(res.text).toHaveBeenCalledTimes(1);
  });
});

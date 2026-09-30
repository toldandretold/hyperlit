/**
 * Guardrail for the shelf-pill resolution decision table.
 *
 * The bug this pins: server-rendered visitor shelf pills carry
 * data-content="", and the ONLY code that resolves an empty content id is
 * the shelf branch in homepageDisplayUnit. The old inline guard read
 * `!isOwner && isUserPage`, so the OWNER clicking their own visitor pill
 * fell through to the generic path and loaded '' as a book id — which
 * loadHyperText's `bookId || book` fallback turned into the USERNAME, and
 * the lazy loader then errored hunting for a container with that id.
 *
 * The decision now lives in shelfTabRouting.ts (pure, no DOM), used by BOTH
 * the click handler and the boot/restore path, so the two can't drift apart.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveShelfClickMode,
  shelfRenderUrl,
  isPersistableContentId,
} from '../../../resources/js/components/homepage/shelfTabRouting.ts';

describe('resolveShelfClickMode', () => {
  it('owner on the user page resolves via the OWNER endpoint (the dead-pill bug)', () => {
    expect(resolveShelfClickMode({
      filter: 'shelf', page: 'user', isOwner: true, isUserPage: true,
    })).toBe('owner-shelf');
  });

  it('visitor on the user page resolves via the public endpoint', () => {
    expect(resolveShelfClickMode({
      filter: 'shelf', page: 'user', isOwner: false, isUserPage: true,
    })).toBe('public-shelf');
  });

  it('journal pages are isOwner-BLIND: public endpoint even with leaked isOwner=true', () => {
    // window.isOwner is stamped by the user page and leaks across SPA body
    // swaps — honoring it on a journal page silently killed the feed buttons.
    expect(resolveShelfClickMode({
      filter: 'shelf', page: 'journal', isOwner: true, isUserPage: true,
    })).toBe('public-shelf');
    expect(resolveShelfClickMode({
      filter: 'shelf', page: 'journal', isOwner: true, isUserPage: false,
    })).toBe('public-shelf');
    expect(resolveShelfClickMode({
      filter: 'shelf', page: 'journal', isOwner: false, isUserPage: false,
    })).toBe('public-shelf');
  });

  it('non-shelf filters take the generic data-content path', () => {
    expect(resolveShelfClickMode({
      filter: 'library', page: 'user', isOwner: true, isUserPage: true,
    })).toBe('generic');
    expect(resolveShelfClickMode({
      filter: undefined, page: 'user', isOwner: false, isUserPage: true,
    })).toBe('generic');
  });

  it('a shelf filter on a page that is neither journal nor user is generic', () => {
    expect(resolveShelfClickMode({
      filter: 'shelf', page: 'home', isOwner: false, isUserPage: false,
    })).toBe('generic');
  });
});

describe('shelfRenderUrl', () => {
  it('owner mode hits the authed shelf render route', () => {
    expect(shelfRenderUrl('owner-shelf', 'abc-123', 'recent'))
      .toBe('/api/shelves/abc-123/render?sort=recent');
  });

  it('public mode hits the public shelf render route', () => {
    expect(shelfRenderUrl('public-shelf', 'abc-123', 'lit'))
      .toBe('/api/public/shelves/abc-123/render?sort=lit');
  });

  it('generic mode has no render URL', () => {
    expect(shelfRenderUrl('generic', 'abc-123', 'recent')).toBeNull();
  });

  it('encodes shelf id and sort', () => {
    expect(shelfRenderUrl('public-shelf', 'a b', 'r&s'))
      .toBe('/api/public/shelves/a%20b/render?sort=r%26s');
  });
});

describe('isPersistableContentId', () => {
  it('rejects the empty string that used to poison localStorage/history', () => {
    expect(isPersistableContentId('')).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isPersistableContentId(null)).toBe(false);
    expect(isPersistableContentId(undefined)).toBe(false);
  });

  it('accepts a real content id', () => {
    expect(isPersistableContentId('shelf_abc_recent')).toBe(true);
    expect(isPersistableContentId('samAll')).toBe(true);
  });
});

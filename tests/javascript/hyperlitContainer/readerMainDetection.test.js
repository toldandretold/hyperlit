/**
 * Reader-main detection must work for SLUG-named books, not just `book_<digits>`.
 *
 * Bug: container-stack restore on back/forward used `main.main-content[id^="book_"]` to decide
 * "are we on a reader page". Canonical / vanity books render a SLUG id (e.g. `bedjaouinieo`), so
 * that guard classified them as "not a reader" and SILENTLY SKIPPED the container-stack restore —
 * the user landed at the TOP with no container. Both restore sites now key off the `data-slug`
 * attribute, which reader.blade.php emits and home/user blades do not.
 *
 * This guards the blade contract the fix depends on:
 *   reader.blade.php: <main class="main-content" id="{{ $book }}" data-slug="…">
 *   home (feed open):  <main class="main-content active-content" id="most-recent">  (no data-slug)
 *   user.blade.php:   <main class="main-content active-content" id="…">            (no data-slug)
 *
 * Note: the homepage now DEFERS its feed (lava-lamp hero) — there is no
 * .main-content until a tab is pressed, at which point homepageDisplayUnit
 * creates one (no data-slug), which is exactly the "home" case below.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const SELECTOR = 'main.main-content[data-slug]';

beforeEach(() => { document.body.innerHTML = ''; });

function setMain(html) { document.body.innerHTML = html; }

describe('reader-main detection ([data-slug]) across book id shapes', () => {
  it('matches a numeric book_<digits> reader', () => {
    setMain('<main class="main-content" id="book_1769036890566" data-slug=""></main>');
    expect(document.querySelector(SELECTOR)?.id).toBe('book_1769036890566');
  });

  it('matches a SLUG-named reader (the bug case: bedjaouinieo)', () => {
    setMain('<main class="main-content" id="bedjaouinieo" data-slug="bedjaouinieo"></main>');
    expect(document.querySelector(SELECTOR)?.id).toBe('bedjaouinieo');
  });

  it('does NOT match the home page (no data-slug)', () => {
    setMain('<main class="main-content active-content" id="most-recent"></main>');
    expect(document.querySelector(SELECTOR)).toBeNull();
  });

  it('does NOT match a user page (no data-slug)', () => {
    setMain('<main class="main-content active-content" id="some-user-book"></main>');
    expect(document.querySelector(SELECTOR)).toBeNull();
  });

  it('the OLD id^="book_" guard would have WRONGLY skipped the slug reader', () => {
    setMain('<main class="main-content" id="bedjaouinieo" data-slug="bedjaouinieo"></main>');
    // The old guard returned null here → "not a reader" → container restore skipped.
    expect(document.querySelector('main.main-content[id^="book_"]')).toBeNull();
    // The new guard correctly finds it.
    expect(document.querySelector(SELECTOR)).not.toBeNull();
  });
});

/**
 * Regression tests for SPA head reconciliation (pageStylesheets.ts).
 *
 * The bug this locks in: each blade loads its own page CSS in the <head>
 * (@vite: app.css + pages/<page>.css), but SPA template switches replaced
 * only the body. A session that started on a READER page and SPA-navigated
 * to home therefore never loaded pages/home.css — the homepage rendered as
 * bare unstyled HTML (no glass hero, lava SVG in an unpositioned div at the
 * bottom of the document), looking like "all the JS died" when every
 * component had in fact initialized fine.
 *
 * syncPageStylesheets() = append the incoming template's missing sheets
 * (awaited), then the returned cleanup removes sheets the incoming template
 * doesn't declare. syncBodyAttributes() = exact attribute sync (the old
 * additive loop leaked the outgoing template's body attributes).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  syncPageStylesheets,
  syncBodyAttributes,
} from '../../../resources/js/SPA/navigation/utils/pageStylesheets';

const APP = 'http://localhost/css/app.css';
const READER = 'http://localhost/css/pages/reader.css';
const HOME = 'http://localhost/css/pages/home.css';

function addLink(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
  return link;
}

/** A fetched-page Document whose head declares the given stylesheets. */
function fetchedDocWith(...hrefs) {
  const links = hrefs.map(h => `<link rel="stylesheet" href="${h}">`).join('');
  return new DOMParser().parseFromString(
    `<!doctype html><html><head>${links}</head><body data-page="home"></body></html>`,
    'text/html',
  );
}

function headHrefs() {
  return Array.from(
    document.head.querySelectorAll('link[rel="stylesheet"]'),
    el => el.href,
  );
}

/** jsdom never fetches stylesheets, so fire the load event by hand. */
function fireLoadOn(href) {
  const el = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]'))
    .find(l => l.href === href);
  el?.dispatchEvent(new Event('load'));
}

describe('syncPageStylesheets — reader-first session navigating to home', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('appends the missing home page sheet and drops the reader one after cleanup', async () => {
    addLink(APP);
    addLink(READER);

    const promise = syncPageStylesheets(fetchedDocWith(APP, HOME));
    // home.css must be appended synchronously (before any await settles)
    expect(headHrefs()).toContain(HOME);
    fireLoadOn(HOME);
    const removeStale = await promise;

    // reader.css survives until AFTER the body swap (no bare flash), then goes
    expect(headHrefs()).toEqual(expect.arrayContaining([APP, READER, HOME]));
    removeStale();
    expect(headHrefs()).toEqual([APP, HOME]);
  });

  it('is a no-op when the incoming template declares the same sheets', async () => {
    addLink(APP);
    addLink(READER);

    const removeStale = await syncPageStylesheets(fetchedDocWith(APP, READER));
    removeStale();

    expect(headHrefs()).toEqual([APP, READER]);
  });

  it('resolves even if a sheet errors instead of loading', async () => {
    addLink(APP);

    const promise = syncPageStylesheets(fetchedDocWith(APP, HOME));
    const added = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]'))
      .find(l => l.href === HOME);
    added.dispatchEvent(new Event('error'));

    await expect(promise).resolves.toBeTypeOf('function');
  });
});

describe('syncBodyAttributes — exact sync, stale attributes removed', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    // reset body attributes
    for (const name of Array.from(document.body.getAttributeNames())) {
      document.body.removeAttribute(name);
    }
  });

  it('removes outgoing-template attributes the new template lacks', () => {
    document.body.setAttribute('data-page', 'reader');
    document.body.setAttribute('data-book-id', 'some-book');

    syncBodyAttributes(fetchedDocWith(APP, HOME));

    expect(document.body.getAttribute('data-page')).toBe('home');
    expect(document.body.hasAttribute('data-book-id')).toBe(false);
  });
});

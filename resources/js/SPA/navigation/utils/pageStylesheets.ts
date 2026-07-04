/**
 * Head reconciliation for SPA template switches (zero-import leaf apart from
 * the logger, so tests and transitions can use it without dragging in the
 * data layer).
 *
 * Each blade loads its OWN page CSS in the <head> (@vite: app.css +
 * pages/<page>.css), but SPA template switches replace only the body — the
 * head keeps whatever the first full load installed. A reader-first session
 * navigating to home therefore never loaded pages/home.css (glass hero, lava
 * mount positioning) and the homepage rendered as bare unstyled HTML.
 */

import { verbose } from '../../../utilities/logger';

/**
 * Reconcile the head's stylesheets with the fetched page's.
 *
 * Appends the new template's missing <link rel="stylesheet"> tags and waits
 * for them (so the swapped-in body never paints unstyled), then returns a
 * cleanup that removes sheets the new template does NOT declare — call it
 * AFTER the body swap so the outgoing page never flashes bare either.
 */
export async function syncPageStylesheets(newDoc: Document): Promise<() => void> {
  const current = new Map<string, HTMLLinkElement>();
  document.head
    .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
    .forEach(el => current.set(el.href, el));

  const wanted = new Set<string>();
  const loading: Promise<void>[] = [];
  newDoc.head
    .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
    .forEach(el => {
      // .href is absolute: DOMParser documents inherit this page's base URL
      const href = el.href;
      wanted.add(href);
      if (current.has(href)) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      loading.push(new Promise<void>(resolve => {
        // a slow/failed sheet must never wedge the whole transition
        const timer = window.setTimeout(resolve, 3000);
        const done = () => { window.clearTimeout(timer); resolve(); };
        link.addEventListener('load', done, { once: true });
        link.addEventListener('error', done, { once: true });
      }));
      document.head.appendChild(link);
      verbose.nav(`Added page stylesheet: ${href}`, '/navigation/utils/pageStylesheets.ts');
    });

  await Promise.all(loading);
  return () => {
    current.forEach((el, href) => {
      if (!wanted.has(href)) {
        el.remove();
        verbose.nav(`Removed stale page stylesheet: ${href}`, '/navigation/utils/pageStylesheets.ts');
      }
    });
  };
}

/**
 * Exact body-attribute sync: the old additive loop left the outgoing
 * template's attributes (and classes) on <body>, silently breaking selectors
 * keyed off them on the incoming page. Mirrors what a full load produces.
 */
export function syncBodyAttributes(newDoc: Document): void {
  for (const name of Array.from(document.body.getAttributeNames())) {
    if (!newDoc.body.hasAttribute(name)) document.body.removeAttribute(name);
  }
  for (const { name, value } of newDoc.body.attributes) {
    document.body.setAttribute(name, value);
  }
}

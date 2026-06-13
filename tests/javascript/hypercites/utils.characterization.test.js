/**
 * Characterization of the hypercites/utils.js helpers NOT already covered by
 * tests/javascript/hyperCites.test.js (which pins generateHyperciteID,
 * determineRelationshipStatus, extractHyperciteIdFromHref).
 *
 * These are pure-ish helpers (some read the DOM); pinned before the .js → .ts
 * migration of resources/js/hypercites/utils.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHyperciteHref,
  removeCitedINEntry,
  findParentWithNumericalId,
  selectionSpansMultipleNodes,
} from '../../../resources/js/hypercites/utils';

describe('parseHyperciteHref', () => {
  it('splits a /book#hypercite href into its parts', () => {
    expect(parseHyperciteHref('/booka#hypercite_x')).toEqual({
      booka: 'booka',
      hyperciteIDa: 'hypercite_x',
      citationIDa: '/booka#hypercite_x',
    });
  });

  it('resolves relative hrefs against the page origin', () => {
    const r = parseHyperciteHref('#hypercite_y');
    expect(r.hyperciteIDa).toBe('hypercite_y');
    expect(r.citationIDa).toBe('/#hypercite_y');
  });
});

describe('removeCitedINEntry', () => {
  it('drops the entry whose #fragment matches the element id, keeps the rest', () => {
    expect(removeCitedINEntry(['/b#cite_x', '/c#cite_y'], 'cite_x')).toEqual(['/c#cite_y']);
  });
  it('keeps entries with no #fragment (unexpected format)', () => {
    expect(removeCitedINEntry(['/b', '/c#cite_y'], 'cite_y')).toEqual(['/b']);
  });
  it('returns [] for a non-array input', () => {
    expect(removeCitedINEntry(null, 'x')).toEqual([]);
    expect(removeCitedINEntry(undefined, 'x')).toEqual([]);
  });
});

describe('findParentWithNumericalId', () => {
  it('walks up to the nearest ancestor with a numeric id (incl. dotted)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div id="2.1"><p><span>x</span></p></div>';
    const span = host.querySelector('span');
    expect(findParentWithNumericalId(span).id).toBe('2.1');
  });
  it('returns null when there is no numeric-id ancestor', () => {
    const host = document.createElement('div');
    host.innerHTML = '<section id="notnumeric"><span>x</span></section>';
    expect(findParentWithNumericalId(host.querySelector('span'))).toBeNull();
  });
});

describe('selectionSpansMultipleNodes', () => {
  it('true when the range crosses two numeric-id nodes, false within one', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div id="1">one</div><div id="2">two</div>';
    document.body.appendChild(host);

    // NB: '#1' is an invalid CSS selector (ids can't start with a digit) — use [id=…]
    const n1 = host.querySelector('[id="1"]');
    const n2 = host.querySelector('[id="2"]');

    const multi = document.createRange();
    multi.setStart(n1.firstChild, 0);
    multi.setEnd(n2.firstChild, 1);
    expect(selectionSpansMultipleNodes(multi)).toBe(true);

    const single = document.createRange();
    single.selectNodeContents(n1);
    expect(selectionSpansMultipleNodes(single)).toBe(false);

    host.remove();
  });
});

// anchorHref: the ONE way click routers read an anchor's destination. An SVG
// anchor's `href` is an SVGAnimatedString OBJECT in every browser, and
// `new URL(link.href, origin)` turned the hypercite map's dots into a book
// called "[object SVGAnimatedString]". happy-dom gives SVG anchors no `href`
// property at all, so the browser shape is modelled explicitly here.
import { describe, test, expect } from 'vitest';
import { anchorHrefOf, anchorUrlOf } from '../../../resources/js/utilities/anchorHref';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG <a> whose `href` reads like a browser's SVGAnimatedString (live attribute). */
function svgAnchor(href) {
  const a = document.createElementNS(SVG_NS, 'a');
  a.setAttribute('href', href);
  Object.defineProperty(a, 'href', {
    configurable: true,
    get() {
      const el = this;
      return {
        get baseVal() { return el.getAttribute('href'); },
        get animVal() { return el.getAttribute('href'); },
        toString() { return '[object SVGAnimatedString]'; },
      };
    },
  });
  return a;
}

describe('anchorHrefOf', () => {
  test('an HTML anchor reports its href as the browser resolves it', () => {
    window.history.replaceState(null, '', '/a/decolonising-security');
    const a = document.createElement('a');
    a.href = '/pushing-the-boundaries';
    expect(anchorHrefOf(a)).toBe(`${window.location.origin}/pushing-the-boundaries`);
  });

  test('an SVG anchor reports the attribute, never "[object SVGAnimatedString]"', () => {
    const a = svgAnchor('/pushing-the-boundaries');
    expect(String(a.href)).toBe('[object SVGAnimatedString]'); // the browser shape under test
    expect(anchorHrefOf(a)).toBe('/pushing-the-boundaries');
  });

  test('a rewritten SVG href attribute is picked up live (the map adds its intro hash on click)', () => {
    const a = svgAnchor('/pushing-the-boundaries');
    a.setAttribute('href', '/pushing-the-boundaries#hypercite_t5skblf');
    expect(anchorHrefOf(a)).toBe('/pushing-the-boundaries#hypercite_t5skblf');
  });

  test('a happy-dom style SVG anchor (no href property) still reads the attribute', () => {
    const a = document.createElementNS(SVG_NS, 'a');
    a.setAttribute('href', '/x');
    expect(anchorHrefOf(a)).toBe('/x');
  });

  test('no href, or a blank one, is null', () => {
    expect(anchorHrefOf(document.createElement('a'))).toBeNull();
    const blank = document.createElementNS(SVG_NS, 'a');
    blank.setAttribute('href', '   ');
    expect(anchorHrefOf(blank)).toBeNull();
  });
});

describe('anchorUrlOf', () => {
  test('resolves a root-relative SVG href against the page origin', () => {
    window.history.replaceState(null, '', '/a/decolonising-security');
    const url = anchorUrlOf(svgAnchor('/abolition-as-method-gabriel-2022#hypercite_5t4wrtk'));
    expect(url.pathname).toBe('/abolition-as-method-gabriel-2022');
    expect(url.hash).toBe('#hypercite_5t4wrtk');
    expect(url.href).not.toContain('SVGAnimatedString');
  });

  test('an unparseable destination is null rather than a throw inside a click handler', () => {
    const a = document.createElementNS(SVG_NS, 'a');
    a.setAttribute('href', 'http://');
    expect(anchorUrlOf(a)).toBeNull();
    expect(anchorUrlOf(document.createElement('a'))).toBeNull();
  });
});

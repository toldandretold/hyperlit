/**
 * Format detection: only a SIGNATURE selector may decide a format.
 *
 * Regression source: book_1787965215968 — common-wealth.org (a Webflow
 * think-tank site) was detected as `sage` because Webflow puts
 * `role="listitem"` on every Collection List item and sage listed
 * `[role="listitem"]` as a selector. detectFormat had no threshold of any kind:
 * the first format with >=1 match on >=1 selector won outright.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectFormat,
  detectFormatVerbose,
  scoreFormats,
} from '../../../resources/js/paste/format-detection/format-detector';
import { FORMAT_REGISTRY } from '../../../resources/js/paste/format-detection/format-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'clipboard');

describe('registry shape', () => {
  it('derives selectors as signature + supporting + domain', () => {
    Object.entries(FORMAT_REGISTRY).forEach(([name, config]) => {
      expect(config.selectors, name).toEqual([
        ...config.signature,
        ...config.supporting,
        ...config.domain,
      ]);
    });
  });

  it('keeps the known-generic selectors OUT of every signature list', () => {
    // These fire on a large slice of the web. If one of them ever needs to
    // decide a format, add a narrower signature instead of promoting it back.
    const generic = ['[role="listitem"]', '.ref', '.citations', '#articleBody', '[id^="Fn"]', 'span.reference[id]'];
    Object.entries(FORMAT_REGISTRY).forEach(([name, config]) => {
      generic.forEach((selector) => {
        expect(config.signature, `${name} must not decide on ${selector}`).not.toContain(selector);
      });
    });
  });

  it('every format except the general fallback can still be decided by something', () => {
    Object.entries(FORMAT_REGISTRY).forEach(([name, config]) => {
      if (name === 'general') return;
      expect(config.signature.length + config.domain.length, name).toBeGreaterThan(0);
    });
  });
});

describe('detectFormat', () => {
  const html = (body) => `<div>${body}</div>`;

  it('chooses a format on a signature match', () => {
    expect(detectFormat(html('<a class="xref fn"><sup>1</sup></a>'))).toBe('cambridge');
  });

  it('does NOT choose a format on supporting selectors alone', () => {
    // The exact shape that misfired: Webflow collection items, nothing else.
    const webflow = html('<div role="listitem">One</div><div role="listitem">Two</div>');
    expect(detectFormat(webflow)).toBe('general');
  });

  it('does not let a generic .ref or .citations container decide either', () => {
    expect(detectFormat(html('<div class="citations"><p class="ref">A source, 2019.</p></div>'))).toBe('general');
  });

  it('does not let a generic #articleBody decide', () => {
    expect(detectFormat(html('<div id="articleBody"><p>Body text.</p></div>'))).toBe('general');
  });

  it('does not detect Hyperlit\'s own footnote ids as Springer', () => {
    // base-processor mints footnote ids as Fn{timestamp}_{rand}, so re-pasting
    // exported Hyperlit content used to come back as Springer.
    expect(detectFormat(html('<p id="Fn1788040795553_abc">A note.</p>'))).toBe('general');
  });

  it('still falls back to a domain match when nothing matches structurally', () => {
    expect(detectFormat(html('<a href="https://onlinelibrary.wiley.com/doi/10.1/x">paper</a>'))).toBe('wiley');
  });

  it('prefers a structural signature over another format\'s domain link', () => {
    const both = html('<a href="https://www.tandfonline.com/doi/full/10.1/x">cited</a><a class="xref fn"><sup>1</sup></a>');
    expect(detectFormat(both)).toBe('cambridge');
  });

  it('returns general for empty or non-string input', () => {
    expect(detectFormat('')).toBe('general');
    expect(detectFormat(null)).toBe('general');
    expect(detectFormat(undefined)).toBe('general');
  });
});

describe('scoreFormats', () => {
  it('separates signature, supporting and domain hits', () => {
    const dom = document.createElement('div');
    dom.innerHTML = '<div role="listitem">x</div><a href="https://journals.sagepub.com/doi/1">y</a>';
    const sage = scoreFormats(dom).find((s) => s.formatType === 'sage');

    expect(sage.signatureHits).toHaveLength(0);
    expect(sage.supportingHits.map((h) => h.selector)).toContain('[role="listitem"]');
    expect(sage.domainHits.map((h) => h.selector)).toContain('a[href*="sagepub.com"]');
  });

  it('does not throw on a selector that is invalid CSS', () => {
    const dom = document.createElement('div');
    dom.innerHTML = '<p>text</p>';
    expect(() => scoreFormats(dom)).not.toThrow();
  });
});

describe('detectFormatVerbose agrees with detectFormat', () => {
  const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html'));

  it('has fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s', (file) => {
    const html = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    // These used to be two separate implementations, and the verbose one
    // omitted the domain-fallback rule entirely.
    expect(detectFormatVerbose(html).detectedFormat).toBe(detectFormat(html));
  });
});

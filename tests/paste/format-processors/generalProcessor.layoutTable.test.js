/**
 * Layout-table escape for the General processor.
 *
 * Regression source: book_1788218867015 — a paste of a 1999 ACM article
 * (cs.brown.edu memex) whose page layout is one <table width="500"> with a
 * single row: a whitespace spacer <td> plus a second <td> holding the ENTIRE
 * document (h1, h2, every paragraph, the References section). The paste
 * pipeline treats TABLE as an unsplittable block, so the whole ~100KB article
 * became ONE table node.
 *
 * Fix under test: GeneralProcessor.normalize() calls unwrapLayoutTables(),
 * which dissolves LAYOUT tables (page scaffolding) while leaving genuine DATA
 * tables — inline tables in a body of text — completely untouched.
 *
 * Fixture: tests/paste/fixtures/clipboard/web-xanadu-layout-table.html is the
 * raw clipboard capture attached to the bug report.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeneralProcessor } from '../../../resources/js/paste/format-processors/general-processor';
import {
  isLayoutTable,
  unwrapLayoutTables,
} from '../../../resources/js/paste/utils/transform-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', 'clipboard', 'web-xanadu-layout-table.html');

const domFrom = (html) => {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return dom;
};

const tableFrom = (html) => domFrom(html).querySelector('table');

describe('isLayoutTable — classification', () => {
  describe('layout tables (unwrap)', () => {
    it('flags the classic page-wrapper: one row, spacer cell + document cell', () => {
      const table = tableFrom(`
        <table width="500"><tbody><tr>
          <td>&nbsp; &nbsp;</td>
          <td><h1>Title</h1><p>Body paragraph.</p><p>Another.</p></td>
        </tr></tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(true);
    });

    it('flags any table whose cell contains block elements', () => {
      const table = tableFrom(`
        <table><tbody>
          <tr><td><p>Left column prose.</p></td><td><p>Right column prose.</p></td></tr>
          <tr><td><p>More.</p></td><td><p>More.</p></td></tr>
        </tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(true);
    });

    it('flags role="presentation" regardless of shape', () => {
      const table = tableFrom(`
        <table role="presentation"><tbody>
          <tr><td>a</td><td>b</td></tr>
          <tr><td>c</td><td>d</td></tr>
        </tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(true);
    });

    it('flags single-column stacked tables', () => {
      const table = tableFrom(`
        <table><tbody>
          <tr><td>Stacked section one</td></tr>
          <tr><td>Stacked section two</td></tr>
        </tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(true);
    });

    it('flags a 1x1 wrapper cell', () => {
      const table = tableFrom('<table><tbody><tr><td>Just some centered text</td></tr></tbody></table>');
      expect(isLayoutTable(table)).toBe(true);
    });
  });

  describe('data tables (keep)', () => {
    it('keeps a table with a <th> header row', () => {
      const table = tableFrom(`
        <table><thead><tr><th>Year</th><th>Value</th></tr></thead>
        <tbody><tr><td>1999</td><td>42</td></tr></tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(false);
    });

    it('keeps a header-less multi-row key/value table (inline-only cells)', () => {
      // The shape of a pasted "Book ID | book_… / User | toldandretold" table.
      const table = tableFrom(`
        <table><tbody>
          <tr><td>Book ID</td><td>book_1788218867015</td></tr>
          <tr><td>User</td><td>toldandretold (3)</td></tr>
          <tr><td>Timestamp</td><td>2026-08-31</td></tr>
        </tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(false);
    });

    it('keeps a table with a <caption>', () => {
      const table = tableFrom(`
        <table><caption>Table 1</caption><tbody>
          <tr><td>a</td><td>b</td></tr>
        </tbody></table>
      `);
      expect(isLayoutTable(table)).toBe(false);
    });

    it('keeps a single-row data table when no cell is a spacer', () => {
      const table = tableFrom('<table><tbody><tr><td>Alpha</td><td>Beta</td><td>Gamma</td></tr></tbody></table>');
      expect(isLayoutTable(table)).toBe(false);
    });
  });
});

describe('unwrapLayoutTables — dissolution', () => {
  it('promotes cell content in document order and wraps loose inline runs in <p>', () => {
    const dom = domFrom(`
      <table><tbody><tr>
        <td> </td>
        <td><small>Attribution line</small><h1>Title</h1><p>Body.</p></td>
      </tr></tbody></table>
    `);

    const count = unwrapLayoutTables(dom);

    expect(count).toBe(1);
    expect(dom.querySelector('table')).toBeNull();
    const tags = Array.from(dom.children).map((el) => el.tagName);
    // Loose <small> got p-wrapped; the whitespace spacer cell contributed nothing.
    expect(tags).toEqual(['P', 'H1', 'P']);
    expect(dom.children[0].textContent).toBe('Attribution line');
  });

  it('preserves a DATA table nested inside a layout wrapper', () => {
    const dom = domFrom(`
      <table width="500"><tbody><tr><td>
        <p>Intro prose.</p>
        <table><thead><tr><th>Year</th><th>Value</th></tr></thead>
        <tbody><tr><td>1999</td><td>42</td></tr></tbody></table>
        <p>Closing prose.</p>
      </td></tr></tbody></table>
    `);

    const count = unwrapLayoutTables(dom);

    expect(count).toBe(1);
    const remaining = dom.querySelectorAll('table');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].querySelector('th').textContent).toBe('Year');
    expect(dom.querySelectorAll(':scope > p')).toHaveLength(2);
  });

  it('leaves a standalone data table byte-identical', () => {
    const dom = domFrom(`
      <p>Prose before.</p>
      <table><tbody>
        <tr><td>Key</td><td>Value</td></tr>
        <tr><td>Other</td><td>Thing</td></tr>
      </tbody></table>
      <p>Prose after.</p>
    `);
    const before = dom.innerHTML;

    expect(unwrapLayoutTables(dom)).toBe(0);
    expect(dom.innerHTML).toBe(before);
  });

  it('dissolves nested layout tables innermost-first', () => {
    const dom = domFrom(`
      <table><tbody><tr><td>
        <table><tbody><tr><td><p>Deeply nested prose.</p></td></tr></tbody></table>
      </td></tr></tbody></table>
    `);

    expect(unwrapLayoutTables(dom)).toBe(2);
    expect(dom.querySelector('table')).toBeNull();
    expect(dom.querySelector('p').textContent).toBe('Deeply nested prose.');
  });
});

describe('GeneralProcessor + real clipboard fixture (book_1788218867015)', () => {
  it('escapes the page-layout table: no table node, real block structure', async () => {
    const html = readFileSync(FIXTURE, 'utf8');
    const processor = new GeneralProcessor();

    const result = await processor.process(html, 'fixtureBook');
    const out = domFrom(result.html);

    // The layout wrapper is gone…
    expect(out.querySelector('table')).toBeNull();

    // …and the document structure it imprisoned is now top-level flow.
    expect(out.querySelector('h1')?.textContent).toContain('Xanalogical Structure');
    const headings = out.querySelectorAll('h2');
    expect(headings.length).toBeGreaterThan(3); // Summary, sections, References…

    // The article body splits into many paragraph nodes, not one blob.
    expect(out.querySelectorAll('p').length).toBeGreaterThan(20);

    // Reference extraction still works (the bug-report paste extracted 2).
    expect(result.references.length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

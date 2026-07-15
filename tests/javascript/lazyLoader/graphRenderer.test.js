/**
 * graphRenderer — the harvest knowledge-network fork tree. The yield report
 * stores a sanitizer-safe <table data-chart="harvest-network"> (column
 * contract: id | parent | depth | status | title | year | book | cited_by |
 * link — YieldReportBook::networkTableInner); this renderer swaps it for a
 * client-built SVG. These tests pin the contract from the table side.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHarvestNetworks } from '../../../resources/js/lazyLoader/graphRenderer';

const ROOT = 'book_root_1';

function row(cells) {
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

const rootRow = row([ROOT, '', 0, 'root', 'Root Title', '', ROOT, '', '']);

function tableWith(rows) {
  const container = document.createElement('div');
  container.innerHTML =
    `<table data-chart="harvest-network"><tbody>${rows.join('')}</tbody></table>`;
  return container;
}

describe('renderHarvestNetworks', () => {
  it('replaces the marker table with an SVG (one circle per row, one edge per non-root)', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Harvested Work', 2001, 'book_held_1', 42, '']),
      row(['c2', ROOT, 1, 'fetch_failed', 'Failed Work', 1999, '', 3, 'https://doi.org/10.1/x']),
    ]);
    renderHarvestNetworks(container);

    expect(container.querySelector('table')).toBeNull();
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.querySelectorAll('circle').length).toBe(3);
    expect(svg.querySelectorAll('path').length).toBe(2);
  });

  it('links harvested nodes to their held book and failed nodes to the external link', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Harvested Work', 2001, 'book_held_1', 42, '']),
      row(['c2', ROOT, 1, 'fetch_failed', 'Failed Work', 1999, '', 3, 'https://doi.org/10.1/x']),
    ]);
    renderHarvestNetworks(container);
    const anchors = [...container.querySelectorAll('a')];

    const held = anchors.find((a) => a.getAttribute('href') === '/book_held_1');
    expect(held).toBeDefined();
    expect(held.getAttribute('target')).toBeNull(); // in-app, same tab

    const external = anchors.find((a) => a.getAttribute('href') === 'https://doi.org/10.1/x');
    expect(external).toBeDefined();
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener');

    // Keyboard model: Tab never enters content — the renderer runs AFTER
    // chunkRender's tabindex pass, so it must stamp tabindex itself.
    anchors.forEach((a) => expect(a.getAttribute('tabindex')).toBe('-1'));
  });

  it('wires a depth-2 child under its depth-1 parent (via the parent held-book id), not the root', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Level One', 2001, 'book_held_1', 0, '']),
      row(['c2', 'book_held_1', 2, 'assigned', 'Level Two', 2005, 'book_held_2', 0, '']),
    ]);
    renderHarvestNetworks(container);
    const svg = container.querySelector('svg');

    const byTitle = (t) =>
      [...svg.querySelectorAll('a')]
        .find((a) => a.getAttribute('aria-label')?.startsWith(t))
        ?.querySelector('circle');
    const root = byTitle('Root Title');
    const one = byTitle('Level One');
    const two = byTitle('Level Two');

    // Rotated layout: each depth level is one COLUMN to the right.
    expect(Number(one.getAttribute('cx'))).toBeGreaterThan(Number(root.getAttribute('cx')));
    expect(Number(two.getAttribute('cx'))).toBeGreaterThan(Number(one.getAttribute('cx')));
    // A single chain: parent centered over its only child → same y.
    expect(two.getAttribute('cy')).toBe(one.getAttribute('cy'));
  });

  it('reparents an unresolvable parent to the root and tolerates legacy rows', () => {
    const container = tableWith([
      rootRow,
      // Parent book id that matches no row in this union (e.g. harvested for a
      // DIFFERENT root) → fans from the root instead of vanishing.
      row(['c1', 'book_gone', 2, 'assigned', 'Orphan', 2010, 'book_held_9', 0, '']),
    ]);
    renderHarvestNetworks(container);
    const svg = container.querySelector('svg');
    expect(svg.querySelectorAll('circle').length).toBe(2);
    expect(svg.querySelectorAll('path').length).toBe(1); // root → orphan edge drawn
  });

  it('skips malformed rows (no id) without throwing', () => {
    const container = tableWith([
      rootRow,
      row(['', '', '', '', '', '', '', '', '']),
      row(['c1', ROOT, 1, 'deferred', 'Kept', 2015, '', 0, 'https://x.test/y']),
    ]);
    expect(() => renderHarvestNetworks(container)).not.toThrow();
    expect(container.querySelector('svg').querySelectorAll('circle').length).toBe(2);
  });

  it('leaves a rootless table alone as its own fallback', () => {
    const container = tableWith([
      row(['c1', ROOT, 1, 'assigned', 'No Root Here', 2001, 'book_held_1', 0, '']),
    ]);
    renderHarvestNetworks(container);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a root-only table (empty harvest) without crashing', () => {
    const container = tableWith([rootRow]);
    renderHarvestNetworks(container);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.querySelectorAll('circle').length).toBe(1);
    expect(svg.querySelectorAll('path').length).toBe(0);
  });

  it('hover over a node shows the citation card; leaving the svg hides it', () => {
    // Full 14-column row (id..link + author/journal/publisher/type/reason).
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'fetch_failed', 'The Rational Kernel', 1985, '', 120,
        'https://doi.org/10.1/x', 'Amin, Samir', 'Review', '', 'journal-article',
        'blocked by the publisher (Cloudflare)']),
    ]);
    document.body.appendChild(container);
    renderHarvestNetworks(container);
    const svg = container.querySelector('svg');
    const circle = [...svg.querySelectorAll('circle')].find((c) => c.getAttribute('fill') === '#e74c3c');

    circle.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
    const card = document.getElementById('harvest-network-card');
    expect(card).not.toBeNull();
    expect(card.style.visibility).toBe('visible');
    // Citation line: author + quoted article title + venue + year.
    expect(card.textContent).toContain('Amin, Samir, “The Rational Kernel”, Review (1985).');
    // Status line: humanised status + reason + citations.
    expect(card.textContent).toContain('Failed to harvest');
    expect(card.textContent).toContain('blocked by the publisher (Cloudflare)');
    expect(card.textContent).toContain('cited by 120');

    svg.dispatchEvent(new MouseEvent('mouseleave'));
    expect(card.style.visibility).toBe('hidden');
    container.remove();
  });

  it('legacy 9-column rows still render (citation card degrades to title/year)', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Old Format Work', 2001, 'book_held_1', 5, '']),
    ]);
    document.body.appendChild(container);
    renderHarvestNetworks(container);
    const circle = [...container.querySelectorAll('circle')].find((c) => c.getAttribute('fill') === '#27ae60');

    circle.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }));
    const card = document.getElementById('harvest-network-card');
    expect(card.style.visibility).toBe('visible');
    expect(card.textContent).toContain('Old Format Work');
    expect(card.textContent).toContain('(2001)');
    expect(card.textContent).toContain('Harvested');
    container.remove();
  });

  it('touch: tap pins the card (with links inside, no navigation); tap outside closes it', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Tappable Work', 2001, 'book_held_1', 5, '',
        'Doe, Jane', '', 'Verso', 'book', '']),
    ]);
    document.body.appendChild(container);
    renderHarvestNetworks(container);
    const svg = container.querySelector('svg');
    const circle = [...svg.querySelectorAll('circle')].find((c) => c.getAttribute('fill') === '#27ae60');

    // A touch pointerdown precedes the click (how browsers sequence taps).
    const pd = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperty(pd, 'pointerType', { value: 'touch' });
    circle.dispatchEvent(pd);
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 });
    circle.dispatchEvent(tap);

    // Navigation suppressed; card pinned with the node's link INSIDE it.
    expect(tap.defaultPrevented).toBe(true);
    const card = document.getElementById('harvest-network-card');
    expect(card.style.visibility).toBe('visible');
    expect(card.style.pointerEvents).toBe('auto'); // links are tappable
    expect(card.textContent).toContain('Doe, Jane');
    const link = [...card.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/book_held_1');
    expect(link).toBeDefined();

    // Tap outside (not on the card, not on a node) → closes.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(card.style.visibility).toBe('hidden');
    container.remove();
  });

  it('mouse clicks are NOT hijacked by the touch pinning (anchor keeps navigating)', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Clickable Work', 2001, 'book_held_1', 5, '']),
    ]);
    document.body.appendChild(container);
    renderHarvestNetworks(container);
    const circle = [...container.querySelectorAll('circle')].find((c) => c.getAttribute('fill') === '#27ae60');

    const pd = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperty(pd, 'pointerType', { value: 'mouse' });
    circle.dispatchEvent(pd);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    circle.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false); // anchor navigation untouched
    container.remove();
  });

  it('renders an action row: expand button + 3D link (both content-tabindex -1)', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Some Work', 2001, 'book_held_1', 5, '']),
    ]);
    renderHarvestNetworks(container);

    const expand = [...container.querySelectorAll('button')]
      .find((b) => b.textContent.includes('Expand diagram'));
    expect(expand).toBeDefined();
    expect(expand.getAttribute('tabindex')).toBe('-1');

    const threeD = [...container.querySelectorAll('a')]
      .find((a) => a.textContent.includes('See in 3D network'));
    expect(threeD).toBeDefined();
    expect(threeD.getAttribute('href'))
      .toBe(`/3d/${ROOT}?layers=hypercite,citation_verified,citation_auto`);
    expect(threeD.getAttribute('tabindex')).toBe('-1');
  });

  it('clicking Expand opens the figure viewer with the network SVG', async () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Some Work', 2001, 'book_held_1', 5, '']),
    ]);
    document.body.appendChild(container);
    renderHarvestNetworks(container);

    [...container.querySelectorAll('button')]
      .find((b) => b.textContent.includes('Expand diagram'))
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The viewer loads via dynamic import — wait for it to land.
    await vi.waitFor(() => {
      expect(document.getElementById('figure-viewer-overlay')).not.toBeNull();
    });

    const view = document.getElementById('figure-viewer-overlay');
    expect(view.querySelector('svg')).not.toBeNull();
    expect(view.textContent).toContain('Knowledge network — Root Title');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('figure-viewer-overlay')).toBeNull();
    container.remove();
  });

  it('sizes nodes by citation count (log scale, clamped)', () => {
    const container = tableWith([
      rootRow,
      row(['c1', ROOT, 1, 'assigned', 'Tiny', 2001, 'b1', 0, '']),
      row(['c2', ROOT, 1, 'assigned', 'Huge', 2002, 'b2', 1000000, '']),
    ]);
    renderHarvestNetworks(container);
    const r = (t) =>
      Number(
        [...container.querySelectorAll('a')]
          .find((a) => a.getAttribute('aria-label')?.startsWith(t))
          .querySelector('circle')
          .getAttribute('r'),
      );
    expect(r('Tiny')).toBe(4);
    expect(r('Huge')).toBeGreaterThan(r('Tiny'));
    expect(r('Huge')).toBeLessThanOrEqual(12);
  });
});

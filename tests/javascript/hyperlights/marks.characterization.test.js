/**
 * Characterization of resources/js/hyperlights/marks.js — mark-element DOM
 * manipulation + relative-time formatting. Pinned before .js → .ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modifyNewMarks, unwrapMark, formatRelativeTime } from '../../../resources/js/hyperlights/marks';

describe('formatRelativeTime', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_000_000 * 1000)); // now = 1_000_000s
  const ago = (s) => 1_000_000 - s;

  it('buckets a Unix timestamp into now/min/hr/d/w/m/y', () => {
    expect(formatRelativeTime(0)).toBe('prehistoric');     // falsy
    expect(formatRelativeTime(null)).toBe('prehistoric');
    expect(formatRelativeTime(ago(30))).toBe('now');        // < 1 min
    expect(formatRelativeTime(ago(120))).toBe('2min');
    expect(formatRelativeTime(ago(3 * 3600))).toBe('3hr');
    expect(formatRelativeTime(ago(2 * 86400))).toBe('2d');
    expect(formatRelativeTime(ago(2 * 7 * 86400))).toBe('2w');
    expect(formatRelativeTime(ago(2 * 30 * 86400))).toBe('2m');
    expect(formatRelativeTime(ago(2 * 365 * 86400))).toBe('2y');
  });
});

describe('modifyNewMarks', () => {
  it('stamps id (first only), HL class, user-highlight, data attrs and intensity', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p data-node-id="N1"><mark class="highlight">a</mark><mark class="highlight">b</mark></p>';
    document.body.appendChild(host);

    modifyNewMarks('HL_42');
    const marks = host.querySelectorAll('mark');

    expect(marks[0].id).toBe('HL_42');
    expect(marks[1].id).toBe('');                       // id only on the first
    marks.forEach(m => {
      expect(m.classList.contains('HL_42')).toBe(true);
      expect(m.classList.contains('user-highlight')).toBe(true);
      expect(m.classList.contains('highlight')).toBe(false);
      expect(m.getAttribute('data-new-hl')).toBe('HL_42');
      expect(m.getAttribute('data-highlight-count')).toBe('1');
      expect(m.style.getPropertyValue('--highlight-intensity')).toBe('0.2'); // 1/5
    });
    host.remove();
  });
});

describe('unwrapMark', () => {
  it('replaces a mark with its children and normalizes the parent text', () => {
    const p = document.createElement('p');
    p.innerHTML = 'a<mark>b</mark>c';
    unwrapMark(p.querySelector('mark'));
    expect(p.innerHTML).toBe('abc');
    expect(p.childNodes.length).toBe(1); // normalized to one text node
  });

  it('is a no-op for a detached/null mark', () => {
    expect(() => unwrapMark(null)).not.toThrow();
    expect(() => unwrapMark(document.createElement('mark'))).not.toThrow();
  });
});

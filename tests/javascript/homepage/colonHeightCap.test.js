/**
 * The journal/user lockup's colon height (capColonHeight in homepageHero.ts).
 *
 * The squares are sized to the RENDERED title block, which is right until a journal's
 * registered name is a sentence: "tripleC Communication Capitalism & Critique Open Access
 * Journal for a Global Sustainable Information Society" wraps to nine lines and drags the
 * mark to 342px, two squares floating a screen apart with the gap (colon-h / 3 in CSS)
 * blown out to match. The cap is what keeps a long name from wrecking the lockup on any
 * journal whose short hero name has not been set yet.
 *
 * Live coverage: tests/e2e/specs/journal/journal-hero.spec.js (the gap == one square width
 * contract, which the cap must not break).
 */
import { describe, it, expect } from 'vitest';
import { capColonHeight } from '../../../resources/js/components/homepage/homepageHero';

const LINE = 24; // a title line at the default clamp
const CAP = LINE * 3;

describe('capColonHeight', () => {
  it('passes short titles through untouched — one, two and three lines all match exactly', () => {
    expect(capColonHeight(LINE, LINE)).toBe(LINE);
    expect(capColonHeight(LINE * 2, LINE)).toBe(LINE * 2);
    expect(capColonHeight(CAP, LINE)).toBe(CAP);
  });

  it('caps a long name at three lines instead of tracking it', () => {
    // the tripleC case: nine lines measured, three lines of colon
    expect(capColonHeight(342, 38)).toBe(38 * 3);
    expect(capColonHeight(LINE * 9, LINE)).toBe(CAP);
  });

  it('is monotonic and never exceeds the cap, however tall the title gets', () => {
    let prev = 0;
    for (let h = 0; h <= 500; h += 7) {
      const v = capColonHeight(h, LINE);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(CAP);
      prev = v;
    }
  });

  it('does not cap when the line height is unknown (computed `normal` parses to NaN)', () => {
    // Better the old uncapped behaviour than a guessed cap that shrinks a one-line mark.
    expect(capColonHeight(342, NaN)).toBe(342);
    expect(capColonHeight(342, 0)).toBe(342);
  });
});

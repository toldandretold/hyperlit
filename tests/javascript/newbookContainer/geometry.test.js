/**
 * Unit tests for the consolidated form geometry (geometry.ts) — the single source of truth that
 * replaced three copies of the mobile/desktop sizing math. Locks the desktop 400px width (the
 * resize-path normalization: it previously jumped to 500px on window resize).
 */
import { describe, it, expect } from 'vitest';
import {
  computeFormGeometry,
  applyFormGeometry,
} from '../../../resources/js/components/newbookContainer/geometry';

describe('computeFormGeometry', () => {
  it('desktop, right-anchored: 400px below-right of the button', () => {
    const g = computeFormGeometry({
      isMobile: false, isLeftAnchored: false,
      buttonRect: { right: 1150, bottom: 40 }, innerWidth: 1200,
    });
    expect(g).toMatchObject({
      width: '400px', maxWidth: '400px', height: '80vh',
      top: '48px', padding: '0', left: '', right: '50px',
    });
  });

  it('desktop, left-anchored: 400px docked to viewport top-left', () => {
    const g = computeFormGeometry({
      isMobile: false, isLeftAnchored: true,
      buttonRect: { right: 80, bottom: 40 }, innerWidth: 1200,
    });
    expect(g).toMatchObject({ width: '400px', top: '50px', left: '50px', right: '' });
  });

  it('mobile, left-anchored: full-width sheet (innerWidth - 30)', () => {
    const g = computeFormGeometry({
      isMobile: true, isLeftAnchored: true,
      buttonRect: { right: 60, bottom: 40 }, innerWidth: 400,
    });
    expect(g).toMatchObject({
      width: '370px', maxWidth: '370px', height: 'calc(100vh - 100px)',
      top: '50px', padding: '15px', left: '15px',
    });
  });

  it('mobile, right-anchored: width sized from button right edge (right - 15)', () => {
    const g = computeFormGeometry({
      isMobile: true, isLeftAnchored: false,
      buttonRect: { right: 380, bottom: 40 }, innerWidth: 400,
    });
    expect(g).toMatchObject({ width: '365px', maxWidth: '365px' });
  });

  it('desktop width is 400px (NOT the legacy 500px resize value)', () => {
    const g = computeFormGeometry({
      isMobile: false, isLeftAnchored: false,
      buttonRect: { right: 1000, bottom: 40 }, innerWidth: 1200,
    });
    expect(g.width).toBe('400px');
    expect(g.maxWidth).toBe('400px');
  });
});

describe('applyFormGeometry', () => {
  const geom = {
    width: '400px', maxWidth: '400px', height: '80vh', top: '48px', padding: '0',
    left: '50px', right: '20px',
  };

  it('always sets size, only writes left/right when anchoring', () => {
    const el = document.createElement('div');
    applyFormGeometry(el, geom, { anchor: false });
    expect(el.style.width).toBe('400px');
    expect(el.style.height).toBe('80vh');
    expect(el.style.top).toBe('48px');
    expect(el.style.maxWidth).toBe('400px');
    expect(el.style.left).toBe('');   // anchor:false leaves position untouched
    expect(el.style.right).toBe('');
  });

  it('anchor:true writes left/right too', () => {
    const el = document.createElement('div');
    applyFormGeometry(el, geom, { anchor: true });
    expect(el.style.left).toBe('50px');
    expect(el.style.right).toBe('20px');
  });
});

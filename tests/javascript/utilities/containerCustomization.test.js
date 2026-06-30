/**
 * Unit tests for the container customization clamp/heal safety net
 * (resources/js/components/utilities/containerCustomization.ts).
 *
 * These pin the behaviour added to stop a saved container geometry from ever positioning or
 * sizing the panel off-screen:
 *   - sanitizeCustomizations() floors a negative/invalid right/left offset (self-heal).
 *   - applyCustomizations() emits a viewport-reactive width clamp (min(saved, calc(100vw - 2·off)))
 *     and floors the emitted offset.
 *   - loadCustomizations() detects a bad stored offset, rewrites localStorage, and warns.
 *
 * The module is side-effect-only: importing it creates window.containerCustomizer and the
 * <style id="dynamic-container-styles"> element. We drive the logic through that singleton.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import '../../../resources/js/components/utilities/containerCustomization';

const STORAGE_KEY = 'containerCustomizations';

/** Read the generated <style> rule text the customizer maintains. */
function styleText() {
  return document.getElementById('dynamic-container-styles').textContent;
}

describe('containerCustomization clamp/heal', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the generated stylesheet between tests.
    window.containerCustomizer.applyCustomizations({});
  });

  describe('sanitizeCustomizations', () => {
    it('floors a negative px offset to 8px and reports a change', () => {
      const c = { 'source-container': { right: '-300px', width: '2000px' } };
      const changed = window.containerCustomizer.sanitizeCustomizations(c);
      expect(changed).toBe(true);
      expect(c['source-container'].right).toBe('8px');
    });

    it('leaves a valid positive offset and non-px values untouched', () => {
      const c = { 'toc-container': { left: '12px', right: 'auto', width: '400px' } };
      const changed = window.containerCustomizer.sanitizeCustomizations(c);
      expect(changed).toBe(false);
      expect(c['toc-container'].left).toBe('12px');
      expect(c['toc-container'].right).toBe('auto');
    });
  });

  describe('applyCustomizations', () => {
    it('emits a viewport-reactive width clamp for a right-anchored container', () => {
      window.containerCustomizer.updateContainer('source-container', {
        width: '2000px', 'max-width': 'none', right: '12px', left: 'auto', transform: 'translateX(0)',
      });
      const css = styleText();
      expect(css).toContain('width: min(2000px, calc(100vw - 24px))');
      expect(css).toContain('right: 12px');
    });

    it('floors a negative offset in the emitted rule and the width calc', () => {
      window.containerCustomizer.updateContainer('source-container', {
        width: '700px', 'max-width': 'none', right: '-300px', left: 'auto', transform: 'translateX(0)',
      });
      const css = styleText();
      expect(css).toContain('right: 8px');
      expect(css).toContain('width: min(700px, calc(100vw - 16px))');
    });
  });

  describe('loadCustomizations self-heal', () => {
    it('detects a negative stored offset, rewrites localStorage, and warns', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        'source-container': {
          width: '2000px', right: '-300px', left: 'auto', 'max-width': 'none', transform: 'translateX(0)',
        },
      }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      window.containerCustomizer.loadCustomizations();

      const healed = JSON.parse(localStorage.getItem(STORAGE_KEY))['source-container'];
      expect(healed.right).toBe('8px');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

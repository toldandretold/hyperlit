// Reading-layout controls for the settings panel: full-width toggle, text-size +
// content-width sliders (live CSS vars + localStorage + backend pref + scroll-
// anchor preservation), and the debounced resize that repositions perimeter
// buttons. Was the toggleFullWidth / applyTextAdjustments / syncSliderUI /
// handleSliderInput / _debounceResize methods of settingsContainer.js. Takes the
// manager as `self`.
import { captureScrollAnchor, restoreScrollAnchor } from '../../utilities/scrollAnchor.js';
import { savePreference, clearPreference } from '../../utilities/preferences.js';

const STORAGE_KEYS = { TEXT_SIZE: 'hyperlit_text_size', CONTENT_WIDTH: 'hyperlit_content_width', FULL_WIDTH: 'hyperlit_full_width' };
const DEFAULTS = { TEXT_SIZE: 28, TEXT_SIZE_MOBILE: 18, CONTENT_WIDTH: 40 };

/**
 * Toggle full-width mode — reduces main-content padding to near-edge-to-edge.
 * Perimeter buttons stay in place but get transparent backgrounds.
 */
export function toggleFullWidth(self: any) {
  const allMainContent = document.querySelectorAll('.main-content');
  if (!allMainContent.length) return;

  // Capture scroll anchor before layout change
  const wrapper: any = document.querySelector('.reader-content-wrapper');
  const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

  // Determine new state from first element
  const isActive = !(allMainContent[0] as any).classList.contains('full-width-mode');
  allMainContent.forEach(el => el.classList.toggle('full-width-mode', isActive));

  // Restore scroll position after reflow
  if (anchor) restoreScrollAnchor(wrapper, anchor);

  // Update button text and active state
  const btn = document.getElementById('fullWidthToggle');
  if (btn) {
    btn.textContent = isActive ? '<margins>' : '>margins<';
    btn.classList.toggle('active', !isActive);
  }

  // Persist
  if (isActive) {
    localStorage.setItem(STORAGE_KEYS.FULL_WIDTH, 'true');
    savePreference('full_width', true);
  } else {
    localStorage.removeItem(STORAGE_KEYS.FULL_WIDTH);
    clearPreference('full_width');
  }
}

/**
 * Apply saved text size and content width from localStorage.
 * Only sets inline CSS variables if user has explicitly changed from defaults.
 */
export function applyTextAdjustments(self: any) {
  const savedSize = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);
  const savedWidth = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);

  if (savedSize) {
    // Set on <html> so the value survives SPA nav (main-content gets replaced, html doesn't)
    document.documentElement.style.setProperty('--font-size-base', `${savedSize}px`);
  }
  const isMobile = window.innerWidth <= 500;
  if (savedWidth && !isMobile) {
    document.documentElement.style.setProperty('--content-width', `${savedWidth}ch`);
    // Also set inline max-width on wrapper to override global * { max-width: 100% }
    const wrapper = document.querySelector('.reader-content-wrapper') as any;
    if (wrapper) wrapper.style.maxWidth = `${savedWidth}ch`;
  }

  // Restore full-width mode (only on narrower screens where the toggle exists)
  const isFullWidth = localStorage.getItem(STORAGE_KEYS.FULL_WIDTH) === 'true';
  const isNarrow = window.innerWidth <= 768;
  if (isFullWidth && isNarrow) {
    const allMainContent = document.querySelectorAll('.main-content');
    allMainContent.forEach(el => el.classList.add('full-width-mode'));
  }

  // Set margins button text and active state
  const btn = document.getElementById('fullWidthToggle');
  if (btn) {
    btn.textContent = isFullWidth ? '<margins>' : '>margins<';
    btn.classList.toggle('active', !isFullWidth);
  }
}

/**
 * Sync slider UI elements with current values.
 * Called when settings panel opens (sliders may have been destroyed by innerHTML replacement).
 */
export function syncSliderUI(self: any) {
  const isMobile = window.innerWidth <= 500;
  const defaultSize = isMobile ? DEFAULTS.TEXT_SIZE_MOBILE : DEFAULTS.TEXT_SIZE;

  const savedSize = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);
  const savedWidth = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
  const textSize = savedSize ? parseInt(savedSize, 10) : defaultSize;
  const contentWidth = savedWidth ? parseInt(savedWidth, 10) : DEFAULTS.CONTENT_WIDTH;

  const sizeSlider = document.getElementById('textSizeSlider') as any;
  const sizeValue = document.getElementById('textSizeValue');
  const widthSlider = document.getElementById('contentWidthSlider') as any;
  const widthValue = document.getElementById('contentWidthValue');

  if (sizeSlider) {
    sizeSlider.value = textSize;
  }
  if (sizeValue) sizeValue.textContent = `${textSize}px`;
  if (widthSlider) widthSlider.value = contentWidth;
  if (widthValue) widthValue.textContent = `${contentWidth}ch`;

  // Sync full-width button text and active state
  const fullWidthBtn = document.getElementById('fullWidthToggle');
  const isFullWidth = document.querySelector('.main-content')?.classList.contains('full-width-mode');
  if (fullWidthBtn) {
    fullWidthBtn.textContent = isFullWidth ? '<margins>' : '>margins<';
    fullWidthBtn.classList.toggle('active', !isFullWidth);
  }
}

/**
 * Delegated input handler for sliders.
 * Sets CSS variable live, saves to localStorage, dispatches resize for button repositioning.
 */
export function handleSliderInput(self: any, e: any) {
  if (e.target.id === 'textSizeSlider') {
    const val = parseInt(e.target.value, 10);
    const isMobile = window.innerWidth <= 500;
    const defaultSize = isMobile ? DEFAULTS.TEXT_SIZE_MOBILE : DEFAULTS.TEXT_SIZE;

    // Capture scroll anchor before font-size change
    const wrapper: any = document.querySelector('.reader-content-wrapper');
    const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

    // Set on <html> so the value survives SPA nav (main-content gets replaced, html doesn't)
    document.documentElement.style.setProperty('--font-size-base', `${val}px`);
    const display = document.getElementById('textSizeValue');
    if (display) display.textContent = `${val}px`;

    if (val === defaultSize) {
      localStorage.removeItem(STORAGE_KEYS.TEXT_SIZE);
      clearPreference('text_size');
      document.documentElement.style.removeProperty('--font-size-base');
    } else {
      localStorage.setItem(STORAGE_KEYS.TEXT_SIZE, String(val));
      savePreference('text_size', val);
    }

    // Restore scroll position after reflow
    if (anchor) restoreScrollAnchor(wrapper, anchor);

    self._debounceResize();
    return;
  }

  if (e.target.id === 'contentWidthSlider') {
    const val = parseInt(e.target.value, 10);

    // Set max-width directly on .reader-content-wrapper — overrides both
    // the CSS variable and the global * { max-width: 100% } rule
    const wrapper = document.querySelector('.reader-content-wrapper') as any;

    // Capture scroll anchor before width change
    const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

    if (wrapper) wrapper.style.maxWidth = `${val}ch`;

    document.documentElement.style.setProperty('--content-width', `${val}ch`);
    const display = document.getElementById('contentWidthValue');
    if (display) display.textContent = `${val}ch`;

    if (val === DEFAULTS.CONTENT_WIDTH) {
      localStorage.removeItem(STORAGE_KEYS.CONTENT_WIDTH);
      clearPreference('content_width');
      document.documentElement.style.removeProperty('--content-width');
      if (wrapper) wrapper.style.removeProperty('max-width');
    } else {
      localStorage.setItem(STORAGE_KEYS.CONTENT_WIDTH, String(val));
      savePreference('content_width', val);
    }

    // Restore scroll position after reflow
    if (anchor) restoreScrollAnchor(wrapper, anchor);

    self._debounceResize();
    return;
  }
}

/**
 * Debounced resize dispatch — triggers perimeter button repositioning.
 */
export function _debounceResize(self: any) {
  if (self._resizeDebounce) clearTimeout(self._resizeDebounce);
  self._resizeDebounce = setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 150);
}

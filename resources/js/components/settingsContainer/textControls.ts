// Reading-layout controls for the settings panel: full-width toggle, text-size +
// content-width sliders (live CSS vars + localStorage + backend pref + scroll-
// anchor preservation), and the debounced resize that repositions perimeter
// buttons. Was the toggleFullWidth / applyTextAdjustments / syncSliderUI /
// handleSliderInput / _debounceResize methods of settingsContainer.js. Takes the
// manager as `self`.
import { captureScrollAnchor, restoreScrollAnchor } from '../../utilities/scrollAnchor';
import { savePreference, clearPreference } from '../../utilities/preferences';

const STORAGE_KEYS = { TEXT_SIZE: 'hyperlit_text_size', CONTENT_WIDTH: 'hyperlit_content_width', FULL_WIDTH: 'hyperlit_full_width' };
const DEFAULTS = { TEXT_SIZE: 28, TEXT_SIZE_MOBILE: 18, CONTENT_WIDTH: 40 };
// Two distinct breakpoints (kept in sync with the CSS):
//  - FONT_MOBILE_BP: below this the text-size default flips 28→18px (variables.css + app.css @500).
//  - WIDTH_HIDE_BP: below this the width slider is hidden and --content-width is forced to 100%
//    (containers.css + variables.css @400), so a saved ch-width must NOT be re-applied there.
const FONT_MOBILE_BP = 500;
const WIDTH_HIDE_BP = 400;

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
 * Reconcile the content-width inline artifacts with the current viewport.
 *
 * Below WIDTH_HIDE_BP the width slider is hidden and the column must be the
 * full-width CSS default (--content-width:100% @400). Since the saved width is
 * applied as INLINE style (on <html> + the wrapper) and inline beats the
 * stylesheet — even the @media rule — a value set while the viewport was wider
 * would otherwise linger as a too-narrow column after shrinking past the
 * breakpoint without a reload (live resize / rotate / devtools).
 *
 * So we STRIP the inline artifacts when below the breakpoint, and (re)apply the
 * saved width when above it. Crucially this never touches localStorage or the
 * backend preference — only the ephemeral inline styles — so the user's saved
 * width returns intact when they're back on a wide screen / desktop.
 */
export function reconcileViewportWidth(_self?: any) {
  const wrapper = document.querySelector('.reader-content-wrapper') as any;
  const widthControlHidden = window.innerWidth <= WIDTH_HIDE_BP;
  const savedWidth = widthControlHidden ? null : localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);

  if (savedWidth) {
    document.documentElement.style.setProperty('--content-width', `${savedWidth}ch`);
    // Inline max-width on wrapper to override global * { max-width: 100% }
    if (wrapper) wrapper.style.maxWidth = `${savedWidth}ch`;
  } else {
    // Below the breakpoint, or no saved width: clear inline artifacts so the
    // stylesheet (--content-width) governs. The saved preference is untouched.
    document.documentElement.style.removeProperty('--content-width');
    if (wrapper) wrapper.style.removeProperty('max-width');
  }
}

/**
 * Apply saved text size and content width from localStorage.
 * Only sets inline CSS variables if user has explicitly changed from defaults.
 */
export function applyTextAdjustments(self: any) {
  const savedSize = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);

  if (savedSize) {
    // Set on <html> so the value survives SPA nav (main-content gets replaced, html doesn't)
    document.documentElement.style.setProperty('--font-size-base', `${savedSize}px`);
  }
  // Apply/strip the inline content-width to match the current viewport.
  reconcileViewportWidth(self);

  // Restore full-width mode only where the toggle exists to turn it back off —
  // i.e. exactly where the width slider is hidden (≤ WIDTH_HIDE_BP).
  const isFullWidth = localStorage.getItem(STORAGE_KEYS.FULL_WIDTH) === 'true';
  const isNarrow = window.innerWidth <= WIDTH_HIDE_BP;
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
  const isMobile = window.innerWidth <= FONT_MOBILE_BP;
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
    const isMobile = window.innerWidth <= FONT_MOBILE_BP;
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

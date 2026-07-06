// Reading-layout controls for the settings panel: text-size + column-width
// STEPPERS (bigger/smaller, narrow/widen — no sliders) that write live CSS vars,
// localStorage + backend pref, preserve the scroll anchor, and debounce the
// resize that repositions perimeter buttons. Each stepper dims (disables) at its
// bound: text size at MIN/MAX; column width at MIN and at the widest that still
// fits the viewport — so on a narrow phone, where only ~2 widths fit, the buttons
// automatically collapse to those two. Takes the manager as `self`.
import { captureScrollAnchor, restoreScrollAnchor } from '../../utilities/scrollAnchor';
import { savePreference, clearPreference } from '../../utilities/preferences';

const STORAGE_KEYS = { TEXT_SIZE: 'hyperlit_text_size', CONTENT_WIDTH: 'hyperlit_content_width' };
// Text size steps in px between MIN..MAX; default flips 28→18 below FONT_MOBILE_BP
// (kept in sync with variables.css + app.css @500).
const TEXT = { MIN: 14, MAX: 48, STEP: 2, DEFAULT: 28, DEFAULT_MOBILE: 18 };
// Column width steps in ch between MIN..MAX. The effective max is additionally
// clamped to what fits the viewport (see effectiveMaxWidth).
const WIDTH = { MIN: 25, MAX: 80, STEP: 5, DEFAULT: 40 };
const FONT_MOBILE_BP = 500;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The reading column element (reader page → wrapper, home/user → main-content). */
function columnEl(): HTMLElement | null {
  return (document.querySelector('.reader-content-wrapper')
    || document.querySelector('.main-content')) as HTMLElement | null;
}

/** Width of one `ch` (the column's current font) in px — used to know how many
 *  chars fit the viewport. Larger text ⇒ wider ch ⇒ fewer columns fit. */
function measureCh(el: HTMLElement): number {
  const probe = document.createElement('span');
  probe.textContent = '0000000000';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;padding:0;border:0;left:-9999px;';
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return w;
}

/** The widest column (in ch) that actually fits the viewport, clamped to WIDTH.MAX.
 *  Below this the "widen" button stops mattering, so we dim it there. */
function effectiveMaxWidth(): number {
  const col = columnEl();
  if (!col) return WIDTH.MAX;
  const parent = col.parentElement as HTMLElement | null;
  const avail = (parent && parent.clientWidth) || document.documentElement.clientWidth || window.innerWidth;
  const ch = measureCh(col);
  if (!avail || !ch) return WIDTH.MAX;
  return clamp(Math.floor(avail / ch), WIDTH.MIN, WIDTH.MAX);
}

function viewportTextDefault(): number {
  return window.innerWidth <= FONT_MOBILE_BP ? TEXT.DEFAULT_MOBILE : TEXT.DEFAULT;
}

/** Current text size (px), clamped into the stepper range. */
function currentTextSize(): number {
  const saved = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);
  if (saved) return clamp(parseInt(saved, 10), TEXT.MIN, TEXT.MAX);
  return viewportTextDefault();
}

/** Saved/default column width in ch, before the viewport-fit clamp. */
function savedWidth(): number {
  const saved = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
  return saved ? parseInt(saved, 10) : WIDTH.DEFAULT;
}

function setDisabled(id: string, disabled: boolean) {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  if (el) el.disabled = disabled;
}

/** Dim the text steppers at their bounds. */
function updateTextButtons() {
  const cur = currentTextSize();
  setDisabled('textSizeDecrease', cur <= TEXT.MIN);
  setDisabled('textSizeIncrease', cur >= TEXT.MAX);
}

/** Dim the width steppers at MIN and at the widest that fits the viewport. */
function updateWidthButtons() {
  const emax = effectiveMaxWidth();
  const cur = clamp(savedWidth(), WIDTH.MIN, emax);
  setDisabled('widthNarrow', cur <= WIDTH.MIN);
  setDisabled('widthWiden', cur >= emax);
}

/** Write the column width: default clears the pref (stylesheet governs), else
 *  pins it as an inline var + wrapper max-width (beats `* { max-width:100% }`). */
function applyWidth(val: number) {
  const wrapper = document.querySelector('.reader-content-wrapper') as HTMLElement | null;
  if (val === WIDTH.DEFAULT) {
    localStorage.removeItem(STORAGE_KEYS.CONTENT_WIDTH);
    clearPreference('content_width');
    document.documentElement.style.removeProperty('--content-width');
    if (wrapper) wrapper.style.removeProperty('max-width');
  } else {
    localStorage.setItem(STORAGE_KEYS.CONTENT_WIDTH, String(val));
    savePreference('content_width', val);
    document.documentElement.style.setProperty('--content-width', `${val}ch`);
    if (wrapper) wrapper.style.maxWidth = `${val}ch`;
  }
}

/**
 * Reconcile the applied column width with the current viewport (live resize /
 * rotate / devtools). Re-clamps the saved width to what now fits and re-applies,
 * then refreshes the bounds-dimming. Never touches the SAVED preference unless
 * the fit actually shrank it — so a wide-screen width returns intact on desktop.
 */
export function reconcileViewportWidth(_self?: any) {
  const saved = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
  if (saved) {
    const clamped = clamp(parseInt(saved, 10), WIDTH.MIN, effectiveMaxWidth());
    // Only re-apply inline artifacts; keep the stored preference as the user set it.
    document.documentElement.style.setProperty('--content-width', `${clamped}ch`);
    const wrapper = document.querySelector('.reader-content-wrapper') as HTMLElement | null;
    if (wrapper) wrapper.style.maxWidth = `${clamped}ch`;
  } else {
    document.documentElement.style.removeProperty('--content-width');
    const wrapper = document.querySelector('.reader-content-wrapper') as HTMLElement | null;
    if (wrapper) wrapper.style.removeProperty('max-width');
  }
  updateWidthButtons();
}

/**
 * Apply saved text size and column width from localStorage on load / SPA-nav.
 * Only sets inline CSS vars when the user has changed from defaults.
 */
export function applyTextAdjustments(self: any) {
  const savedSize = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);
  if (savedSize) {
    // Set on <html> so it survives SPA nav (main-content is replaced, html isn't).
    document.documentElement.style.setProperty('--font-size-base', `${savedSize}px`);
  }
  reconcileViewportWidth(self);
}

/**
 * Refresh the stepper bounds-dimming when the panel opens (the base
 * ContainerManager resets innerHTML, so the buttons are fresh each open).
 */
export function syncControlsUI(_self: any) {
  updateTextButtons();
  updateWidthButtons();
}

/** Step the text size by ±TEXT.STEP (dir = +1 larger / -1 smaller). */
export function stepTextSize(self: any, dir: number) {
  const cur = currentTextSize();
  const next = clamp(cur + dir * TEXT.STEP, TEXT.MIN, TEXT.MAX);
  if (next === cur) return;

  const wrapper: any = document.querySelector('.reader-content-wrapper');
  const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

  const def = viewportTextDefault();
  if (next === def) {
    localStorage.removeItem(STORAGE_KEYS.TEXT_SIZE);
    clearPreference('text_size');
    document.documentElement.style.removeProperty('--font-size-base');
  } else {
    document.documentElement.style.setProperty('--font-size-base', `${next}px`);
    localStorage.setItem(STORAGE_KEYS.TEXT_SIZE, String(next));
    savePreference('text_size', next);
  }

  if (anchor) restoreScrollAnchor(wrapper, anchor);

  updateTextButtons();
  updateWidthButtons(); // font-size change alters ch fit → width bounds move
  self._debounceResize();
}

/** Step the column width by ±WIDTH.STEP (dir = +1 wider / -1 narrower),
 *  clamped to what fits the viewport. */
export function stepWidth(self: any, dir: number) {
  const emax = effectiveMaxWidth();
  const cur = clamp(savedWidth(), WIDTH.MIN, emax);
  const next = clamp(cur + dir * WIDTH.STEP, WIDTH.MIN, emax);
  if (next === cur) return;

  const wrapper: any = document.querySelector('.reader-content-wrapper');
  const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

  applyWidth(next);

  if (anchor) restoreScrollAnchor(wrapper, anchor);

  updateWidthButtons();
  self._debounceResize();
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

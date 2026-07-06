// Reading-layout controls for the settings panel: text-size + column-width
// STEPPERS (bigger/smaller, narrow/widen) that write live CSS vars, localStorage
// + backend pref, preserve the scroll anchor, and debounce the resize that
// repositions perimeter buttons.
//
// TWO WIDTH REGIMES (same as the old slider + >margins< toggle):
//  - Wide viewports (> WIDTH_HIDE_BP): the steppers move the saved ch-width
//    between WIDTH.MIN and the widest that fits the viewport.
//  - Narrow viewports (≤ WIDTH_HIDE_BP, i.e. phones): the saved ch-width is
//    NEVER applied — the stylesheet's --content-width:100% governs. There are
//    exactly TWO width settings: default margins, and full-width-mode (margins
//    out). The narrow/widen steppers toggle between them; "narrow" dims at
//    default, "widen" dims at full-width.
// Steppers dim (disable) at their bounds. Takes the manager as `self`.
import { captureScrollAnchor, restoreScrollAnchor } from '../../utilities/scrollAnchor';
import { savePreference, clearPreference } from '../../utilities/preferences';

const STORAGE_KEYS = { TEXT_SIZE: 'hyperlit_text_size', CONTENT_WIDTH: 'hyperlit_content_width', FULL_WIDTH: 'hyperlit_full_width' };
// Text size steps in px between MIN..MAX; default flips 28→18 below FONT_MOBILE_BP
// (kept in sync with variables.css + app.css @500).
const TEXT = { MIN: 14, MAX: 48, STEP: 2, DEFAULT: 28, DEFAULT_MOBILE: 18 };
// Column width steps in ch between MIN..MAX (wide viewports only). The effective
// max is additionally clamped to what fits the viewport (see effectiveMaxWidth).
const WIDTH = { MIN: 25, MAX: 80, STEP: 5, DEFAULT: 40 };
// Two distinct breakpoints (kept in sync with the CSS):
//  - FONT_MOBILE_BP: below this the text-size default flips 28→18px (variables.css + app.css @500).
//  - WIDTH_HIDE_BP: at/below this --content-width is forced to 100% by the
//    stylesheet (variables.css @400) and a saved ch-width must NOT be applied;
//    the width steppers become the two-state margins toggle instead.
const FONT_MOBILE_BP = 500;
const WIDTH_HIDE_BP = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Phones: the two-state margins regime (saved ch-widths never apply here). */
function isNarrowViewport(): boolean {
  return window.innerWidth <= WIDTH_HIDE_BP;
}

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
 *  Beyond this the "widen" button stops mattering, so we dim it there. */
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

/** Saved/default column width in ch (wide-viewport regime only). */
function savedWidth(): number {
  const saved = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
  return saved ? parseInt(saved, 10) : WIDTH.DEFAULT;
}

function isFullWidthMode(): boolean {
  return !!document.querySelector('.main-content')?.classList.contains('full-width-mode');
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

/** Dim the width steppers at their bounds — per regime. */
function updateWidthButtons() {
  if (isNarrowViewport()) {
    // Two-state margins toggle: default (narrow) ⟷ full-width (wide).
    const full = isFullWidthMode();
    setDisabled('widthNarrow', !full);
    setDisabled('widthWiden', full);
    return;
  }
  const emax = effectiveMaxWidth();
  const cur = clamp(savedWidth(), WIDTH.MIN, emax);
  setDisabled('widthNarrow', cur <= WIDTH.MIN);
  setDisabled('widthWiden', cur >= emax);
}

/** Write the ch column width (wide regime): default clears the pref (stylesheet
 *  governs), else pins it as an inline var + wrapper max-width (beats
 *  `* { max-width:100% }`). */
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

/** Toggle full-width-mode (narrow regime) — margins out / back to default. */
function setFullWidthMode(active: boolean) {
  document.querySelectorAll('.main-content').forEach(el => el.classList.toggle('full-width-mode', active));
  if (active) {
    localStorage.setItem(STORAGE_KEYS.FULL_WIDTH, 'true');
    savePreference('full_width', true);
  } else {
    localStorage.removeItem(STORAGE_KEYS.FULL_WIDTH);
    clearPreference('full_width');
  }
}

/**
 * Reconcile the width artifacts with the current viewport (load / SPA-nav /
 * live resize / rotate / devtools).
 *
 * Below WIDTH_HIDE_BP the saved ch-width must NOT apply: since it's applied as
 * INLINE style (on <html> + the wrapper) and inline beats the stylesheet — even
 * the @media --content-width:100% rule — a value set on a wider screen would
 * linger as a too-narrow column on a phone. So we STRIP the inline artifacts
 * there and restore the saved full-width-mode class instead. Above the
 * breakpoint we (re)apply the saved ch-width and drop full-width-mode (a
 * phones-only state). Never touches localStorage or the backend prefs — the
 * saved width returns intact when back on a wide screen.
 */
export function reconcileViewportWidth(_self?: any) {
  const wrapper = document.querySelector('.reader-content-wrapper') as HTMLElement | null;

  if (isNarrowViewport()) {
    document.documentElement.style.removeProperty('--content-width');
    if (wrapper) wrapper.style.removeProperty('max-width');
    // Restore the phone's own two-state setting.
    const full = localStorage.getItem(STORAGE_KEYS.FULL_WIDTH) === 'true';
    document.querySelectorAll('.main-content').forEach(el => el.classList.toggle('full-width-mode', full));
  } else {
    document.querySelectorAll('.main-content').forEach(el => el.classList.remove('full-width-mode'));
    const saved = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
    if (saved) {
      document.documentElement.style.setProperty('--content-width', `${saved}ch`);
      // Inline max-width on wrapper to override global * { max-width: 100% }
      if (wrapper) wrapper.style.maxWidth = `${saved}ch`;
    } else {
      document.documentElement.style.removeProperty('--content-width');
      if (wrapper) wrapper.style.removeProperty('max-width');
    }
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

/** Step the column width (dir = +1 wider / -1 narrower). On phones this is the
 *  two-state margins toggle; on wide viewports it steps the saved ch-width,
 *  clamped to what fits. */
export function stepWidth(self: any, dir: number) {
  const wrapper: any = document.querySelector('.reader-content-wrapper');
  const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

  if (isNarrowViewport()) {
    const full = isFullWidthMode();
    const wantFull = dir > 0;
    if (wantFull === full) return; // already at that bound
    setFullWidthMode(wantFull);
  } else {
    const emax = effectiveMaxWidth();
    const cur = clamp(savedWidth(), WIDTH.MIN, emax);
    const next = clamp(cur + dir * WIDTH.STEP, WIDTH.MIN, emax);
    if (next === cur) return;
    applyWidth(next);
  }

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

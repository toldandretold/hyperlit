// Reading-mode preference (scroll vs paginated). Mirrors themeSwitcher: this
// module owns only the PREFERENCE (localStorage + backend + body class + event);
// actual pagination engagement is reconciled by scrolling/paginator.ts
// syncEngagement(), which listens for the 'readingmodechange' event — the
// preference can be "paginated" while the paginator stays disengaged (home
// page, edit mode).
import { savePreference } from '../../utilities/preferences';

const READING_MODE_STORAGE_KEY = 'hyperlit_reading_mode';

export const READING_MODES = {
  SCROLL: 'scroll',
  PAGINATED: 'paginated',
} as const;

export type ReadingMode = (typeof READING_MODES)[keyof typeof READING_MODES];

let currentMode: ReadingMode = READING_MODES.SCROLL;

function isReadingMode(value: unknown): value is ReadingMode {
  return value === READING_MODES.SCROLL || value === READING_MODES.PAGINATED;
}

export function getReadingMode(): ReadingMode {
  return currentMode;
}

function applyReadingModeClass(mode: ReadingMode): void {
  document.body.classList.toggle('reading-mode-paginated', mode === READING_MODES.PAGINATED);
}

export function switchReadingMode(mode: ReadingMode): void {
  if (!isReadingMode(mode) || mode === currentMode) return;

  currentMode = mode;
  applyReadingModeClass(mode);

  localStorage.setItem(READING_MODE_STORAGE_KEY, mode);
  savePreference('reading_mode', mode);

  window.dispatchEvent(new CustomEvent('readingmodechange', { detail: { mode } }));
}

export function initializeReadingMode(): ReadingMode {
  const saved = localStorage.getItem(READING_MODE_STORAGE_KEY);
  currentMode = isReadingMode(saved) ? saved : READING_MODES.SCROLL;
  applyReadingModeClass(currentMode);
  return currentMode;
}

/**
 * Entry for the standalone docuverse page (docuverse.blade.php — non-SPA).
 * Fetches the graph for the CURRENTLY SELECTED connection layers, then
 * dynamically imports the Three.js scene. Changing a layer checkbox refetches
 * from the server (the graph is rebuilt per selection server-side — a longish
 * load on toggle is accepted) and tears down + rebuilds the scene.
 */

import { log } from '../utilities/logger';
import type { DocuversePayload } from './types';

declare global {
  interface Window {
    __docuverse?: { focus: string | null };
  }
}

let disposeScene: (() => void) | null = null;
let fetchSeq = 0;
let lastPayload: DocuversePayload | null = null;

// ── Theme (shared with the reader: same storage key + body classes) ──
const THEME_KEY = 'hyperlit_theme_preference';
const THEMES = ['dark', 'light', 'sepia'];

function applyTheme(theme: string): void {
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-sepia', 'theme-vibe');
  document.body.classList.add(`theme-${theme}`);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* storage may be unavailable; theme still applies this visit */ }
  markActiveTheme();
  // The WebGL scene can't read CSS live — rebuild it from the cached payload
  // (no refetch) so background/axis/palette re-resolve under the new theme.
  if (lastPayload && disposeScene) {
    const stage = document.getElementById('dv-stage');
    disposeScene();
    disposeScene = null;
    if (stage) {
      void import('./scene').then(({ startScene }) => {
        if (lastPayload) disposeScene = startScene(stage, lastPayload);
      });
    }
  }
}

function markActiveTheme(): void {
  const current = THEMES.find((t) => document.body.classList.contains(`theme-${t}`)) ?? 'dark';
  document.querySelectorAll<HTMLButtonElement>('#dv-theme-picker button').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.theme === current));
  });
}

function wireThemePicker(): void {
  const toggle = document.getElementById('dv-theme-toggle');
  const picker = document.getElementById('dv-theme-picker');
  if (!toggle || !picker) return;
  toggle.addEventListener('click', () => {
    picker.hidden = !picker.hidden;
    toggle.setAttribute('aria-expanded', String(!picker.hidden));
  });
  picker.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach((el) => {
    el.addEventListener('click', () => {
      applyTheme(el.dataset.theme!);
      picker.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
  // Click elsewhere closes the picker.
  document.addEventListener('pointerdown', (event) => {
    if (!picker.hidden && !(event.target as Element).closest?.('#dv-theme')) {
      picker.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  markActiveTheme();
}

// ?layers=… presets the checkboxes (the yield report links here with all
// layers on — a fresh harvest's links are auto-matched citations, so the
// default hypercite+verified view would land empty).
// A checkbox may carry a COMPOUND value ("citation_verified,citation_auto" —
// the single Citations toggle requests both API kinds), so always split on ','.
const presetLayers = new URLSearchParams(window.location.search).get('layers');
if (presetLayers) {
  const wanted = new Set(presetLayers.split(','));
  document.querySelectorAll<HTMLInputElement>('.dv-layers input[type="checkbox"]').forEach((el) => {
    el.checked = el.value.split(',').some((v) => wanted.has(v));
  });
}

function selectedLayers(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('.dv-layers input[type="checkbox"]:checked')]
    .flatMap((el) => el.value.split(','));
}

function setStatus(text: string | null): void {
  const status = document.getElementById('dv-status');
  if (!status) return;
  status.textContent = text ?? '';
  status.style.display = text ? 'flex' : 'none';
}

async function loadAndRender(): Promise<void> {
  const stage = document.getElementById('dv-stage');
  if (!stage) return;
  const seq = ++fetchSeq;
  const layers = selectedLayers();

  disposeScene?.();
  disposeScene = null;

  if (layers.length === 0) {
    setStatus('Pick at least one connection layer.');
    return;
  }
  setStatus('Charting the docuverse…');

  try {
    const focus = window.__docuverse?.focus;
    const params = new URLSearchParams({ layers: layers.join(',') });
    if (focus) params.set('focus', focus);
    const resp = await fetch(`/api/docuverse/data?${params}`);
    if (!resp.ok) throw new Error(`data fetch failed (${resp.status})`);
    const payload = (await resp.json()) as DocuversePayload;
    if (seq !== fetchSeq) return; // a newer toggle superseded this fetch

    if (payload.nodes.length === 0) {
      setStatus(focus
        ? 'This book isn’t linked into the docuverse on these layers yet — verify citations, hypercite across books, or add a layer.'
        : 'No connected works on these layers yet — link some texts, or add a layer.');
      return;
    }

    const { startScene } = await import('./scene');
    if (seq !== fetchSeq) return;
    setStatus(null);
    lastPayload = payload; // theme switches rebuild from this, no refetch
    disposeScene = startScene(stage, payload);
  } catch (error) {
    log.error(`Docuverse failed to load: ${(error as Error).message}`, 'docuverse3d');
    if (seq === fetchSeq) setStatus('The docuverse could not be loaded. Try refreshing.');
  }
}

document.querySelectorAll<HTMLInputElement>('.dv-layers input[type="checkbox"]').forEach((el) => {
  el.addEventListener('change', () => void loadAndRender());
});

// Legend + "Connected by" collapse to their title. Phones start collapsed
// (screen space is the scene's); desktop starts open but can tuck them away.
function wireCollapsibles(): void {
  const compact = !!window.matchMedia?.('(max-width: 700px)').matches
    || !!window.matchMedia?.('(pointer: coarse)').matches;
  document.querySelectorAll<HTMLButtonElement>('.dv-collapse-toggle').forEach((btn) => {
    const target = document.getElementById(btn.dataset.target ?? '');
    if (!target) return;
    const set = (open: boolean): void => {
      target.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', () => set(!!target.hidden)); // !! — `hidden` types as boolean|'until-found'
    if (compact) set(false);
  });
}

wireCollapsibles();
wireThemePicker();
void loadAndRender();

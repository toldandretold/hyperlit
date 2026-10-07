// Book-translation live-progress overlay: a full-screen layer that renders
// the translation stage chain (queued → text → notes → write) from the stage
// map + boundary telemetry the status endpoint already returns. Modeled on
// the Knowledge Commons Harvester viz (creatorTools/harvestViz.ts) — same
// status palette, horizontal/vertical responsive chain, pin-able details
// panel — but module-scoped (bookTranslation.ts is a module, not a
// ContainerManager) and simpler: no substages, no stop buttons (closing the
// overlay never stops the run; the job owns its own lifecycle).
//
// The static stage descriptions come from GET /api/book-translation/map
// (TranslationMap server-side), fetched LAZILY the first time the overlay
// opens and cached for the page's lifetime — the Translate section's init
// must stay fetch-free (its vitest suite counts fetch calls).
import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { log } from '../../utilities/logger';
import type { BookTranslationStatus } from './bookTranslation';

const FILE = 'components/sourceContainer/translationViz.ts';

interface MapStage {
  id: string;
  title: string;
  plain: string;
  dev: string;
  code_ref: string;
  signals: string[];
}

let mapStages: MapStage[] | null = null;
let overlay: HTMLElement | null = null;
let trapRelease: (() => void) | null = null;
let resizeHandler: (() => void) | null = null;
let unfollow: (() => void) | null = null;
let pinnedStage: string | null = null;
let lastStatus: BookTranslationStatus | null = null;

async function fetchMap(): Promise<MapStage[]> {
  if (mapStages) return mapStages;
  try {
    const resp = await fetch('/api/book-translation/map', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const data: any = await resp.json().catch(() => ({}));
    if (resp.ok && Array.isArray(data.stages)) mapStages = data.stages;
  } catch (err) {
    log.error('failed to load the translation stage map', FILE, err);
  }

  return mapStages ?? [];
}

/**
 * Open the overlay for one book's run. `follow` subscribes the overlay to the
 * module-level run watch (bookTranslation.ts owns it) and returns an
 * unsubscribe — passed in rather than imported, so this module stays a leaf.
 */
export async function openTranslationVizOverlay(
  status: BookTranslationStatus,
  follow?: (listener: (s: BookTranslationStatus) => void) => () => void,
): Promise<void> {
  if (document.getElementById('translation-viz-overlay')) return;

  lastStatus = status;
  pinnedStage = null;

  const el = document.createElement('div');
  el.id = 'translation-viz-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Book translation — live progress');
  el.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';
  el.innerHTML = `
      <style>
        @keyframes translationPipePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        /* App theme styles p/strong/code with its own palette — pin them. */
        #translation-viz-card p      { color: #d8d8d8; margin: 0; font-family: inherit; }
        #translation-viz-card strong { color: #ffffff; }
        #translation-viz-card code   { color: #8fd0c6; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; }
      </style>
      <div id="translation-viz-card" style="background: #2a2a2a; color: #fff; border-radius: 10px; width: min(92vw, 1100px); max-height: 86vh; display: flex; flex-direction: column; overflow: hidden;">
        <div style="flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 24px 32px 16px;">
          <h3 style="margin: 0; color: #EF8D34; font-size: 16px;">Book translation — live progress</h3>
          <button type="button" id="translation-viz-close" title="Close (the translation keeps running)" aria-label="Close" style="background: none; border: none; color: #aaa; font-size: 22px; cursor: pointer; line-height: 1; padding: 2px 6px;">×</button>
        </div>
        <div id="translation-viz-scroll" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 32px 20px;">
          <div id="translation-viz">
            <p style="font-size: 13px; color: #aaa; margin: 0;">Loading translation state…</p>
          </div>
        </div>
      </div>`;
  document.body.appendChild(el);
  overlay = el;

  el.addEventListener('click', (e) => { if (e.target === el) closeTranslationVizOverlay(); });
  el.querySelector('#translation-viz-close')?.addEventListener('click', () => closeTranslationVizOverlay());

  // Focus trap: seat focus inside, cycle within, Escape closes, restore on close.
  trapRelease = trapModalFocus(el, { onEscape: () => closeTranslationVizOverlay() });

  // Re-render on resize so the chain flips horizontal ↔ vertical.
  resizeHandler = () => { if (lastStatus) render(lastStatus); };
  window.addEventListener('resize', resizeHandler);

  // Live updates ride the existing run watch — the overlay re-renders on
  // every poll and unsubscribes on close (the watch itself keeps going).
  unfollow = follow ? follow((s) => updateTranslationViz(s)) : null;

  await fetchMap();
  render(status);
}

/** Feed a fresh status payload to the overlay; a no-op while it's closed. */
export function updateTranslationViz(status: BookTranslationStatus): void {
  lastStatus = status;
  if (overlay) render(status);
}

/** Close and unhook. The RUN is untouched — only the window goes away. */
export function closeTranslationVizOverlay(): void {
  trapRelease?.();
  trapRelease = null;
  unfollow?.();
  unfollow = null;
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  document.getElementById('translation-viz-overlay')?.remove();
  overlay = null;
  pinnedStage = null;
}

type StageState = 'done' | 'running' | 'failed' | 'skipped' | 'pending';

/**
 * A stage's display state from the latest-state map the server keeps
 * (progress.stages), with harvest's inference fallback for progress files
 * that predate the map: position relative to the current stage.
 */
function statusOf(stageId: string, status: BookTranslationStatus): StageState {
  const overall = status.progress?.status ?? null;
  const raw = status.progress?.stages?.[stageId]?.status ?? null;
  let st: StageState | null = null;
  if (raw === 'completed') st = 'done';
  else if (raw === 'failed') st = 'failed';
  else if (raw === 'skipped') st = 'skipped';
  else if (raw !== null) st = 'running'; // started / progress

  // A finished run leaves no stage still pending/running — a gap just means
  // it was never recorded (old progress file); render it done, not stuck.
  if (overall === 'done' && (st === null || st === 'running')) return 'done';
  if (st) return st;

  const order = (mapStages ?? []).map((s) => s.id);
  const cur = order.indexOf(status.progress?.stage ?? '');
  const idx = order.indexOf(stageId);
  if (cur === -1 || idx === -1) return 'pending';
  if (idx < cur) return 'done';
  if (idx === cur) return overall === 'failed' ? 'failed' : 'running';

  return 'pending';
}

const PALETTE: Record<StageState, { ring: string; fill: string; text: string; icon: string; line: string }> = {
  done:    { ring: '#27ae60', fill: '#27ae60', text: '#27ae60', icon: '✓', line: '#27ae60' },
  running: { ring: '#EF8D34', fill: '#EF8D34', text: '#EF8D34', icon: '●', line: '#555'    },
  failed:  { ring: '#e74c3c', fill: '#e74c3c', text: '#e74c3c', icon: '✗', line: '#555'    },
  skipped: { ring: '#777',    fill: 'transparent', text: '#999', icon: '–', line: '#555'   },
  pending: { ring: '#555',    fill: 'transparent', text: '#888', icon: '',  line: '#444'   },
};

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any
)[c]);

/** The stage map's live signals, prettied for the details panel. */
function signalsHtmlFor(stageId: string, status: BookTranslationStatus): string {
  const live: any = status.progress?.stages?.[stageId] ?? {};
  const parts: string[] = [];
  if (live.section && live.sections) {
    parts.push(`<span style="color:#999;">section:</span> <strong>${esc(live.section)}/${esc(live.sections)}</strong>`);
  }
  if (live.title) parts.push(`<span style="color:#999;">now:</span> <strong>${esc(live.title)}</strong>`);
  if (typeof live.chars_done === 'number' && typeof live.chars_total === 'number' && live.chars_total > 0) {
    parts.push(`<span style="color:#999;">characters:</span> <strong>${live.chars_done.toLocaleString()} / ${live.chars_total.toLocaleString()}</strong>`);
  }
  if (live.paragraphs) parts.push(`<span style="color:#999;">paragraphs:</span> <strong>${esc(live.paragraphs)}</strong>`);
  if (live.retried) parts.push(`<span style="color:#999;">retried:</span> <strong>${esc(live.retried)}</strong>`);

  return parts.length
    ? `<p style="margin: 10px 0 0 0; font-size: 14px;">${parts.join(' &nbsp;&nbsp;·&nbsp;&nbsp; ')}</p>`
    : '';
}

function render(status: BookTranslationStatus): void {
  const viz = overlay?.querySelector<HTMLElement>('#translation-viz');
  if (!viz || !mapStages || mapStages.length === 0) return;

  const vertical = window.innerWidth < 760;
  const overall = status.progress?.status ?? null;
  const telemetry: any[] = (status as any).telemetry ?? [];
  const lastEvent = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const percent = Math.round((status.progress?.percent ?? 0) * 100);
  const detailText = lastEvent?.detail
    ? `${lastEvent.detail}${overall === 'running' && percent > 0 ? ` — ${percent}%` : ''}`
    : overall === 'running' && percent > 0 ? `${percent}%` : '';

  const failedText = overall === 'failed' && status.progress?.error
    ? `<p style="font-size: 13px; color: #e74c3c; margin: 12px 0 0 0;">${esc(status.progress.error)}</p>` : '';

  // Terminal done: completion banner linking the finished copy.
  const newBook = status.progress?.new_book ?? status.existing?.book ?? null;
  const doneBanner = overall === 'done'
    ? `<div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
         <span style="font-size: 16px; color: #27ae60; font-weight: bold;">✓ Translation complete</span>
         ${newBook ? `<a href="/${encodeURIComponent(newBook)}" style="font-size: 14px; color: #8fd0c6; text-decoration: underline;">Open the translation →</a>` : ''}
       </div>`
    : '';

  // Details panel: auto-follow the running/failed stage unless the user pinned one.
  const selectedId = pinnedStage
    || mapStages.find((s) => ['running', 'failed'].includes(statusOf(s.id, status)))?.id
    || mapStages[mapStages.length - 1]?.id
    || '';
  const sel = mapStages.find((s) => s.id === selectedId);

  let expanded = '';
  if (sel) {
    const st = statusOf(sel.id, status);
    const stLabel = ({ done: 'completed', running: 'running', failed: 'failed', skipped: 'skipped', pending: 'pending' } as const)[st];
    expanded = `
        <div style="${vertical ? 'margin: 8px 0 8px 0;' : 'margin-top: 22px;'} padding: ${vertical ? '14px 16px' : '18px 20px'}; font-size: 14px; line-height: 1.7; background: rgba(255,255,255,0.06); border-radius: 6px;">
          <p style="font-size: 15px;"><strong>${esc(sel.title)}</strong> — <span style="color: ${PALETTE[st].text}; font-weight: bold;">${stLabel}</span></p>
          <p style="margin: 10px 0 0 0; color: #c4c4c4;">${esc(sel.plain)}</p>
          ${signalsHtmlFor(sel.id, status)}
          <p style="margin: 14px 0 0 0; color: #888; font-size: 12px;">code: <code style="font-size: 12px;">${esc(sel.code_ref)}</code></p>
        </div>`;
  }

  const circleFor = (st: StageState, size: number): string => {
    const p = PALETTE[st];
    const pulse = st === 'running' ? 'animation: translationPipePulse 1.2s ease-in-out infinite;' : '';

    return `<span style="flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: ${size}px; height: ${size}px; border-radius: 50%; border: 3px solid ${p.ring}; background: ${p.fill}; color: ${st === 'done' || st === 'running' || st === 'failed' ? '#fff' : p.text}; font-size: ${Math.round(size * 0.42)}px; font-weight: bold; ${pulse}">${p.icon}</span>`;
  };

  let body: string;
  if (vertical) {
    body = mapStages.map((stage, i) => {
      const st = statusOf(stage.id, status);
      const p = PALETTE[st];
      const isSel = stage.id === selectedId;
      const connector = i < mapStages!.length - 1
        ? `<div style="width: 3px; height: 16px; margin: 4px 0 4px 18px; border-radius: 2px; background: ${st === 'done' ? p.line : '#444'};"></div>`
        : '';

      return `
          <button type="button" class="translation-pipe-stage" data-stage="${stage.id}" style="display: flex; align-items: center; gap: 12px; background: none; border: none; padding: 2px 0; cursor: pointer; text-align: left; width: 100%;">
            ${circleFor(st, 38)}
            <span style="font-size: 14px; color: ${p.text}; ${isSel ? 'font-weight: bold;' : ''}">${esc(stage.title)}</span>
          </button>
          ${isSel ? expanded : ''}
          ${connector}`;
    }).join('');
    body = `
        ${doneBanner ? `<div style="margin: 0 0 16px 0;">${doneBanner}</div>` : (detailText ? `<p style="font-size: 13px; color: #b5b5b5; margin: 0 0 14px 0;">${esc(detailText)}</p>` : '')}
        ${failedText}
        <div>${body}</div>`;
  } else {
    const chain = mapStages.map((stage, i) => {
      const st = statusOf(stage.id, status);
      const p = PALETTE[st];
      const active = stage.id === selectedId;
      const connector = i < mapStages!.length - 1
        ? `<div style="flex: 1 1 auto; height: 3px; margin: 21px 6px 0 6px; border-radius: 2px; background: ${st === 'done' ? p.line : '#444'};"></div>`
        : '';

      return `
          <button type="button" class="translation-pipe-stage" data-stage="${stage.id}" style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; background: none; border: none; padding: 0; cursor: pointer; width: 120px;">
            <span style="display:flex; ${active ? 'box-shadow: 0 0 0 4px rgba(255,255,255,0.12); border-radius: 50%;' : ''}">${circleFor(st, 44)}</span>
            <span style="font-size: 13px; line-height: 1.35; color: ${p.text}; text-align: center; ${active ? 'font-weight: bold;' : ''}">${esc(stage.title)}</span>
          </button>${connector}`;
    }).join('');
    body = `
        <div style="display: flex; align-items: flex-start; justify-content: space-between;">${chain}</div>
        ${doneBanner ? `<div style="margin: 18px 0 0 0;">${doneBanner}</div>` : (detailText ? `<p style="font-size: 14px; color: #b5b5b5; margin: 18px 0 0 0;">${esc(detailText)}</p>` : '')}
        ${failedText}
        ${expanded}`;
  }

  viz.innerHTML = body;

  viz.querySelectorAll<HTMLButtonElement>('.translation-pipe-stage').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.stage ?? null;
      pinnedStage = pinnedStage === id ? null : id; // click again to unpin
      if (lastStatus) render(lastStatus);
    });
  });
}

// Source Network Harvester live-progress overlay: a full-screen layer that
// renders the harvest stage chain (scan → select → harvest → shelf) from the
// telemetry stream the status endpoint already returns. Modeled on the AI
// review pipeline viz (aiReview/pipelineViz.ts) — same sticky-status walker,
// status palette, and horizontal/vertical responsive chain — but simpler
// (no substages, no report/nothing-to-review branch). Peer calls via `self`.
import { trapModalFocus } from '../../../utilities/modalFocusTrap';
import { log } from '../../../utilities/logger';

const FILE = 'components/sourceContainer/creatorTools/harvestViz.ts';

export async function openHarvestVizOverlay(self: any) {
  if (document.getElementById('harvest-viz-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'harvest-viz-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';
  overlay.innerHTML = `
      <style>
        @keyframes harvestPipePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        /* App theme styles p/strong/code with its own palette — pin them. */
        #harvest-viz-card p      { color: #d8d8d8; margin: 0; font-family: inherit; }
        #harvest-viz-card strong { color: #ffffff; }
        #harvest-viz-card code   { color: #8fd0c6; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; }
      </style>
      <div id="harvest-viz-card" style="background: #2a2a2a; color: #fff; padding: 28px 32px; border-radius: 10px; width: min(92vw, 1100px); max-height: 86vh; overflow-y: auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <h3 style="margin: 0; color: #EF8D34; font-size: 16px;">Harvest the Knowledge Commons — live progress</h3>
          <button type="button" id="harvest-viz-close" style="background: none; border: none; color: #aaa; font-size: 22px; cursor: pointer; line-height: 1; padding: 2px 6px;">×</button>
        </div>
        <p style="display: flex; align-items: center; gap: 9px; font-size: 13px; color: #9fc7c0; margin: 0 0 20px 0; line-height: 1.5;"><span style="font-size: 19px; line-height: 1; flex: 0 0 auto;">📚</span><span>Fetching every open-access work this book cites and importing it as a verified source text. This runs in the background — it's safe to close this window or leave the page.</span></p>
        <div id="harvest-viz">
          <p style="font-size: 13px; color: #aaa; margin: 0;">Loading harvest state…</p>
        </div>
      </div>`;
  document.body.appendChild(overlay);

  const close = () => self.closeHarvestVizOverlay();
  overlay.addEventListener('click', (e: any) => { if (e.target === overlay) close(); });
  overlay.querySelector('#harvest-viz-close')?.addEventListener('click', close);

  // Focus trap: seat focus inside, cycle within, Escape closes, restore on close.
  self._harvestTrapRelease = trapModalFocus(overlay, { onEscape: close });

  self._harvestVizOpen = true;

  // Re-render on resize so the chain flips horizontal ↔ vertical
  self._harvestVizResizeHandler = () => {
    if (self._harvestVizLast) self.renderHarvestViz(self._harvestVizLast);
  };
  window.addEventListener('resize', self._harvestVizResizeHandler);

  if (!self._harvestMap) await self.fetchHarvestMap();
  // Poll fast while watching, and render immediately
  self.startHarvestPolling(5000);
  self.pollHarvestStatus();
}

export function closeHarvestVizOverlay(self: any) {
  if (self._harvestTrapRelease) { self._harvestTrapRelease(); self._harvestTrapRelease = null; }
  document.getElementById('harvest-viz-overlay')?.remove();
  self._harvestVizOpen = false;
  self._harvestVizStage = null;
  if (self._harvestVizResizeHandler) {
    window.removeEventListener('resize', self._harvestVizResizeHandler);
    self._harvestVizResizeHandler = null;
  }
  // Drop back to the slow poll only while a harvest is still being tracked.
  if (self._harvestPollInterval && self._harvestId) self.startHarvestPolling(10000);
}

export async function fetchHarvestMap(self: any) {
  try {
    const resp = await fetch('/api/source-harvest/map', { credentials: 'include' });
    if (resp.ok) {
      const data = await resp.json();
      self._harvestMap = data.stages || [];
    }
  } catch (err) {
    log.error('Failed to load harvest map', FILE, err);
    self._harvestMap = [];
  }
}

/**
 * Render the live harvest into the overlay: one node per stage, connected by
 * progress lines. Done stages light green, the running stage pulses orange,
 * failures go red. The details panel auto-follows the active stage (click to
 * pin) with the plain note, latest signals, and code ref.
 */
export function renderHarvestViz(self: any, harvest: any) {
  const viz = document.getElementById('harvest-viz');
  if (!viz || !self._harvestVizOpen || !self._harvestMap) return;

  const telemetry = harvest.telemetry || [];

  const lastByStage: any = {};
  for (const ev of telemetry) {
    if (ev.stage) lastByStage[ev.stage] = ev;
  }
  const signalsByStage: any = {};
  for (const ev of telemetry) {
    if (ev.stage && ev.signals) signalsByStage[ev.stage] = ev.signals;
  }

  const statusOf = (stageId: any) => {
    // Sticky terminal states: once a stage completed/failed/skipped, only a
    // fresh 'started' flips it back to running (a stray 'progress' can't).
    let st: string | null = null;
    for (const ev of telemetry) {
      if (ev.stage !== stageId) continue;
      if (ev.status === 'started') st = 'running';
      else if (ev.status === 'progress') { if (st === null || st === 'running') st = 'running'; }
      else if (ev.status === 'completed') st = 'done';
      else if (ev.status === 'failed') st = 'failed';
      else if (ev.status === 'skipped') st = 'skipped';
    }

    // Once the whole run is over, no stage can still be pending/running — a
    // gap just means it was skipped (e.g. shelf when nothing was imported).
    // Without this the chain looks stuck at the last un-emitted stage.
    if (harvest.status === 'completed' && (st === null || st === 'running')) return 'skipped';

    if (st) return st;

    // No telemetry for this stage yet: infer from the current step ordering.
    const order = self._harvestMap.map((s: any) => s.id);
    const cur = order.indexOf(harvest.step);
    const idx = order.indexOf(stageId);
    if (cur === -1 || idx === -1) return 'pending';
    if (idx < cur) return 'done';
    if (idx === cur) return harvest.status === 'failed' ? 'failed' : 'running';
    return 'pending';
  };

  const palette: any = {
    done:    { ring: '#27ae60', fill: '#27ae60', text: '#27ae60', icon: '✓', line: '#27ae60' },
    running: { ring: '#EF8D34', fill: '#EF8D34', text: '#EF8D34', icon: '●', line: '#555'    },
    failed:  { ring: '#e74c3c', fill: '#e74c3c', text: '#e74c3c', icon: '✗', line: '#555'    },
    skipped: { ring: '#777',    fill: 'transparent', text: '#999', icon: '–', line: '#555'   },
    pending: { ring: '#555',    fill: 'transparent', text: '#888', icon: '',  line: '#444'   },
  };

  self._harvestVizLast = harvest;

  const vertical = window.innerWidth < 760;

  const lastEvent = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const detailText = (lastEvent && lastEvent.detail) || harvest.step_detail || '';
  const failedText = harvest.status === 'failed' && harvest.error
    ? `<p style="font-size: 13px; color: #e74c3c; margin: 12px 0 0 0;">${harvest.error}</p>` : '';

  // Terminal done: completion banner with the imported count + shelf link.
  const done = harvest.status === 'completed';
  let doneBanner = '';
  if (done) {
    const c = harvest.counts || {};
    const imported = (c.assigned || 0) + (c.assigned_existing || 0);
    const shelf = harvest.shelf;
    const shelfLink = (shelf && shelf.creator)
      ? `<a href="/u/${encodeURIComponent(shelf.creator)}/shelf/${encodeURIComponent(shelf.slug)}" style="font-size: 14px; color: #8fd0c6; text-decoration: underline;">View the sources on your shelf →</a>`
      : '';
    doneBanner = `<div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
           <span style="font-size: 16px; color: #27ae60; font-weight: bold;">✓ Harvest complete</span>
           <span style="font-size: 14px; color: #c4c4c4;">${imported} source${imported === 1 ? '' : 's'} imported.</span>
           ${shelfLink}
         </div>`;
  }

  // Details panel: auto-follow the running/failed stage unless the user pinned one.
  const selectedId = self._harvestVizStage
    || self._harvestMap.find((s: any) => ['running', 'failed'].includes(statusOf(s.id)))?.id
    || self._harvestMap[self._harvestMap.length - 1].id;
  const sel = self._harvestMap.find((s: any) => s.id === selectedId);

  let expanded = '';
  if (sel) {
    const st = statusOf(sel.id);
    const signals = signalsByStage[sel.id];
    const signalsHtml = signals
      ? `<p style="margin: 10px 0 0 0; font-size: 14px;">${Object.entries(signals).map(([k, v]) => `<span style="color:#999;">${k}:</span> <strong>${v}</strong>`).join(' &nbsp;&nbsp;·&nbsp;&nbsp; ')}</p>`
      : '';
    const stLabel = ({ done: 'completed', running: 'running', failed: 'failed', skipped: 'skipped', pending: 'pending' } as any)[st];
    expanded = `
        <div style="${vertical ? 'margin: 8px 0 8px 0;' : 'margin-top: 22px;'} padding: ${vertical ? '14px 16px' : '18px 20px'}; font-size: 14px; line-height: 1.7; background: rgba(255,255,255,0.06); border-radius: 6px;">
          <p style="font-size: 15px;"><strong>${sel.title}</strong> — <span style="color: ${palette[st].text}; font-weight: bold;">${stLabel}</span></p>
          <p style="margin: 10px 0 0 0; color: #c4c4c4;">${sel.plain}</p>
          ${signalsHtml}
          <p style="margin: 14px 0 0 0; color: #888; font-size: 12px;">code: <code style="font-size: 12px;">${sel.code_ref}</code></p>
        </div>`;
  }

  const circleFor = (st: any, p: any, size: any) => {
    const pulse = st === 'running' ? 'animation: harvestPipePulse 1.2s ease-in-out infinite;' : '';
    return `<span style="flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: ${size}px; height: ${size}px; border-radius: 50%; border: 3px solid ${p.ring}; background: ${p.fill}; color: ${st === 'done' || st === 'running' || st === 'failed' ? '#fff' : p.text}; font-size: ${Math.round(size * 0.42)}px; font-weight: bold; ${pulse}">${p.icon}</span>`;
  };

  let body;
  if (vertical) {
    body = self._harvestMap.map((stage: any, i: any) => {
      const st = statusOf(stage.id);
      const p = palette[st];
      const isSel = stage.id === selectedId;
      const connector = i < self._harvestMap.length - 1
        ? `<div style="width: 3px; height: 16px; margin: 4px 0 4px 18px; border-radius: 2px; background: ${st === 'done' ? p.line : '#444'};"></div>`
        : '';
      return `
          <button type="button" class="harvest-pipe-stage" data-stage="${stage.id}" style="display: flex; align-items: center; gap: 12px; background: none; border: none; padding: 2px 0; cursor: pointer; text-align: left; width: 100%;">
            ${circleFor(st, p, 38)}
            <span style="font-size: 14px; color: ${p.text}; ${isSel ? 'font-weight: bold;' : ''}">${stage.title}</span>
          </button>
          ${isSel ? expanded : ''}
          ${connector}`;
    }).join('');
    body = `
        ${done ? `<div style="margin: 0 0 16px 0;">${doneBanner}</div>` : (detailText ? `<p style="font-size: 13px; color: #b5b5b5; margin: 0 0 14px 0;">${detailText}</p>` : '')}
        ${failedText}
        <div>${body}</div>`;
  } else {
    const chain = self._harvestMap.map((stage: any, i: any) => {
      const st = statusOf(stage.id);
      const p = palette[st];
      const active = stage.id === selectedId;
      const connector = i < self._harvestMap.length - 1
        ? `<div style="flex: 1 1 auto; height: 3px; margin: 21px 6px 0 6px; border-radius: 2px; background: ${st === 'done' ? p.line : '#444'};"></div>`
        : '';
      return `
          <button type="button" class="harvest-pipe-stage" data-stage="${stage.id}" style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; background: none; border: none; padding: 0; cursor: pointer; width: 120px;">
            <span style="display:flex; ${active ? 'box-shadow: 0 0 0 4px rgba(255,255,255,0.12); border-radius: 50%;' : ''}">${circleFor(st, p, 44)}</span>
            <span style="font-size: 13px; line-height: 1.35; color: ${p.text}; text-align: center; ${active ? 'font-weight: bold;' : ''}">${stage.title}</span>
          </button>${connector}`;
    }).join('');
    body = `
        <div style="display: flex; align-items: flex-start; justify-content: space-between;">${chain}</div>
        ${done ? `<div style="margin: 18px 0 0 0;">${doneBanner}</div>` : (detailText ? `<p style="font-size: 14px; color: #b5b5b5; margin: 18px 0 0 0;">${detailText}</p>` : '')}
        ${failedText}
        ${expanded}`;
  }

  viz.innerHTML = body;

  viz.querySelectorAll('.harvest-pipe-stage').forEach((btn: any) => {
    btn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.stage;
      self._harvestVizStage = self._harvestVizStage === id ? null : id; // click again to unpin
      self.renderHarvestViz(harvest);
    });
  });
}

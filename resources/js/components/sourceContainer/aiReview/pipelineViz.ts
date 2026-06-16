// AI review live-pipeline overlay: the full-screen layer, the pipeline-map
// fetch, the stage-chain renderer (horizontal/vertical, telemetry-driven
// statuses + details panel), and the post-completion highlight sync into
// IndexedDB. Peer calls route through `self`.

export async function openAiReviewVizOverlay(self: any) {
  if (document.getElementById('ai-review-viz-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'ai-review-viz-overlay';
  overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';
  overlay.innerHTML = `
      <style>
        @keyframes aiPipePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        /* The overlay sits inside the app DOM, whose theme styles p/strong/code
           with its own palette — pin every text element explicitly. */
        #ai-review-viz-card p      { color: #d8d8d8; margin: 0; font-family: inherit; }
        #ai-review-viz-card strong { color: #ffffff; }
        #ai-review-viz-card code   { color: #8fd0c6; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; }
      </style>
      <div id="ai-review-viz-card" style="background: #2a2a2a; color: #fff; padding: 28px 32px; border-radius: 10px; width: min(92vw, 1100px); max-height: 86vh; overflow-y: auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <h3 style="margin: 0; color: #EF8D34; font-size: 16px;">AI Citation Review — live pipeline</h3>
          <button type="button" id="ai-review-viz-close" style="background: none; border: none; color: #aaa; font-size: 22px; cursor: pointer; line-height: 1; padding: 2px 6px;">×</button>
        </div>
        <p style="display: flex; align-items: center; gap: 9px; font-size: 13px; color: #9fc7c0; margin: 0 0 20px 0; line-height: 1.5;"><span style="font-size: 19px; line-height: 1; flex: 0 0 auto;">✉️</span><span>The full report will be emailed to you when it completes — it's safe to close this window or leave the page.</span></p>
        <div id="ai-review-viz">
          <p style="font-size: 13px; color: #aaa; margin: 0;">Loading pipeline state…</p>
        </div>
      </div>`;
  document.body.appendChild(overlay);

  const close = () => self.closeAiReviewVizOverlay();
  overlay.addEventListener('click', (e: any) => { if (e.target === overlay) close(); });
  overlay.querySelector('#ai-review-viz-close')?.addEventListener('click', close);

  self._aiVizOpen = true;

  // Re-render on resize so the chain flips horizontal ↔ vertical
  self._aiVizResizeHandler = () => {
    if (self._aiVizLastPipeline) self.renderPipelineViz(self._aiVizLastPipeline);
  };
  window.addEventListener('resize', self._aiVizResizeHandler);

  if (!self._pipelineMap) await self.fetchPipelineMap();
  // Poll fast while watching, and render immediately
  self.startAiReviewPolling(5000);
  self.pollAiReviewStatus();
}

export function closeAiReviewVizOverlay(self: any) {
  document.getElementById('ai-review-viz-overlay')?.remove();
  self._aiVizOpen = false;
  self._aiVizStage = null;
  if (self._aiVizResizeHandler) {
    window.removeEventListener('resize', self._aiVizResizeHandler);
    self._aiVizResizeHandler = null;
  }
  if (self._aiReviewPollInterval) self.startAiReviewPolling(30000);
}

export async function fetchPipelineMap(self: any) {
  try {
    const resp = await fetch('/api/citation-pipeline/map', { credentials: 'include' });
    if (resp.ok) {
      const data = await resp.json();
      self._pipelineMap = data.stages || [];
    }
  } catch (err) {
    console.warn('Failed to load pipeline map:', err);
    self._pipelineMap = [];
  }
}

/**
 * Render the live pipeline into the full-screen overlay: one column per
 * stage (all visible without scrolling), connected by progress lines.
 * Done stages light up green; the running stage pulses orange; failures go
 * red with the error below. The details panel under the chain auto-follows
 * the active stage (click a stage to pin it instead) and carries the
 * plain-language note, latest signals, review sub-stages, and the code ref
 * (so a dev looking at a failure is one click from the responsible file).
 */
export function renderPipelineViz(self: any, pipeline: any) {
  const viz = document.getElementById('ai-review-viz');
  if (!viz || !self._aiVizOpen || !self._pipelineMap) return;

  const telemetry = pipeline.telemetry || [];

  // Last event per stage / per review substage
  const lastByStage: any = {};
  const lastBySubstage: any = {};
  for (const ev of telemetry) {
    if (ev.stage) lastByStage[ev.stage] = ev;
    if (ev.stage === 'review' && ev.substage) lastBySubstage[ev.substage] = ev;
  }
  // Latest signals snapshot per stage
  const signalsByStage: any = {};
  for (const ev of telemetry) {
    if (ev.stage && ev.signals) signalsByStage[ev.stage] = ev.signals;
  }

  const statusOf = (stageId: any) => {
    // Walk the stream with sticky terminal states: once a stage completed /
    // failed / was skipped, only a fresh 'started' (a genuine re-run) may
    // flip it back to running — a stray 'progress' event must not. (Guards
    // against pre-fix streams where a resume re-emitted a progress signal
    // for an already-completed stage.)
    let st = null;
    for (const ev of telemetry) {
      if (ev.stage !== stageId) continue;
      if (ev.status === 'started') {
        st = 'running';
      } else if (ev.status === 'progress') {
        if (st === null || st === 'running') st = 'running';
      } else if (ev.status === 'completed') {
        st = 'done';
      } else if (ev.status === 'failed') {
        st = 'failed';
      } else if (ev.status === 'skipped') {
        st = 'skipped';
      }
    }
    if (st) return st;

    // No telemetry (older runs): infer from current_step ordering
    const order = self._pipelineMap.map((s: any) => s.id);
    const cur = order.indexOf(pipeline.current_step);
    const idx = order.indexOf(stageId);
    if (cur === -1 || idx === -1) return 'pending';
    if (idx < cur) return 'done';
    if (idx === cur) return pipeline.status === 'failed' ? 'failed' : 'running';
    return 'pending';
  };

  const palette: any = {
    done:    { ring: '#27ae60', fill: '#27ae60', text: '#27ae60', icon: '✓', line: '#27ae60' },
    running: { ring: '#EF8D34', fill: '#EF8D34', text: '#EF8D34', icon: '●', line: '#555'    },
    failed:  { ring: '#e74c3c', fill: '#e74c3c', text: '#e74c3c', icon: '✗', line: '#555'    },
    skipped: { ring: '#777',    fill: 'transparent', text: '#999', icon: '–', line: '#555'   },
    pending: { ring: '#555',    fill: 'transparent', text: '#888', icon: '',  line: '#444'   },
  };

  // Remember the latest pipeline so resize re-renders don't need a new poll
  self._aiVizLastPipeline = pipeline;

  // Narrow viewport → vertical chain (top to bottom, details under the
  // selected stage); wide → horizontal chain with details below.
  const vertical = window.innerWidth < 760;

  // Detail line: most recent telemetry detail, else step_detail
  const lastEvent = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const detailText = (lastEvent && lastEvent.detail) || pipeline.step_detail || '';
  const failedText = pipeline.status === 'failed' && pipeline.error
    ? `<p style="font-size: 13px; color: #e74c3c; margin: 12px 0 0 0;">${pipeline.error}</p>` : '';

  // Terminal DONE state: replace the live ticker with a completion banner
  const done = pipeline.status === 'completed';
  const doneBanner = done
    ? `<div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
           <span style="font-size: 16px; color: #27ae60; font-weight: bold;">✓ Review complete</span>
           <a href="/${encodeURIComponent(pipeline.book)}/AIreview" style="font-size: 14px; color: #8fd0c6; text-decoration: underline;">View the report →</a>
           <span style="font-size: 13px; color: #888;">A summary has been emailed to you.</span>
         </div>`
    : '';

  // Details panel: auto-follow the active stage (running/failed) unless the
  // user has pinned one by clicking.
  const selectedId = self._aiVizStage
    || self._pipelineMap.find((s: any) => ['running', 'failed'].includes(statusOf(s.id)))?.id
    || self._pipelineMap[self._pipelineMap.length - 1].id;
  const sel = self._pipelineMap.find((s: any) => s.id === selectedId);

  let expanded = '';
  if (sel) {
    const st = statusOf(sel.id);
    const ev = lastByStage[sel.id];
    const signals = signalsByStage[sel.id];
    const signalsHtml = signals
      ? `<p style="margin: 10px 0 0 0; font-size: 14px;">${Object.entries(signals).map(([k, v]) => `<span style="color:#999;">${k}:</span> <strong>${v}</strong>`).join(' &nbsp;&nbsp;·&nbsp;&nbsp; ')}</p>`
      : '';

    // Sub-stages: one per row — checkpoint mark, title, latest message.
    let substagesHtml = '';
    if (sel.substages) {
      substagesHtml = '<div style="margin-top: 14px; border-top: 1px dashed #555; padding-top: 12px;">'
        + sel.substages.map((sub: any) => {
            const subEv = lastBySubstage[sub.id];
            // A finished stage can't have anything still "waiting" — events
            // may simply be absent (e.g. runs from before a phase emitted).
            const stageOver = st === 'done' || st === 'skipped';
            const mark = subEv
              ? '<span style="color:#27ae60; font-weight:bold;">✓</span>'
              : (stageOver ? '<span style="color:#555;">–</span>' : '<span style="color:#666;">○</span>');
            const msg = subEv?.detail
              ? `<span style="color: #9a9a9a;">${subEv.detail}</span>`
              : (stageOver ? '<span style="color: #555;">—</span>' : '<span style="color: #666;">waiting…</span>');
            return `<p style="display: flex; gap: 10px; align-items: baseline; margin: 0 0 7px 0; font-size: ${vertical ? 13 : 14}px; line-height: 1.5; ${vertical ? 'flex-wrap: wrap;' : ''}">
                  <span style="flex: 0 0 14px; text-align: center;">${mark}</span>
                  <strong style="flex: 0 0 ${vertical ? 'auto' : '170px'};">${sub.title}</strong>
                  <span style="flex: 1 1 auto;">${msg}</span>
                </p>`;
          }).join('')
        + '</div>';
    }

    const stLabel = ({ done: 'completed', running: 'running', failed: 'failed', skipped: 'skipped', pending: 'pending' } as any)[st];
    expanded = `
        <div style="${vertical ? 'margin: 8px 0 8px 0;' : 'margin-top: 22px;'} padding: ${vertical ? '14px 16px' : '18px 20px'}; font-size: 14px; line-height: 1.7; background: rgba(255,255,255,0.06); border-radius: 6px;">
          <p style="font-size: 15px;"><strong>${sel.title}</strong> — <span style="color: ${palette[st].text}; font-weight: bold;">${stLabel}</span></p>
          <p style="margin: 10px 0 0 0; color: #c4c4c4;">${sel.plain}</p>
          ${signalsHtml}
          ${substagesHtml}
          <p style="margin: 14px 0 0 0; color: #888; font-size: 12px;">code: <code style="font-size: 12px;">${sel.code_ref}</code></p>
        </div>`;
  }

  const circleFor = (st: any, p: any, size: any) => {
    const pulse = st === 'running' ? 'animation: aiPipePulse 1.2s ease-in-out infinite;' : '';
    return `<span style="flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: ${size}px; height: ${size}px; border-radius: 50%; border: 3px solid ${p.ring}; background: ${p.fill}; color: ${st === 'done' || st === 'running' || st === 'failed' ? '#fff' : p.text}; font-size: ${Math.round(size * 0.42)}px; font-weight: bold; ${pulse}">${p.icon}</span>`;
  };

  let body;
  if (vertical) {
    // Top-to-bottom chain; the selected stage's details slot in right below
    // it (accordion — selecting another stage moves the panel there).
    body = self._pipelineMap.map((stage: any, i: any) => {
      const st = statusOf(stage.id);
      const p = palette[st];
      const isSel = stage.id === selectedId;
      const connector = i < self._pipelineMap.length - 1
        ? `<div style="width: 3px; height: 16px; margin: 4px 0 4px 18px; border-radius: 2px; background: ${st === 'done' ? p.line : '#444'};"></div>`
        : '';
      return `
          <button type="button" class="ai-pipe-stage" data-stage="${stage.id}" style="display: flex; align-items: center; gap: 12px; background: none; border: none; padding: 2px 0; cursor: pointer; text-align: left; width: 100%;">
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
    // Horizontal chain — all stages on one line, details below.
    const chain = self._pipelineMap.map((stage: any, i: any) => {
      const st = statusOf(stage.id);
      const p = palette[st];
      const active = stage.id === selectedId;
      const connector = i < self._pipelineMap.length - 1
        ? `<div style="flex: 1 1 auto; height: 3px; margin: 21px 6px 0 6px; border-radius: 2px; background: ${st === 'done' ? p.line : '#444'};"></div>`
        : '';
      return `
          <button type="button" class="ai-pipe-stage" data-stage="${stage.id}" style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; background: none; border: none; padding: 0; cursor: pointer; width: 110px;">
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

  viz.querySelectorAll('.ai-pipe-stage').forEach((btn: any) => {
    btn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.stage;
      self._aiVizStage = self._aiVizStage === id ? null : id; // click again to unpin (auto-follow)
      self.renderPipelineViz(pipeline);
    });
  });
}

/**
 * After the citation pipeline completes, pull the new highlights into
 * IndexedDB and re-render them on visible nodes so they appear immediately
 * without requiring a page refresh.
 */
export async function syncPipelineHighlights(self: any, bookId: any) {
  try {
    const { syncAnnotationsOnly } = await import('../../../indexedDB/serverSync/index');
    const { updateLocalAnnotationsTimestamp } = await import('../../../indexedDB/core/library');

    // Sync highlights + hypercites from server into IndexedDB
    await syncAnnotationsOnly(bookId);

    // Align the local annotations_updated_at so future freshness checks pass
    const libResp = await fetch(
      `/api/database-to-indexeddb/books/${encodeURIComponent(bookId)}/library`,
      { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } }
    );
    if (libResp.ok) {
      const libData = await libResp.json();
      if (libData.success && libData.library?.annotations_updated_at) {
        await updateLocalAnnotationsTimestamp(bookId, libData.library.annotations_updated_at);
      }
    }

    // Re-render highlights on currently visible nodes
    const visibleNodeIds = Array.from(
      document.querySelectorAll('[id]:not([data-chunk-id]):not(.sentinel)')
    ).filter((el: any) => /^\d+$/.test(el.id)).map((el: any) => el.id);

    if (visibleNodeIds.length > 0) {
      const { reprocessHighlightsForNodes } = await import('../../../hyperlights/deletion');
      await reprocessHighlightsForNodes(bookId, visibleNodeIds);
    }

    console.log(`[Pipeline] Synced ${bookId} highlights after pipeline completion`);
  } catch (err) {
    console.warn('[Pipeline] Failed to sync highlights after completion:', err);
  }
}

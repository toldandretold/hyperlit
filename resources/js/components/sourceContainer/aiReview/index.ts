// AI Citation Review controls (#ai-review-section / #ai-review-btn): initial
// status load (IDB + server probe), the button state machine (idle ⇄ reviewing
// ⇄ completed), the "results emailed / see live pipeline" panel, and triggering
// a new review. Polling lives in ./polling, the live overlay in ./pipelineViz;
// peer calls route through `self`.
import { book } from '../../../app';
import { openDatabase } from '../../../indexedDB/index';
import { getRecord } from '../helpers';

export async function handleAiReviewGenerate(self: any) {
  const generateBtn = self.container.querySelector("#ai-review-generate");
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Submitting...';
  }

  try {
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    const resp = await fetch('/api/citation-pipeline/trigger', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({ book, force: self.container.querySelector('#ai-review-force')?.checked || false }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      if (resp.status === 402) {
        const infoPanel = self.container.querySelector('#ai-review-info');
        if (infoPanel) {
          let banner = infoPanel.querySelector('.ai-review-balance-error');
          if (!banner) {
            banner = document.createElement('p');
            banner.className = 'ai-review-balance-error';
            banner.style.cssText = 'font-size: 12px; color: var(--hyperlit-orange); margin: 0 0 10px 0; line-height: 1.5;';
            infoPanel.insertBefore(banner, generateBtn);
          }
          banner.innerHTML = 'Insufficient balance. <a href="#" onclick="event.preventDefault(); fetch(\'/api/billing/checkout\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Accept\': \'application/json\', \'X-XSRF-TOKEN\': decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || \'\') }, credentials: \'include\', body: JSON.stringify({ amount: 5, return_url: window.location.href }) }).then(r => r.json()).then(d => { if (d.checkout_url) window.location.href = d.checkout_url; })" style="color: var(--hyperlit-aqua); text-decoration: underline;">Top Up Balance</a>';
        }
        if (generateBtn) {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate Review';
        }
        return;
      }
      throw new Error(data.message || `Request failed: ${resp.status}`);
    }

    self._pipelineId = data.pipeline_id;
    self.setAiReviewState('reviewing');
    self.startAiReviewPolling();
    // Show the live pipeline right away — the card explains the report is
    // emailed on completion, so users know they can close it / leave.
    self.openAiReviewVizOverlay();
  } catch (error: any) {
    console.error('AI Review trigger failed:', error);
    alert('Failed to start AI Citation Review: ' + error.message);
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate Review';
    }
  }
}

export async function loadAiReviewStatus(self: any) {
  const section = self.container.querySelector('#ai-review-section');
  const aiBtn = self.container.querySelector('#ai-review-btn');
  if (!section || !aiBtn || aiBtn.disabled) return; // not logged in or no section

  try {
    // 1. Check if a completed AIreview sub-book already exists — try IndexedDB first (fast)
    const aiReviewBook = `${book}/AIreview`;
    let aiReviewExists = false;
    try {
      const db = await openDatabase();
      const libRecord = await getRecord(db, "library", aiReviewBook);
      if (libRecord) aiReviewExists = true;
    } catch (_) { /* ignore IndexedDB errors */ }

    // 2. Check pipeline status — response also tells us if AIreview exists on the server
    //    (avoids a separate /library probe that 404s when no review has been run)
    const resp = await fetch(`/api/citation-pipeline/running/${encodeURIComponent(book)}`, {
      credentials: 'include',
    });
    if (!resp.ok) {
      if (aiReviewExists) self.setAiReviewState('completed');
      return;
    }
    const data = await resp.json();
    if (!aiReviewExists && data.ai_review_exists) aiReviewExists = true;

    if (data.pipeline) {
      self._pipelineId = data.pipeline.id;
      self.setAiReviewState('reviewing', data.pipeline.current_step);
      self.startAiReviewPolling();
      return;
    }

    // No running pipeline — show completed if AIreview sub-book exists
    if (aiReviewExists) {
      self.setAiReviewState('completed');
      return;
    }
  } catch (err) {
    console.warn('Failed to load AI review status:', err);
  }
}

export function setAiReviewState(self: any, state: any, currentStep?: any) {
  const aiBtn = self.container.querySelector('#ai-review-btn');
  if (!aiBtn) return;

  const stepLabels: any = {
    bibliography: 'Scanning bibliography',
    content: 'Scanning citations',
    vacuum: 'Fetching sources',
    ocr: 'Processing PDFs',
    review: 'Reviewing citations',
  };

  const infoPanel = self.container.querySelector('#ai-review-info');

  if (state === 'reviewing') {
    const stepText = (currentStep && stepLabels[currentStep]) || 'Reviewing...';
    aiBtn.disabled = true;
    aiBtn.style.color = 'var(--hyperlit-aqua)';
    aiBtn.style.borderColor = 'color-mix(in srgb, var(--hyperlit-aqua) 40%, transparent)';
    aiBtn.style.cursor = 'not-allowed';
    aiBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        ${stepText}`;
    if (infoPanel) infoPanel.style.display = 'none';
    self.ensureAiReviewLivePanel();
  } else if (state === 'completed') {
    self.container.querySelector('#ai-review-live')?.remove();
    aiBtn.disabled = false;
    aiBtn.style.color = 'var(--hyperlit-aqua)';
    aiBtn.style.borderColor = 'color-mix(in srgb, var(--hyperlit-aqua) 40%, transparent)';
    aiBtn.style.cursor = 'pointer';
    aiBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        See Review`;
    if (infoPanel) infoPanel.style.display = 'none';

    // Replace click handler to navigate to review page
    const newBtn = aiBtn.cloneNode(true);
    aiBtn.parentNode.replaceChild(newBtn, aiBtn);
    newBtn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = `/${encodeURIComponent(book)}/AIreview`;
    });

    // Add "Regenerate" link below
    const existingRegen = self.container.querySelector('#ai-review-regenerate');
    if (!existingRegen) {
      const regenLink = document.createElement('a');
      regenLink.id = 'ai-review-regenerate';
      regenLink.href = '#';
      regenLink.textContent = 'Regenerate';
      regenLink.style.cssText = 'display: block; font-size: 11px; color: var(--color-label); margin-top: 6px; text-decoration: underline; cursor: pointer;';
      regenLink.addEventListener('click', (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        // Reset to idle state so user can trigger a new scan
        const btn = self.container.querySelector('#ai-review-btn');
        if (btn) {
          const freshBtn = btn.cloneNode(false);
          freshBtn.style.color = 'var(--hyperlit-orange)';
          freshBtn.style.borderColor = 'rgba(239,141,52,0.4)';
          freshBtn.style.cursor = 'pointer';
          freshBtn.disabled = false;
          freshBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              AI Citation Review`;
          btn.parentNode.replaceChild(freshBtn, btn);
          freshBtn.addEventListener('click', (ev: any) => {
            ev.preventDefault();
            ev.stopPropagation();
            const panel = self.container.querySelector('#ai-review-info');
            if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          });
        }
        regenLink.remove();
      });
      newBtn.parentNode.insertBefore(regenLink, newBtn.nextSibling);
    }
  }
}

/**
 * Below the "Reviewing..." button: the results-by-email note and the
 * "See live processing pipeline" toggle. Idempotent — called on every
 * poll-driven state refresh.
 */
export function ensureAiReviewLivePanel(self: any) {
  const aiBtn = self.container.querySelector('#ai-review-btn');
  if (!aiBtn || self.container.querySelector('#ai-review-live')) return;

  const panel = document.createElement('div');
  panel.id = 'ai-review-live';
  panel.style.cssText = 'margin-top: 8px;';
  panel.innerHTML = `
      <p style="font-size: 11px; color: var(--color-label); margin: 0 0 6px 0; line-height: 1.4;">
        Results will be emailed to you when complete — you can safely leave this page.
      </p>
      <button type="button" id="ai-review-viz-toggle" style="background: none; border: none; padding: 0; font-size: 11px; color: var(--hyperlit-aqua); text-decoration: underline; cursor: pointer;">
        See live processing pipeline ▸
      </button>
    `;
  aiBtn.parentNode.insertBefore(panel, aiBtn.nextSibling);

  panel.querySelector('#ai-review-viz-toggle')?.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    await self.openAiReviewVizOverlay();
  });
}

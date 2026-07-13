// AI Citation Review controls (#ai-review-section / #ai-review-btn): initial
// status load (IDB + server probe), the button state machine (idle ⇄ reviewing
// ⇄ completed), the "results emailed / see live pipeline" panel, and triggering
// a new review. Polling lives in ./polling, the live overlay in ./pipelineViz;
// peer calls route through `self`.
import { book } from '../../../app';
import { openDatabase } from '../../../indexedDB/index';
import { getRecord } from '../helpers';
import { isByoLlmActive } from '../../../aiProviders/profiles';
import { startTicketWorker } from '../../../aiProviders/ticketWorker';
import { getAuthContextSync } from '../../../utilities/auth/session';
import { isLoggedIn } from '../../../utilities/auth/index';
import { promptLogin } from '../../../utilities/auth/promptLogin';
import { offerTopUp } from '../../../utilities/billing/topUp';
import { checklistDialog, alertDialog } from '../../dialog/dialog';
import { log } from '../../../utilities/logger';

const FILE = 'components/sourceContainer/aiReview/index.ts';

/**
 * Open the confirm popup (pricing + a "rescan" option), then trigger the review
 * — the same shape as the harvester's confirm, replacing the old inline panel
 * the button used to expand. An anonymous click routes to login first.
 */
export async function openAiReviewConfirm(self: any) {
  if (!(await isLoggedIn())) {
    await self.closeContainer?.();
    await promptLogin();
    return;
  }

  const isPremium = getAuthContextSync()?.user?.status === 'premium';
  const price = isPremium
    ? 'Cost: included with Premium.'
    : 'Estimated cost: around $1.00 (varies by book length) — it runs an external OCR + several LLMs to check each citation\'s truth claim against available sources. Results are published as both in-text hyperlights and a report.';

  const result = await checklistDialog({
    title: 'AI Citation Review',
    message: `Review this text's citations — takes 10–15 minutes, and you're emailed on completion.\n\n${price}`,
    items: [{ value: 'force', label: 'Rescan all sources from scratch' }],
    confirmLabel: 'Generate review',
  });
  if (!result) return; // cancelled
  await handleAiReviewGenerate(self, result.selected.includes('force'));
}

export async function handleAiReviewGenerate(self: any, force = false) {
  const aiBtn = self.container.querySelector('#ai-review-btn');
  if (aiBtn) { aiBtn.disabled = true; aiBtn.style.cursor = 'wait'; }
  const restoreBtn = () => { if (aiBtn) { aiBtn.disabled = false; aiBtn.style.cursor = 'pointer'; } };

  try {
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    // BYO-key mode (native shell + active LLM profile): the pipeline's LLM
    // calls park as inference tickets which THIS page answers via the ticket
    // worker — the run needs the page to stay open.
    const byo = await isByoLlmActive();
    const resp = await fetch('/api/citation-pipeline/trigger', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({ book, force, client_inference: byo }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      restoreBtn();
      if (resp.status === 402) {
        await offerTopUp('Insufficient balance to run the review. Top up $5 to continue?');
        return;
      }
      throw new Error(data.message || `Request failed: ${resp.status}`);
    }

    self._pipelineId = data.pipeline_id;

    // BYO: start answering the pipeline's parked prompts. Polling stops the
    // worker when the pipeline reaches a terminal state.
    if (byo) {
      self._ticketWorker?.stop();
      self._ticketWorker = startTicketWorker({ feature: 'ai_review', contextId: data.pipeline_id });
    }

    self.setAiReviewState('reviewing');
    self.startAiReviewPolling();
    // Show the live pipeline right away — the card explains the report is
    // emailed on completion, so users know they can close it / leave.
    self.openAiReviewVizOverlay();
  } catch (error: any) {
    log.error('AI Review trigger failed', FILE, error);
    restoreBtn();
    await alertDialog({ title: 'AI Citation Review', message: 'Failed to start AI Citation Review: ' + (error?.message || 'unknown error') });
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

export function setAiReviewState(self: any, state: any, currentStep?: any, opts?: any) {
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
    // "Nothing to review" → no /AIreview report was created, so the button must
    // not navigate there (it would 404). Show an inert "No references found".
    const nothingToReview = opts?.nothingToReview === true;
    aiBtn.disabled = false;
    aiBtn.style.color = 'var(--hyperlit-aqua)';
    aiBtn.style.borderColor = 'color-mix(in srgb, var(--hyperlit-aqua) 40%, transparent)';
    if (infoPanel) infoPanel.style.display = 'none';

    let targetBtn: any;
    if (nothingToReview) {
      aiBtn.disabled = true;
      aiBtn.style.cursor = 'default';
      aiBtn.title = 'No bibliography or citation footnotes are saved to the database for this book.';
      aiBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          No references found`;
      targetBtn = aiBtn;
    } else {
      aiBtn.style.cursor = 'pointer';
      aiBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          See Review`;
      // Replace click handler to navigate to review page
      const newBtn = aiBtn.cloneNode(true);
      aiBtn.parentNode.replaceChild(newBtn, aiBtn);
      newBtn.addEventListener('click', (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = `/${encodeURIComponent(book)}/AIreview`;
      });
      targetBtn = newBtn;
    }

    // Add "Regenerate" link below (both cases — lets the user re-run after a fix)
    const existingRegen = self.container.querySelector('#ai-review-regenerate');
    if (!existingRegen) {
      const regenLink = document.createElement('a');
      regenLink.id = 'ai-review-regenerate';
      regenLink.href = '#';
      regenLink.textContent = 'Regenerate';
      regenLink.style.cssText = 'display: block; font-size: var(--sc-11); color: var(--color-label); margin-top: 6px; text-decoration: underline; cursor: pointer;';
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
            self.openAiReviewConfirm();
          });
        }
        regenLink.remove();
      });
      targetBtn.parentNode.insertBefore(regenLink, targetBtn.nextSibling);
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

  // BYO runs are answered BY this page (ticket worker) — leaving pauses the run.
  const note = self._ticketWorker?.isRunning()
    ? 'Your own AI provider is answering this review — keep this page open until it completes (closing pauses the run; you can resume later).'
    : 'Results will be emailed to you when complete — you can safely leave this page.';

  const panel = document.createElement('div');
  panel.id = 'ai-review-live';
  panel.style.cssText = 'margin-top: 8px;';
  panel.innerHTML = `
      <p style="font-size: var(--sc-11); color: var(--color-label); margin: 0 0 6px 0; line-height: 1.4;">
        ${note}
      </p>
      <button type="button" id="ai-review-viz-toggle" style="background: none; border: none; padding: 0; font-size: var(--sc-11); color: var(--hyperlit-aqua); text-decoration: underline; cursor: pointer;">
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

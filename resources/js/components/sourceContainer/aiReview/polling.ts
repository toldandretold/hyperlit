// AI review status polling: interval management + a single poll that reads the
// pipeline status, updates the button + live viz, and on completion pulls the
// new highlights into IndexedDB. Peer calls (setAiReviewState, renderPipelineViz,
// syncPipelineHighlights) route through `self`.

import { pipelineNothingToReview } from './pipelineState';

export function startAiReviewPolling(self: any, intervalMs = 30000) {
  self.stopAiReviewPolling(); // clear any existing interval
  self._aiReviewPollInterval = setInterval(() => {
    self.pollAiReviewStatus();
  }, intervalMs);
}

export function stopAiReviewPolling(self: any) {
  if (self._aiReviewPollInterval) {
    clearInterval(self._aiReviewPollInterval);
    self._aiReviewPollInterval = null;
  }
}

export async function pollAiReviewStatus(self: any) {
  try {
    if (!self._pipelineId) return;

    const resp = await fetch(`/api/citation-pipeline/status/${encodeURIComponent(self._pipelineId)}`, {
      credentials: 'include',
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const pipeline = data.pipeline;
    if (!pipeline) return;

    if (pipeline.status === 'completed') {
      self.stopAiReviewPolling();
      // "Nothing to review" (0 bibliography entries + 0 citation footnotes):
      // no /AIreview report exists, so the button must NOT navigate there.
      const nothingToReview = pipelineNothingToReview(pipeline);
      self.setAiReviewState('completed', undefined, { nothingToReview });
      // If the live overlay is open, show the final state
      self.renderPipelineViz(pipeline);

      // Pull pipeline-created highlights into IndexedDB so they render immediately
      // (nothing to sync in the empty case).
      if (!nothingToReview) self.syncPipelineHighlights(pipeline.book);
    } else if (pipeline.status === 'failed') {
      self.stopAiReviewPolling();
      // Show the failure in the live viz (if open) before resetting the button
      self.renderPipelineViz(pipeline);
      // Reset button to idle state
      const aiBtn = self.container.querySelector('#ai-review-btn');
      if (aiBtn) {
        aiBtn.disabled = false;
        aiBtn.style.color = 'var(--hyperlit-orange)';
        aiBtn.style.borderColor = 'rgba(239,141,52,0.4)';
        aiBtn.style.cursor = 'pointer';
        aiBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            AI Citation Review`;
      }
    } else {
      // Still running — update the step display + live viz
      self.setAiReviewState('reviewing', pipeline.current_step);
      self.renderPipelineViz(pipeline);
    }
  } catch (err) {
    console.warn('AI review poll failed:', err);
  }
}

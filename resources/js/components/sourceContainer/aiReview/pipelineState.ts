// Zero-import leaf: pure predicates over a polled citation-pipeline object.
// Shared by the live-viz renderer (pipelineViz.ts) and the poller (polling.ts)
// so "what does this completed pipeline actually mean" is defined in one place.

/**
 * True when the pipeline finished but there was genuinely nothing to review:
 * the backend (CitationPipelineCommand) found 0 bibliography entries AND 0
 * citation footnotes, emitted `review: skipped` with detail "No bibliography
 * entries or citation footnotes", and still marked the pipeline `completed`.
 *
 * In that state the `/{book}/AIreview` sub-book is never created and no email
 * is sent — so the UI must NOT claim "Review complete · View the report ·
 * emailed to you".
 *
 * We require BOTH the skipped review stage AND the zero bibliography signals,
 * so a deliberate CLI `--skip-review` on a book that DOES have a bibliography
 * (review skipped, but signals non-zero) is not mistaken for the empty case.
 * If signals are absent (older runs predating them), returns false → callers
 * fall back to the normal completion banner, no regression.
 */
export function pipelineNothingToReview(pipeline: any): boolean {
  if (!pipeline || pipeline.status !== 'completed') return false;

  const telemetry: any[] = Array.isArray(pipeline.telemetry) ? pipeline.telemetry : [];

  // Sticky-resolve the `review` stage status (mirrors statusOf() in pipelineViz)
  // and capture the latest `bibliography` signals snapshot.
  let reviewStatus: string | null = null;
  let bibSignals: any = null;
  for (const ev of telemetry) {
    if (ev.stage === 'review') {
      if (ev.status === 'started') reviewStatus = 'running';
      else if (ev.status === 'progress') { if (reviewStatus === null || reviewStatus === 'running') reviewStatus = 'running'; }
      else if (ev.status === 'completed') reviewStatus = 'done';
      else if (ev.status === 'failed') reviewStatus = 'failed';
      else if (ev.status === 'skipped') reviewStatus = 'skipped';
    }
    if (ev.stage === 'bibliography' && ev.signals) bibSignals = ev.signals;
  }

  if (reviewStatus !== 'skipped') return false;
  if (!bibSignals) return false;

  const entries = Number(bibSignals.entries ?? 0);
  const footnoteCitations = Number(bibSignals.footnote_citations ?? 0);
  return entries === 0 && footnoteCitations === 0;
}

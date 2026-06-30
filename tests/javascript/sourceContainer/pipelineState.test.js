/**
 * pipelineNothingToReview — the predicate that distinguishes a citation-review
 * pipeline that genuinely had nothing to review (0 bibliography entries + 0
 * citation footnotes → backend skipped vacuum/ocr/review but still marked the
 * run `completed`) from a real completion. Drives the honest empty-state banner
 * and the non-navigating button, instead of the false "Review complete · View
 * the report · emailed to you".
 */
import { describe, it, expect } from 'vitest';
import { pipelineNothingToReview } from '../../../resources/js/components/sourceContainer/aiReview/pipelineState';

// Telemetry mirroring the real "nothing to review" run from production logs.
const emptyTelemetry = [
  { at: 't1', stage: 'bibliography', detail: 'Scanning bibliography entries', status: 'started' },
  { at: 't2', stage: 'bibliography', detail: 'Bibliography scan finished', status: 'progress', signals: { entries: 0, footnote_citations: 0 } },
  { at: 't3', stage: 'bibliography', detail: 'Scanning in-text citations', status: 'progress' },
  { at: 't4', stage: 'vacuum', detail: 'No bibliography entries or citation footnotes', status: 'skipped' },
  { at: 't5', stage: 'ocr', detail: 'No bibliography entries or citation footnotes', status: 'skipped' },
  { at: 't6', stage: 'review', detail: 'No bibliography entries or citation footnotes', status: 'skipped' },
  { at: 't7', stage: 'bibliography', status: 'completed' },
];

describe('pipelineNothingToReview', () => {
  it('is TRUE for a completed run where review was skipped with zero bibliography signals', () => {
    expect(pipelineNothingToReview({ status: 'completed', book: 'book_1', telemetry: emptyTelemetry })).toBe(true);
  });

  it('is FALSE for a genuine completion where review actually ran', () => {
    const telemetry = [
      { stage: 'bibliography', status: 'completed', signals: { entries: 12, footnote_citations: 40 } },
      { stage: 'vacuum', status: 'completed' },
      { stage: 'review', status: 'started' },
      { stage: 'review', status: 'completed' },
    ];
    expect(pipelineNothingToReview({ status: 'completed', book: 'book_2', telemetry })).toBe(false);
  });

  it('is FALSE for a CLI --skip-review on a book that DOES have a bibliography (review skipped, signals non-zero)', () => {
    const telemetry = [
      { stage: 'bibliography', status: 'completed', signals: { entries: 12, footnote_citations: 5 } },
      { stage: 'review', status: 'skipped', detail: 'Skipped (--skip-review)' },
    ];
    expect(pipelineNothingToReview({ status: 'completed', book: 'book_3', telemetry })).toBe(false);
  });

  it('is FALSE when the pipeline has not completed yet', () => {
    expect(pipelineNothingToReview({ status: 'running', book: 'book_4', telemetry: emptyTelemetry })).toBe(false);
  });

  it('is FALSE when review skipped but signals are absent (older runs) — fall back to normal banner', () => {
    const telemetry = [
      { stage: 'bibliography', status: 'completed' },
      { stage: 'review', status: 'skipped', detail: 'No bibliography entries or citation footnotes' },
    ];
    expect(pipelineNothingToReview({ status: 'completed', book: 'book_5', telemetry })).toBe(false);
  });

  it('is robust to a missing/empty telemetry array', () => {
    expect(pipelineNothingToReview({ status: 'completed', book: 'book_6' })).toBe(false);
    expect(pipelineNothingToReview(null)).toBe(false);
  });
});

// @vitest-environment happy-dom
/**
 * runIntegritySweep — an untouched read-mode sub-book PREVIEW is not a lost write.
 *
 * A read-mode footnote renders its parent record's `preview_nodes`, which never pass
 * through IndexedDB. When the server holds no such sub-book (a tab carrying the footnote
 * record of a superseded conversion — footnote ids are re-minted per conversion), the
 * node stays DOM 1 / IDB 0 / PG 0 forever and every container close raised the integrity
 * alarm (prod 2026-11-27, lenin-1914-disruption-of-unity-under-cover/Fn1795668256482_0005).
 *
 * The exemption must be precise: only a node whose text is STILL its preview. An edited
 * preview node that never reached IDB is exactly what the sweep exists to report.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFreshIndexedDB } from '../indexedDB/idbHarness.js';

const reportIntegrityFailure = vi.fn();
vi.mock('../../../resources/js/integrity/reporter', () => ({ reportIntegrityFailure }));

const { runIntegritySweep } = await import('../../../resources/js/integrity/verifier');

const SUB = 'parentBook/Fn1795668256482_0005';
const NODE_ID = '08ba7a00-8282-47d8-be78-ec2b2d304bc3';
const PREVIEW = [{
  node_id: NODE_ID,
  content: `<p id="1" data-node-id="${NODE_ID}">This refers to Prosveshcheniye.</p>`,
}];

function mount(text) {
  document.body.innerHTML = `
    <div class="sub-book-content" data-book-id="${SUB}">
      <div class="chunk" data-chunk-id="0">
        <p id="1" data-node-id="${NODE_ID}">${text}</p>
      </div>
    </div>`;
  return document.querySelector('.sub-book-content');
}

describe('runIntegritySweep — read-mode preview sub-books', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    reportIntegrityFailure.mockClear();
  });

  it('does not report an untouched preview node that is absent from IDB', async () => {
    const el = mount('This refers to Prosveshcheniye.');
    const res = await runIntegritySweep(SUB, el, 'closeHyperlitContainer', { previewSource: PREVIEW });
    expect(res.ok).toBe(true);
    expect(res.missingFromIDB).toHaveLength(0);
    expect(reportIntegrityFailure).not.toHaveBeenCalled();
  });

  it('still reports a preview node whose text was EDITED but never reached IDB', async () => {
    const el = mount('This refers to Prosveshcheniye, edited.');
    const res = await runIntegritySweep(SUB, el, 'closeHyperlitContainer', { previewSource: PREVIEW });
    expect(res.ok).toBe(false);
    expect(res.missingFromIDB).toHaveLength(1);
    expect(reportIntegrityFailure).toHaveBeenCalledTimes(1);
  });

  it('still reports a missing node when the sub-book is not a preview', async () => {
    const el = mount('This refers to Prosveshcheniye.');
    const res = await runIntegritySweep(SUB, el, 'closeHyperlitContainer');
    expect(res.missingFromIDB).toHaveLength(1);
    expect(reportIntegrityFailure).toHaveBeenCalledTimes(1);
  });
});

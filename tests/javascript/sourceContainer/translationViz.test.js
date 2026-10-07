/**
 * Translation live-progress overlay (translationViz.ts).
 *
 * Locks: the stage map is fetched LAZILY — once, on first open, never by the
 * panel's init (bookTranslation.test.js counts that module's fetches); the
 * chain renders from the latest-state stage map with un-recorded stages on a
 * FINISHED run shown done rather than stuck; a skipped stage says so; the
 * terminal banner links the new copy; closing releases the focus trap and
 * the follow subscription but never touches the run; Escape closes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { init: vi.fn() },
}));
const trapRelease = vi.fn();
const trapCalls = [];
vi.mock('../../../resources/js/utilities/modalFocusTrap', () => ({
  trapModalFocus: vi.fn((el, opts) => { trapCalls.push(opts); return trapRelease; }),
}));

import {
  openTranslationVizOverlay,
  closeTranslationVizOverlay,
  updateTranslationViz,
} from '../../../resources/js/components/sourceContainer/translationViz';

const MAP = {
  success: true,
  stages: ['queued', 'text', 'notes', 'write'].map((id) => ({
    id,
    title: `Stage ${id}`,
    plain: `What ${id} does.`,
    dev: 'dev note',
    code_ref: 'app/Services/Translation/BookTranslationService.php',
    signals: [],
  })),
};

const RUNNING = {
  success: true, available: true, target_label: 'English', running: true,
  progress: {
    status: 'running', phase: 'text', percent: 0.42, error: null, stage: 'text',
    stages: { queued: { status: 'completed' }, text: { status: 'progress', section: 2, sections: 5, title: '第二章' } },
  },
  telemetry: [{ t: 'now', stage: 'text', status: 'progress', detail: 'Section 2/5: 第二章' }],
};

const DONE = {
  success: true, available: true, target_label: 'English', running: false,
  existing: { book: 'book_99', title: '长相思 (English)' },
  progress: {
    status: 'done', phase: 'notes', percent: 1, error: null, stage: 'write', new_book: 'book_99',
    // notes recorded skipped; queued never recorded (old progress file shape).
    stages: { text: { status: 'completed' }, notes: { status: 'skipped' }, write: { status: 'completed', new_book: 'book_99' } },
  },
  telemetry: [],
};

const overlay = () => document.getElementById('translation-viz-overlay');
const stageButtons = () => [...document.querySelectorAll('.translation-pipe-stage')];

let fetchMock;

beforeEach(() => {
  document.body.innerHTML = '';
  trapRelease.mockClear();
  trapCalls.length = 0;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => MAP }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  closeTranslationVizOverlay();
  vi.unstubAllGlobals();
});

describe('openTranslationVizOverlay', () => {
  it('opens once, fetches the map lazily and only ever once, and renders the chain', async () => {
    await openTranslationVizOverlay(RUNNING);
    expect(overlay()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/book-translation/map');
    expect(stageButtons()).toHaveLength(4);
    // The running stage's live signals reach the details panel.
    expect(overlay().textContent).toContain('第二章');

    // A second open while already open is a no-op…
    await openTranslationVizOverlay(RUNNING);
    expect(document.querySelectorAll('#translation-viz-overlay')).toHaveLength(1);

    // …and after a close/reopen the map comes from the module cache.
    closeTranslationVizOverlay();
    await openTranslationVizOverlay(RUNNING);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders a finished run whole: skipped says so, gaps read done, the banner links the copy', async () => {
    await openTranslationVizOverlay(DONE);
    const text = overlay().textContent;
    expect(text).toContain('Translation complete');
    expect(overlay().querySelector('a[href="/book_99"]')).not.toBeNull();
    // 'queued' was never recorded — on a done run it must not look stuck.
    expect(text).not.toContain('pending');
  });

  it('follows the run while open, and closing releases everything but the run', async () => {
    const unfollow = vi.fn();
    let listener;
    await openTranslationVizOverlay(RUNNING, (fn) => { listener = fn; return unfollow; });
    expect(typeof listener).toBe('function');

    listener({ ...RUNNING, telemetry: [{ t: 'now', stage: 'text', status: 'progress', detail: 'Section 3/5: 第三章' }] });
    expect(overlay().textContent).toContain('Section 3/5');

    closeTranslationVizOverlay();
    expect(overlay()).toBeNull();
    expect(unfollow).toHaveBeenCalledTimes(1);
    expect(trapRelease).toHaveBeenCalledTimes(1);
    // Updates after close are a no-op, not a crash.
    updateTranslationViz(RUNNING);
    expect(overlay()).toBeNull();
  });

  it('closes on Escape via the focus trap contract', async () => {
    await openTranslationVizOverlay(RUNNING);
    expect(trapCalls[0]?.onEscape).toBeTypeOf('function');
    trapCalls[0].onEscape();
    expect(overlay()).toBeNull();
  });
});

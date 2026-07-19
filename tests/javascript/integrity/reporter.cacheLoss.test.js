// @vitest-environment happy-dom
/**
 * Integrity reporter — the local-cache-loss modal (ex-"Okay, hacker").
 *
 * The ">80% of DOM nodes missing from IDB with ZERO mismatches" signature is
 * browser storage eviction (Safari ITP 7-day wipe / disk-pressure eviction /
 * dead IDB connection dropping writes) — a manual DevTools wipe + refresh just
 * re-downloads from the server and never produces it. These tests pin:
 *   1. the signature shows the honest cache-loss card, NOT a hacker accusation
 *   2. cache-loss does NOT auto-grant premium (it isn't data loss);
 *      genuine mismatch data-loss still does
 *   3. the Restore button clears the book from IDB (stale survivors included)
 *   4. the report wire format keeps the `suspiciousWipe` field name the
 *      server's IntegrityReportController validates
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/integrity/logCapture', () => ({
  getRecentLogs: () => [],
}));
vi.mock('../../../resources/js/utilities/modalFocusTrap', () => ({
  trapModalFocus: vi.fn(() => vi.fn()),
}));
vi.mock('../../../resources/js/indexedDB/core/healthMonitor', () => ({
  isIDBBroken: () => false,
}));
vi.mock('../../../resources/js/integrity/emergencyBackup', () => ({
  buildBrowserMd: vi.fn(async () => null),
  buildBrowserDatabaseMd: vi.fn(async () => null),
  buildServerDatabaseMd: vi.fn(async () => null),
  buildStitchedUpMd: vi.fn(() => null),
  buildReadme: vi.fn(() => ''),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  isLoggedIn: vi.fn(async () => true),
}));
// Reporter counts IDB nodes for context — no real IDB in tests; the count
// path catches the rejection and reports 0.
vi.mock('../../../resources/js/indexedDB/core/connection', () => ({
  openDatabase: vi.fn(() => Promise.reject(new Error('no IDB in test'))),
}));
const deleteBookFromIndexedDB = vi.fn(async () => ({ success: true, deleted: {} }));
vi.mock('../../../resources/js/indexedDB/utilities/cleanup', () => ({
  deleteBookFromIndexedDB: (...args) => deleteBookFromIndexedDB(...args),
}));

const BOOK = 'book_cache_loss_test';

/** Build the book container: `total` block nodes with numeric ids. */
function buildDom(total = 86) {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = BOOK;
  for (let i = 1; i <= total; i++) {
    const p = document.createElement('p');
    p.id = String(i * 100);
    p.textContent = `node ${i}`;
    container.appendChild(p);
  }
  document.body.appendChild(container);
}

/** `count` MissingNode entries as the verifier emits them. */
function missing(count) {
  return Array.from({ length: count }, (_, i) => ({
    startLine: String((i + 1) * 100),
    nodeId: `${BOOK}_${i}_x`,
    tag: 'P',
    domText: `node ${i + 1}`,
  }));
}

let fetchCalls;
beforeEach(() => {
  vi.resetModules();
  fetchCalls = [];
  deleteBookFromIndexedDB.mockClear();
  global.fetch = vi.fn(async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  });
  buildDom();
});

const loadReporter = () => import('../../../resources/js/integrity/reporter');

describe('local-cache-loss modal', () => {
  it('mass-missing signature shows the honest cache-loss card, never a hacker accusation', async () => {
    const { reportIntegrityFailure } = await loadReporter();
    await reportIntegrityFailure({ bookId: BOOK, missingFromIDB: missing(81), trigger: 'periodic-save' });

    const card = document.querySelector('#integrity-failure-backdrop .integrity-card');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('browser cleared');
    expect(card.textContent).toContain('safe on the server');
    expect(card.textContent).not.toMatch(/hacker/i);
    expect(card.querySelector('#integrity-restore-btn')).toBeTruthy();
    expect(card.querySelector('#integrity-send-report-btn')).toBeTruthy();
    expect(card.querySelector('#integrity-dismiss-btn')).toBeTruthy();
  });

  it('genuine mismatch data-loss auto-grants premium; cache-loss does NOT', async () => {
    const { reportIntegrityFailure } = await loadReporter();

    // Real mismatch (data loss) first — no cooldown yet, modal shows + grants.
    await reportIntegrityFailure({
      bookId: BOOK,
      mismatches: [{ startLine: '100', nodeId: 'n', domText: 'a', idbText: 'b' }],
      trigger: 'save',
    });
    expect(fetchCalls.filter(c => c.url.includes('claim-premium'))).toHaveLength(1);

    // Cache-loss OVERRIDES the open modal + cooldown by design — but must not
    // add a second grant (browser eviction isn't data loss).
    await reportIntegrityFailure({ bookId: BOOK, missingFromIDB: missing(81), trigger: 'periodic-save' });
    expect(document.querySelector('.integrity-card').textContent).toContain('browser cleared');
    expect(fetchCalls.filter(c => c.url.includes('claim-premium'))).toHaveLength(1);
  });

  it('Restore button wipes the book from IDB (stale survivors included) before reloading', async () => {
    const { reportIntegrityFailure } = await loadReporter();
    await reportIntegrityFailure({ bookId: BOOK, missingFromIDB: missing(81), trigger: 'periodic-save' });

    document.querySelector('#integrity-restore-btn').click();
    await vi.waitFor(() => expect(deleteBookFromIndexedDB).toHaveBeenCalledWith(BOOK));
  });

  it('sent report keeps the suspiciousWipe wire field (server controller compat) set true', async () => {
    const { reportIntegrityFailure } = await loadReporter();
    await reportIntegrityFailure({ bookId: BOOK, missingFromIDB: missing(81), trigger: 'periodic-save' });

    document.querySelector('#integrity-send-report-btn').click();
    await vi.waitFor(() => {
      const report = fetchCalls.find(c => c.url.includes('/api/integrity/report'));
      expect(report).toBeTruthy();
      expect(JSON.parse(report.opts.body).suspiciousWipe).toBe(true);
    });
    // Premium rides on sending the report for cache-loss (parity with server-error modal)
    await vi.waitFor(() =>
      expect(fetchCalls.filter(c => c.url.includes('claim-premium')).length).toBe(1));
  });

  it('small partial loss (below the 80% signature) is NOT classed as cache loss', async () => {
    const { reportIntegrityFailure } = await loadReporter();
    await reportIntegrityFailure({ bookId: BOOK, missingFromIDB: missing(12), trigger: 'save' });

    const card = document.querySelector('#integrity-failure-backdrop .integrity-card');
    expect(card).toBeTruthy();
    expect(card.textContent).not.toContain('browser cleared');
    expect(card.querySelector('#integrity-restore-btn')).toBeNull();
  });
});

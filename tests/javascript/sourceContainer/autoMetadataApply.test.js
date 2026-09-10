/**
 * autoMetadata — the Apply path and the proposal card.
 *
 * The behaviours worth locking here are the safety ones: Apply re-reads the
 * record and drops any row whose starting value moved under it (never clobber a
 * field the user just edited by hand), it regenerates the bibtex rather than
 * leaning on the server's patch (the citation line renders from the LOCAL
 * bibtex, so a columns-only write would leave "Untitled" on screen), and a
 * failed backend sync still keeps the local write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const idb = { record: null, put: vi.fn() };

vi.mock('../../../resources/js/app', () => ({ book: 'test-book' }));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: vi.fn().mockResolvedValue({
    transaction: () => ({ objectStore: () => ({ put: idb.put }) }),
  }),
  prepareLibraryForIndexedDB: (r) => r,
  getNodesFromIndexedDB: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../resources/js/components/sourceContainer/helpers', () => ({
  getRecord: vi.fn(async () => idb.record),
  isSyntheticBook: vi.fn(() => false),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getAuthContextSync: () => ({ user: { name: 'alice' } }),
}));
vi.mock('../../../resources/js/e2ee/registry', () => ({ isBookEncrypted: vi.fn(() => false) }));
vi.mock('../../../resources/js/utilities/billing/topUp', () => ({ offerTopUp: vi.fn() }));
vi.mock('../../../resources/js/aiProviders/profiles', () => ({ isByoLlmActive: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../resources/js/aiProviders/ticketWorker', () => ({ startTicketWorker: vi.fn() }));

import { applyAutoMetadata } from '../../../resources/js/components/sourceContainer/autoMetadata/index';
import {
  autoMetaIconHtml,
  proposalCardHtml,
  proposalMountHtml,
} from '../../../resources/js/components/sourceContainer/autoMetadata/card';

const proposal = (fields) => ({ tier: 'local', fields, notes: [] });

const titleRow = {
  field: 'title', current: 'Untitled', suggested: 'The Dispossessed',
  confidence: 'high', provenance: 'first heading',
};
const authorRow = {
  field: 'author', current: 'anon', suggested: 'alice',
  confidence: 'medium', provenance: 'your account',
};

/**
 * The real panel shape: the wand rides inline on the citation line, and the card
 * renders into its own slot beneath the citation block — above the action row.
 */
function mountHost(p) {
  document.body.innerHTML = `
    <div id="source-container">
      <div class="scroller" id="source-content">
        <p class="citation">anon, <i>Untitled</i> (2026).${autoMetaIconHtml()}</p>
        <p class="license-line">CC BY-SA 4.0</p>
        ${proposalMountHtml()}
        <div id="check-source-section">
          <div id="source-categories"><button id="check-source-btn"></button></div>
        </div>
      </div>
    </div>`;
  document.querySelector('#auto-meta-mount').innerHTML = proposalCardHtml(p, {});
  return {
    container: document.getElementById('source-container'),
    syncLibraryRecordToBackend: vi.fn().mockResolvedValue({}),
    refreshCitationDisplay: vi.fn().mockResolvedValue(undefined),
    handleCheckSource: vi.fn(),
  };
}

beforeEach(() => {
  idb.record = { book: 'test-book', title: 'Untitled', author: 'anon', year: '2026', creator: 'alice', type: 'book' };
  idb.put.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('applyAutoMetadata', () => {
  it('writes the ticked fields to IndexedDB and syncs once', async () => {
    const p = proposal([titleRow, authorRow]);
    const host = mountHost(p);

    await applyAutoMetadata(host, p);

    expect(idb.put).toHaveBeenCalledTimes(1);
    const written = idb.put.mock.calls[0][0];
    expect(written.title).toBe('The Dispossessed');
    expect(written.author).toBe('alice');
    expect(host.syncLibraryRecordToBackend).toHaveBeenCalledTimes(1);
    expect(host.refreshCitationDisplay).toHaveBeenCalled();
  });

  it('regenerates the bibtex so the citation line can actually change', async () => {
    // buildSourceHtml renders from the LOCAL bibtex and only synthesises one
    // when it is absent — a columns-only write would leave "Untitled" on screen.
    const p = proposal([titleRow]);
    const host = mountHost(p);

    await applyAutoMetadata(host, p);

    const written = idb.put.mock.calls[0][0];
    expect(written.bibtex).toContain('The Dispossessed');
    expect(written.bibtex).not.toContain('Untitled');
  });

  it('bumps the timestamp so the server does not treat the write as stale', async () => {
    const p = proposal([titleRow]);
    const host = mountHost(p);
    const before = Date.now();

    await applyAutoMetadata(host, p);

    expect(idb.put.mock.calls[0][0].timestamp).toBeGreaterThanOrEqual(before);
  });

  it('writes ONLY the rows the user left ticked', async () => {
    const p = proposal([titleRow, authorRow]);
    const host = mountHost(p);
    document.querySelector('#auto-meta-check-author').checked = false;

    await applyAutoMetadata(host, p);

    const written = idb.put.mock.calls[0][0];
    expect(written.title).toBe('The Dispossessed');
    expect(written.author).toBe('anon'); // untouched
  });

  it('drops a row whose value changed under it rather than clobbering', async () => {
    // The pencil form ran between propose and apply. The never-clobber
    // guarantee has to hold at WRITE time, not just at propose time.
    const p = proposal([titleRow, authorRow]);
    const host = mountHost(p);
    idb.record = { ...idb.record, title: 'A Title I Just Typed' };

    await applyAutoMetadata(host, p);

    const written = idb.put.mock.calls[0][0];
    expect(written.title).toBe('A Title I Just Typed');
    expect(written.author).toBe('alice'); // the untouched row still applies
  });

  it('writes nothing at all when every row went stale', async () => {
    const p = proposal([titleRow]);
    const host = mountHost(p);
    idb.record = { ...idb.record, title: 'A Title I Just Typed' };

    await applyAutoMetadata(host, p);

    expect(idb.put).not.toHaveBeenCalled();
    expect(host.syncLibraryRecordToBackend).not.toHaveBeenCalled();
    expect(document.querySelector('#auto-meta-note').textContent).toMatch(/already changed/i);
  });

  it('writes nothing when the user unticked everything', async () => {
    const p = proposal([titleRow]);
    const host = mountHost(p);
    document.querySelector('#auto-meta-check-title').checked = false;

    await applyAutoMetadata(host, p);

    expect(idb.put).not.toHaveBeenCalled();
    expect(document.querySelector('#auto-meta-note').textContent).toMatch(/nothing selected/i);
  });

  it('keeps the local write and still refreshes when the backend sync fails', async () => {
    const p = proposal([titleRow]);
    const host = mountHost(p);
    host.syncLibraryRecordToBackend.mockRejectedValue(new Error('offline'));

    await applyAutoMetadata(host, p);

    expect(idb.put).toHaveBeenCalledTimes(1);
    expect(host.refreshCitationDisplay).toHaveBeenCalled();
    expect(document.querySelector('#auto-meta-note').textContent).toMatch(/saved locally/i);
  });

  it('forces type=article so a journal survives generateBibtexFromForm', async () => {
    // `misc` and `book` drop the journal key entirely.
    const p = proposal([{ ...titleRow, field: 'journal', current: '', suggested: 'New Left Review' }]);
    idb.record = { ...idb.record, journal: '' };
    const host = mountHost(p);

    await applyAutoMetadata(host, p);

    const written = idb.put.mock.calls[0][0];
    expect(written.type).toBe('article');
    expect(written.bibtex).toContain('New Left Review');
  });
});

describe('the inline wand glyph', () => {
  it('carries no hardcoded fill — the source SVG ships #000000, invisible on dark glass', () => {
    const html = autoMetaIconHtml();
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain('#000000');
  });

  it('is sized for a line of text, not the SVG\'s native 800px', () => {
    const html = autoMetaIconHtml();
    expect(html).not.toContain('800px');
    expect(html).toMatch(/width="1[0-9]"/);
  });

  it('is a real button with an accessible name, and its svg is not a click target', () => {
    document.body.innerHTML = `<p>cite${autoMetaIconHtml()}</p>`;
    const btn = document.querySelector('#auto-meta-btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    // aria-hidden + pointer-events:none so the click always lands on the button.
    expect(btn.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the card into its own slot, leaving the citation line intact', () => {
    const host = mountHost(proposal([titleRow]));
    // The wand stays put — the user may want to run it again after editing.
    expect(host.container.querySelector('.citation #auto-meta-btn')).not.toBeNull();
    expect(host.container.querySelector('#auto-meta-mount #auto-meta-proposal')).not.toBeNull();
  });
});

describe('proposal card', () => {
  it('shows the AI price before it is pressed, never after', () => {
    const html = proposalCardHtml(proposal([titleRow]), {});
    expect(html).toContain('auto-meta-escalate');
    expect(html).toMatch(/\$0\.001/);
  });

  it('offers the user\'s own model as free when BYO is active', () => {
    const html = proposalCardHtml(proposal([titleRow]), { byo: true });
    expect(html).toMatch(/your own AI · free/);
  });

  it('withholds the AI tier entirely for an encrypted book', () => {
    // Its plaintext must never leave the client; the free local pass already ran.
    const html = proposalCardHtml(proposal([titleRow]), { aiBlockedReason: 'This book is encrypted…' });
    expect(html).not.toContain('auto-meta-escalate');
    expect(html).toContain('encrypted');
  });

  it('still renders (with its reasons) when there is nothing to suggest', () => {
    const html = proposalCardHtml({ tier: 'local', fields: [], notes: ['No heading found.'] }, {});
    expect(html).toContain('No heading found.');
    expect(html).not.toContain('auto-meta-apply');
    expect(html).toContain('auto-meta-cancel');
  });

  it('leaves a replace-something-deliberate row unticked, so Apply skips it', async () => {
    const replaceRow = { ...titleRow, current: 'A Title I Chose', checked: false };
    idb.record = { ...idb.record, title: 'A Title I Chose' };
    const host = mountHost(proposal([replaceRow]));

    expect(document.querySelector('#auto-meta-check-title').checked).toBe(false);

    await applyAutoMetadata(host, proposal([replaceRow]));
    expect(idb.put).not.toHaveBeenCalled();
  });

  it('shows notes alongside suggestions, not only when there are none', () => {
    // e.g. "that title is fine, but too short for the databases to search on".
    const html = proposalCardHtml(
      { tier: 'local', fields: [titleRow], notes: ['Something worth knowing.'] }, {},
    );
    expect(html).toContain('auto-meta-check-title');
    expect(html).toContain('Something worth knowing.');
  });

  it('escapes hostile field values', () => {
    const html = proposalCardHtml(
      proposal([{ ...titleRow, suggested: '<img src=x onerror=alert(1)>' }]), {},
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

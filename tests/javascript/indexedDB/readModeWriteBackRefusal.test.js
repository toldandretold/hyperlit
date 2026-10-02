// @vitest-environment jsdom
/**
 * GUARDRAIL (behavioural): a READ-mode write-back may not take a node's content
 * from a live DOM that no longer says what is stored.
 *
 * This is the test that would actually have caught the bug. The write path in
 * batch.ts is reachable with no auth gate from footnoteSelfHeal's render heal,
 * which fires on EVERY chunk render, and it flows on to IndexedDB and
 * queueForSync → Postgres. With a browser translator active, that meant a
 * reader could have Google's output stored as the book's real content.
 *
 * And it would have been undetectable after the fact: `contentProcessor` unwraps
 * `<font>` tags on save ("browser artifacts from execCommand"), while Chrome
 * Translate's entire footprint inside a paragraph is
 * `<font style="vertical-align: inherit;">…</font>`. So the save strips the only
 * evidence and stores clean, plausible prose — and the integrity verifier then
 * reports DOM↔IDB agreement, because both sides are translated. Hence the
 * first test asserts specifically that the `<font>` unwrap no longer launders it.
 *
 * The POSITIVE controls matter as much as the refusals: without them this gate
 * could be "satisfied" by a change that refuses everything, which would silently
 * break ordinary editing and the footnote renumber heal.
 *
 * Runs in `npm run test:run` (vitest + fake-indexeddb, no server).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same import-seam mocks as batchUpdate.characterization.test.js — everything
// inside resources/js/indexedDB runs for real against fake-indexeddb.
vi.mock('../../../resources/js/postgreSQL.js', () => ({
  syncIndexedDBtoPostgreSQL: vi.fn(),
}));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
vi.mock('../../../resources/js/integrity/reporter', () => ({
  reportIntegrityFailure: vi.fn(),
  reportServerError: vi.fn(),
}));
vi.mock('../../../resources/js/footnotes/FootnoteNumberingService', () => ({
  rebuildAndRenumber: vi.fn(),
  getDisplayNumber: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/auth', () => ({
  refreshCsrfToken: vi.fn(),
}));

import { installFreshIndexedDB, seedStore, readOne } from './idbHarness.js';
import {
  batchUpdateIndexedDBRecords,
  initNodeBatchDependencies,
} from '../../../resources/js/indexedDB/nodes/batch';
import {
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

const GERMAN = 'Der Kapitalismus ist ein Wirtschaftssystem.';
const ENGLISH = 'Capitalism is an economic system.';
const STORED = `<p id="100" data-node-id="bookA-n100">${GERMAN}</p>`;

/** Seed node 100 with the German (real) content. */
async function seedGermanNode() {
  await seedStore('nodes', [{
    book: 'bookA',
    startLine: 100,
    chunk_id: 1,
    node_id: 'bookA-n100',
    content: STORED,
    footnotes: [],
    citations: [],
    hyperlights: [],
    hypercites: [],
  }]);
}

/** Render the node into the DOM with the given inner HTML. */
function renderNode(innerHtml) {
  document.body.innerHTML = `
    <div class="main-content" id="bookA">
      <div class="chunk" data-chunk-id="1">
        <p id="100" data-node-id="bookA-n100">${innerHtml}</p>
      </div>
    </div>`;
}

describe('read-mode write-back refuses a DOM that drifted from what is stored', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '';
    document.documentElement.className = '';
    delete window.__hyperlitExternalTranslation;
    pendingSyncs.clear();
    initSyncQueueDependencies({ debouncedMasterSync: vi.fn() });
    initNodeBatchDependencies({ book: 'bookA' });
  });

  afterEach(() => {
    // The latch is window-backed and STICKY, so it must not leak between tests.
    document.documentElement.className = '';
    delete window.__hyperlitExternalTranslation;
  });

  it('does not persist Chrome-translated text — and the <font> unwrap cannot launder it', async () => {
    await seedGermanNode();
    // Exactly what Chrome Translate leaves behind, including the <font> wrapper
    // that contentProcessor would otherwise strip into clean prose.
    renderNode(`<font style="vertical-align: inherit;">${ENGLISH}</font>`);

    // No `source` — i.e. the read-mode default ('heal'), as footnoteSelfHeal calls it.
    await batchUpdateIndexedDBRecords([{ id: '100' }]);

    const stored = await readOne('nodes', ['bookA', 100]);
    expect(stored.content).toBe(STORED);
    expect(stored.content).not.toContain(ENGLISH);
    // Nothing translated may be on its way to the server either.
    const queued = pendingSyncs.get('nodes-bookA-100');
    expect(queued?.data?.content ?? '').not.toContain(ENGLISH);
  });

  it('refuses on the marker alone, even when the text happens to match', async () => {
    // The belt as well as the braces: a translator may be detected before it has
    // finished rewriting, and the latch is allowed to drive the refusal on its own.
    await seedGermanNode();
    renderNode(GERMAN);
    document.documentElement.classList.add('translated-ltr');

    await batchUpdateIndexedDBRecords([{ id: '100' }]);

    expect(pendingSyncs.has('nodes-bookA-100')).toBe(false);
  });

  it('refuses an EDIT-sourced write too while translated (an edit session is worse, not better)', async () => {
    // An authorized edit on a translated DOM would save every untouched
    // paragraph in the chunk in the target language. Edit-mode entry is blocked
    // upstream; this is the backstop for translation starting mid-session.
    await seedGermanNode();
    renderNode(ENGLISH);
    document.documentElement.classList.add('translated-ltr');

    await batchUpdateIndexedDBRecords([{ id: '100' }], { source: 'edit' });

    const stored = await readOne('nodes', ['bookA', 100]);
    expect(stored.content).toBe(STORED);
  });

  it('does not invent an EMPTY record for a rendered node it declined to read', async () => {
    // The new-record branch would otherwise store `content: ""`, replacing a node
    // we merely declined to look at with an empty one. Nothing is seeded here.
    renderNode(`<font style="vertical-align: inherit;">${ENGLISH}</font>`);
    document.documentElement.classList.add('translated-ltr');

    await batchUpdateIndexedDBRecords([{ id: '100' }]);

    expect(await readOne('nodes', ['bookA', 100])).toBeUndefined();
  });

  // ─────────────────────── positive controls ───────────────────────
  // Without these, "refuse everything" would pass the gate and silently break
  // both ordinary editing and the footnote-renumber heal.

  it('POSITIVE: an edit-sourced write still persists a legitimately changed DOM', async () => {
    await seedGermanNode();
    renderNode('Der Kapitalismus ist etwas anderes.');

    await batchUpdateIndexedDBRecords([{ id: '100' }], { source: 'edit' });

    const stored = await readOne('nodes', ['bookA', 100]);
    expect(stored.content).toContain('etwas anderes');
  });

  it('POSITIVE: a heal still persists when only a footnote MARKER number changed', async () => {
    // The one legitimate read-mode text change, and the whole reason the heal
    // exists. A naive "text must match exactly" gate breaks precisely this.
    const storedWithMarker =
      '<p id="100" data-node-id="bookA-n100">Ein Satz'
      + '<sup fn-count-id="7" id="Fn7"><a class="footnote-ref" href="#Fn7">7</a></sup></p>';
    await seedStore('nodes', [{
      book: 'bookA',
      startLine: 100,
      chunk_id: 1,
      node_id: 'bookA-n100',
      content: storedWithMarker,
      footnotes: [],
      citations: [],
      hyperlights: [],
      hypercites: [],
    }]);
    // Same prose, renumbered marker (7 → 2) exactly as the renumber would leave it.
    renderNode('Ein Satz<sup fn-count-id="2" id="Fn7"><a class="footnote-ref" href="#Fn7">2</a></sup>');

    await batchUpdateIndexedDBRecords([{ id: '100' }]);

    const stored = await readOne('nodes', ['bookA', 100]);
    expect(stored.content).toContain('fn-count-id="2"');
  });
});

/**
 * Payload transforms — the per-store field walkers the sync seam runs on.
 * Pins WHICH fields are content-bearing per store (FIELD_SPECS), that
 * structural fields stay plaintext, that encryption is idempotent, and that
 * decryption is self-describing (plaintext rows untouched, even vault-locked).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';
import {
  createVault,
  createDekForBook,
  clearKeyCaches,
  VaultLockedError,
} from '../../../resources/js/e2ee/keys';
import {
  FIELD_SPECS,
  encryptStoreRows,
  encryptNodes,
  decryptRows,
  encryptUnifiedPayload,
} from '../../../resources/js/e2ee/transform';
import { isEnvelope, isJsonEnvelope } from '../../../resources/js/e2ee/envelope';

const BOOK = 'bk1';

async function setUpEncryptedBook(book = BOOK) {
  await createVault();
  const { wrappedDek } = await createDekForBook(book);
  await seedStore('library', [{ book, wrapped_dek: wrappedDek }]);
  return wrappedDek;
}

function sampleNode() {
  return {
    book: BOOK,
    startLine: 100,
    chunk_id: 1,
    node_id: 'bk1_123_abc',
    content: '<p>SECRET body</p>',
    hyperlights: [{ highlightID: 'hl1', annotation: 'SECRET note', charStart: 0, charEnd: 4 }],
    hypercites: [{ hyperciteId: 'hc1', relationshipStatus: 'single', citedIN: [], charStart: 0, charEnd: 2 }],
    footnotes: [{ id: 'fn1', marker: '1' }],
    citations: [{ referenceId: 'ref1', text: 'SECRET citation' }],
    raw_json: { content: '<p>SECRET body</p>' },
    plainText: 'SECRET body',
  };
}

beforeEach(async () => {
  installFreshIndexedDB();
  clearKeyCaches();
});

describe('encryptRecordForStore via encryptNodes', () => {
  it('envelopes content fields, drops plainText, leaves structural fields alone', async () => {
    await setUpEncryptedBook();
    const [enc] = await encryptNodes(BOOK, [sampleNode()]);

    expect(isEnvelope(enc.content)).toBe(true);
    expect(isJsonEnvelope(enc.hyperlights)).toBe(true);
    expect(isJsonEnvelope(enc.hypercites)).toBe(true);
    expect(isJsonEnvelope(enc.footnotes)).toBe(true);
    expect(isJsonEnvelope(enc.citations)).toBe(true);
    expect(isJsonEnvelope(enc.raw_json)).toBe(true);
    expect('plainText' in enc).toBe(false);

    expect(enc.book).toBe(BOOK);
    expect(enc.startLine).toBe(100);
    expect(enc.chunk_id).toBe(1);
    expect(enc.node_id).toBe('bk1_123_abc');

    expect(JSON.stringify(enc)).not.toContain('SECRET');
  });

  it('does not mutate the caller record (IDB stays plaintext)', async () => {
    await setUpEncryptedBook();
    const original = sampleNode();
    await encryptNodes(BOOK, [original]);
    expect(original.content).toBe('<p>SECRET body</p>');
    expect(original.plainText).toBe('SECRET body');
  });

  it('is idempotent — encrypting twice leaves already-enveloped fields untouched', async () => {
    await setUpEncryptedBook();
    const [once] = await encryptNodes(BOOK, [sampleNode()]);
    const [twice] = await encryptNodes(BOOK, [once]);
    expect(twice).toEqual(once);
  });

  it('throws VaultLockedError instead of passing plaintext through when locked', async () => {
    await expect(encryptNodes(BOOK, [sampleNode()])).rejects.toBeInstanceOf(VaultLockedError);
  });
});

describe('decryptRows', () => {
  it('round-trips every store spec', async () => {
    await setUpEncryptedBook();

    const fixtures = {
      nodes: sampleNode(),
      hyperlights: {
        book: BOOK, hyperlight_id: 'hl1', node_id: ['n1'], startLine: 5,
        annotation: 'SECRET a', highlightedText: 'SECRET t', highlightedHTML: '<b>SECRET t</b>',
        charData: { n1: { charStart: 1, charEnd: 9 } }, preview_nodes: [{ content: 'SECRET p' }],
      },
      hypercites: {
        book: BOOK, hyperciteId: 'hc1', node_id: ['n1'], relationshipStatus: 'couple',
        hypercitedText: 'SECRET q', hypercitedHTML: '<i>SECRET q</i>',
        charData: { n1: { charStart: 0, charEnd: 8 } }, citedIN: ['bk9'],
      },
      footnotes: { book: BOOK, footnoteId: 'fn1', content: '<p>SECRET f</p>', preview_nodes: [] },
      bibliography: { book: BOOK, referenceId: 'ref1', content: 'SECRET bib', source_id: 'src9' },
      library: { book: BOOK, title: 'SECRET title', author: 'SECRET author', year: '1984', timestamp: 5 },
    };

    for (const [store, row] of Object.entries(fixtures)) {
      const [enc] = await encryptStoreRows(store, BOOK, [{ ...row }]);
      // Every spec'd string field that was set became an envelope
      for (const f of FIELD_SPECS[store].strings) {
        if (row[f]) expect(isEnvelope(enc[f]), `${store}.${f}`).toBe(true);
      }
      const [dec] = await decryptRows(store, [enc]);
      if (store === 'nodes') {
        const { plainText, ...rest } = row;
        expect(dec).toEqual(rest);
      } else {
        expect(dec).toEqual(row);
      }
    }
  });

  it('passes plaintext rows through untouched WITHOUT needing the vault', async () => {
    // No vault at all — a reader of public books must never hit VaultLockedError
    const rows = [sampleNode(), { book: 'other', startLine: 1, content: '<p>plain</p>' }];
    const out = await decryptRows('nodes', rows);
    expect(out).toEqual(rows);
  });

  it('rejects ciphertext spliced into another book (AAD mismatch)', async () => {
    await setUpEncryptedBook('bk1');
    const { wrappedDek } = await createDekForBook('bk2');
    await seedStore('library', [{ book: 'bk2', wrapped_dek: wrappedDek }]);

    const [enc] = await encryptNodes('bk1', [sampleNode()]);
    const spliced = { ...enc, book: 'bk2' }; // attacker moves row between books
    await expect(decryptRows('nodes', [spliced])).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    await setUpEncryptedBook();
    const [enc] = await encryptNodes(BOOK, [sampleNode()]);
    const segments = enc.content.split('.');
    const flipped = segments[3].startsWith('A') ? 'B' + segments[3].slice(1) : 'A' + segments[3].slice(1);
    const tampered = { ...enc, content: [segments[0], segments[1], segments[2], flipped].join('.') };
    await expect(decryptRows('nodes', [tampered])).rejects.toThrow();
  });
});

describe('encryptUnifiedPayload', () => {
  it('encrypts every section, keeps _action markers and the book id plaintext', async () => {
    await setUpEncryptedBook();

    const payload = {
      book: BOOK,
      nodes: [sampleNode(), { ...sampleNode(), startLine: 101, _action: 'delete' }],
      hypercites: [{ book: BOOK, hyperciteId: 'hc1', hypercitedText: 'SECRET', citedIN: [], charData: {}, node_id: [], relationshipStatus: 'single' }],
      hyperlights: [{ book: BOOK, hyperlight_id: 'hl1', annotation: 'SECRET', highlightedText: 'SECRET', highlightedHTML: 'SECRET', charData: {}, node_id: [] }],
      hyperlightDeletions: [{ book: BOOK, hyperlight_id: 'hl2', _action: 'delete' }],
      footnotes: [{ book: BOOK, footnoteId: 'fn1', content: 'SECRET' }],
      footnoteDeletions: [],
      bibliography: [{ book: BOOK, referenceId: 'r1', content: 'SECRET' }],
      bibliographyDeletions: [],
      library: { book: BOOK, title: 'SECRET title', timestamp: 1 },
    };

    const enc = await encryptUnifiedPayload(payload);

    expect(enc.book).toBe(BOOK);
    expect(enc.nodes[1]._action).toBe('delete');
    expect(enc.hyperlightDeletions[0]._action).toBe('delete');
    expect(enc.hyperlightDeletions[0].hyperlight_id).toBe('hl2');
    expect(isEnvelope(enc.library.title)).toBe(true);
    expect(enc.library.timestamp).toBe(1);
    expect(JSON.stringify(enc)).not.toContain('SECRET');
  });

  it('sub-book payloads use the ROOT book DEK', async () => {
    await setUpEncryptedBook('bk1');
    const payload = {
      book: 'bk1/Fn3',
      nodes: [{ book: 'bk1/Fn3', startLine: 100, chunk_id: 1, node_id: null, content: 'SECRET sub', hyperlights: [], hypercites: [], footnotes: [] }],
      hypercites: [], hyperlights: [], hyperlightDeletions: [],
      footnotes: [], footnoteDeletions: [], bibliography: [], bibliographyDeletions: [],
      library: null,
    };
    const enc = await encryptUnifiedPayload(payload);
    expect(isEnvelope(enc.nodes[0].content)).toBe(true);
    // And the download path can bring it back (root DEK via rootBookId)
    const [dec] = await decryptRows('nodes', enc.nodes);
    expect(dec.content).toBe('SECRET sub');
  });
});

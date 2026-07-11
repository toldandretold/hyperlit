import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the read-only server fetch and the E2EE decrypt seam so we can drive the check
// deterministically. nodePlainText (DOMParser) runs for real under happy-dom.
const fetchServerNodesRaw = vi.fn();
vi.mock('../../../resources/js/indexedDB/serverSync/pull', () => ({
  fetchServerNodesRaw: (...args) => fetchServerNodesRaw(...args),
}));

const decryptRows = vi.fn();
vi.mock('../../../resources/js/e2ee/transform', () => ({
  decryptRows: (...args) => decryptRows(...args),
}));

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn(), init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  verbose: { content: vi.fn() },
}));

import { isLostAckSelfConflict } from '../../../resources/js/indexedDB/syncQueue/selfConflictContentCheck';

const BOOK = 'book_123';
// A server row is passed through decryptRows before comparison; default no-op (plaintext book).
function serverRow(overrides) {
  return { book: BOOK, startLine: 1, chunk_id: 1, node_id: 'n1', content: '', ...overrides };
}
function localNode(overrides) {
  return { book: BOOK, startLine: 1, node_id: 'n1', content: '', ...overrides };
}

describe('isLostAckSelfConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: decryptRows is a pass-through (plaintext book — no envelopes).
    decryptRows.mockImplementation((_store, rows) => Promise.resolve(rows));
  });

  it('returns true when every conflicting node matches the server text (lost-ACK)', async () => {
    fetchServerNodesRaw.mockResolvedValue([serverRow({ node_id: 'n1', content: '<p>Hello world</p>' })]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ node_id: 'n1', content: '<p>Hello world</p>' }),
    ]);
    expect(result).toBe(true);
    expect(fetchServerNodesRaw).toHaveBeenCalledWith(BOOK);
    expect(decryptRows).toHaveBeenCalledWith('nodes', expect.any(Array));
  });

  it('matches on normalized TEXT even when HTML differs (server-side sanitizer drift)', async () => {
    // Same words, different markup/whitespace — should still be recognized as our own write.
    fetchServerNodesRaw.mockResolvedValue([serverRow({ content: '<p>Hello   <b>world</b></p>' })]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '<p>Hello <b>world</b></p>\n' }),
    ]);
    expect(result).toBe(true);
  });

  it('returns false when a conflicting node text differs (real other-device edit)', async () => {
    fetchServerNodesRaw.mockResolvedValue([serverRow({ content: '<p>A different sentence</p>' })]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '<p>My sentence</p>' }),
    ]);
    expect(result).toBe(false);
  });

  it('returns false when a conflicting node has no server counterpart', async () => {
    fetchServerNodesRaw.mockResolvedValue([serverRow({ node_id: 'other', startLine: 99 })]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ node_id: 'n1', startLine: 1, content: '<p>Hello</p>' }),
    ]);
    expect(result).toBe(false);
  });

  it('falls back to startLine when node_id is null and matches', async () => {
    fetchServerNodesRaw.mockResolvedValue([serverRow({ node_id: null, startLine: 5, content: '<p>x</p>' })]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ node_id: null, startLine: 5, content: '<p>x</p>' }),
    ]);
    expect(result).toBe(true);
  });

  it('returns false (blocks) if any deletion is present in the batch', async () => {
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '<p>Hello</p>' }),
      { book: BOOK, startLine: 2, node_id: 'n2', _action: 'delete' },
    ]);
    expect(result).toBe(false);
    expect(fetchServerNodesRaw).not.toHaveBeenCalled(); // short-circuits before the fetch
  });

  it('returns false when there are no content-bearing nodes to verify', async () => {
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '' }),
    ]);
    expect(result).toBe(false);
    expect(fetchServerNodesRaw).not.toHaveBeenCalled();
  });

  it('ignores nodes belonging to a different book', async () => {
    fetchServerNodesRaw.mockResolvedValue([serverRow({ content: '<p>Hello</p>' })]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '<p>Hello</p>' }),
      { book: 'other_book', startLine: 1, node_id: 'x', content: '<p>unrelated</p>' },
    ]);
    expect(result).toBe(true);
  });

  it('returns false (blocks) when the server fetch throws (offline / cannot verify)', async () => {
    fetchServerNodesRaw.mockRejectedValue(new Error('network down'));
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '<p>Hello</p>' }),
    ]);
    expect(result).toBe(false);
  });

  it('E2EE: decrypts enveloped server content before comparing', async () => {
    // Server returns ciphertext; decryptRows yields the plaintext that matches local.
    fetchServerNodesRaw.mockResolvedValue([serverRow({ content: 'hlenc.v1.aaa.bbb' })]);
    decryptRows.mockImplementation((_store, rows) =>
      Promise.resolve(rows.map(r => ({ ...r, content: '<p>Secret text</p>' }))));
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ content: '<p>Secret text</p>' }),
    ]);
    expect(result).toBe(true);
    expect(decryptRows).toHaveBeenCalledWith('nodes', expect.any(Array));
  });

  it('requires ALL conflicting nodes to match (one mismatch blocks)', async () => {
    fetchServerNodesRaw.mockResolvedValue([
      serverRow({ node_id: 'n1', startLine: 1, content: '<p>same</p>' }),
      serverRow({ node_id: 'n2', startLine: 2, content: '<p>server changed this</p>' }),
    ]);
    const result = await isLostAckSelfConflict(BOOK, [
      localNode({ node_id: 'n1', startLine: 1, content: '<p>same</p>' }),
      localNode({ node_id: 'n2', startLine: 2, content: '<p>local wrote this</p>' }),
    ]);
    expect(result).toBe(false);
  });
});

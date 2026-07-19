/**
 * Sent sync-token ledger (syncQueue/sentSyncTokens.ts): the client-side half of
 * lost-ACK self-conflict detection. Tokens are recorded BEFORE the POST goes out
 * and persisted in localStorage (a lost write's 409 can arrive after a reload,
 * when historyLog replays the failed batch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSyncToken,
  recordSentSyncToken,
  hasSentSyncToken,
  __clearSentSyncTokensForTests,
} from '../../../resources/js/indexedDB/syncQueue/sentSyncTokens';

describe('sentSyncTokens', () => {
  beforeEach(() => {
    __clearSentSyncTokensForTests();
  });

  it('generates unique tokens', () => {
    const a = generateSyncToken();
    const b = generateSyncToken();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('recognizes a recorded token and rejects an unknown one', () => {
    const token = generateSyncToken();
    expect(hasSentSyncToken(token)).toBe(false);
    recordSentSyncToken(token);
    expect(hasSentSyncToken(token)).toBe(true);
    expect(hasSentSyncToken('never-sent')).toBe(false);
  });

  it('persists across module state (localStorage-backed, not memory)', () => {
    const token = generateSyncToken();
    recordSentSyncToken(token);
    // Simulate a reload: read straight from storage.
    const stored = JSON.parse(localStorage.getItem('hyperlit_sent_sync_tokens'));
    expect(stored).toContain(token);
  });

  it('caps the ledger at 50 tokens, evicting oldest first', () => {
    const first = generateSyncToken();
    recordSentSyncToken(first);
    for (let i = 0; i < 50; i++) recordSentSyncToken(`tok-${i}`);
    expect(hasSentSyncToken(first)).toBe(false); // evicted
    expect(hasSentSyncToken('tok-0')).toBe(true);
    expect(hasSentSyncToken('tok-49')).toBe(true);
    expect(JSON.parse(localStorage.getItem('hyperlit_sent_sync_tokens'))).toHaveLength(50);
  });

  it('survives corrupted storage without throwing', () => {
    localStorage.setItem('hyperlit_sent_sync_tokens', '{not json');
    expect(hasSentSyncToken('x')).toBe(false);
    const token = generateSyncToken();
    recordSentSyncToken(token); // overwrites the corrupt value
    expect(hasSentSyncToken(token)).toBe(true);
  });
});

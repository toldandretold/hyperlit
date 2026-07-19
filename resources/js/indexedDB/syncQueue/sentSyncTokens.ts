// Sent sync-token ledger for lost-ACK self-conflict detection. Zero-import leaf.
//
// Every unified-sync POST carries a client-generated `sync_token`; the server stores
// the token alongside the library timestamp it produces (library.last_sync_token) and
// echoes it back in a STALE_DATA 409 as `server_sync_token`. If the echoed token is in
// this ledger, the server's "newer" version is provably one THIS client wrote — the
// response was just lost in transit — so the caller can fast-forward + retry silently
// instead of hard-blocking with the discard overlay.
//
// Unlike the content-compare check (selfConflictContentCheck), a token match stays
// provable even when local edits kept piling on AFTER the committed-but-unACKed write
// (the paste flow saves the same node several times in quick succession), or when the
// server's write-path sanitizer round-trips the content differently. That drift is what
// let the "Book out of date" overlay fire on a mere network blip.
//
// localStorage (not memory) because a failed batch is replayed from historyLog across
// reloads — the 409 for a lost write can arrive in a later session than the write itself.

const STORAGE_KEY = 'hyperlit_sent_sync_tokens';
const MAX_TOKENS = 50;

function readTokens(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Create a fresh token for one unified-sync POST. */
export function generateSyncToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `st_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Record a token as sent BEFORE the POST goes out — the response may never arrive. */
export function recordSentSyncToken(token: string): void {
  try {
    const tokens = readTokens().filter(t => t !== token);
    tokens.push(token);
    while (tokens.length > MAX_TOKENS) tokens.shift();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    // Storage unavailable — the ack/content checks still cover recovery.
  }
}

/** Was this token one of ours? (true ⇒ the server's current version is our own write) */
export function hasSentSyncToken(token: string): boolean {
  return readTokens().includes(token);
}

/** Test-only: wipe the ledger so unit tests don't leak state into one another. */
export function __clearSentSyncTokensForTests(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

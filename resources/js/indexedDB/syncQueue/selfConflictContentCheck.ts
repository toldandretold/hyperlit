// Lost-ACK self-conflict detection, extracted so it can be unit-tested in isolation.
// Tests: tests/javascript/indexedDB/selfConflictContentCheck.test.js
//
// A network blip mid-save can COMMIT the write on the server (advancing its
// library.timestamp) while the RESPONSE is lost — so the client never advances its
// base_timestamp and the next sync 409s STALE_DATA. The existing _ackedServerTs guard
// (master.ts) only recognizes a conflict the client was already ACKed for; a lost-ACK,
// by definition, was never ACKed, so that guard can't fire and the user gets the scary
// "Book out of date, your edits must be discarded" overlay for an edit that already
// committed.
//
// This check closes that gap: on a 409, fetch the server's CURRENT content for the
// conflicting nodes and compare its plain text to what we tried to write. If every
// conflicting node matches, it's provably our own already-committed write → the caller
// silently fast-forwards + retries (no overlay). Anything we can't prove is a match
// (a real other-device edit, a deletion, a fetch failure) returns false → the caller
// keeps the existing hard-block. We only ever LIFT the block on affirmative proof.

import { nodePlainText } from '../../utilities/nodeText';
import { log } from '../../utilities/logger';
import type { BookId } from '../types';
import type { ServerNodeRow } from '../serverSync/types';

/** The subset of a wire node this check needs. Update nodes carry `content`;
 *  deletion entries carry `_action: 'delete'` and no meaningful content. */
export interface ConflictNodeInput {
  book: BookId;
  startLine: number;
  node_id: string | null;
  content?: string;
  _action?: string;
}

/**
 * Decide whether a STALE_DATA 409 for `bookId` is our OWN lost-ACK write rather than a
 * genuine cross-device edit. Returns true only when the server's current content for
 * EVERY conflicting node is present and its plain text equals ours.
 */
export async function isLostAckSelfConflict(
  bookId: BookId,
  localNodes: ConflictNodeInput[],
): Promise<boolean> {
  // A deletion anywhere in the batch is unverifiable by content-compare → don't claim a
  // self-conflict (block, the safe default). Deletions in a plain-text edit are rare, so
  // this rarely costs us a legitimate recovery.
  if (localNodes.some(n => n._action === 'delete')) return false;
  // The update-with-content nodes for THIS book are what the server's per-book stale
  // check rejected and what we can verify.
  const toVerify = localNodes.filter(
    n => n.book === bookId && typeof n.content === 'string' && n.content.length > 0,
  );
  if (toVerify.length === 0) return false;

  let serverRows: ServerNodeRow[];
  try {
    // Dynamic imports keep this rare-path module off the static import graph — a static
    // edge into serverSync/pull closes a syncQueue↔serverSync ring (the de-cycle invariant).
    const { fetchServerNodesRaw } = await import('../serverSync/pull');
    const raw = await fetchServerNodesRaw(String(bookId));
    // E2EE books return enveloped `content`; decrypt to plaintext for comparison.
    // No-op for plaintext books. Throws if the vault is locked → caught below → block.
    const { decryptRows } = await import('../../e2ee/transform');
    serverRows = await decryptRows('nodes', raw);
  } catch (e) {
    // Couldn't reach/decrypt the server's version — can't prove a self-conflict, so
    // let the caller fall through to the existing overlay. Safe by default.
    log.error('Self-conflict content check could not fetch server nodes', '/indexedDB/syncQueue/selfConflictContentCheck.ts', e);
    return false;
  }

  // Look up by the stable node_id first (survives renumbering), fall back to startLine.
  const byNodeId = new Map<string, ServerNodeRow>();
  const byStartLine = new Map<number, ServerNodeRow>();
  for (const row of serverRows) {
    if (row.node_id != null) byNodeId.set(String(row.node_id), row);
    byStartLine.set(Number(row.startLine), row);
  }

  for (const local of toVerify) {
    const server =
      (local.node_id != null ? byNodeId.get(String(local.node_id)) : undefined)
      ?? byStartLine.get(Number(local.startLine));
    if (!server) return false; // no server counterpart → can't be our committed write
    if (nodePlainText(server.content) !== nodePlainText(local.content as string)) return false;
  }

  return true;
}

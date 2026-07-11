/**
 * localManifest — the on-disk manifest for LOCALLY generated (BYO-key) book
 * audio in the native shell. Read/written via the bridge's file.readManifest /
 * file.writeManifest; MP3s live beside it in the app's per-book audio dir.
 *
 * This is a CLOSED WORLD: hashes here are sha256 of the locally-derived
 * speakable text, compared only against themselves (never the server's
 * source_hash). The manifest doubles as the generation CHECKPOINT — it is
 * written after every node, so a cancelled/crashed run resumes by hash-skip.
 */

import { nativeCall } from '../../utilities/nativeBridge';
import type { AudioManifest } from '../../components/audioPlayer/manifest';

export interface LocalAudioNode {
  filename: string;
  /** sha256 (hex) of the speakable text this MP3 narrates. */
  hash: string;
  durationMs: number | null;
}

export interface LocalAudioManifest {
  version: 1;
  voice: string;
  nodes: Record<string, LocalAudioNode>;
}

export async function readLocalManifest(book: string): Promise<LocalAudioManifest | null> {
  try {
    const res = await nativeCall<{ json: LocalAudioManifest | null }>('file.readManifest', { book });
    const m = res?.json;
    if (!m || m.version !== 1 || typeof m.nodes !== 'object') return null;
    return m;
  } catch {
    return null; // not in shell / no manifest yet
  }
}

export async function writeLocalManifest(book: string, manifest: LocalAudioManifest): Promise<void> {
  await nativeCall('file.writeManifest', { book, json: manifest });
}

export function emptyLocalManifest(voice: string): LocalAudioManifest {
  return { version: 1, voice, nodes: {} };
}

/**
 * Adapt a local manifest to the player's AudioManifest shape. Staleness is
 * computed against `currentHashes` (node_id → sha256 of the node's CURRENT
 * speakable text) when provided; nodes absent from it are marked fresh.
 */
export function toAudioManifest(
  local: LocalAudioManifest,
  currentHashes?: Record<string, string>
): AudioManifest {
  const nodes: AudioManifest['nodes'] = {};
  for (const [nodeId, entry] of Object.entries(local.nodes)) {
    nodes[nodeId] = {
      filename: entry.filename,
      duration_ms: entry.durationMs,
      stale: currentHashes ? currentHashes[nodeId] !== undefined && currentHashes[nodeId] !== entry.hash : false,
    };
  }
  return { voice: local.voice, nodes };
}

/** sha256 hex via WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * localSource — the audio player's seam to LOCALLY generated (BYO-key) book
 * audio in the native macOS shell. Mirrors encryptedAudio's role: it provides
 * an alternative `resolveSrc` so PlaybackController streams from the shell's
 * hyperlit-local:// scheme handler (disk, with Range support) instead of the
 * server route.
 */

import { isNativeShell, nativeCall } from '../../utilities/nativeBridge';
import {
  readLocalManifest,
  toAudioManifest,
  sha256Hex,
  type LocalAudioManifest,
} from '../../aiProviders/tts/localManifest';
import { speakableTextFromContent } from '../../aiProviders/tts/speakableText';
import { getNodesFromIndexedDB } from '../../indexedDB/nodes/read';
import { asBookId } from '../../utilities/idHelpers';
import type { AudioManifest } from './manifest';

/** The local manifest, or null (browser / no local audio yet). */
export async function loadLocalAudio(book: string): Promise<LocalAudioManifest | null> {
  if (!isNativeShell()) return null;
  const manifest = await readLocalManifest(book);
  if (!manifest || Object.keys(manifest.nodes).length === 0) return null;
  return manifest;
}

/**
 * Player-shaped manifest with LOCAL staleness: hash each node's CURRENT
 * speakable text and compare against the manifest (a few hundred sha256s —
 * cheap, and only on the play press).
 */
export async function toPlayerManifest(book: string, local: LocalAudioManifest): Promise<AudioManifest> {
  const currentHashes: Record<string, string> = {};
  try {
    const nodes = await getNodesFromIndexedDB(asBookId(book));
    for (const node of nodes) {
      const nodeId = (node as { node_id?: string }).node_id;
      if (!nodeId || !local.nodes[nodeId]) continue;
      const text = speakableTextFromContent((node as { content?: string }).content);
      if (text !== '') currentHashes[nodeId] = await sha256Hex(text);
    }
  } catch {
    // IndexedDB unavailable — serve without staleness rather than not at all.
  }
  return toAudioManifest(local, currentHashes);
}

/** resolveSrc for PlaybackController: filename → hyperlit-local:// URL. */
export function localResolveSrc(book: string): (filename: string) => Promise<string> {
  return async (filename: string) => {
    const res = await nativeCall<{ url: string }>('file.audioUrl', { book, filename });
    return res.url;
  };
}

/**
 * localGeneration — the client-side port of GenerateBookAudioJob for BYO-key
 * TTS in the native shell: iterate the book's nodes in reading order, derive
 * speakable text, synthesize with the user's own voice provider (via the
 * bridge), write MP3s to disk, and checkpoint the local manifest after EVERY
 * node (hash-skip = idempotent resume; a cancelled run loses nothing).
 *
 * No server calls, no billing — the audio exists only on this Mac.
 */

import { getNodesFromIndexedDB } from '../../indexedDB/nodes/read';
import { asBookId } from '../../utilities/idHelpers';
import { executeTts } from '../execute';
import { getActiveProfile } from '../profiles';
import { nativeCall } from '../../utilities/nativeBridge';
import { speakableTextFromContent, splitSentences } from './speakableText';
import {
  emptyLocalManifest,
  readLocalManifest,
  sha256Hex,
  writeLocalManifest,
  type LocalAudioManifest,
} from './localManifest';
import { log, verbose } from '../../utilities/logger';

const FILE = '/aiProviders/tts/localGeneration.ts';

/** Mirrors services.tts.max_chars_per_request (DeepInfra Kokoro's comfort zone). */
const MAX_CHARS_PER_REQUEST = 1500;
/** CBR estimate matching GenerateBookAudioJob::estimateDurationMs (64 kbps). */
const BITRATE_KBPS = 64;

export interface LocalGenerationProgress {
  doneNodes: number;
  totalNodes: number;
  failedNodes: string[];
}

export interface LocalGenerationHandle {
  cancel: () => void;
  /** Resolves when the run finishes, is cancelled, or fails hard. */
  done: Promise<LocalGenerationProgress>;
}

/** Filesystem-safe filename from a node id (Swift enforces the same charset). */
function filenameFor(nodeId: string): string {
  return `${nodeId.replace(/[^A-Za-z0-9_-]/g, '_')}.mp3`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Generate (or update) the local audiobook for a book. Nodes whose speakable
 * hash already matches the manifest are skipped — so re-running after edits
 * narrates only what changed, and resuming after a cancel continues where it
 * stopped.
 */
export function startLocalGeneration(
  book: string,
  onProgress?: (p: LocalGenerationProgress) => void
): LocalGenerationHandle {
  let cancelled = false;

  const run = async (): Promise<LocalGenerationProgress> => {
    const profile = await getActiveProfile('tts');
    if (!profile) throw new Error('No active TTS provider');
    const voice = profile.voice || 'af_bella';

    // Reading order comes from the client's own IndexedDB (same source the
    // player uses for its playlist).
    const nodes = await getNodesFromIndexedDB(asBookId(book));

    // Existing manifest = the checkpoint. A voice change invalidates it all
    // (same rule as the server's book_audio_meta voice).
    let manifest: LocalAudioManifest | null = await readLocalManifest(book);
    if (!manifest || manifest.voice !== voice) {
      manifest = emptyLocalManifest(voice);
    }

    // Work list: speakable nodes only, with their current hashes.
    const work: Array<{ nodeId: string; text: string; hash: string }> = [];
    for (const node of nodes) {
      const nodeId = (node as { node_id?: string }).node_id;
      if (!nodeId) continue;
      const text = speakableTextFromContent((node as { content?: string }).content);
      if (text === '') continue;
      work.push({ nodeId, text, hash: await sha256Hex(text) });
    }

    const progress: LocalGenerationProgress = {
      doneNodes: 0,
      totalNodes: work.length,
      failedNodes: [],
    };

    for (const item of work) {
      if (cancelled) break;

      // Hash-skip idempotency (the resume/update mechanism).
      const existing = manifest.nodes[item.nodeId];
      if (existing && existing.hash === item.hash) {
        progress.doneNodes++;
        onProgress?.(progress);
        continue;
      }

      try {
        // Long nodes are synthesized in sentence segments and concatenated —
        // MP3 frames concatenate playably (same as the server job).
        const segments = item.text.length > MAX_CHARS_PER_REQUEST
          ? splitSentences(item.text, MAX_CHARS_PER_REQUEST)
          : [item.text];

        const parts: Uint8Array[] = [];
        for (const segment of segments) {
          if (cancelled) break;
          const res = await executeTts(profile.id, { text: segment, voice });
          if (res.base64 === null) throw new Error('provider returned no audio');
          parts.push(base64ToBytes(res.base64));
        }
        if (cancelled) break;

        const total = parts.reduce((n, p) => n + p.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) {
          bytes.set(p, offset);
          offset += p.length;
        }

        const filename = filenameFor(item.nodeId);
        await nativeCall('file.writeAudio', { book, filename, base64: bytesToBase64(bytes) }, { timeoutMs: 60_000 });

        manifest.nodes[item.nodeId] = {
          filename,
          hash: item.hash,
          durationMs: Math.round((total * 8) / (BITRATE_KBPS * 1000) * 1000),
        };
        // Checkpoint after EVERY node — a crash/cancel loses at most one node.
        await writeLocalManifest(book, manifest);

        progress.doneNodes++;
      } catch (e) {
        progress.failedNodes.push(item.nodeId);
        log.error(`Local TTS failed for node ${item.nodeId}`, FILE, e);
      }
      onProgress?.(progress);
    }

    verbose.content(
      `Local TTS run finished: ${progress.doneNodes}/${progress.totalNodes} nodes, ${progress.failedNodes.length} failed${cancelled ? ' (cancelled)' : ''}`,
      FILE
    );
    return progress;
  };

  return {
    cancel: () => {
      cancelled = true;
    },
    done: run(),
  };
}

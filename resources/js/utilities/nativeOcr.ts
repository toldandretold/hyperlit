/**
 * nativeOcr — client for the macOS shell's on-device PDF OCR (the ocr.* bridge
 * methods; see docs/native-bridge-protocol.md). A LEAF module like nativeBridge
 * itself: imports only the bridge and the logger, no DOM.
 *
 * The 4MB bridge-envelope cap means everything crosses in chunks:
 *
 *   ocr.begin            → { sessionId, chunkSize }        (chunkSize = raw bytes)
 *   ocr.chunk × N        ← file.slice() base64 pieces
 *   ocr.run              → engine starts on a native background task
 *     ocr_progress event → { page, totalPages, stage }     (throttled ~250ms)
 *     ocr_complete event → { ok, chunkCount, … }
 *   ocr.result × M       → base64 pieces of the result JSON
 *   ocr.end              → session + temp file destroyed
 *
 * The result Blob is a Mistral-shaped ocr_response.json; the import flow
 * attaches it to the /import-file upload, where the server seeds it as the
 * conversion pipeline's OCR cache (no Mistral call, no charge).
 */

import { nativeCall, onNativeEvent, isNativeShell, NativeBridgeError } from './nativeBridge';
import { log, verbose } from './logger';

const FILE = '/utilities/nativeOcr.ts';

/** No event (progress or complete) for this long ⇒ assume the engine died. */
const STALL_TIMEOUT_MS = 5 * 60_000;

export interface NativeOcrProgress {
  page: number;
  totalPages: number;   // 0 while a BYO remote provider (Mistral) is in flight
  stage: 'text' | 'vision' | 'images' | 'compose' | 'mistral';
}

export interface NativeOcrResult {
  blob: Blob;
  /** 'native' (on-device engine) or 'mistral' (user's own key) — sent to the
   *  server as ocr_source for provenance stamping. */
  source: string;
}

interface BeginResult {
  sessionId: string;
  chunkSize: number;
}

interface CompleteEvent {
  sessionId: string;
  ok: boolean;
  pages?: number;
  resultBytes?: number;
  chunkCount?: number;
  source?: string;
  error?: string;
}

interface ResultChunk {
  dataBase64: string;
  last: boolean;
}

/** Whether the current environment can OCR PDFs on-device. */
export function nativeOcrAvailable(): boolean {
  return isNativeShell();
}

/**
 * OCR a PDF via the native shell — on-device (free) or through the user's own
 * BYO OCR provider when one is active in Settings — and return the
 * Mistral-shaped ocr_response.json as a Blob ready to append to the import
 * FormData, plus its source. Throws NativeBridgeError (or a plain Error
 * carrying the engine's message) on failure — callers decide whether to fall
 * back to server-side (billed) OCR.
 */
export async function nativePdfOcr(
  file: File,
  onProgress?: (p: NativeOcrProgress) => void
): Promise<NativeOcrResult> {
  const begin = await nativeCall<BeginResult>('ocr.begin', { bytesTotal: file.size, name: file.name });
  const { sessionId, chunkSize } = begin;
  verbose.content(`Native OCR session ${sessionId} started (${file.size} bytes)`, FILE);

  try {
    // 1. Stream the PDF across the bridge in raw-byte slices (base64-encoded).
    let seq = 0;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
      const dataBase64 = await blobToBase64(slice);
      await nativeCall('ocr.chunk', { sessionId, seq, dataBase64 }, { timeoutMs: 60_000 });
      seq += 1;
    }

    // 2. Subscribe to completion BEFORE starting the run (no missed events),
    //    with a stall watchdog that any progress event resets.
    const completion = waitForCompletion(sessionId, onProgress);
    await nativeCall('ocr.run', { sessionId });
    const complete = await completion;

    if (!complete.ok) {
      throw new NativeBridgeError('ocr_failed', complete.error || 'On-device OCR failed');
    }

    // 3. Pull the result JSON back, chunk by chunk.
    const parts: Uint8Array[] = [];
    for (let i = 0; ; i++) {
      const chunk = await nativeCall<ResultChunk>('ocr.result', { sessionId, seq: i }, { timeoutMs: 60_000 });
      parts.push(base64ToBytes(chunk.dataBase64));
      if (chunk.last) break;
    }

    log.content(`Native OCR complete (${complete.source || 'native'}): ${complete.pages} pages, ${complete.resultBytes} bytes`, FILE);
    return {
      blob: new Blob(parts as BlobPart[], { type: 'application/json' }),
      source: complete.source || 'native',
    };
  } finally {
    // Always tear the session down (frees the temp PDF; cancels a live run).
    nativeCall('ocr.end', { sessionId }).catch(() => {});
  }
}

/** Resolve on this session's ocr_complete; reject if events stall for 5 min. */
function waitForCompletion(
  sessionId: string,
  onProgress?: (p: NativeOcrProgress) => void
): Promise<CompleteEvent> {
  return new Promise<CompleteEvent>((resolve, reject) => {
    let offProgress = () => {};
    let offComplete = () => {};
    let watchdog: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      offProgress();
      offComplete();
      clearTimeout(watchdog);
    };
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        cleanup();
        reject(new NativeBridgeError('timeout', `Native OCR stalled (no events for ${STALL_TIMEOUT_MS / 1000}s)`));
      }, STALL_TIMEOUT_MS);
    };

    offProgress = onNativeEvent('ocr_progress', (data) => {
      const p = data as NativeOcrProgress & { sessionId?: string };
      if (p?.sessionId !== sessionId) return;
      arm();
      onProgress?.({ page: p.page, totalPages: p.totalPages, stage: p.stage });
    });

    offComplete = onNativeEvent('ocr_complete', (data) => {
      const c = data as CompleteEvent;
      if (c?.sessionId !== sessionId) return;
      cleanup();
      resolve(c);
    });

    arm();
  });
}

/** Base64-encode a Blob via FileReader (readAsDataURL, prefix stripped). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file slice'));
    reader.onload = () => {
      const url = reader.result as string;
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.readAsDataURL(blob);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Audio manifest + status API layer for the per-node TTS player.
//
// The manifest maps node_id -> {filename, duration_ms, stale}; playback ORDER
// comes from the client's own IndexedDB nodes (single source of truth), not
// from the server. Staleness is computed server-side per request
// (sha256(plainText) vs the audio row's source_hash), so a re-fetch after an
// edit is immediately honest.

import { verbose } from '../../utilities/logger';

export interface AudioNodeEntry {
  filename: string;
  duration_ms: number | null;
  stale: boolean;
}

export interface AudioManifest {
  voice: string | null;
  nodes: Record<string, AudioNodeEntry>;
}

export interface AudioStatus {
  has_audio: boolean;
  voice: string | null;
  total_nodes: number;
  audio_nodes: number;
  stale_nodes: number;
  missing_chars: number;
  stale_chars: number;
  estimated_cost_user: number;
  generating: boolean;
}

export interface AudioProgress {
  status: 'none' | 'generating' | 'done' | 'partial' | 'cancelled' | 'failed';
  done_nodes?: number;
  total_nodes?: number;
  done_chars?: number;
  total_chars?: number;
  failed_nodes?: string[];
  error?: string;
}

export async function fetchAudioManifest(bookId: string): Promise<AudioManifest | null> {
  try {
    const resp = await fetch(`/api/book-audio/${bookId}/manifest`, { credentials: 'include' });
    if (!resp.ok) return null;

    return (await resp.json()) as AudioManifest;
  } catch (e) {
    verbose.content(`audioPlayer: manifest fetch failed: ${e}`, '/components/audioPlayer/manifest');

    return null;
  }
}

export async function fetchAudioStatus(bookId: string): Promise<AudioStatus | null> {
  try {
    const resp = await fetch(`/api/book-audio/${bookId}/status`, { credentials: 'include' });
    if (!resp.ok) return null;

    return (await resp.json()) as AudioStatus;
  } catch (e) {
    verbose.content(`audioPlayer: status fetch failed: ${e}`, '/components/audioPlayer/manifest');

    return null;
  }
}

export async function fetchAudioProgress(bookId: string): Promise<AudioProgress | null> {
  try {
    const resp = await fetch(`/api/book-audio/${bookId}/progress`, { credentials: 'include', cache: 'no-store' });
    if (!resp.ok) return null;

    return (await resp.json()) as AudioProgress;
  } catch {
    return null;
  }
}

export function audioUrl(bookId: string, filename: string): string {
  return `/${bookId}/audio/${filename}`;
}

export function staleCount(manifest: AudioManifest): number {
  return Object.values(manifest.nodes).filter((n) => n.stale).length;
}

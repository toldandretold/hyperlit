// Generation flow: cost-confirm dialog → POST generate → poll progress.
//
// Generation is requester-pays and idempotent server-side (the job skips
// nodes whose (node_id, source_hash) audio already exists), so "generate"
// and "regenerate stale/missing nodes" are the SAME call — only the price
// shown in the confirm dialog differs.

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { confirmDialog, alertDialog } from '../dialog/dialog';
import { fetchAudioProgress, fetchAudioStatus, type AudioProgress, type AudioStatus } from './manifest';

const POLL_MS = 2000;

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function stopProgressPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Confirm cost with the user and kick off generation. Returns true if the
 * job was accepted (caller should start polling), false otherwise.
 */
export async function confirmAndGenerate(bookId: string, status: AudioStatus): Promise<boolean> {
  const billableChars = status.missing_chars + status.stale_chars;
  const isTopUp = status.has_audio;
  const price = status.estimated_cost_user < 0.01 ? '<$0.01' : `~$${status.estimated_cost_user.toFixed(2)}`;

  const confirmed = await confirmDialog({
    title: isTopUp ? 'Update audiobook?' : 'Generate audiobook?',
    message: isTopUp
      ? `${status.stale_nodes} edited section(s) and any new text will be re-narrated (${billableChars.toLocaleString()} characters, ${price}). Everyone who reads this book gets the update.`
      : `This narrates the whole book (${billableChars.toLocaleString()} characters, ${price}). Once generated, everyone who reads this book can listen for free.`,
    confirmLabel: isTopUp ? 'Update audio' : 'Generate',
  });
  if (!confirmed) return false;

  // ensureCsrfToken returns the XSRF cookie token → goes in X-XSRF-TOKEN
  // (X-CSRF-TOKEN is the session-token header and 419s with this value).
  const csrf = await ensureCsrfToken();
  let resp: Response | null = null;
  try {
    resp = await fetch(`/api/book-audio/${bookId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf ?? '' },
      credentials: 'include',
    });
  } catch {
    resp = null;
  }

  if (resp && resp.status === 202) {
    log.user(`Audiobook generation started for ${bookId}`, '/components/audioPlayer/generation');

    return true;
  }
  if (resp && resp.status === 409) {
    // Someone else's run is in flight — polling shows its progress.
    return true;
  }
  if (resp && resp.status === 401) {
    await alertDialog({ title: 'Sign in required', message: 'Sign in to generate audio for this book.' });

    return false;
  }
  if (resp && resp.status === 402) {
    await alertDialog({ title: 'Insufficient balance', message: 'Audiobook generation needs credits. Top up on your account page and try again.' });

    return false;
  }

  await alertDialog({ title: 'Could not start', message: 'Audiobook generation could not be started. Please try again later.' });

  return false;
}

/**
 * Poll audio_progress.json every 2s until the run reaches a terminal state.
 * onBeat fires on every poll (including the terminal one).
 */
export function pollGenerationProgress(
  bookId: string,
  onBeat: (progress: AudioProgress) => void,
  onDone: (progress: AudioProgress) => void,
): void {
  stopProgressPolling();
  pollTimer = setInterval(async () => {
    const progress = await fetchAudioProgress(bookId);
    if (!progress) return;
    onBeat(progress);
    if (progress.status === 'done' || progress.status === 'partial'
      || progress.status === 'cancelled' || progress.status === 'failed') {
      stopProgressPolling();
      onDone(progress);
    }
  }, POLL_MS);
}

/** Re-fetch status (used before generating and for the stale chip). */
export async function refreshStatus(bookId: string): Promise<AudioStatus | null> {
  const status = await fetchAudioStatus(bookId);
  if (status) {
    verbose.content(
      `audioPlayer: status audio=${status.audio_nodes}/${status.total_nodes} stale=${status.stale_nodes}`,
      '/components/audioPlayer/generation',
    );
  }

  return status;
}

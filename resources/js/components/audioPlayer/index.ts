// "Listen to this book" — per-node TTS player. ButtonRegistry component
// (pages: ['reader']): initAudioPlayer runs on every reader entry (full load
// AND in-SPA book open), destroyAudioPlayer on exit, so it survives SPA nav.
//
// Entry point is the Listen button INSIDE the settings menu (settings-panel
// blade → settingsContainer delegation → openAudioPlayer()). Nothing is on
// screen until then: audio exists → the mini player pill appears at the
// bottom and playback starts from the reader's position; no audio → cost-
// confirm dialog → requester-pays generation with progress (and cancel) in
// the same pill. Encrypted books and sub-books hide the Listen button.

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { currentLazyLoader } from '../../pageLoad/currentLazyLoaderState';
import { isBookEncrypted } from '../../e2ee/registry';
import { fetchAudioManifest, staleCount, type AudioManifest } from './manifest';
import { confirmAndGenerate, pollGenerationProgress, refreshStatus, stopProgressPolling } from './generation';
import { PlaybackController, type PlaylistEntry } from './playbackController';
import { PlayerBar } from './playerBar';

let controller: PlaybackController | null = null;
let bar: PlayerBar | null = null;
let manifest: AudioManifest | null = null;
let busy = false;
let generating = false;
let active = false; // component initialized on a reader page

function bookId(): string | null {
  return currentLazyLoader?.bookId ?? null;
}

function audioAvailableForBook(id: string): boolean {
  return !id.includes('/') && !isBookEncrypted(id);
}

/** Settings-menu entry point (delegated in settingsContainer/index.ts). */
export function openAudioPlayer(): void {
  void handlePlayPress();
}

async function handlePlayPress(): Promise<void> {
  const id = bookId();
  if (!id || busy || !audioAvailableForBook(id)) return;

  // Toggle when already active.
  if (controller && controller.getState() === 'playing') {
    controller.pause();

    return;
  }
  if (controller && controller.getState() === 'paused') {
    void controller.resume();

    return;
  }

  busy = true;
  try {
    manifest = await fetchAudioManifest(id);
    const hasAudio = manifest && Object.keys(manifest.nodes).length > 0;

    if (!hasAudio) {
      const status = await refreshStatus(id);
      if (!status) return;
      // Someone else's run may already be in flight — just watch it.
      if (!status.generating) {
        const accepted = await confirmAndGenerate(id, status);
        if (!accepted) return;
      }
      generating = true;
      bar?.show();
      bar?.setGenerating(true);
      bar?.setStatus('Generating audio…');
      watchGeneration(id, /*playWhenDone*/ true);

      return;
    }

    await startPlayback(id);
  } finally {
    busy = false;
  }
}

async function startPlayback(id: string): Promise<void> {
  if (!manifest) return;
  if (!controller) controller = buildController(id);
  bar?.show();
  bar?.setGenerating(false);
  bar?.setSpeed(controller.getSettings().speed);
  bar?.setHighlightActive(controller.getSettings().highlight);
  void updateStaleChip(id);
  const started = await controller.start(manifest);
  if (!started) {
    bar?.setStatus('No audio available yet.');
  }
}

function buildController(id: string): PlaybackController {
  return new PlaybackController(id, {
    onStateChange: (state) => bar?.setPlaying(state === 'playing'),
    onEntryChange: (entry: PlaylistEntry, index: number, total: number) => {
      bar?.setStatus(`${index + 1} / ${total}${entry.stale ? ' · out-of-date section' : ''}`);
    },
    onFollowModeChange: (following) => bar?.setFollowVisible(!following),
    onFinished: () => {
      bar?.setStatus('');
      bar?.hide();
    },
  });
}

function watchGeneration(id: string, playWhenDone: boolean): void {
  let beat = 0;
  let startedLive = false;
  let startingLive = false;
  let noneBeats = 0;

  pollGenerationProgress(
    id,
    (progress) => {
      // 'none' means no progress file exists. A few beats of it right after
      // dispatch is normal (worker pickup); a stretch of it means the run
      // never started (e.g. a crashed request left a stale lock) — stop
      // pretending, don't spin forever.
      if (progress.status === 'none') {
        noneBeats++;
        if (noneBeats >= 10) { // ~20s with no sign of life
          stopProgressPolling();
          generating = false;
          bar?.setGenerating(false);
          bar?.setStatus('Generation didn’t start — try again shortly.');
        }

        return;
      }
      noneBeats = 0;
      if (progress.status === 'generating' && !startedLive) {
        bar?.setStatus(`Generating audio… ${progress.done_nodes ?? 0}/${progress.total_nodes ?? '?'} sections`);
      }
      if (!playWhenDone) return;

      // Play-while-generating: every other beat (~4s), refresh the manifest;
      // begin playback the moment the reader's position has audio (generation
      // runs in reading order), then keep extending the playlist while the
      // synthesizer works ahead of the listener.
      beat++;
      if (beat % 2 !== 0 || startingLive) return;
      startingLive = true;
      void (async () => {
        try {
          const fresh = await fetchAudioManifest(id);
          if (!fresh || Object.keys(fresh.nodes).length === 0) return;
          manifest = fresh;
          if (startedLive) {
            controller?.updatePlaylist(fresh);

            return;
          }
          if (!controller) controller = buildController(id);
          const started = await controller.start(fresh, /*onlyIfPositionCovered*/ true);
          if (started) {
            startedLive = true;
            // Stop button means "stop playback" again; generation keeps
            // running server-side and the poll keeps feeding the playlist.
            generating = false;
            bar?.setGenerating(false);
            bar?.setSpeed(controller.getSettings().speed);
            bar?.setHighlightActive(controller.getSettings().highlight);
          }
        } finally {
          startingLive = false;
        }
      })();
    },
    (progress) => {
      void (async () => {
        generating = false;
        bar?.setGenerating(false);
        manifest = await fetchAudioManifest(id);

        if (startedLive) {
          // Already listening — just hand the finished playlist over.
          if (manifest) controller?.updatePlaylist(manifest);
          void updateStaleChip(id);

          return;
        }
        if (progress.status === 'failed') {
          bar?.setStatus('Audio generation failed.');

          return;
        }
        if (progress.status === 'cancelled') {
          bar?.setStatus('Audio generation cancelled.');

          return;
        }
        if (playWhenDone && manifest && Object.keys(manifest.nodes).length > 0) {
          await startPlayback(id);
        } else {
          bar?.setStatus(progress.status === 'partial' ? 'Audio ready (some sections failed).' : 'Audio ready.');
        }
      })();
    },
  );
}

async function cancelGeneration(id: string): Promise<void> {
  const csrf = await ensureCsrfToken();
  try {
    await fetch(`/api/book-audio/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf ?? '' },
      credentials: 'include',
    });
  } catch { /* the poll's terminal beat still closes the bar */ }
  bar?.setStatus('Cancelling…');
}

async function updateStaleChip(id: string): Promise<void> {
  if (!manifest) return;
  const stale = staleCount(manifest);
  if (stale === 0) {
    bar?.setStale(0, null);

    return;
  }
  const status = await refreshStatus(id);
  const price = status
    ? (status.estimated_cost_user < 0.01 ? '<$0.01' : `~$${status.estimated_cost_user.toFixed(2)}`)
    : null;
  bar?.setStale(stale, price);
}

async function handleRegenerate(): Promise<void> {
  const id = bookId();
  if (!id) return;
  const status = await refreshStatus(id);
  if (!status) return;
  const accepted = await confirmAndGenerate(id, status);
  if (!accepted) return;
  generating = true;
  bar?.setGenerating(true);
  bar?.setStatus('Updating audio…');
  watchGeneration(id, /*playWhenDone*/ false);
}

/**
 * Show the settings-menu Listen button iff the player is live on this page
 * and the open book is narratable. Also called by settingsContainer after
 * its innerHTML resets restore the button's default `hidden`.
 */
export function syncListenButton(): void {
  const id = bookId();
  const button = document.getElementById('audioListenButton');
  if (button) button.hidden = !active || !id || !audioAvailableForBook(id);
}

export function initAudioPlayer(): void {
  active = true;
  syncListenButton();

  bar = new PlayerBar({
    onPlayPause: () => void handlePlayPress(),
    onStop: () => {
      const id = bookId();
      if (generating && id) {
        void cancelGeneration(id);

        return; // the poll's terminal 'cancelled' beat updates the bar
      }
      controller?.stop();
      bar?.hide();
    },
    onSpeed: () => {
      if (controller) bar?.setSpeed(controller.cycleSpeed());
    },
    onHighlightToggle: () => {
      if (!controller) return;
      const enabled = !controller.getSettings().highlight;
      controller.setHighlightEnabled(enabled);
      bar?.setHighlightActive(enabled);
    },
    onResumeFollow: () => controller?.resumeFollowing(),
    onRegenerate: () => void handleRegenerate(),
  });

  log.init('audioPlayer initialized', '/components/audioPlayer');
  verbose.init('audioPlayer: listen button synced', '/components/audioPlayer');
}

export function destroyAudioPlayer(): void {
  active = false;
  syncListenButton(); // home/user share the settings panel — hide there
  stopProgressPolling();
  controller?.destroy();
  controller = null;
  manifest = null;
  generating = false;
  bar?.destroy(); // removes its DOM listeners — the pill markup persists across SPA navs
  bar = null;
  busy = false;
}

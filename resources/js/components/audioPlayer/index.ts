// "Listen to this book" — per-node TTS player. ButtonRegistry component
// (pages: ['reader']): initAudioPlayer runs on every reader entry (full load
// AND in-SPA book open), destroyAudioPlayer on exit, so it survives SPA nav.
//
// Entry point is the Listen button INSIDE the settings menu (settings-panel
// blade → settingsContainer delegation → openAudioPlayer()). Nothing is on
// screen until then: audio exists → the mini player pill appears at the
// bottom and playback starts from the reader's position; no audio → cost-
// confirm dialog → requester-pays generation with progress (and cancel) in
// the same pill. Sub-books hide the Listen button. Encrypted books show it:
// audio from before the lock plays via client-side decryption
// (encryptedAudio.ts); creating NEW audio is impossible (explained on press).

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { currentLazyLoader } from '../../pageLoad/currentLazyLoaderState';
import { isBookEncrypted } from '../../e2ee/registry';
import { isNativeShell } from '../../utilities/nativeBridge';
import { isByoTtsActive } from '../../aiProviders/profiles';
import { startLocalGeneration, type LocalGenerationHandle } from '../../aiProviders/tts/localGeneration';
import { loadLocalAudio, toPlayerManifest, localResolveSrc } from './localSource';
import { alertDialog, confirmDialog } from '../dialog/dialog';
import { fetchAudioManifest, staleCount, type AudioManifest } from './manifest';
import { confirmAndGenerate, formatPrice, pollGenerationProgress, refreshStatus, requestGeneration, stopProgressPolling } from './generation';
import { PlaybackController, type PlaylistEntry } from './playbackController';
import { PlayerBar } from './playerBar';

let controller: PlaybackController | null = null;
let bar: PlayerBar | null = null;
let manifest: AudioManifest | null = null;
let busy = false;
let generating = false;
let active = false; // component initialized on a reader page
let usingLocalAudio = false; // playing MP3s from the native shell's disk store
let localGen: LocalGenerationHandle | null = null; // in-flight local BYO narration

function bookId(): string | null {
  return currentLazyLoader?.bookId ?? null;
}

/** Settings-menu entry point (delegated in settingsContainer/index.ts). */
export function openAudioPlayer(): void {
  void handlePlayPress();
}

/** Encrypted book with NO audio yet: the server never sees plaintext, so it
 *  can't CREATE a narration — EXPLAIN that instead of silently doing nothing
 *  (the silent guard used to eat the press when the E2EE flag loaded after
 *  button sync). Books that had audio before locking keep it (encrypted in
 *  place) and play fine — this dialog is only for the creation gap. */
async function showEncryptedNotice(): Promise<void> {
  await alertDialog({
    title: 'Audio creation unavailable for encrypted books',
    // NOTE: alertDialog escapes its message (XSS posture) — HTML tags would
    // render as literal text. pre-line honours \n, so the list is plain text.
    message: 'Creating an audiobook is unavailable while a book is encrypted. The server never sees the text, so it can\'t narrate it. That will become possible with "hyperlit.local". Email sam@hyperlit.io and pester him to make it!\n\n'
      + 'What you *can* do:\n'
      + '1. Make the book private (unencrypted).\n'
      + '2. Create the audiobook.\n'
      + '3. Re-encrypt the book — the audio files are encrypted along with it, and you can keep listening.\n\n'
      + 'One caveat: during creation, the unencrypted text is sent to the text-to-speech model via an external API.',
  });
}

/** Decrypting audio needs the book DEK — prompt the passkey unlock if the
 *  vault is locked (rare here: opening an encrypted book already unlocks it). */
async function ensureVaultUnlocked(): Promise<void> {
  const { isVaultUnlocked } = await import('../../e2ee/keys');
  if (await isVaultUnlocked()) return;
  const { showUnlockModal } = await import('../../e2ee/ui/unlockModal');
  await showUnlockModal(); // throws if dismissed
}

async function handlePlayPress(): Promise<void> {
  const id = bookId();
  if (!id || busy || id.includes('/')) return;

  // Toggle when already active (encrypted playback toggles the same way).
  if (controller && controller.getState() === 'playing') {
    controller.pause();

    return;
  }
  if (controller && controller.getState() === 'paused') {
    void controller.resume();

    return;
  }

  // Native shell: LOCALLY generated audio (BYO voice provider, MP3s on this
  // Mac) takes precedence over server audio. Staleness is computed locally by
  // re-hashing the current speakable text.
  if (isNativeShell() && !isBookEncrypted(id)) {
    busy = true;
    try {
      const local = await loadLocalAudio(id);
      if (local) {
        manifest = await toPlayerManifest(id, local);
        if (staleCount(manifest) > 0 && await offerLocalStaleUpdate(id, staleCount(manifest))) {
          return; // update accepted — local generation replays when done
        }
        usingLocalAudio = true;
        await startPlayback(id);

        return;
      }
    } finally {
      busy = false;
    }
  }

  // Encrypted book: audio that existed at lock time was encrypted in place
  // (e2ee/audioBlobs.ts) and plays via client-side decryption. What CAN'T
  // happen is creating/updating audio (the server would need plaintext).
  if (isBookEncrypted(id)) {
    busy = true;
    try {
      manifest = await fetchAudioManifest(id);
      if (!manifest || Object.keys(manifest.nodes).length === 0) {
        void showEncryptedNotice();

        return;
      }
      await ensureVaultUnlocked();
      await startPlayback(id);
    } catch (e) {
      // Unlock dismissed / decrypt failed — playback just doesn't start.
      verbose.content(`audioPlayer: encrypted playback not started: ${e}`, '/components/audioPlayer');
    } finally {
      busy = false;
    }

    return;
  }

  busy = true;
  try {
    manifest = await fetchAudioManifest(id);
    const hasAudio = manifest && Object.keys(manifest.nodes).length > 0;

    if (!hasAudio) {
      // BYO voice provider active (native shell): narrate on THIS Mac with the
      // user's own key — free, stored locally, no server involvement.
      if (isNativeShell() && await isByoTtsActive()) {
        const accepted = await confirmDialog({
          title: 'Generate audiobook on this Mac',
          message: 'This book will be narrated using your own voice provider (app settings, ⌘,). '
            + 'The audio is stored only on this Mac — no credits are charged.\n\n'
            + 'To use server generation instead, deactivate your voice provider first.',
          confirmLabel: 'Generate locally',
          cancelLabel: 'Cancel',
        });
        if (accepted) runLocalGeneration(id);

        return;
      }

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

    // Audio exists but some paragraphs were edited since: decide HERE, at the
    // press, not via chrome on the player (the pill stays clean).
    if (manifest && staleCount(manifest) > 0 && await offerStaleUpdate(id)) {
      return; // update accepted — watchGeneration takes over and auto-plays
    }

    await startPlayback(id);
  } finally {
    busy = false;
  }
}

/**
 * "Audio is out of date — update (price) | listen anyway". Returns true when
 * an update run was accepted (caller stops; the watcher plays when ready).
 * Any decline/failure falls back to listening to the current audio.
 */
async function offerStaleUpdate(id: string): Promise<boolean> {
  const status = await refreshStatus(id);
  if (!status || status.stale_nodes === 0) return false;

  const wantsUpdate = await confirmDialog({
    title: 'Audio is out of date',
    message: `${status.stale_nodes} section(s) have been edited since this audiobook was narrated (update: ${formatPrice(status)}). You can update now or listen to the current audio.`,
    confirmLabel: `Update (${formatPrice(status)})`,
    cancelLabel: 'Listen anyway',
  });
  if (!wantsUpdate) return false;

  const accepted = status.generating || await requestGeneration(id);
  if (!accepted) return false; // 401/402/etc alerts shown — fall back to old audio

  generating = true;
  bar?.show();
  bar?.setGenerating(true);
  bar?.setStatus('Updating audio…');
  watchGeneration(id, /*playWhenDone*/ true);

  return true;
}

/**
 * Local flavour of offerStaleUpdate: edits since the last LOCAL narration are
 * re-narrated with the user's own provider (free) — hash-skip means only the
 * changed nodes are synthesized. Declining just plays the current audio.
 */
async function offerLocalStaleUpdate(id: string, staleNodes: number): Promise<boolean> {
  if (!(await isByoTtsActive())) return false; // no provider — play what exists

  const wantsUpdate = await confirmDialog({
    title: 'Audio is out of date',
    message: `${staleNodes} section(s) have been edited since this audiobook was narrated on this Mac. Update with your own voice provider (free), or listen to the current audio.`,
    confirmLabel: 'Update locally',
    cancelLabel: 'Listen anyway',
  });
  if (!wantsUpdate) return false;

  runLocalGeneration(id);

  return true;
}

/**
 * Drive a local BYO narration run with pill progress, then auto-play. The
 * pill's stop button cancels (see initAudioPlayer's onStop); the manifest
 * checkpoint after every node means a cancelled run resumes for free.
 */
function runLocalGeneration(id: string): void {
  generating = true;
  bar?.show();
  bar?.setGenerating(true);
  bar?.setStatus('Narrating on this Mac…');

  localGen = startLocalGeneration(id, (p) => {
    bar?.setStatus(`Narrating ${p.doneNodes} / ${p.totalNodes}`);
  });

  void localGen.done
    .then(async (p) => {
      const cancelled = localGen === null; // onStop cleared it
      localGen = null;
      generating = false;
      bar?.setGenerating(false);

      if (cancelled) return; // pill already hidden by onStop

      if (p.failedNodes.length > 0) {
        bar?.setStatus(`${p.failedNodes.length} section(s) failed — check your voice provider`);
      }

      const local = await loadLocalAudio(id);
      if (!local) {
        bar?.setStatus('No audio was generated — check your voice provider (⌘,)');

        return;
      }
      manifest = await toPlayerManifest(id, local);
      usingLocalAudio = true;
      await startPlayback(id);
    })
    .catch((e) => {
      localGen = null;
      generating = false;
      bar?.setGenerating(false);
      bar?.setStatus('Local narration failed — check your voice provider (⌘,)');
      log.error('audioPlayer: local generation failed', '/components/audioPlayer', e);
    });
}

async function startPlayback(id: string): Promise<void> {
  if (!manifest) return;
  if (!controller) controller = buildController(id);
  bar?.show();
  bar?.setGenerating(false);
  bar?.setSpeed(controller.getSettings().speed);
  bar?.setHighlightActive(controller.getSettings().highlight);
  const started = await controller.start(manifest);
  if (!started) {
    bar?.setStatus('No audio available yet.');
  }
}

function buildController(id: string): PlaybackController {
  // Source resolver: local disk (native shell) > encrypted-decrypt > server URL.
  const resolveSrc = usingLocalAudio
    ? localResolveSrc(id)
    : isBookEncrypted(id)
      ? async (filename: string) => (await import('./encryptedAudio')).getDecryptedAudioUrl(id, filename)
      : undefined;

  return new PlaybackController(id, {
    onStateChange: (state) => bar?.setPlaying(state === 'playing'),
    // Staleness was already decided at press-time (offerStaleUpdate) — the
    // playing pill stays clean.
    onEntryChange: (_entry: PlaylistEntry, index: number, total: number) => {
      bar?.setStatus(`${index + 1} / ${total}`);
    },
    onFollowModeChange: (following) => bar?.setFollowVisible(!following),
    onFinished: () => {
      bar?.setStatus('');
      bar?.hide();
    },
    onAutoplayBlocked: () => {
      bar?.show();
      bar?.setPlaying(false);
      bar?.setStatus('Audio ready — press play');
    },
  }, resolveSrc);
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
        bar?.setStatus(progress.stage === 'preparing'
          ? 'Preparing text for narration…'
          : `Generating audio… ${progress.done_nodes ?? 0}/${progress.total_nodes ?? '?'} sections`);
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

/**
 * Show the settings-menu Listen button iff the player is live on this page
 * (reader) and this isn't a sub-book. Encrypted books DO show the button —
 * pressing it explains why narration isn't possible (an invisible button +
 * silent no-op left users baffled, especially since the E2EE flag can load
 * after this sync). Also called by settingsContainer after its innerHTML
 * resets restore the button's default `hidden`.
 */
export function syncListenButton(): void {
  const id = bookId();
  const button = document.getElementById('audioListenButton');
  if (button) button.hidden = !active || !id || id.includes('/');
}

export function initAudioPlayer(): void {
  active = true;
  syncListenButton();

  bar = new PlayerBar({
    onPlayPause: () => void handlePlayPress(),
    onStop: () => {
      const id = bookId();
      // Local BYO narration: cancel the loop (manifest checkpoint keeps
      // everything already narrated — a later run resumes via hash-skip).
      if (localGen) {
        localGen.cancel();
        localGen = null; // signals the .then() that this was a cancel
        generating = false;
        bar?.setGenerating(false);
        bar?.hide();

        return;
      }
      if (generating && id) {
        void cancelGeneration(id);

        return; // the poll's terminal 'cancelled' beat updates the bar
      }
      controller?.stop();
      bar?.hide();
    },
    onRestart: () => void controller?.restartFromTop(),
    onPrev: () => void controller?.previous(),
    onNext: () => void controller?.next(),
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
  });

  log.init('audioPlayer initialized', '/components/audioPlayer');
  verbose.init('audioPlayer: listen button synced', '/components/audioPlayer');
}

export function destroyAudioPlayer(): void {
  active = false;
  syncListenButton(); // home/user share the settings panel — hide there
  stopProgressPolling();
  localGen?.cancel(); // checkpointed after every node — nothing is lost
  localGen = null;
  usingLocalAudio = false;
  controller?.destroy();
  controller = null;
  manifest = null;
  generating = false;
  bar?.destroy(); // removes its DOM listeners — the pill markup persists across SPA navs
  bar = null;
  busy = false;
  // Revoke any decrypted audio blob URLs (encrypted-book playback).
  void import('./encryptedAudio').then(({ clearAudioBlobCache }) => clearAudioBlobCache());
}

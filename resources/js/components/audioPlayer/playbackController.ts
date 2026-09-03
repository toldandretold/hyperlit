// Playback engine: one persistent <audio> element advancing through the
// book's nodes in IndexedDB order, highlighting + (optionally) following the
// node being read.
//
// Playlist entries pair the manifest key (node_id / data-node-id) with the
// node's DOM id (startLine) — navigateToInternalId wants the DOM id, and it
// also handles chunk-window eviction (a far-away node's chunk is loaded
// before scrolling).
//
// FAILURE MODEL. Every paragraph is a separate MP3 fetched over HTTP and played
// progressively, so playback can die in ways `ended` never reports: the download
// breaks mid-stream, a load supersedes an in-flight play(), the OS pauses us, or
// the playlist re-read comes back short. All of those used to leave the player
// silent while the pill still claimed to be playing (pressing prev/next was the
// only way out). Now every failure funnels through recoverFrom() — retry the
// node once, then skip, bounded — and a watchdog catches stall shapes nobody
// enumerated. audioTrace.ts records the whole sequence so an intermittent stall
// can be diagnosed after the fact.

import { log, verbose, isVerboseEnabled } from '../../utilities/logger';
import { getNodesFromIndexedDB } from '../../indexedDB/nodes/read';
import { asBookId } from '../../utilities/idHelpers';
import { getFreshAnchor } from '../../scrolling/readingAnchor';
import { navigateToInternalId } from '../../scrolling/internalNav';
import { currentLazyLoader } from '../../pageLoad/currentLazyLoaderState';
import { traceAudio } from './audioTrace';
import { audioUrl, type AudioManifest } from './manifest';

export type PlayerState = 'idle' | 'playing' | 'paused';

export interface PlaylistEntry {
  nodeId: string;      // data-node-id — the manifest key
  elementId: string;   // DOM id (startLine serialization)
  filename: string;
  stale: boolean;
}

export interface PlaybackCallbacks {
  onStateChange: (state: PlayerState) => void;
  onEntryChange: (entry: PlaylistEntry, index: number, total: number) => void;
  onFollowModeChange: (following: boolean) => void;
  onFinished: () => void;
  /** Autoplay was blocked (the triggering gesture is too old — e.g. playback
   *  auto-starting after generation). Everything is staged; a press of the
   *  play button resumes. */
  onAutoplayBlocked: () => void;
}

const SPEED_STEPS = [1, 1.25, 1.5, 1.75, 2];
const READING_CLASS = 'audio-reading';
const SETTINGS_KEY = 'hyperlitAudioSettings';
/** A user scroll pauses follow; after this much scroll-free time, follow
 *  re-engages on the next paragraph advance (walk-away-and-come-back). */
const FOLLOW_RESUME_MS = 30_000;

/** A failed node is retried once before being skipped: a network blip leaves the
 *  audio perfectly good, and losing a paragraph to one is far more noticeable
 *  than the 600ms the retry costs. */
const MAX_NODE_RETRIES = 1;
const RETRY_BACKOFF_MS = 600;
const WATCHDOG_TICK_MS = 1000;
/** Playing, buffered, but currentTime frozen — something is genuinely wrong. */
const WATCHDOG_STUCK_MS = 6000;
/** readyState < HAVE_FUTURE_DATA is honest buffering; give a slow network room. */
const WATCHDOG_BUFFER_MS = 15_000;
/** Within this much of the duration, "no progress" means it finished and the
 *  `ended` event went missing — advance rather than recover. */
const NEAR_END_S = 0.35;
/** Bound on consecutive rejected playlist re-reads, so a book the user genuinely
 *  shortened can't freeze the ordering forever. */
const MAX_REJECTED_REFRESHES = 3;
/** Bound on consecutive unplayable nodes before we stop, so a systemic failure
 *  doesn't race to the end of the book (an unbounded skip once "finished" a
 *  212-paragraph book instantly and hid the player). */
const MAX_CONSECUTIVE_SKIPS = 5;

interface AudioSettings {
  highlight: boolean;
  follow: boolean;
  speed: number;
}

export function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { highlight: true, follow: true, speed: 1, ...JSON.parse(raw) };
  } catch { /* fall through to defaults */ }

  return { highlight: true, follow: true, speed: 1 };
}

export function saveAudioSettings(settings: AudioSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode etc. — settings just don't persist */ }
}

export class PlaybackController {
  private audio: HTMLAudioElement;

  private playlist: PlaylistEntry[] = [];

  /** Book nodes in reading order. NOT a once-only cache: on a freshly opened
   *  book the background chunk download is still filling IndexedDB, so a
   *  press-play snapshot can have HOLES (first paragraphs + some far-away
   *  ones → playback suddenly jumps to the bottom of the book). Refreshed at
   *  every paragraph boundary via refreshPlaylist(). */
  private orderedNodes: { nodeId: string; elementId: string }[] = [];

  private lastManifest: AudioManifest | null = null;

  private index = -1;

  private state: PlayerState = 'idle';

  private settings: AudioSettings;

  private bookId: string;

  private callbacks: PlaybackCallbacks;

  private boundUserScroll: (e: Event) => void;

  /** [type, listener] pairs on the media element — a list rather than a field
   *  per listener so destroy() cannot forget one (the element outlives nothing,
   *  but a leaked listener would fire against a dead controller). */
  private mediaListeners: Array<[string, EventListener]> = [];

  private lastUserScrollAt = 0;

  private consecutiveSkips = 0;

  /** Monotonic. Bumped by everything that changes "what should be playing".
   *  Any async continuation that resumes holding a stale token belongs to a
   *  superseded intent and MUST return without touching the element — this is
   *  what stops an ended→next() advance racing a user prev/next tap into
   *  "AbortError: play() interrupted by a new load request", which the old
   *  catch misread as a bad node and silently SKIPPED a paragraph. */
  private playToken = 0;

  /** True whenever the source has been torn down on purpose (idle/destroyed).
   *  The element fires error/emptied/pause during that teardown and a quiescent
   *  player must not mistake its own teardown for a stall. */
  private quiescent = true;

  /** Set immediately before any programmatic pause() so the `pause` listener can
   *  tell "we did that" from "the OS/tab did that to us". */
  private expectPause = false;

  /** Watchdog heartbeat: when currentTime last actually moved, and to what. */
  private lastProgressAt = 0;

  private lastTime = 0;

  /** Retries spent on the CURRENT node (reset whenever the node changes). */
  private nodeRetries = 0;

  /** The playToken whose recovery has already been started. A bad source
   *  signals TWICE — the element fires `error` AND play() rejects — and without
   *  this the second signal lands while the first is still in its retry backoff,
   *  sees nodeRetries already spent, and skips the paragraph immediately. That
   *  turned "retry once, then skip" into "never retry at all". */
  private recoveredToken = -1;

  private watchdogTimer: number | null = null;

  private rejectedRefreshes = 0;

  /** Where to resume the next load — set by a retry, consumed by loadedmetadata. */
  private pendingSeek = 0;

  /** Encrypted books swap in a fetch-decrypt-to-blob-URL resolver
   *  (encryptedAudio.ts); plaintext books stream the serve URL directly. */
  private resolveSrc: ((filename: string) => Promise<string>) | null;

  constructor(
    bookId: string,
    callbacks: PlaybackCallbacks,
    resolveSrc?: (filename: string) => Promise<string>,
  ) {
    this.bookId = bookId;
    this.callbacks = callbacks;
    this.resolveSrc = resolveSrc ?? null;
    this.settings = loadAudioSettings();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.applyPlaybackRate();
    this.installMediaListeners();
    // A user scroll means "I'm reading somewhere else" — stop dragging the
    // viewport around (keep playing + highlighting). internalNav's scroll
    // lock already yields to user scrolls mid-animation; this stops FUTURE
    // advances from scrolling. Follow re-engages after FOLLOW_RESUME_MS of
    // scroll silence (see maybeAutoResumeFollow) or via "Resume following".
    this.boundUserScroll = (e: Event) => {
      // Touching the player pill isn't "reading somewhere else". LOAD-BEARING
      // for the drag grip (playerDrag.ts): arrow-key nudging and touch-dragging
      // the pill must not disable follow mode.
      if (e.target instanceof Element && e.target.closest('#audio-player-bar')) return;
      // For keys, only scroll-intent keys outside editable targets count.
      if (e instanceof KeyboardEvent) {
        const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        if (!scrollKeys.includes(e.key)) return;
        if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return;
      }
      this.lastUserScrollAt = Date.now();
      this.setFollow(false, true);
    };
    window.addEventListener('wheel', this.boundUserScroll, { passive: true });
    window.addEventListener('touchmove', this.boundUserScroll, { passive: true });
    window.addEventListener('keydown', this.boundUserScroll, { passive: true });
  }

  destroy(): void {
    this.playToken++;
    this.quiescent = true;
    this.stopWatchdog();
    this.trace('destroy');
    this.clearHighlight();
    for (const [type, listener] of this.mediaListeners) {
      this.audio.removeEventListener(type, listener);
    }
    this.mediaListeners = [];
    window.removeEventListener('wheel', this.boundUserScroll);
    window.removeEventListener('touchmove', this.boundUserScroll);
    window.removeEventListener('keydown', this.boundUserScroll);
    this.teardownSource();
    this.clearMediaSession();
    this.setState('idle');
  }

  getState(): PlayerState {
    return this.state;
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  /** The pill reads this every paragraph so its label can never drift from the
   *  engine (it used to be written only on the button press). */
  getSpeed(): number {
    return this.settings.speed;
  }

  currentEntry(): PlaylistEntry | null {
    return this.playlist[this.index] ?? null;
  }

  /**
   * Build the playlist from IndexedDB node order × the manifest, resolve the
   * starting node from the reader's current position, and start playing.
   *
   * `onlyIfPositionCovered` is the play-while-generating mode: refuse to
   * start (return false) unless the reader's position already has audio —
   * generation runs in reading order, so "not covered yet" means the
   * synthesizer hasn't reached them; starting from the book's top instead
   * would be wrong.
   */
  async start(manifest: AudioManifest, onlyIfPositionCovered = false): Promise<boolean> {
    this.lastManifest = manifest;
    await this.ensureOrderedNodes();
    this.playlist = this.buildPlaylist(manifest);

    if (this.playlist.length === 0) {
      log.content('audioPlayer: manifest has no playable nodes', '/components/audioPlayer/playbackController');

      return false;
    }

    const startIndex = this.findStartIndex(onlyIfPositionCovered);
    if (startIndex === null) return false; // position not covered yet — caller retries next poll

    this.index = startIndex;
    this.consecutiveSkips = 0;
    this.nodeRetries = 0;
    this.rejectedRefreshes = 0;
    this.setFollow(this.settings.follow, false);
    await this.playCurrent();

    return true;
  }

  /**
   * Refresh the playlist from a newer manifest without interrupting playback
   * — the play-while-generating poll calls this so nodes synthesized behind
   * the listener keep appearing ahead of them.
   */
  updatePlaylist(manifest: AudioManifest): void {
    if (this.orderedNodes.length === 0) return; // start() hasn't run
    this.lastManifest = manifest;
    const current = this.currentEntry();
    this.playlist = this.buildPlaylist(manifest);
    this.relocate(current);
  }

  /**
   * Re-read node order from IndexedDB and rebuild the playlist around the
   * current entry. Called at every paragraph boundary — this is what closes
   * the holes left by a press-play snapshot racing the background chunk
   * download.
   */
  private async refreshPlaylist(): Promise<void> {
    if (!this.lastManifest) return;
    const current = this.currentEntry();
    try {
      await this.ensureOrderedNodes(true);
    } catch (e) {
      // An IndexedDB rejection must NOT kill the advance. The caller is
      // `void this.next()` from the `ended` handler, so a rejection here used to
      // go unhandled and playback simply stopped dead mid-book.
      verbose.content(`audioPlayer: playlist refresh failed, keeping the cached order: ${e}`, '/components/audioPlayer/playbackController');

      return;
    }
    this.playlist = this.buildPlaylist(this.lastManifest);
    this.relocate(current);
  }

  private relocate(current: PlaylistEntry | null): void {
    if (!current) return;
    const idx = this.playlist.findIndex((e) => e.nodeId === current.nodeId);
    if (idx !== -1) {
      this.index = idx;

      return;
    }
    // The node vanished (deleted, or a partial read we accepted). Land where it
    // USED to sit by reading position, so next()'s index++ resumes with the
    // paragraph after it. Clamping to the END of the list here — the old
    // behaviour — is what made next()'s bounds check fire a spurious stop() and
    // "randomly" end playback halfway through a book.
    const line = parseFloat(current.elementId);
    const after = Number.isNaN(line)
      ? -1
      : this.playlist.findIndex((e) => parseFloat(e.elementId) > line);
    this.index = after === -1
      ? Math.max(0, this.playlist.length - 1)
      : Math.max(0, after - 1);
  }

  private async ensureOrderedNodes(force = false): Promise<void> {
    if (!force && this.orderedNodes.length > 0) return;
    const nodes = await getNodesFromIndexedDB(asBookId(this.bookId));
    const ordered = [...nodes]
      .sort((a, b) => a.startLine - b.startLine)
      .filter((n) => n.node_id)
      .map((n) => ({ nodeId: n.node_id as string, elementId: String(n.startLine) }));

    if (force && this.orderedNodes.length > 0) {
      const current = this.currentEntry();
      const keepsCurrent = !current || ordered.some((n) => n.nodeId === current.nodeId);
      const majorShrink = ordered.length * 4 < this.orderedNodes.length * 3; // lost >25%
      // A transient/partial IDB read used to REPLACE a good ordering, shrinking
      // the playlist so relocate() clamped the index to the end and the next
      // advance called stop(). Reject an untrustworthy read — bounded, so a book
      // the user genuinely shortened isn't frozen on a stale order forever.
      const untrustworthy = ordered.length === 0 || !keepsCurrent || majorShrink;
      if (untrustworthy && this.rejectedRefreshes < MAX_REJECTED_REFRESHES) {
        this.rejectedRefreshes++;
        this.trace('refresh-rejected');
        verbose.content(
          `audioPlayer: ignoring node re-read (${ordered.length} vs ${this.orderedNodes.length})`,
          '/components/audioPlayer/playbackController',
        );

        return;
      }
    }
    this.rejectedRefreshes = 0;
    this.orderedNodes = ordered;
  }

  private buildPlaylist(manifest: AudioManifest): PlaylistEntry[] {
    const playlist: PlaylistEntry[] = [];
    for (const node of this.orderedNodes) {
      const entry = manifest.nodes[node.nodeId];
      if (!entry) continue; // no audio (new/empty/not-yet-generated node)
      playlist.push({
        nodeId: node.nodeId,
        elementId: node.elementId,
        filename: entry.filename,
        stale: entry.stale,
      });
    }

    return playlist;
  }

  /** `seekTo` > 0 resumes a retried node near where it died. */
  async playCurrent(seekTo = 0): Promise<void> {
    const entry = this.currentEntry();
    if (!entry) {
      this.stop();

      return;
    }

    const token = ++this.playToken; // supersede anything already in flight
    this.pendingSeek = seekTo;
    this.quiescent = false;
    this.lastProgressAt = Date.now();
    this.lastTime = seekTo;
    this.trace('node-start');

    try {
      // Pause BEFORE swapping source: an in-flight play() on the old source is
      // exactly what turns into AbortError when a new load lands on top of it.
      this.silentPause();

      const src = this.resolveSrc
        ? await this.resolveSrc(entry.filename)
        : audioUrl(this.bookId, entry.filename);
      if (token !== this.playToken) return; // superseded while resolving

      this.audio.src = src;
      this.applyPlaybackRate(); // the src setter just reset it — see applyPlaybackRate
      await this.audio.play();
      if (token !== this.playToken) return; // superseded while starting
      this.applyPlaybackRate();
      this.consecutiveSkips = 0;
    } catch (e) {
      if (token !== this.playToken) return; // a newer intent owns the element now
      if (e instanceof DOMException && e.name === 'AbortError') {
        // play() was interrupted by a new load request. NOT a bad node and NOT a
        // reason to skip a paragraph — the interrupting load owns the outcome.
        this.trace('play-aborted');

        return;
      }
      // Autoplay blocked: the gesture that led here is too old (generation
      // just finished, or a background poll started playback). NOT a bad
      // file — stage everything and wait for one press of play.
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        this.trace('autoplay-blocked');
        this.setState('paused');
        this.callbacks.onEntryChange(entry, this.index, this.playlist.length);
        this.applyHighlight(entry);
        this.callbacks.onAutoplayBlocked();

        return;
      }
      verbose.content(`audioPlayer: play failed on ${entry.nodeId}: ${e}`, '/components/audioPlayer/playbackController');
      await this.recoverFrom('play-failed', token);

      return;
    }

    this.setState('playing');
    this.callbacks.onEntryChange(entry, this.index, this.playlist.length);
    this.applyHighlight(entry);
    this.maybeAutoResumeFollow();
    if (this.followActive) void this.scrollToEntry(entry);
    this.updateMediaSession();
    this.prefetchNext();
  }

  /** Re-engage follow at a paragraph boundary once the user has stopped
   *  scrolling for FOLLOW_RESUME_MS (only when their saved preference is on). */
  private maybeAutoResumeFollow(): void {
    if (this.followActive || !this.settings.follow) return;
    if (Date.now() - this.lastUserScrollAt < FOLLOW_RESUME_MS) return;
    this.followActive = true;
    this.callbacks.onFollowModeChange(true);
  }

  pause(): void {
    // Traced because this is reachable WITHOUT any user gesture on the page:
    // the mediaSession 'pause' action handler routes here, and Chrome fires it
    // for hardware media keys, AirPods ear-detection, and screen lock. Without
    // an entry, that path was the one state change the ring could not see —
    // playback stopped mid-book with a trace that just went silent (e2e stall
    // post-mortem, 2026-09-03).
    this.trace('pause-requested');
    this.silentPause();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    this.trace('resume-requested');
    this.quiescent = false;
    try {
      await this.audio.play();
      this.setState('playing');
    } catch {
      // e.g. the tab lost its user-gesture allowance — surface via state
      this.setState('paused');
    }
  }

  stop(): void {
    this.playToken++; // kill any in-flight playCurrent continuation
    this.quiescent = true;
    this.stopWatchdog();
    this.trace('stop');
    this.teardownSource();
    this.clearHighlight();
    this.clearMediaSession();
    this.index = -1;
    this.nodeRetries = 0;
    this.consecutiveSkips = 0;
    this.setState('idle');
    this.callbacks.onFinished();
  }

  async next(): Promise<void> {
    this.trace('next');
    await this.refreshPlaylist();
    if (this.index >= this.playlist.length - 1) {
      this.stop();

      return;
    }
    this.index++;
    this.nodeRetries = 0;
    try {
      await this.playCurrent();
    } catch (e) {
      log.error('audioPlayer: advance failed', '/components/audioPlayer/playbackController', e);
      this.stop();
    }
  }

  /** Hard restart from the first narrated paragraph of the book. */
  async restartFromTop(): Promise<void> {
    if (this.playlist.length === 0) return;
    this.index = 0;
    this.nodeRetries = 0;
    this.consecutiveSkips = 0;
    await this.playCurrent();
  }

  async previous(): Promise<void> {
    this.trace('previous');
    // Within the first 3 seconds, prev = previous node; later it restarts the node.
    if (this.audio.currentTime > 3 || this.index <= 0) {
      this.audio.currentTime = 0;

      return;
    }
    await this.refreshPlaylist();
    this.index--;
    this.nodeRetries = 0;
    try {
      await this.playCurrent();
    } catch (e) {
      log.error('audioPlayer: step back failed', '/components/audioPlayer/playbackController', e);
      this.stop();
    }
  }

  cycleSpeed(): number {
    const pos = SPEED_STEPS.indexOf(this.settings.speed);
    this.settings.speed = SPEED_STEPS[(pos + 1) % SPEED_STEPS.length] ?? 1;
    this.applyPlaybackRate();
    saveAudioSettings(this.settings);
    this.trace('speed');

    return this.settings.speed;
  }

  setFollow(follow: boolean, fromUserScroll: boolean): void {
    // A user scroll only disables the SESSION's following; it doesn't rewrite
    // the saved preference.
    if (!fromUserScroll) {
      this.settings.follow = follow;
      saveAudioSettings(this.settings);
    }
    this.followActive = follow;
    this.callbacks.onFollowModeChange(follow);
  }

  private followActive = true;

  resumeFollowing(): void {
    this.followActive = true;
    this.callbacks.onFollowModeChange(true);
    const entry = this.currentEntry();
    if (entry) void this.scrollToEntry(entry);
  }

  isFollowing(): boolean {
    return this.followActive;
  }

  setHighlightEnabled(enabled: boolean): void {
    this.settings.highlight = enabled;
    saveAudioSettings(this.settings);
    if (!enabled) {
      this.clearHighlight();
    } else {
      const entry = this.currentEntry();
      if (entry && this.state === 'playing') this.applyHighlight(entry);
    }
  }

  // ── media element ──────────────────────────────────────────────────

  /**
   * The <audio> load algorithm resets playbackRate to defaultPlaybackRate on
   * EVERY src assignment, so setting only playbackRate makes the chosen speed
   * survive exactly one paragraph (the reported bug). defaultPlaybackRate is
   * what carries the speed across node boundaries; playbackRate applies it to
   * whatever is playing right now. Both, always, together.
   */
  private applyPlaybackRate(): void {
    const rate = this.settings.speed;
    if (this.audio.defaultPlaybackRate !== rate) this.audio.defaultPlaybackRate = rate;
    if (this.audio.playbackRate !== rate) this.audio.playbackRate = rate;
  }

  private listenMedia(type: string, listener: EventListener): void {
    this.audio.addEventListener(type, listener);
    this.mediaListeners.push([type, listener]);
  }

  private installMediaListeners(): void {
    this.listenMedia('loadedmetadata', () => {
      this.applyPlaybackRate(); // fires after the load algorithm finished mutating
      if (this.pendingSeek > 0) {
        const target = this.pendingSeek;
        this.pendingSeek = 0;
        try {
          this.audio.currentTime = target;
        } catch { /* unseekable stream — start from the top instead */ }
      }
      this.trace('loadedmetadata');
    });

    this.listenMedia('playing', () => {
      // NOTE: nodeRetries is deliberately NOT reset here. Resetting it on a
      // successful start would give a node that reliably dies mid-stream an
      // infinite retry budget (play → die at 3s → retry → play → die at 3s → …).
      // It resets only when the index moves, so one visit earns one retry.
      this.lastProgressAt = Date.now();
      this.applyPlaybackRate();
      this.trace('playing');
      if (this.state !== 'playing') this.setState('playing'); // heal a drifted pill
    });

    // The watchdog's heartbeat. Fires ~4Hz — no branch, no trace, no log.
    this.listenMedia('timeupdate', () => {
      this.lastProgressAt = Date.now();
      this.lastTime = this.audio.currentTime;
    });

    // Buffering counts as liveness, so a slow-but-working network never trips
    // the watchdog.
    this.listenMedia('progress', () => {
      this.lastProgressAt = Date.now();
    });

    // Traced, deliberately not acted on: these are normal, and the watchdog is
    // what decides a stall is real. They exist so the ring shows the run-up.
    this.listenMedia('waiting', () => this.trace('waiting'));
    this.listenMedia('stalled', () => this.trace('stalled'));

    this.listenMedia('error', () => {
      if (this.quiescent) {
        this.trace('error-quiescent'); // our own teardown, not a failure
        return;
      }
      this.trace('error');
      log.content(
        `audioPlayer: media error (code ${this.audio.error?.code ?? '?'}) on ${this.currentEntry()?.nodeId ?? 'unknown node'}`,
        '/components/audioPlayer/playbackController',
      );
      void this.recoverFrom('media-error', this.playToken);
    });

    this.listenMedia('pause', () => {
      if (this.expectPause) {
        this.expectPause = false;
        return;
      }
      if (this.quiescent || this.audio.ended) return;
      // Nobody asked for this — the OS, the tab, or audio-focus loss paused us.
      // Surface it so the pill offers Play instead of claiming to be playing.
      this.trace('pause');
      log.content('audioPlayer: playback paused externally', '/components/audioPlayer/playbackController');
      this.setState('paused');
    });

    this.listenMedia('ended', () => {
      this.trace('ended');
      void this.next();
    });
  }

  /**
   * `audio.src = ''` makes Chrome resolve the empty string against the document
   * URL and try to load the HTML page as media — which fires a REAL error event.
   * removeAttribute + load() is the spec-clean reset.
   */
  private teardownSource(): void {
    this.silentPause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  /** Pause without the `pause` listener reading it as an external interruption.
   *  The `expectPause` flag is armed ONLY when a pause event will actually fire
   *  — arming it against an already-paused element would leave it set and
   *  swallow the next genuine OS pause. */
  private silentPause(): void {
    if (this.audio.paused) return;
    this.expectPause = true;
    this.audio.pause();
  }

  /**
   * Every failure path — a media `error`, a play()/resolver rejection, and the
   * watchdog — lands here. One node gets ONE retry (resumed near where it died);
   * after that it is skipped, and skips stay bounded so a systemic failure stops
   * the player instead of racing to the end of the book.
   */
  private async recoverFrom(reason: string, token: number): Promise<void> {
    if (token !== this.playToken) return;      // stale intent
    if (this.quiescent) return;                // we tore the source down on purpose
    if (this.recoveredToken === token) return; // this attempt is already being recovered
    this.recoveredToken = token;
    const entry = this.currentEntry();
    if (!entry) {
      this.stop();

      return;
    }

    if (this.nodeRetries < MAX_NODE_RETRIES) {
      this.nodeRetries++;
      const resumeAt = this.lastTime > 2 ? Math.max(0, this.lastTime - 0.5) : 0;
      this.trace('retry');
      log.content(
        `audioPlayer: retrying ${entry.nodeId} after ${reason} (from ${resumeAt.toFixed(1)}s)`,
        '/components/audioPlayer/playbackController',
      );
      await new Promise((resolve) => { setTimeout(resolve, RETRY_BACKOFF_MS); });
      if (token !== this.playToken || this.quiescent) return;
      await this.playCurrent(resumeAt);

      return;
    }

    this.consecutiveSkips++;
    this.trace('skip');
    log.content(
      `audioPlayer: skipping ${entry.nodeId} after ${reason} (skip ${this.consecutiveSkips})`,
      '/components/audioPlayer/playbackController',
    );
    this.nodeRetries = 0;
    if (this.consecutiveSkips > MAX_CONSECUTIVE_SKIPS || this.index >= this.playlist.length - 1) {
      this.stop();

      return;
    }
    this.index++;
    await this.playCurrent();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastProgressAt = Date.now();
    this.watchdogTimer = window.setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer === null) return;
    window.clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /**
   * The catch-all. Whatever shape a stall takes — an event we don't listen for,
   * a source that silently went dead, an `ended` that never arrived — it ends up
   * as "state says playing, currentTime isn't moving", and this recovers it.
   */
  private watchdogTick(): void {
    if (this.state !== 'playing' || this.quiescent) return;
    // A paused element is the `pause` listener's business — EXCEPT when it is
    // paused because playback finished (`ended` true). The pause listener
    // deliberately ignores that shape on the promise that `ended` follows; if
    // Chrome loses the `ended` event, nobody owns the advance and playback dies
    // silently with the pill still claiming to play. Fall through so the
    // "finished but `ended` never fired" branch below advances after the
    // normal stall window.
    if (this.audio.paused && !this.audio.ended) return;
    if (isVerboseEnabled()) this.trace('tick');

    const since = Date.now() - this.lastProgressAt;
    const limit = this.audio.readyState < 3 ? WATCHDOG_BUFFER_MS : WATCHDOG_STUCK_MS;
    if (since < limit) return;

    this.lastProgressAt = Date.now(); // one shot per stall, not one per tick
    const token = this.playToken;

    // "Finished but `ended` never fired" is an ADVANCE, not a failure.
    const duration = this.audio.duration;
    if (this.audio.ended
      || (Number.isFinite(duration) && duration > 0 && this.audio.currentTime >= duration - NEAR_END_S)) {
      this.trace('watchdog-ended');
      log.content(
        'audioPlayer: watchdog advancing — playback reached the end without an `ended` event',
        '/components/audioPlayer/playbackController',
      );
      void this.next();

      return;
    }

    this.trace('watchdog');
    log.content(
      `audioPlayer: watchdog fired — no progress for ${since}ms (readyState ${this.audio.readyState})`,
      '/components/audioPlayer/playbackController',
    );
    void this.recoverFrom('watchdog', token);
  }

  private trace(event: string): void {
    traceAudio({
      t: Math.round(performance.now()),
      event,
      index: this.index,
      nodeId: this.currentEntry()?.nodeId ?? null,
      state: this.state,
      readyState: this.audio.readyState,
      networkState: this.audio.networkState,
      paused: this.audio.paused,
      currentTime: Math.round(this.audio.currentTime * 100) / 100,
      playbackRate: this.audio.playbackRate,
      errorCode: this.audio.error?.code ?? null,
    });
  }

  // ── internals ──────────────────────────────────────────────────────

  private setState(state: PlayerState): void {
    this.state = state;
    // The watchdog only ever runs while playing, so it can't outlive the state.
    if (state === 'playing') this.startWatchdog(); else this.stopWatchdog();
    this.callbacks.onStateChange(state);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'none';
    }
  }

  /**
   * Start where the reader is. Primary anchor: getFreshAnchor() — the
   * reading-position system's proven detector, re-run synchronously at press
   * time so it can't lag (stale anchors were the jump-to-top bug; the old
   * live-scan-first order existed only because the saved value used to lag).
   * Fallback: viewportAnchor() for any path where no loader was live to
   * refresh it. Returns null (don't start yet) when `requireCovered` and the
   * anchor position has no audio in the playlist yet — generation is in
   * reading order, so a partial playlist is a prefix that hasn't reached them.
   */
  private findStartIndex(requireCovered = false): number | null {
    const fresh = getFreshAnchor(this.bookId);
    let anchor: number | null = fresh ? parseFloat(fresh.elementId) : null;

    if (anchor === null) anchor = this.viewportAnchor();

    if (anchor === null) return 0;
    const idx = this.playlist.findIndex((e) => parseFloat(e.elementId) >= (anchor as number));

    if (idx === -1) return requireCovered ? null : 0;

    return idx;
  }

  /** startLine of the topmost node element currently visible, or null. */
  private viewportAnchor(): number | null {
    const scope = document.getElementById(this.bookId) ?? document;
    const nodes = scope.querySelectorAll<HTMLElement>('.chunk > [id]');
    for (const el of nodes) {
      const line = parseFloat(el.id);
      if (Number.isNaN(line)) continue;
      const rect = el.getBoundingClientRect();
      // First element whose bottom clears the header band = topmost visible.
      if (rect.bottom > 100 && rect.top < window.innerHeight) return line;
      if (rect.top >= window.innerHeight) break; // document order — past the fold
    }

    return null;
  }

  private findElement(entry: PlaylistEntry): HTMLElement | null {
    return document.getElementById(entry.elementId)
      ?? document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(entry.nodeId)}"]`);
  }

  private applyHighlight(entry: PlaylistEntry): void {
    this.clearHighlight();
    if (!this.settings.highlight) return;
    this.findElement(entry)?.classList.add(READING_CLASS);
  }

  private clearHighlight(): void {
    document.querySelectorAll(`.${READING_CLASS}`).forEach((el) => el.classList.remove(READING_CLASS));
  }

  private async scrollToEntry(entry: PlaylistEntry): Promise<void> {
    if (!this.followActive || !currentLazyLoader) return;
    try {
      // showOverlay=false: no full-screen loading flash on every paragraph.
      await navigateToInternalId(entry.elementId, currentLazyLoader, false);
      // Navigation can happen before the chunk renders the highlight target.
      this.applyHighlight(entry);
    } catch (e) {
      verbose.content(`audioPlayer: follow-scroll failed: ${e}`, '/components/audioPlayer/playbackController');
    }
  }

  private prefetchNext(): void {
    const nextEntry = this.playlist[this.index + 1];
    if (!nextEntry) return;
    // Warm the next node so it starts gap-free: the decrypt cache for
    // encrypted books, the plain HTTP cache otherwise.
    if (this.resolveSrc) {
      void this.resolveSrc(nextEntry.filename).catch(() => { /* best-effort */ });
      return;
    }
    fetch(audioUrl(this.bookId, nextEntry.filename), { credentials: 'include' }).catch(() => { /* best-effort */ });
  }

  private updateMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const title = document.querySelector('#main h1')?.textContent?.trim()
      || document.title.replace(/ [—|-] Hyperlit.*$/i, '')
      || 'Hyperlit';
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: 'Hyperlit audiobook',
    });
    navigator.mediaSession.setActionHandler('play', () => void this.resume());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => void this.previous());
    navigator.mediaSession.setActionHandler('nexttrack', () => void this.next());
  }

  private clearMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch { /* unsupported action */ }
    }
  }
}

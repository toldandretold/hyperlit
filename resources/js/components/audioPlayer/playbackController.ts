// Playback engine: one persistent <audio> element advancing through the
// book's nodes in IndexedDB order, highlighting + (optionally) following the
// node being read.
//
// Playlist entries pair the manifest key (node_id / data-node-id) with the
// node's DOM id (startLine) — navigateToInternalId wants the DOM id, and it
// also handles chunk-window eviction (a far-away node's chunk is loaded
// before scrolling).

import { log, verbose } from '../../utilities/logger';
import { getNodesFromIndexedDB } from '../../indexedDB/nodes/read';
import { asBookId } from '../../utilities/idHelpers';
import { getFreshAnchor } from '../../scrolling/readingAnchor';
import { navigateToInternalId } from '../../scrolling/internalNav';
import { currentLazyLoader } from '../../pageLoad/currentLazyLoaderState';
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

const SPEED_STEPS = [1, 1.25, 1.5, 2];
const READING_CLASS = 'audio-reading';
const SETTINGS_KEY = 'hyperlitAudioSettings';
/** A user scroll pauses follow; after this much scroll-free time, follow
 *  re-engages on the next paragraph advance (walk-away-and-come-back). */
const FOLLOW_RESUME_MS = 30_000;

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

  private boundEnded: () => void;

  private lastUserScrollAt = 0;

  private consecutiveSkips = 0;

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
    this.audio.playbackRate = this.settings.speed;
    this.boundEnded = () => void this.next();
    this.audio.addEventListener('ended', this.boundEnded);
    // A user scroll means "I'm reading somewhere else" — stop dragging the
    // viewport around (keep playing + highlighting). internalNav's scroll
    // lock already yields to user scrolls mid-animation; this stops FUTURE
    // advances from scrolling. Follow re-engages after FOLLOW_RESUME_MS of
    // scroll silence (see maybeAutoResumeFollow) or via "Resume following".
    this.boundUserScroll = (e: Event) => {
      // Touching the player pill isn't "reading somewhere else".
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
    this.clearHighlight();
    this.audio.removeEventListener('ended', this.boundEnded);
    window.removeEventListener('wheel', this.boundUserScroll);
    window.removeEventListener('touchmove', this.boundUserScroll);
    window.removeEventListener('keydown', this.boundUserScroll);
    this.audio.pause();
    this.audio.src = '';
    this.clearMediaSession();
    this.setState('idle');
  }

  getState(): PlayerState {
    return this.state;
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
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
    await this.ensureOrderedNodes(true);
    this.playlist = this.buildPlaylist(this.lastManifest);
    this.relocate(current);
  }

  private relocate(current: PlaylistEntry | null): void {
    if (!current) return;
    const idx = this.playlist.findIndex((e) => e.nodeId === current.nodeId);
    this.index = idx !== -1 ? idx : Math.min(this.index, this.playlist.length - 1);
  }

  private async ensureOrderedNodes(force = false): Promise<void> {
    if (!force && this.orderedNodes.length > 0) return;
    const nodes = await getNodesFromIndexedDB(asBookId(this.bookId));
    this.orderedNodes = [...nodes]
      .sort((a, b) => a.startLine - b.startLine)
      .filter((n) => n.node_id)
      .map((n) => ({ nodeId: n.node_id as string, elementId: String(n.startLine) }));
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

  async playCurrent(): Promise<void> {
    const entry = this.currentEntry();
    if (!entry) {
      this.stop();

      return;
    }

    this.audio.playbackRate = this.settings.speed;
    try {
      // Resolver failures (fetch/decrypt) land in the same catch as play()
      // failures — a bad node skips ahead (bounded), never crashes playback.
      this.audio.src = this.resolveSrc
        ? await this.resolveSrc(entry.filename)
        : audioUrl(this.bookId, entry.filename);
      await this.audio.play();
      this.consecutiveSkips = 0;
    } catch (e) {
      // Autoplay blocked: the gesture that led here is too old (generation
      // just finished, or a background poll started playback). NOT a bad
      // file — stage everything and wait for one press of play.
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        this.setState('paused');
        this.callbacks.onEntryChange(entry, this.index, this.playlist.length);
        this.applyHighlight(entry);
        this.callbacks.onAutoplayBlocked();

        return;
      }
      // A genuinely bad node (e.g. its file was pruned mid-session) — skip
      // ahead, but bounded: systemic failure must not cascade through the
      // whole book (the old unbounded skip is how an autoplay rejection once
      // "finished" a 212-paragraph book instantly and hid the player).
      verbose.content(`audioPlayer: play failed on ${entry.nodeId}: ${e}`, '/components/audioPlayer/playbackController');
      this.consecutiveSkips++;
      if (this.consecutiveSkips <= 5 && this.index < this.playlist.length - 1) {
        this.index++;
        await this.playCurrent();
      } else {
        this.stop();
      }

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
    this.audio.pause();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    try {
      await this.audio.play();
      this.setState('playing');
    } catch {
      // e.g. the tab lost its user-gesture allowance — surface via state
      this.setState('paused');
    }
  }

  stop(): void {
    this.audio.pause();
    this.audio.src = '';
    this.clearHighlight();
    this.clearMediaSession();
    this.index = -1;
    this.setState('idle');
    this.callbacks.onFinished();
  }

  async next(): Promise<void> {
    await this.refreshPlaylist(); // heal snapshot holes before choosing "next"
    if (this.index >= this.playlist.length - 1) {
      this.stop();

      return;
    }
    this.index++;
    await this.playCurrent();
  }

  /** Hard restart from the first narrated paragraph of the book. */
  async restartFromTop(): Promise<void> {
    if (this.playlist.length === 0) return;
    this.index = 0;
    await this.playCurrent();
  }

  async previous(): Promise<void> {
    // Within the first 3 seconds, prev = previous node; later it restarts the node.
    if (this.audio.currentTime > 3 || this.index <= 0) {
      this.audio.currentTime = 0;

      return;
    }
    await this.refreshPlaylist();
    this.index--;
    await this.playCurrent();
  }

  cycleSpeed(): number {
    const pos = SPEED_STEPS.indexOf(this.settings.speed);
    this.settings.speed = SPEED_STEPS[(pos + 1) % SPEED_STEPS.length] ?? 1;
    this.audio.playbackRate = this.settings.speed;
    saveAudioSettings(this.settings);

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

  // ── internals ──────────────────────────────────────────────────────

  private setState(state: PlayerState): void {
    this.state = state;
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

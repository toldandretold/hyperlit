// The centred bottom mini-player pill (#audio-player-bar in reader.blade.php,
// `.visible` toggles it). Appears ONLY while audio is playing or generating —
// never a permanent fixture. Pure view — state comes in through update
// methods; user intents go out through the handler object. While generating,
// the `.generating` class hides playback-only controls and the stop button
// doubles as Cancel.

export interface PlayerBarHandlers {
  onPlayPause: () => void;
  onStop: () => void;
  onSpeed: () => void;
  onHighlightToggle: () => void;
  onResumeFollow: () => void;
  onRegenerate: () => void;
}

export class PlayerBar {
  private bar: HTMLElement | null;

  private playPauseButton: HTMLButtonElement | null;

  private stopButton: HTMLButtonElement | null;

  private statusText: HTMLElement | null;

  private speedButton: HTMLButtonElement | null;

  private highlightButton: HTMLButtonElement | null;

  private followButton: HTMLButtonElement | null;

  private staleChip: HTMLButtonElement | null;

  /** [element, type, listener] triples for destroy() — the pill's DOM lives in
   *  the blade and persists across SPA navs, so listeners MUST be removed or
   *  every reader re-entry stacks another set (a double-fire makes toggles
   *  flip twice and look stuck). */
  private listeners: Array<[HTMLElement, string, EventListener]> = [];

  constructor(handlers: PlayerBarHandlers) {
    this.bar = document.getElementById('audio-player-bar');
    this.playPauseButton = this.bar?.querySelector('#audio-play-pause') ?? null;
    this.stopButton = this.bar?.querySelector('#audio-stop') ?? null;
    this.statusText = this.bar?.querySelector('#audio-status-text') ?? null;
    this.speedButton = this.bar?.querySelector('#audio-speed') ?? null;
    this.highlightButton = this.bar?.querySelector('#audio-highlight') ?? null;
    this.followButton = this.bar?.querySelector('#audio-resume-follow') ?? null;
    this.staleChip = this.bar?.querySelector('#audio-stale-chip') ?? null;

    this.listen(this.playPauseButton, handlers.onPlayPause);
    this.listen(this.stopButton, handlers.onStop);
    this.listen(this.speedButton, handlers.onSpeed);
    this.listen(this.highlightButton, handlers.onHighlightToggle);
    this.listen(this.followButton, handlers.onResumeFollow);
    this.listen(this.staleChip, handlers.onRegenerate);
  }

  private listen(el: HTMLElement | null, handler: () => void): void {
    if (!el) return;
    el.addEventListener('click', handler);
    this.listeners.push([el, 'click', handler]);
  }

  destroy(): void {
    for (const [el, type, listener] of this.listeners) {
      el.removeEventListener(type, listener);
    }
    this.listeners = [];
    this.hide();
  }

  show(): void {
    this.bar?.classList.add('visible');
  }

  hide(): void {
    this.bar?.classList.remove('visible');
  }

  setPlaying(playing: boolean): void {
    if (!this.playPauseButton) return;
    this.playPauseButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playPauseButton.classList.toggle('is-playing', playing);
  }

  /** Generation mode: playback controls hidden, stop button reads as Cancel. */
  setGenerating(generating: boolean): void {
    this.bar?.classList.toggle('generating', generating);
    this.stopButton?.setAttribute('aria-label', generating ? 'Cancel generation' : 'Stop');
  }

  setStatus(text: string): void {
    if (this.statusText) this.statusText.textContent = text;
  }

  setSpeed(speed: number): void {
    if (this.speedButton) this.speedButton.textContent = `${speed}×`;
  }

  setHighlightActive(active: boolean): void {
    this.highlightButton?.classList.toggle('active', active);
  }

  setFollowVisible(showResume: boolean): void {
    this.followButton?.classList.toggle('audio-hidden', !showResume);
  }

  setStale(staleNodes: number, price: string | null): void {
    if (!this.staleChip) return;
    if (staleNodes <= 0) {
      this.staleChip.classList.add('audio-hidden');

      return;
    }
    this.staleChip.classList.remove('audio-hidden');
    this.staleChip.textContent = price
      ? `Audio may be out of date · Update (${price})`
      : 'Audio may be out of date';
  }
}

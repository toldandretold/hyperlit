/**
 * Fake <audio> element for the PlaybackController specs.
 *
 * The load-bearing detail is the `src` setter: a REAL media element runs the
 * media load algorithm on assignment, and that algorithm sets playbackRate back
 * to defaultPlaybackRate. Reproducing it here is what makes the speed-continuity
 * spec a genuine regression test rather than a tautology — without it, the test
 * would pass against the buggy code too.
 *
 * happy-dom's own HTMLMediaElement can't decode anything and never fires
 * ended/error, so the controller is driven through this instead: the `_*`
 * methods are the test's hands on the media element.
 */
export class FakeAudio extends EventTarget {
  static instances = [];

  constructor() {
    super();
    this._src = '';
    this.preload = '';
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.currentTime = 0;
    this.duration = 10;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.networkState = 0;
    this.error = null;
    /** Swap to reject (NotAllowedError / AbortError / TypeError) or to hang. */
    this.playBehaviour = async () => {};
    this.srcHistory = [];
    this.playCalls = 0;
    FakeAudio.instances.push(this);
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = value;
    this.srcHistory.push(value);
    this.ended = false;
    this.error = null;
    this.readyState = 0;
    this.currentTime = 0;
    this.playbackRate = this.defaultPlaybackRate; // <-- the real load algorithm
    this.dispatchEvent(new Event('loadstart'));
  }

  getAttribute(name) {
    return name === 'src' ? this._src : null;
  }

  setAttribute(name, value) {
    if (name === 'src') this.src = value;
  }

  removeAttribute(name) {
    if (name === 'src') this._src = '';
  }

  load() {
    this.readyState = 0;
    this.playbackRate = this.defaultPlaybackRate;
    this.dispatchEvent(new Event('emptied'));
  }

  async play() {
    this.playCalls++;
    await this.playBehaviour(this);
    this.paused = false;
    this.readyState = 4;
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('playing'));
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  // ── test drivers ────────────────────────────────────────────────────

  /** Advance playback time and fire the heartbeat the watchdog listens for. */
  _tick(dt = 1) {
    this.currentTime += dt;
    this.dispatchEvent(new Event('timeupdate'));
  }

  _end() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('ended'));
  }

  /** MediaError codes: 1 aborted, 2 network, 3 decode, 4 unsupported. */
  _error(code = 2) {
    this.error = { code };
    this.networkState = 3;
    this.paused = true;
    this.dispatchEvent(new Event('error'));
  }

  _stall() {
    this.dispatchEvent(new Event('stalled'));
  }

  /** A pause nobody asked for — the OS, the tab, or audio-focus loss. */
  _osPause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  /**
   * Playback reached the end but the browser LOST the `ended` event. Per spec
   * ordering the element sets ended/paused first and then fires `pause`
   * followed by `ended` — so the controller's pause listener sees `ended`
   * already true and defers to an `ended` handler that will never run.
   */
  _endWithoutEndedEvent() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('pause'));
  }

  /**
   * A source the browser can't load (404, wrong content type, dead file).
   * A REAL element signals this TWICE — it fires `error` AND rejects the play()
   * promise — and the controller has to treat that as one failure, not two.
   */
  _failSource(code = 4) {
    this.playBehaviour = async (self) => {
      self.error = { code };
      self.networkState = 3;
      self.paused = true;
      self.dispatchEvent(new Event('error'));

      throw new DOMException('The element has no supported sources.', 'NotSupportedError');
    };
  }
}

/** Install as the global Audio constructor. Returns the uninstaller. */
export function installFakeAudio() {
  FakeAudio.instances.length = 0;
  const original = globalThis.Audio;
  globalThis.Audio = FakeAudio;

  return () => {
    globalThis.Audio = original;
  };
}

export function currentAudio() {
  return FakeAudio.instances.at(-1);
}

/** The controller branches on `instanceof DOMException` + `.name`, so a plain
 *  Error with a name won't exercise the right path. */
export function domException(name) {
  return new DOMException(`simulated ${name}`, name);
}

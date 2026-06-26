/**
 * scrolling/scrollTrace — a dormant, flag-gated diagnostic that makes "who scrolled the
 * reader, and what decided it?" answerable after the fact.
 *
 * Zero-import LEAF (imports nothing) so it can be reached statically/downward from any
 * scrolling or navigation module mid circular-import without landing in the Temporal Dead
 * Zone — same rule as navState.ts / currentLazyLoaderState.ts.
 *
 * Two producers feed ONE shared ring buffer on `window.__scrollTrace`:
 *   1. scroll-writes  — every programmatic write to the READER container's scroll position
 *      (its `scrollTo` and its `scrollTop` setter), captured per-instance (never on the
 *      global Element.prototype — that would be a perf + correctness hazard). Call sites may
 *      label themselves via nextScrollReason() so the smoking-gun writes (e.g. the
 *      fallback `scrollTo({top:0})`) are attributable without parsing stacks; unlabelled
 *      writes still record with reason:'' + a trimmed stack, so nothing is invisible.
 *   2. nav-decisions  — emitted by LinkNavigationHandler._handlePopstateInner: the decision
 *      INPUTS on entry, then which branch was taken before each return.
 *
 * Enable with `localStorage.setItem('hyperlit_scroll_trace','true')` then RELOAD (install is
 * gated at reader-init for zero production cost). Read with `window.__scrollTrace.dump()`.
 *
 * Everything is a no-op when the flag is off, so this ships dormant in the tree.
 */

const FLAG = 'hyperlit_scroll_trace';
const RING_CAP = 500;
const INSTALL_MARKER = '__scrollTraceInstalled';

export type ScrollTraceKind = 'scroll-write' | 'nav-decision';

export interface ScrollTraceEntry {
  kind: ScrollTraceKind;
  t: number; // performance.now()
  seq: number; // monotonic
  // scroll-write fields
  reason?: string;
  prevTop?: number;
  newTop?: number | null;
  via?: 'scrollTo' | 'scrollTop=' | 'scrollIntoView' | 'manual';
  stack?: string;
  // nav-decision fields are spread in freely (hash, branch, capturedStackDepth, …)
  [k: string]: unknown;
}

interface ScrollTraceStore {
  buffer: ScrollTraceEntry[];
  cap: number;
  seq: number;
  dump: (n?: number) => ScrollTraceEntry[];
  clear: () => void;
}

// One-shot semantic tag, consumed by the very next recorded scroll-write.
let pendingReason = '';

function w(): any {
  return typeof window !== 'undefined' ? (window as any) : null;
}

export function scrollTraceEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === 'true';
  } catch {
    return false;
  }
}

function store(): ScrollTraceStore | null {
  const win = w();
  if (!win) return null;
  if (!win.__scrollTrace) {
    const s: ScrollTraceStore = {
      buffer: [],
      cap: RING_CAP,
      seq: 0,
      dump(n?: number) {
        const out = typeof n === 'number' ? this.buffer.slice(-n) : this.buffer.slice();
        try {
          // Human convenience; harmless in e2e (the return value is what tests read).
          // eslint-disable-next-line no-console
          console.table(
            out.map((e) => ({
              seq: e.seq,
              t: Math.round(e.t),
              kind: e.kind,
              what: e.kind === 'scroll-write' ? `${e.via} ${e.reason || ''}`.trim() : e.branch ?? e.phase,
              detail: e.kind === 'scroll-write' ? `${e.prevTop}→${e.newTop}` : (e.hash ?? ''),
            }))
          );
        } catch { /* console.table unavailable */ }
        return out;
      },
      clear() {
        this.buffer.length = 0;
        this.seq = 0;
      },
    };
    win.__scrollTrace = s;
  }
  return win.__scrollTrace as ScrollTraceStore;
}

function push(entry: Partial<ScrollTraceEntry> & { kind: ScrollTraceKind }): void {
  const s = store();
  if (!s) return;
  const full: ScrollTraceEntry = {
    t: typeof performance !== 'undefined' ? performance.now() : 0,
    seq: ++s.seq,
    ...entry,
  } as ScrollTraceEntry;
  s.buffer.push(full);
  if (s.buffer.length > s.cap) s.buffer.shift();
}

/** Tag the NEXT recorded scroll-write with a semantic reason (consumed once). */
export function nextScrollReason(tag: string): void {
  if (!scrollTraceEnabled()) return;
  pendingReason = tag;
}

function trimStack(): string {
  try {
    const raw = new Error().stack || '';
    // Drop the Error line + this frame + the recorder frame; keep the next ~5 callers.
    return raw.split('\n').slice(3, 8).map((l) => l.trim()).join(' | ');
  } catch {
    return '';
  }
}

/** Record a programmatic scroll-write. `via:'manual'` lets a call site log a scroll it owns. */
export function recordScrollWrite(partial: { via: ScrollTraceEntry['via']; prevTop?: number; newTop?: number | null }): void {
  if (!scrollTraceEnabled()) return;
  const reason = pendingReason;
  pendingReason = '';
  push({ kind: 'scroll-write', reason, stack: trimStack(), ...partial });
}

/** Record a navigation decision (popstate inputs on entry, branch taken on exit). */
export function recordNavDecision(rec: Record<string, unknown>): void {
  if (!scrollTraceEnabled()) return;
  push({ kind: 'nav-decision', ...rec });
}

export function dumpScrollTrace(n?: number): ScrollTraceEntry[] {
  const s = store();
  return s ? s.dump(n) : [];
}

/**
 * Wrap a single reader container's scroll-write surface. Idempotent per element. Installs an
 * OWN accessor for `scrollTop` that shadows Element.prototype's (delegating get/set through
 * the prototype descriptor) and an OWN `scrollTo` that delegates to the prototype method —
 * recording on the way through. The global prototype is never touched.
 */
export function installScrollTrace(container: any): void {
  if (!container || !scrollTraceEnabled()) return;
  if (container[INSTALL_MARKER]) return;

  // --- scrollTop setter ---
  const protoDesc =
    Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') ||
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  if (protoDesc?.get && protoDesc.set) {
    const get = protoDesc.get;
    const set = protoDesc.set;
    try {
      Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get(this: any) {
          return get.call(this);
        },
        set(this: any, v: number) {
          const prev = get.call(this);
          recordScrollWrite({ via: 'scrollTop=', prevTop: prev, newTop: v });
          set.call(this, v);
        },
      });
    } catch { /* descriptor install failed — leave scrollTop untouched */ }
  }

  // --- scrollTo method ---
  const protoScrollTo = HTMLElement.prototype.scrollTo || (container.scrollTo as any);
  if (typeof protoScrollTo === 'function') {
    container.scrollTo = function (this: any, ...args: any[]) {
      let newTop: number | null = null;
      const opt = args[0];
      if (opt && typeof opt === 'object') newTop = typeof opt.top === 'number' ? opt.top : null;
      else if (typeof args[1] === 'number') newTop = args[1];
      const prev = (() => {
        try {
          return this.scrollTop;
        } catch {
          return undefined;
        }
      })();
      recordScrollWrite({ via: 'scrollTo', prevTop: prev, newTop });
      return (protoScrollTo as (...a: any[]) => any).apply(this, args);
    };
  }

  container[INSTALL_MARKER] = true;
}

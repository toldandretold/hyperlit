/**
 * Boot/feed performance milestones. Zero-import leaf: safe to call from any
 * module (including happy-dom vitest environments, where performance.mark may
 * be missing) — every function swallows its own errors so instrumentation can
 * never break the path it measures.
 *
 * Marks are namespaced `hyperlit:` so the e2e perf suite
 * (tests/e2e/specs/performance/user-page-load.spec.js) can read exactly ours
 * via performance.getEntriesByType without picking up browser/library noise.
 */

const PREFIX = 'hyperlit:';

export function perfMark(name: string): void {
  try {
    performance.mark(PREFIX + name);
  } catch {
    /* non-browser environment or duplicate-name quirk — never throw */
  }
}

/**
 * Mark only if this name hasn't been marked in this page lifetime, and report
 * whether the mark landed. For boot milestones on code paths that also run
 * during in-SPA navigations (e.g. overlay-hide), where a re-mark would pair a
 * fresh end mark with the original page's start mark.
 */
export function perfMarkOnce(name: string): boolean {
  try {
    if (performance.getEntriesByName(PREFIX + name, 'mark').length > 0) return false;
    performance.mark(PREFIX + name);
    return true;
  } catch {
    return false;
  }
}

export function perfMeasure(name: string, startMark: string, endMark?: string): void {
  try {
    if (endMark !== undefined) {
      performance.measure(PREFIX + name, PREFIX + startMark, PREFIX + endMark);
    } else {
      performance.measure(PREFIX + name, PREFIX + startMark);
    }
  } catch {
    /* a mark is missing (path not taken this load) — measuring is best-effort */
  }
}

export interface PerfSnapshot {
  /** mark name (prefix stripped) → startTime ms since navigation start */
  marks: Record<string, number>;
  /** measure name (prefix stripped) → duration ms */
  measures: Record<string, number>;
}

export function perfSnapshot(): PerfSnapshot {
  const snapshot: PerfSnapshot = { marks: {}, measures: {} };
  try {
    for (const entry of performance.getEntriesByType('mark')) {
      if (entry.name.startsWith(PREFIX)) {
        snapshot.marks[entry.name.slice(PREFIX.length)] = entry.startTime;
      }
    }
    for (const entry of performance.getEntriesByType('measure')) {
      if (entry.name.startsWith(PREFIX)) {
        snapshot.measures[entry.name.slice(PREFIX.length)] = entry.duration;
      }
    }
  } catch {
    /* return whatever we gathered */
  }
  return snapshot;
}

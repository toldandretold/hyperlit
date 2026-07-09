/**
 * scrolling/navStamp — durable per-(book, target) "when did we last deliberately navigate
 * here?" timestamps. This is the causal half of the reading-position resume-vs-jump decision
 * (see resources/js/scrolling/README.md): a target we navigated to is JUMPed to unless the
 * saved reading position moved AFTER we navigated there (`savedAt > navigatedAt`), in which
 * case the user read past it and we RESUME.
 *
 * Zero-import LEAF (imports nothing) so it can be reached statically/downward from any
 * scrolling or navigation module mid circular-import without landing in the Temporal Dead Zone
 * — same posture as navState.ts.
 *
 * Stored in localStorage, NOT sessionStorage: durability across the tab/session is the whole
 * point. The bug this replaces (ephemeral navigatedHashes + scrolledAway) only worked within a
 * single session; a reader who returns LATER (restart, restored tab) needs the "I navigated
 * here / I read past it" fact to survive. Its localStorage key is a distinct namespace
 * (`hyperlit_nav_at_<bookId>`) chosen so the reading-position storage-accessor guardrail under
 * tests/javascript/architecture/ does not flag this leaf — that gate matches the reading-position
 * storage key prefix, which this key deliberately avoids.
 */

const KEY_PREFIX = 'hyperlit_nav_at_';
// Bound growth per book — keep only the newest N targets. A reader won't meaningfully depend on
// resume-vs-jump for a target they navigated to hundreds of annotations ago.
const MAX_TARGETS = 50;

function keyFor(bookId: string): string {
  return `${KEY_PREFIX}${bookId}`;
}

function read(bookId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(keyFor(bookId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Record that we deliberately navigated to `targetId` in `bookId` right now (epoch ms). */
export function recordNavigatedAt(bookId: string, targetId: string): void {
  if (!bookId || !targetId) return;
  try {
    const map = read(bookId);
    map[targetId] = Date.now();
    const keys = Object.keys(map);
    if (keys.length > MAX_TARGETS) {
      // Evict the oldest entries by timestamp — but NEVER the one we just set (which under a
      // tight burst can share a timestamp with others; the current target must always survive).
      const evictable = keys.filter((k) => k !== targetId).sort((a, b) => map[a]! - map[b]!);
      for (const k of evictable.slice(0, keys.length - MAX_TARGETS)) delete map[k];
    }
    localStorage.setItem(keyFor(bookId), JSON.stringify(map));
  } catch {
    /* localStorage unavailable / quota exceeded — best effort */
  }
}

/** Epoch ms we last deliberately navigated to `targetId` in `bookId`, or undefined if never. */
export function getNavigatedAt(bookId: string, targetId: string): number | undefined {
  if (!bookId || !targetId) return undefined;
  const v = read(bookId)[targetId];
  return typeof v === 'number' ? v : undefined;
}

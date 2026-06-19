/**
 * saveQueue/types — shared shapes for the editor save queue + its integrity monitor.
 *
 * Zero runtime imports (type-only id imports are erased) so both index.ts and
 * integrityMonitor.ts can depend on it without forming a cycle.
 */
import type { LineId, DataNodeId, BookId } from '../../utilities/idHelpers';

// Debounce delays (in milliseconds)
// 🚀 PERFORMANCE: Increased delays for better batching and mobile performance
export const DEBOUNCE_DELAYS = {
  TYPING: 1500,       // Wait 1.5s after user stops typing (was 300ms)
  MUTATIONS: 1000,    // Wait 1s after mutations stop (was 300ms)
  SAVES: 1500,        // Wait 1.5s between save operations (was 500ms)
  BULK_SAVE: 2000,    // Wait 2s for bulk operations (was 1000ms)
  TITLE_SYNC: 500,
};

/** A debounced void function as produced by utilities/debounce (callable + cancel/flush). */
export type DebouncedVoidFn = (() => void) & { cancel: () => void; flush: () => void };

export interface PendingNode { id: LineId; action: string; bookId: BookId | null; }
export interface DeletionData { dataNodeId: DataNodeId | null; bookId: BookId; }
export interface PendingSaves {
  nodes: Map<LineId, PendingNode>;
  deletions: Set<LineId>;
  deletionMap?: Map<LineId, DeletionData>;
  lastActivity: number | null;
}

/**
 * The slice of SaveQueue that IntegrityMonitor reads/drives. Declaring it as an
 * interface keeps the coupling uni-directional (queue → monitor, no import cycle)
 * and explicit — the monitor only touches these members.
 */
export interface IntegritySurface {
  pendingSaves: PendingSaves;
  currentSavePromise: Promise<void> | null;
  _lastInputTimestamp: number;
  _destroyed: boolean;
  queueNode(id: LineId, action?: string, bookId?: BookId | null): void;
  flush(): Promise<void>;
}

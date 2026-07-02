/**
 * MutationProcessor Module
 *
 * Handles batching and processing of DOM mutations using requestAnimationFrame.
 * Queues mutations and processes them in batches to improve performance during
 * rapid typing or large paste operations.
 */

import { isPasteInProgress, isProgrammaticUpdateInProgress, hypercitePasteInProgress, keyboardLayoutInProgress } from "../utilities/operationState";
import { isChunkLoadingInProgress, getLoadingChunkId } from "../lazyLoader/utilities/chunkLoadingState";
import { getEditToolbar } from '../editToolbar/index';

interface MutationProcessorOptions {
  filterMutations?: (mutations: any[]) => any[];
  processMutations?: (mutations: any[]) => void | Promise<void>;
  shouldSkipMutation?: (mutations: any[]) => boolean;
  // Called when a paste/programmatic operation causes us to DROP a batch of mutations. The
  // drop itself is unchanged; this is a hook to schedule a structural safety-net (chunk
  // overflow sweep), because a programmatic insert can push a chunk past the limit and these
  // dropped mutations are never redelivered.
  onTransientSkip?: () => void;
}

/**
 * MutationProcessor class
 * Manages a queue of mutations and processes them in batches using RAF
 */
export class MutationProcessor {
  filterMutations: (mutations: any[]) => any[];
  processMutations: (mutations: any[]) => void | Promise<void>;
  shouldSkipMutation: (mutations: any[]) => boolean;
  onTransientSkip: () => void;
  queue: any[];
  rafId: number | null;

  constructor(options: MutationProcessorOptions = {}) {
    // Options
    this.filterMutations = options.filterMutations || ((mutations) => mutations);
    this.processMutations = options.processMutations || (() => {});
    this.shouldSkipMutation = options.shouldSkipMutation || (() => false);
    this.onTransientSkip = options.onTransientSkip || (() => {});

    // State
    this.queue = [];
    this.rafId = null;

    // Bind methods
    this.process = this.process.bind(this);
  }

  /**
   * Add mutations to the processing queue
   */
  enqueue(mutations: any[]): void {
    this.queue.push(...mutations);

    // If not already scheduled, schedule for next animation frame
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(this.process);
    }
  }

  /**
   * Process all queued mutations
   */
  async process(): Promise<void> {
    if (this.queue.length === 0) return;

    // Get all queued mutations
    const mutations = this.queue;
    this.queue = [];
    this.rafId = null;

    // Apply all the same filters as before
    if (isPasteInProgress()) {
      console.log("🚫 Skipping queued mutations: Paste operation is in control.");
      this.onTransientSkip(); // safety net: a paste may have overflowed a chunk (large paste self-chunks → no-op)
      return;
    }

    if (isProgrammaticUpdateInProgress()) {
      this.onTransientSkip();
      return;
    }

    if (hypercitePasteInProgress) {
      return;
    }

    if (isChunkLoadingInProgress()) {
      return;
    }

    const toolbar = getEditToolbar() as any;
    if (toolbar && toolbar.isFormatting) {
      return;
    }

    if (keyboardLayoutInProgress) {
      return;
    }

    if (this.shouldSkipMutation(mutations)) {
      return;
    }

    // Filter mutations (e.g., to only include chunk mutations)
    const filteredMutations = this.filterMutations(mutations);

    if (filteredMutations.length > 0) {
      await this.processMutations(filteredMutations);
    }
  }

  /**
   * Force immediate processing of queued mutations
   */
  flush(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.queue.length > 0) {
      this.process();
    }
  }

  /**
   * Cancel pending mutation processing and clear queue
   */
  cancel(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      console.log("🚀 Cancelled pending mutation processing");
    }

    if (this.queue.length > 0) {
      console.log(`🚀 Cleared ${this.queue.length} queued mutations`);
      this.queue = [];
    }
  }

  /**
   * Check if there are pending mutations
   */
  get hasPending(): boolean {
    return this.queue.length > 0 || this.rafId !== null;
  }

  /**
   * Cleanup and destroy
   */
  destroy(): void {
    this.cancel();
  }
}

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
import { verbose } from '../utilities/logger';

interface MutationProcessorOptions {
  filterMutations?: (mutations: any[]) => any[];
  processMutations?: (mutations: any[]) => void | Promise<void>;
  shouldSkipMutation?: (mutations: any[]) => boolean;
}

/**
 * MutationProcessor class
 * Manages a queue of mutations and processes them in batches using RAF
 */
export class MutationProcessor {
  filterMutations: (mutations: any[]) => any[];
  processMutations: (mutations: any[]) => void | Promise<void>;
  shouldSkipMutation: (mutations: any[]) => boolean;
  queue: any[];
  rafId: number | null;

  constructor(options: MutationProcessorOptions = {}) {
    // Options
    this.filterMutations = options.filterMutations || ((mutations) => mutations);
    this.processMutations = options.processMutations || (() => {});
    this.shouldSkipMutation = options.shouldSkipMutation || (() => false);

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
      return;
    }

    if (isProgrammaticUpdateInProgress()) {
      console.log("Skipping queued mutations: Programmatic update in progress.");
      return;
    }

    if (hypercitePasteInProgress) {
      console.log("Skipping queued mutations during hypercite paste");
      return;
    }

    if (isChunkLoadingInProgress()) {
      console.log(`Skipping queued mutations during chunk loading for chunk ${getLoadingChunkId()}`);
      return;
    }

    const toolbar = getEditToolbar() as any;
    if (toolbar && toolbar.isFormatting) {
      console.log("Skipping queued mutations during formatting");
      return;
    }

    if (keyboardLayoutInProgress) {
      console.log("Skipping queued mutations during keyboard layout adjustment");
      return;
    }

    if (this.shouldSkipMutation(mutations)) {
      console.log("Skipping queued mutations related to status icons");
      return;
    }

    // Filter mutations (e.g., to only include chunk mutations)
    const filteredMutations = this.filterMutations(mutations);

    if (filteredMutations.length > 0) {
      verbose.content(`Processing batch of ${filteredMutations.length} mutations`, 'divEditor/mutationProcessor.js');
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
      console.log('🚨 Flushing queued mutations');
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

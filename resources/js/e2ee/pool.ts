/**
 * Bounded-concurrency runner with per-item retry — the resilience primitive
 * behind every E2EE tree/image pass (docs/e2ee.md). A book can be HUNDREDS of
 * parts (each footnote/annotation is a `book/Fn…` sub-book) plus its images;
 * the pass must run in parallel, retry transient failures, and NOT abort the
 * whole transition because one part hiccupped (that left books falsely flagged
 * encrypted-but-plaintext, or decrypted-but-ciphertext). Returns the items that
 * STILL failed after all retries so the caller can decide (throw / repair).
 */

export type ProgressFn = (done: number, total: number) => void;

export async function runPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  opts: { concurrency?: number; retries?: number; onProgress?: ProgressFn } = {},
): Promise<T[]> {
  const { concurrency = 6, retries = 2, onProgress } = opts;
  const failures: T[] = [];
  const total = items.length;
  let idx = 0;
  let done = 0;

  const runner = async (): Promise<void> => {
    while (idx < total) {
      const item = items[idx++]!;
      let ok = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await worker(item);
          ok = true;
          break;
        } catch {
          /* retry */
        }
      }
      if (!ok) failures.push(item);
      onProgress?.(++done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) || 1 }, () => runner()));
  return failures;
}

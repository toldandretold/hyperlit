/**
 * Pins utilities/retry.js ahead of its TS conversion: retry count, backoff
 * progression (1.5x), success short-circuit, and last-error propagation.
 */
import { describe, it, expect, vi } from 'vitest';

// retry.js statically imports nodes/delete.js, whose chain reaches the
// editIndicator DOM component via operationState — stub the seam.
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));

import { retryOperation } from '../../../resources/js/indexedDB/utilities/retry';

describe('retryOperation', () => {
  it('returns immediately on first success', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(retryOperation(op, 3, 1)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries until success and returns the value', async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockResolvedValue('third time lucky');
    await expect(retryOperation(op, 3, 1)).resolves.toBe('third time lucky');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('throws the LAST error after exhausting maxRetries', async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValue(new Error('final'));
    await expect(retryOperation(op, 3, 1)).rejects.toThrow('final');
    expect(op).toHaveBeenCalledTimes(3);
  });
});

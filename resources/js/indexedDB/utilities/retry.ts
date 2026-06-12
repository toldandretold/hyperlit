/**
 * Retry Utilities Module
 * Generic retry logic with exponential backoff
 */

import { deleteIndexedDBRecord } from '../nodes/delete';

/**
 * Retry an operation with exponential backoff (delay × 1.5 per attempt)
 *
 * @throws the LAST error if all attempts fail
 */
export async function retryOperation<T>(
  operation: () => Promise<T> | T,
  maxRetries = 3,
  delay = 1000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`Operation failed (attempt ${attempt}/${maxRetries}):`, error);
      lastError = error;

      if (attempt < maxRetries) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
        // Increase delay for next attempt (exponential backoff)
        delay *= 1.5;
      }
    }
  }

  // If we get here, all retries failed
  console.error(`Operation failed after ${maxRetries} attempts:`, lastError);
  throw lastError;
}

/**
 * Delete an IndexedDB record with automatic retry
 * Wrapper around deleteIndexedDBRecord with retry logic
 */
export async function deleteIndexedDBRecordWithRetry(id: string | number): Promise<boolean> {
  return retryOperation(() => deleteIndexedDBRecord(id));
}

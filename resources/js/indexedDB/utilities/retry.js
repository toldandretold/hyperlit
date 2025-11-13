/**
 * Retry Utilities Module
 * Generic retry logic with exponential backoff
 */

import { deleteIndexedDBRecord } from '../nodes/delete.js';

/**
 * Retry an operation with exponential backoff
 *
 * @param {Function} operation - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} delay - Initial delay in milliseconds (default: 1000)
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} If all retries fail
 */
export async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  let lastError;

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
 *
 * @param {string|number} id - Node ID to delete
 * @returns {Promise<boolean>} Success status
 */
export async function deleteIndexedDBRecordWithRetry(id) {
  // Import deleteIndexedDBRecord dynamically to avoid circular dependency
  // deleteIndexedDBRecord already imported statically
  return retryOperation(() => deleteIndexedDBRecord(id));
}

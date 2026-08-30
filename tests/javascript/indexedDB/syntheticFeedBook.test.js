/**
 * isSyntheticFeedBook / isUserHomeVariantBook (indexedDB/core/utilities.ts) —
 * the ONE classifier for server-generated feed books. Guards two allowlists
 * that used to hardcode only the three homepage ids, letting shelf renders and
 * user-home sorted variants leak into the offline-books list and (worse) the
 * sync queue, where an edit landing on one would be pushed back to PostgreSQL
 * against a server-regenerated row:
 *   - getAllOfflineAvailableBooks (indexedDB/core/library.ts)
 *   - debouncedMasterSync          (indexedDB/syncQueue/master.ts)
 */
import { describe, it, expect } from 'vitest';
import { isSyntheticFeedBook, isUserHomeVariantBook } from '../../../resources/js/indexedDB/core/utilities';

describe('isSyntheticFeedBook', () => {
  it('matches the three cron-generated homepage feeds', () => {
    expect(isSyntheticFeedBook('most-recent')).toBe(true);
    expect(isSyntheticFeedBook('most-connected')).toBe(true);
    expect(isSyntheticFeedBook('most-lit')).toBe(true);
  });

  it('matches shelf renders in both owner and public forms', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(isSyntheticFeedBook(`shelf_${uuid}_connected`)).toBe(true);
    expect(isSyntheticFeedBook(`shelf_${uuid}_connected_pub`)).toBe(true);
    expect(isSyntheticFeedBook(`shelf_${uuid}_published_pub`)).toBe(true);
    expect(isSyntheticFeedBook(`shelf_${uuid}_manual`)).toBe(true);
  });

  it('matches user-home sorted variants for every visibility and sort', () => {
    expect(isSyntheticFeedBook('sam_public_connected')).toBe(true);
    expect(isSyntheticFeedBook('sam_private_lit')).toBe(true);
    expect(isSyntheticFeedBook('sam_all_title')).toBe(true);
    expect(isSyntheticFeedBook('sam_public_author')).toBe(true);
  });

  it('is anchored on the shelf uuid — a "shelf_"-prefixed username cannot false-positive', () => {
    expect(isSyntheticFeedBook('shelf_x_connected')).toBe(false);
    expect(isSyntheticFeedBook('shelf_life')).toBe(false);
  });

  it('leaves real books, usernames and home books alone', () => {
    expect(isSyntheticFeedBook('book_1773824629440')).toBe(false);
    expect(isSyntheticFeedBook('sam')).toBe(false);
    expect(isSyntheticFeedBook('samAll')).toBe(false);
    expect(isSyntheticFeedBook('samAccount')).toBe(false);
    // 'recent' never mints a sorted variant — it short-circuits to the base book
    expect(isSyntheticFeedBook('sam_public_recent')).toBe(false);
    expect(isSyntheticFeedBook('')).toBe(false);
    expect(isSyntheticFeedBook(null)).toBe(false);
    expect(isSyntheticFeedBook(undefined)).toBe(false);
  });
});

describe('isUserHomeVariantBook', () => {
  it('matches the three regenerated variants of the given base book', () => {
    expect(isUserHomeVariantBook('samAll', 'sam')).toBe(true);
    expect(isUserHomeVariantBook('samPrivate', 'sam')).toBe(true);
    expect(isUserHomeVariantBook('samAccount', 'sam')).toBe(true);
  });

  it('does NOT match the base book itself or another user\'s variants', () => {
    expect(isUserHomeVariantBook('sam', 'sam')).toBe(false);
    expect(isUserHomeVariantBook('alexAll', 'sam')).toBe(false);
  });

  it('is inert without a base book (not on a user page)', () => {
    expect(isUserHomeVariantBook('samAll', null)).toBe(false);
    expect(isUserHomeVariantBook('samAll', undefined)).toBe(false);
    expect(isUserHomeVariantBook(null, 'sam')).toBe(false);
  });
});

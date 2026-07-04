/**
 * Schema characterization — pins the IndexedDB schema produced by the REAL
 * upgrade path in core/connection.js (fresh install, oldVersion 0 → DB_VERSION).
 *
 * If this test fails you either bumped DB_VERSION / changed a store or index
 * on purpose (→ update the pinned snapshot below AND check the migration path
 * for existing users), or you changed it by accident (→ that's the catch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB } from './idbHarness.js';
import { openDatabase, DB_VERSION } from '../../../resources/js/indexedDB/core/connection';

describe('IndexedDB schema (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
  });

  it('opens MarkdownDB at the pinned version', async () => {
    const db = await openDatabase();
    expect(db.name).toBe('MarkdownDB');
    expect(db.version).toBe(DB_VERSION);
    expect(DB_VERSION).toBe(28);
  });

  it('creates exactly the pinned stores and indexes on a fresh install', async () => {
    const db = await openDatabase();

    const snapshot = {};
    for (const storeName of Array.from(db.objectStoreNames)) {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      const indexes = {};
      for (const indexName of Array.from(store.indexNames)) {
        const idx = store.index(indexName);
        indexes[indexName] = {
          keyPath: idx.keyPath,
          unique: idx.unique,
          multiEntry: idx.multiEntry,
        };
      }
      snapshot[storeName] = {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
      };
    }

    expect(snapshot).toEqual({
      nodes: {
        keyPath: ['book', 'startLine'],
        autoIncrement: false,
        indexes: {
          chunk_id: { keyPath: 'chunk_id', unique: false, multiEntry: false },
          book: { keyPath: 'book', unique: false, multiEntry: false },
          book_startLine: { keyPath: ['book', 'startLine'], unique: false, multiEntry: false },
          node_id: { keyPath: 'node_id', unique: false, multiEntry: false },
        },
      },
      footnotes: {
        keyPath: ['book', 'footnoteId'],
        autoIncrement: false,
        indexes: {
          book: { keyPath: 'book', unique: false, multiEntry: false },
          footnoteId: { keyPath: 'footnoteId', unique: false, multiEntry: false },
        },
      },
      bibliography: {
        keyPath: ['book', 'referenceId'],
        autoIncrement: false,
        indexes: {
          book: { keyPath: 'book', unique: false, multiEntry: false },
          referenceId: { keyPath: 'referenceId', unique: false, multiEntry: false },
          source_id: { keyPath: 'source_id', unique: false, multiEntry: false },
        },
      },
      markdownStore: {
        keyPath: ['url', 'book'],
        autoIncrement: false,
        indexes: {},
      },
      hyperlights: {
        keyPath: ['book', 'hyperlight_id'],
        autoIncrement: false,
        indexes: {
          hyperlight_id: { keyPath: 'hyperlight_id', unique: false, multiEntry: false },
          book: { keyPath: 'book', unique: false, multiEntry: false },
          book_startLine: { keyPath: ['book', 'startLine'], unique: false, multiEntry: false },
          // multiEntry: a highlight spanning N nodes is indexed once per node_id
          node_id: { keyPath: 'node_id', unique: false, multiEntry: true },
        },
      },
      hypercites: {
        keyPath: ['book', 'hyperciteId'],
        autoIncrement: false,
        indexes: {
          hyperciteId: { keyPath: 'hyperciteId', unique: false, multiEntry: false },
          book: { keyPath: 'book', unique: false, multiEntry: false },
          book_startLine: { keyPath: ['book', 'startLine'], unique: false, multiEntry: false },
          node_id: { keyPath: 'node_id', unique: false, multiEntry: true },
        },
      },
      library: {
        keyPath: 'book',
        autoIncrement: false,
        indexes: {},
      },
      historyLog: {
        keyPath: 'id',
        autoIncrement: true,
        indexes: {
          status: { keyPath: 'status', unique: false, multiEntry: false },
          bookId: { keyPath: 'bookId', unique: false, multiEntry: false },
        },
      },
      // v28: persisted non-extractable vault CryptoKey (resources/js/e2ee/keys.ts)
      e2ee: {
        keyPath: 'id',
        autoIncrement: false,
        indexes: {},
      },
    });
  });
});

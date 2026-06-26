/**
 * Hypercite health-check engine. Verifies whether a given hypercite id still exists in a target
 * book's node / footnote / hyperlight content, checking IndexedDB first and falling back to
 * PostgreSQL. Returns `{ exists, chunkKey }`. Stand-alone from the render + management layers.
 */

import { openDatabase } from '../../indexedDB/index';
import { parseSubBookId } from '../../utilities/subBookIdHelper';

/**
 * Build the full-data API URL, handling sub-book IDs with slashes.
 * e.g. "book_X/FnY" → "/api/database-to-indexeddb/books/book_X/FnY/data"
 */
function buildBookDataUrl(bookId: any) {
  const slashIndex = bookId.indexOf('/');
  if (slashIndex !== -1) {
    const parentBook = bookId.substring(0, slashIndex);
    const subId = bookId.substring(slashIndex + 1);
    return `/api/database-to-indexeddb/books/${parentBook}/${subId}/data`;
  }
  return `/api/database-to-indexeddb/books/${bookId}/data`;
}

/**
 * Check if a hypercite exists in a specific book's nodes.
 * Searches for the hypercite ID in the content HTML (pasted citations appear as <a id="hypercite_xxx">).
 * @returns Promise<{exists: boolean, chunkKey: string|null}>
 */
export async function checkHyperciteExists(bookId: any, hyperciteId: any, contentType: any = 'node', contentItemId: any = null, subBookId: any = '', indexedDBOnly: any = false) {
  try {
    console.log(`🔍 Checking if hypercite ${hyperciteId} exists in book ${bookId} (type=${contentType}, itemId=${contentItemId})`);

    const db: any = await openDatabase();
    const idPattern = `id="${hyperciteId}"`;

    // --- Footnote check ---
    if (contentType === 'footnote' && contentItemId) {
      // Look up the specific footnote in IndexedDB
      const fnTx = db.transaction('footnotes', 'readonly');
      const fnStore = fnTx.objectStore('footnotes');
      const fnRequest = fnStore.get([bookId, contentItemId]);

      const footnote: any = await new Promise((resolve: any, reject: any) => {
        fnRequest.onsuccess = () => resolve(fnRequest.result);
        fnRequest.onerror = () => reject(fnRequest.error);
      });

      if (footnote && footnote.content && typeof footnote.content === 'string') {
        if (footnote.content.includes(idPattern)) {
          // Secondary check: is this footnote still active in the book?
          // Footnote DB records persist after deletion, so verify the footnoteId
          // is still referenced in at least one node's footnotes array
          const nodesTx = db.transaction('nodes', 'readonly');
          const nodesStore = nodesTx.objectStore('nodes');
          const bookIndex = nodesStore.index('book');
          const nodes: any = await new Promise((resolve: any, reject: any) => {
            const req = bookIndex.getAll(bookId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });

          const footnoteStillActive = nodes.some((node: any) =>
            node.footnotes?.some((fn: any) => {
              const id = typeof fn === 'string' ? fn : fn?.id;
              return id === contentItemId;
            })
          );

          if (!footnoteStillActive) {
            console.log(`⚠️ Hypercite found in footnote content but footnote ${contentItemId} is no longer active in any node`);
            return { exists: false, chunkKey: null };
          }

          console.log(`✅ Found hypercite ${hyperciteId} in active footnote ${contentItemId}`);
          return { exists: true, chunkKey: `${bookId}:footnote:${contentItemId}` };
        }
        // Footnote content doesn't contain the hypercite — fall through to sub-book check
      }

      // Check sub-book nodes in IndexedDB — guard by library visibility, not parent node references
      if (subBookId) {
        // Guard: skip if the book has been deleted
        const libCheckTx = db.transaction('library', 'readonly');
        const libCheckStore = libCheckTx.objectStore('library');
        const libRecord: any = await new Promise((resolve: any) => {
          const req = libCheckStore.get(bookId);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });

        if (libRecord && libRecord.visibility === 'deleted') {
          console.log(`⚠️ Book ${bookId} is deleted — skipping sub-book node check`);
        } else {
          console.log(`🔍 Checking sub-book nodes for ${subBookId}`);
          const fnSubBookTx = db.transaction('nodes', 'readonly');
          const fnSubBookStore = fnSubBookTx.objectStore('nodes');
          const fnSubBookIndex = fnSubBookStore.index('book');
          const fnSubBookNodes: any = await new Promise((resolve: any, reject: any) => {
            const req = fnSubBookIndex.getAll(subBookId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });

          console.log(`📚 Found ${fnSubBookNodes.length} sub-book nodes for footnote ${subBookId}`);

          for (const node of fnSubBookNodes) {
            if (node.content && typeof node.content === 'string' && node.content.includes(idPattern)) {
              console.log(`✅ Found hypercite ${hyperciteId} in footnote sub-book node (${subBookId})`);
              return { exists: true, chunkKey: `${bookId}:footnote:${contentItemId}` };
            }
          }
        }
      }

      // Fallback to PostgreSQL if not found in IndexedDB
      if (!indexedDBOnly) {
        console.log(`📡 Footnote not in IndexedDB, checking PostgreSQL for book ${bookId}`);
        try {
          const response: any = await fetch(buildBookDataUrl(bookId), {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
            },
            credentials: 'include'
          });

          if (response.ok) {
            const data: any = await response.json();
            const fnData = data.footnotes?.data;
            if (fnData && fnData[contentItemId]) {
              const fnContent = fnData[contentItemId];
              if (typeof fnContent === 'string' && fnContent.includes(idPattern)) {
                console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL footnote ${contentItemId}`);
                return { exists: true, chunkKey: `${bookId}:footnote:${contentItemId}` };
              }
            }

            // Check sub-book nodes in PostgreSQL (library deletion already guarded above)
            if (subBookId) {
              const subResponse: any = await fetch(buildBookDataUrl(subBookId), {
                method: 'GET',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
                },
                credentials: 'include'
              });

              if (subResponse.ok) {
                const subData: any = await subResponse.json();
                const pgFnSubBookNodes = subData.nodes || [];
                console.log(`📚 Found ${pgFnSubBookNodes.length} PostgreSQL sub-book nodes for footnote ${subBookId}`);
                for (const node of pgFnSubBookNodes) {
                  if (node.content && typeof node.content === 'string' && node.content.includes(idPattern)) {
                    console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL footnote sub-book node (${subBookId})`);
                    return { exists: true, chunkKey: `${bookId}:footnote:${contentItemId}` };
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error('Error fetching footnote from PostgreSQL:', error);
        }
      }

      console.log(`❌ Hypercite ${hyperciteId} not found in footnote ${contentItemId}`);
      return { exists: false, chunkKey: null };
    }

    // --- Hyperlight check ---
    if (contentType === 'hyperlight' && contentItemId) {
      // Define sub-book ID (needed for both IndexedDB and PostgreSQL paths)
      const hlSubBookId = subBookId || `${bookId}/${contentItemId}`;

      // Derive the hyperlight's actual book — may differ from bookId for nested hyperlights
      // e.g. HL inside a footnote: subBookId = "book_X/2/FnY/HL_Z" → hlBook = "book_X/FnY"
      let hlActualBook = bookId;
      let skipIndexedDBHLChecks = false;
      let parentFnId: any = null;
      let foundationBook: any = null;

      if (subBookId) {
        const parsed = parseSubBookId(subBookId);
        if (parsed.level >= 2 && parsed.parentItemId) {
          hlActualBook = `${parsed.foundation}/${parsed.parentItemId}`;
          parentFnId = parsed.parentItemId;
          foundationBook = parsed.foundation;

          // If this hyperlight is nested inside a footnote, verify the parent footnote is still active
          const fnCheckTx = db.transaction('nodes', 'readonly');
          const fnCheckStore = fnCheckTx.objectStore('nodes');
          const fnCheckIndex = fnCheckStore.index('book');
          const fnCheckNodes: any = await new Promise((resolve: any, reject: any) => {
            const req = fnCheckIndex.getAll(parsed.foundation);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });

          const parentFnStillActive = fnCheckNodes.some((node: any) =>
            node.footnotes?.some((fn: any) => {
              const id = typeof fn === 'string' ? fn : fn?.id;
              return id === parsed.parentItemId;
            })
          );

          if (!parentFnStillActive) {
            console.log(`⚠️ Parent footnote ${parsed.parentItemId} not found in IndexedDB — deferring to PostgreSQL`);
            skipIndexedDBHLChecks = true;
          }
        }
      }

      if (!skipIndexedDBHLChecks) {
        // Look up the specific hyperlight in IndexedDB
        const hlTx = db.transaction('hyperlights', 'readonly');
        const hlStore = hlTx.objectStore('hyperlights');
        const hlRequest = hlStore.get([hlActualBook, contentItemId]);

        const hyperlight: any = await new Promise((resolve: any, reject: any) => {
          hlRequest.onsuccess = () => resolve(hlRequest.result);
          hlRequest.onerror = () => reject(hlRequest.error);
        });

        // 1. Check annotation field (works for simple hyperlights that aren't sub-books)
        if (hyperlight && hyperlight.annotation && typeof hyperlight.annotation === 'string') {
          if (hyperlight.annotation.includes(idPattern)) {
            console.log(`✅ Found hypercite ${hyperciteId} in hyperlight ${contentItemId} annotation`);
            return { exists: true, chunkKey: `${bookId}:hyperlight:${contentItemId}` };
          }
        }

        // 2. Check sub-book nodes in IndexedDB — only if hyperlight record still exists
        // When a hyperlight's annotation becomes a sub-book, content is stored as nodes
        // under the sub-book ID — use the passed-in subBookId which handles all nesting depths
        if (hyperlight) {
          console.log(`🔍 Annotation check missed — checking sub-book nodes for ${hlSubBookId}`);

          const subBookTx = db.transaction('nodes', 'readonly');
          const subBookNodesStore = subBookTx.objectStore('nodes');
          const subBookIndex = subBookNodesStore.index('book');
          const subBookNodes: any = await new Promise((resolve: any, reject: any) => {
            const req = subBookIndex.getAll(hlSubBookId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });

          console.log(`📚 Found ${subBookNodes.length} sub-book nodes for ${hlSubBookId}`);

          for (const node of subBookNodes) {
            if (node.content && typeof node.content === 'string' && node.content.includes(idPattern)) {
              console.log(`✅ Found hypercite ${hyperciteId} in sub-book node (${hlSubBookId})`);
              return { exists: true, chunkKey: `${bookId}:hyperlight:${contentItemId}` };
            }
          }
        }
      }

      // 3. Fallback to PostgreSQL — check annotation and sub-book nodes
      if (!indexedDBOnly) {
        console.log(`📡 Not found in IndexedDB, checking PostgreSQL for book ${hlActualBook}`);
        try {
          const response: any = await fetch(buildBookDataUrl(hlActualBook), {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
            },
            credentials: 'include'
          });

          if (response.ok) {
            const data: any = await response.json();

            // If parent footnote check was skipped in IndexedDB, verify it in PostgreSQL first
            if (skipIndexedDBHLChecks && parentFnId && foundationBook) {
              // Fetch the foundation book data (not hlActualBook) to check parent footnote
              const fnPgResponse: any = await fetch(buildBookDataUrl(foundationBook), {
                method: 'GET',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
                },
                credentials: 'include'
              });

              if (!fnPgResponse.ok) {
                console.log(`⚠️ Failed to fetch foundation book ${foundationBook} from PostgreSQL`);
                return { exists: false, chunkKey: null };
              }

              const fnPgData: any = await fnPgResponse.json();
              const pgNodes = fnPgData.nodes || [];
              const parentFnActiveInPG = pgNodes.some((node: any) =>
                node.footnotes?.some((fn: any) => {
                  const id = typeof fn === 'string' ? fn : fn?.id;
                  return id === parentFnId;
                })
              );

              if (!parentFnActiveInPG) {
                console.log(`⚠️ Parent footnote ${parentFnId} not active in PostgreSQL either — hyperlight ${contentItemId} is disconnected`);
                return { exists: false, chunkKey: null };
              }
              console.log(`✅ Parent footnote ${parentFnId} confirmed active in PostgreSQL`);
            }

            // Check annotation field in PostgreSQL hyperlights
            const hyperlights = data.hyperlights || [];
            const match = hyperlights.find((hl: any) => hl.hyperlight_id === contentItemId);
            if (match && match.annotation && typeof match.annotation === 'string') {
              if (match.annotation.includes(idPattern)) {
                console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL hyperlight ${contentItemId}`);
                return { exists: true, chunkKey: `${bookId}:hyperlight:${contentItemId}` };
              }
            }

            // Check sub-book nodes in PostgreSQL data — only if hyperlight still exists
            if (match) {
              // Fetch sub-book data from its own endpoint (parent API doesn't return sub-book nodes)
              const subResponse: any = await fetch(buildBookDataUrl(hlSubBookId), {
                method: 'GET',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
                },
                credentials: 'include'
              });

              if (subResponse.ok) {
                const subData: any = await subResponse.json();
                const pgSubBookNodes = subData.nodes || [];
                console.log(`📚 Found ${pgSubBookNodes.length} PostgreSQL sub-book nodes for ${hlSubBookId}`);
                for (const node of pgSubBookNodes) {
                  if (node.content && typeof node.content === 'string' && node.content.includes(idPattern)) {
                    console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL sub-book node (${hlSubBookId})`);
                    return { exists: true, chunkKey: `${bookId}:hyperlight:${contentItemId}` };
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error('Error fetching hyperlight from PostgreSQL:', error);
        }
      }

      console.log(`❌ Hypercite ${hyperciteId} not found in hyperlight ${contentItemId}`);
      return { exists: false, chunkKey: null };
    }

    // --- Node check (default/existing behavior) ---
    const tx = db.transaction(['nodes'], 'readonly');
    const nodesStore = tx.objectStore('nodes');

    // Get all nodes for the book
    const bookIndex = nodesStore.index('book');
    const nodesRequest = bookIndex.getAll(bookId);

    const nodes: any = await new Promise((resolve: any, reject: any) => {
      nodesRequest.onsuccess = () => resolve(nodesRequest.result || []);
      nodesRequest.onerror = () => reject(nodesRequest.error);
    });

    console.log(`📚 Found ${nodes.length} chunks for book ${bookId} in IndexedDB`);

    // Search through all chunks' content for the hypercite ID in HTML
    // Pasted citations appear as: <a href="..." id="hypercite_xxx">
    // Check IndexedDB chunks first
    for (const chunk of nodes) {
      if (chunk.content && typeof chunk.content === 'string') {
        if (chunk.content.includes(idPattern)) {
          const chunkKey = `${bookId}:${chunk.startLine}`;
          console.log(`✅ Found hypercite ${hyperciteId} in IndexedDB chunk ${chunkKey}`);
          return { exists: true, chunkKey };
        }
      }
    }

    // If no chunks in IndexedDB or not found, fall back to PostgreSQL
    if (!indexedDBOnly && nodes.length === 0) {
      console.log(`📡 No chunks in IndexedDB, checking PostgreSQL for book ${bookId}`);

      try {
        const response: any = await fetch(buildBookDataUrl(bookId), {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
          },
          credentials: 'include'
        });

        if (!response.ok) {
          console.warn(`⚠️ Failed to fetch book data from PostgreSQL: ${response.status}`);
          return { exists: false, chunkKey: null };
        }

        const data: any = await response.json();
        const pgChunks = data.nodes || [];
        console.log(`📚 Found ${pgChunks.length} chunks for book ${bookId} in PostgreSQL`);

        // Search through PostgreSQL chunks
        for (const chunk of pgChunks) {
          if (chunk.content && typeof chunk.content === 'string') {
            if (chunk.content.includes(idPattern)) {
              const chunkKey = `${bookId}:${chunk.startLine}`;
              console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL chunk ${chunkKey}`);
              return { exists: true, chunkKey };
            }
          }
        }
      } catch (error) {
        console.error('Error fetching from PostgreSQL:', error);
      }
    }

    console.log(`❌ Hypercite ${hyperciteId} not found in book ${bookId}`);
    return { exists: false, chunkKey: null };

  } catch (error) {
    console.error('Error checking hypercite existence:', error);
    return { exists: false, chunkKey: null };
  }
}

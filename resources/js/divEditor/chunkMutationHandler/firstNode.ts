/**
 * Resolve the ID (startLine) of the FIRST node in a book by querying IndexedDB
 * and taking the lowest startLine. Used by the no-delete-id marker system when a
 * marked node is deleted (the marker is transferred to the book's first node).
 * Extracted from chunkMutationHandler (sub-book aware via bookId).
 */
import { getNodesFromIndexedDB } from '../../indexedDB/index';

export async function getFirstNodeIdForBook(bookId: any = null): Promise<string | null> {
  try {
    // Use provided bookId, or fall back to main content
    if (!bookId) {
      const mainContent = document.querySelector('.main-content');
      bookId = mainContent?.id || 'latest';
    }

    // Get all nodes for this book from IndexedDB
    const nodes = await getNodesFromIndexedDB(bookId);

    if (!nodes || nodes.length === 0) {
      console.warn('⚠️ No nodes found in IndexedDB for book:', bookId);
      return null;
    }

    // Find the node with the lowest startLine (first node in book)
    const firstNode = nodes.reduce((min: any, node: any) => {
      const minStart = parseFloat(min.startLine);
      const nodeStart = parseFloat(node.startLine);
      return nodeStart < minStart ? node : min;
    });

    return firstNode.startLine.toString();
  } catch (error) {
    console.error('❌ Error getting first node ID for book:', error);
    return null;
  }
}

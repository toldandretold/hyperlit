// Delete-book section (#delete-book-btn) inside Creator Tools: double-confirm,
// refresh CSRF, DELETE on the server first, then remove from IndexedDB and
// redirect to the owner's home. Takes the SourceContainerManager as `self`.
import { book } from '../../../app';
import { canUserEditBook, getAuthContextSync } from '../../../utilities/auth/index';

export async function handleDeleteBook(self: any) {
  // Re-check permissions
  const canEdit = await canUserEditBook(book);
  if (!canEdit) {
    alert("You don't have permission to delete this book.");
    return;
  }

  // First confirmation
  if (!confirm(`Delete "${book}" and all associated data?`)) return;

  // Second confirmation — spell out what's lost
  if (!confirm(
    'Are you sure? This will permanently delete:\n\n' +
    '- All book content (nodes, footnotes, references)\n' +
    '- The library record and citation data\n' +
    '- Any AI review results\n\n' +
    'This action cannot be undone.'
  )) return;

  const btn = self.container.querySelector("#delete-book-btn");
  if (btn) {
    btn.disabled = true;
    btn.style.cursor = 'not-allowed';
    btn.style.opacity = '0.6';
    btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Deleting...`;
  }

  try {
    // 1. Verify session is still valid & refresh CSRF
    const { refreshCsrfToken } = await import('../../../utilities/auth/index');
    const isAuthenticated = await refreshCsrfToken();
    if (!isAuthenticated) {
      throw new Error('Your session has expired. Please log in again.');
    }

    // 2. Delete from server first
    const csrfToken = (window as any).csrfToken || (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    const resp = await fetch(`/api/books/${encodeURIComponent(book)}`, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`${resp.status} ${txt}`);
    }

    // 3. Delete from IndexedDB only after server confirms
    const { deleteBookFromIndexedDB } = await import('../../../indexedDB/index');
    await deleteBookFromIndexedDB(book);

    console.log(`Book ${book} deleted successfully.`);

    // 4. Redirect to user home
    const authCtx = getAuthContextSync();
    const username = authCtx?.user?.username;
    window.location.href = username ? `/${encodeURIComponent(username)}` : '/';

  } catch (error: any) {
    console.error('Delete book failed:', error);
    alert('Failed to delete book: ' + error.message);
    if (btn) {
      btn.disabled = false;
      btn.style.cursor = 'pointer';
      btn.style.opacity = '1';
      btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          Delete Book`;
    }
  }
}

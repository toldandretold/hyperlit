// auth/crossTab.ts — logout + cross-tab / same-tab auth sync (BroadcastChannel).
// Was the logout + auth-state-listener portion of utilities/auth.js. Keeps its
// component/pageLoad imports DYNAMIC so this util doesn't statically depend on
// the editButton component / pageLoad bootstrap.
import { clearDatabase } from '../../indexedDB/index';
import { ensureAuthInitialized, refreshAuth, resetAuth, clearCurrentUser } from './session';

/**
 * Handles the full logout process.
 * Makes a POST request to the server's logout endpoint, then clears all local data.
 */
export async function logout() {
  try {
    const response = await fetch('/logout', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': (window as any).csrfToken
      },
    });
    if (!response.ok) console.error('Logout request failed.', response);
  } catch (error) {
    console.error('Error during logout fetch:', error);
  } finally {
    // Broadcast logout to other tabs BEFORE clearing local state
    broadcastAuthChange('logout');
    await clearCurrentUser(); // Wipes IndexedDB
    await clearBrowserCache(); // Wipes CacheStorage
    window.location.href = '/'; // Redirect to home for a fresh start
  }
}

/**
 * Clears all caches managed by the CacheStorage API.
 */
async function clearBrowserCache() {
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    } catch (error) {
      console.error('Error clearing browser caches:', error);
    }
  }
}

// ============================================================================
// CROSS-TAB AUTH SYNC
// Broadcasts auth changes to other tabs so they stay in sync
// ============================================================================

let authBroadcastChannel: any = null;

/**
 * Initialize listener for same-tab auth state changes
 * Updates UI based on page type without full reload (where possible)
 */
export function initializeAuthStateListener() {
  window.addEventListener('auth-state-changed', async (event: any) => {
    const { type, sameTab } = event.detail;

    // Only handle same-tab events here (cross-tab handled by broadcast listener)
    if (!sameTab) return;

    const pageType = document.body.getAttribute('data-page');
    console.log(`📡 Auth state changed (${type}) on ${pageType} page`);

    if (pageType === 'user') {
      // User page: reload to get fresh server-rendered delete buttons
      console.log('🔄 Reloading user page for fresh server-rendered content...');
      window.location.reload();

    } else if (pageType === 'reader') {
      // Reader page: update edit button permissions
      // With RLS, we need to ensure auth state is fully settled before making API calls
      console.log('🔄 Updating edit button permissions...');

      // If user is in edit mode and logging out, exit edit mode first
      if (type === 'logout' && (window as any).isEditing) {
        console.log('🔄 User was in edit mode, disabling edit mode on logout...');
        const { disableEditMode } = await import('../../components/editButton/index');
        // IDB was already wiped by clearDatabase() above and the content is on
        // the server — skip the flush + integrity sweep so we don't emit a false
        // "missingFromIDB" report (DOM nodes vs an emptied DB) on every logout.
        disableEditMode({ skipPersistence: true });
      }

      // Wait for any pending auth initialization to complete
      await ensureAuthInitialized();

      // Small delay to ensure server-side session is fully established
      // This is needed because RLS queries depend on session context being set
      await new Promise(resolve => setTimeout(resolve, 100));

      // After logout, check if user still has access to this book
      // If it's a private book they no longer have access to, show access denied
      if (type === 'logout') {
        const { book } = await import('../../app.js');
        if (book) {
          try {
            const response = await fetch(`/api/database-to-indexeddb/books/${encodeURIComponent(book)}/library`, {
              credentials: 'include'
            });
            if (response.status === 404 || response.status === 403) {
              // User no longer has access to this book
              console.log('🔒 User lost access to private book after logout');
              const { handlePrivateBookAccessDenied } = await import('../../pageLoad/index');
              handlePrivateBookAccessDenied(book);
              return; // Don't continue with edit button updates
            }
          } catch (error) {
            console.warn('Failed to check book access after logout:', error);
          }
        }
      }

      const { checkEditPermissionsAndUpdateUI } = await import('../../components/editButton/index');
      await checkEditPermissionsAndUpdateUI();
    }
    // Home page doesn't need special handling - no auth-dependent UI
  });

  console.log('📡 Auth state listener initialized');
}

export function initializeAuthBroadcastListener() {
  if (authBroadcastChannel) {
    console.log('📡 Auth broadcast listener already initialized');
    return; // Already initialized
  }

  console.log('📡 Initializing auth broadcast listener...');
  authBroadcastChannel = new BroadcastChannel('auth-sync');

  authBroadcastChannel.addEventListener('message', async (event: any) => {
    const { type, user, timestamp } = event.data;

    console.log(`📡 RECEIVED auth broadcast: ${type}`, event.data);

    if (type === 'login') {
      // Another tab logged in - refresh our auth state
      console.log('🔄 Another tab logged in, refreshing auth state...');
      await refreshAuth();

      // Update UI to reflect logged-in state
      // Dispatch a custom event that components can listen for
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: { type: 'login', user }
      }));

      // Reload the page to get fresh server-rendered content
      window.location.reload();

    } else if (type === 'logout') {
      // Another tab logged out - clear our state
      console.log('🔄 Another tab logged out, clearing state...');
      resetAuth();
      await clearDatabase();

      const pageType = document.body.getAttribute('data-page');
      console.log(`📡 Handling cross-tab logout on ${pageType} page`);

      if (pageType === 'user') {
        // User page: reload to refresh server-rendered delete buttons
        console.log('🔄 Reloading user page for fresh server-rendered content...');
        window.location.reload();

      } else if (pageType === 'reader') {
        // Reader page: update edit button permissions
        console.log('🔄 Updating edit button permissions...');
        const { checkEditPermissionsAndUpdateUI } = await import('../../components/editButton/index');
        await checkEditPermissionsAndUpdateUI();

      } else {
        // Home page or unknown: redirect to home for fresh start
        window.location.href = '/';
      }
    }
  });

  console.log('📡 Auth broadcast listener initialized successfully');
}

/**
 * Broadcast an auth change to other tabs
 * @param {'login' | 'logout'} type - The type of auth change
 * @param {Object|null} user - The user object (for login) or null (for logout)
 */
export function broadcastAuthChange(type: any, user: any = null) {
  console.log(`📡 Broadcasting auth change: ${type}`, user);

  if (!authBroadcastChannel) {
    console.log('📡 Creating new BroadcastChannel for sending');
    authBroadcastChannel = new BroadcastChannel('auth-sync');
  }

  authBroadcastChannel.postMessage({
    type,
    user,
    timestamp: Date.now()
  });

  console.log(`📡 Auth change broadcasted successfully: ${type}`);
}

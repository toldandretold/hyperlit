/**
 * Preferences sync module — bridges localStorage ↔ backend.
 *
 * Server-injected `window.__userPreferences` seeds localStorage on page load.
 * Changes are fire-and-forget POSTed back to the backend.
 */

const KEY_MAP = {
  theme:         'hyperlit_theme_preference',
  vibe_css:      'hyperlit_vibe_css',
  text_size:     'hyperlit_text_size',
  content_width: 'hyperlit_content_width',
  full_width:    'hyperlit_full_width',
};

// Queue to prevent concurrent POSTs from overwriting each other
let pendingUpdate = null;
let flushTimer = null;

/**
 * Seed localStorage from server-injected preferences.
 * Backend values always win when present.
 * Any localStorage values the server is missing get uploaded in a single batch.
 * Call once at boot, before initializeTheme().
 */
export function seedFromServer() {
  const prefs = window.__userPreferences;

  // No server data — either not logged in or first deploy.
  // If logged in (CSRF token present), upload any existing localStorage values.
  if (!prefs || typeof prefs !== 'object') {
    uploadMissingPreferences({});
    return;
  }

  // Server → localStorage: backend wins when key is present
  for (const [key, localKey] of Object.entries(KEY_MAP)) {
    if (!(key in prefs) || prefs[key] === null || prefs[key] === undefined) continue;

    const value = prefs[key];

    if (key === 'vibe_css') {
      localStorage.setItem(localKey, JSON.stringify(value));
    } else if (key === 'full_width') {
      if (value) {
        localStorage.setItem(localKey, 'true');
      } else {
        localStorage.removeItem(localKey);
      }
    } else {
      localStorage.setItem(localKey, String(value));
    }
  }

  // localStorage → server: upload any keys the server doesn't have yet
  uploadMissingPreferences(prefs);
}

/**
 * Check localStorage for preference values the server is missing and upload them.
 * Handles the migration case where values existed before backend persistence was added.
 */
function uploadMissingPreferences(serverPrefs) {
  const missing = {};

  for (const [key, localKey] of Object.entries(KEY_MAP)) {
    // Skip if server already has this key
    if (key in serverPrefs && serverPrefs[key] !== null && serverPrefs[key] !== undefined) continue;

    const localValue = localStorage.getItem(localKey);
    if (localValue === null) continue;

    if (key === 'vibe_css') {
      try {
        missing[key] = JSON.parse(localValue);
      } catch {
        continue;
      }
    } else if (key === 'full_width') {
      missing[key] = localValue === 'true';
    } else if (key === 'text_size' || key === 'content_width') {
      const num = parseInt(localValue, 10);
      if (!isNaN(num)) missing[key] = num;
    } else {
      missing[key] = localValue;
    }
  }

  if (Object.keys(missing).length > 0) {
    postPreferences(missing);
  }
}

/**
 * Fire-and-forget POST a preference to the backend.
 * Batches rapid successive calls into a single request to avoid race conditions.
 * @param {string} key - One of the ALLOWED_KEYS (theme, vibe_css, text_size, content_width, full_width)
 * @param {*} value - The value to save
 */
export function savePreference(key, value) {
  if (!pendingUpdate) pendingUpdate = {};
  pendingUpdate[key] = value;

  // Debounce: flush after a microtask so back-to-back calls batch together
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const payload = pendingUpdate;
      pendingUpdate = null;
      flushTimer = null;
      postPreferences(payload);
    }, 0);
  }
}

/**
 * Remove a preference key from the backend (sends null).
 * @param {string} key - The preference key to clear
 */
export function clearPreference(key) {
  savePreference(key, null);
}

/**
 * POST a preferences payload to the backend. Fire-and-forget.
 */
function postPreferences(payload) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrfToken) return;

  fetch('/api/user/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
      'Accept': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  }).catch(() => {
    // Fire-and-forget — don't block UI on failure
  });
}

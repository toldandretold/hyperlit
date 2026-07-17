/**
 * Preferences sync module — bridges localStorage ↔ backend.
 *
 * Server-injected `(window as any).__userPreferences` seeds localStorage on page load.
 * Changes are fire-and-forget POSTed back to the backend.
 *
 * Font size, content width, and reading mode are device-scoped (mobile vs
 * desktop) — pages mode is worth having on a wide screen but poor on a phone,
 * so Pages/Scroll must NOT sync across devices, exactly like text size.
 * Theme, vibe_css, and full_width are universal across devices.
 */

const DEVICE_CLASS = window.innerWidth <= 500 ? 'mobile' : 'desktop';

const UNIVERSAL_KEYS = {
  theme:     'hyperlit_theme_preference',
  vibe_css:  'hyperlit_vibe_css',
  full_width:'hyperlit_full_width',
  gate_filter: 'hyperlit_gate_filter',
};

const DEVICE_KEYS = {
  text_size:     'hyperlit_text_size',
  content_width: 'hyperlit_content_width',
  reading_mode:  'hyperlit_reading_mode',
};

// Queue to prevent concurrent POSTs from overwriting each other
let pendingUpdate: any = null;
let flushTimer: any = null;

/**
 * Return the backend key for a given preference.
 * Device-scoped keys get a _mobile / _desktop suffix.
 */
function backendKey(key: any) {
  if (key in DEVICE_KEYS) return `${key}_${DEVICE_CLASS}`;
  return key;
}

/**
 * Return the localStorage key for a given preference.
 */
function localKey(key: any) {
  return (UNIVERSAL_KEYS as any)[key] || (DEVICE_KEYS as any)[key] || null;
}

/**
 * Seed localStorage from server-injected preferences.
 * Backend values always win when present.
 * Any localStorage values the server is missing get uploaded in a single batch.
 * Call once at boot, before initializeTheme().
 */
export function seedFromServer() {
  const prefs = (window as any).__userPreferences;

  // No server data — either not logged in or first deploy.
  // If logged in (CSRF token present), upload any existing localStorage values.
  if (!prefs || typeof prefs !== 'object') {
    uploadMissingPreferences({});
    return;
  }

  // Server → localStorage: backend wins when key is present
  // Universal keys
  for (const [key, lsKey] of Object.entries(UNIVERSAL_KEYS)) {
    if (!(key in prefs) || prefs[key] === null || prefs[key] === undefined) continue;

    const value = prefs[key];

    if (key === 'vibe_css' || key === 'gate_filter') {
      localStorage.setItem(lsKey, JSON.stringify(value));
    } else if (key === 'full_width') {
      if (value) {
        localStorage.setItem(lsKey, 'true');
      } else {
        localStorage.removeItem(lsKey);
      }
    } else {
      localStorage.setItem(lsKey, String(value));
    }
  }

  // Device-scoped keys: prefer device-specific, fall back to legacy
  for (const [key, lsKey] of Object.entries(DEVICE_KEYS)) {
    const deviceKey = `${key}_${DEVICE_CLASS}`;
    const serverValue = prefs[deviceKey] ?? prefs[key] ?? null;

    if (serverValue === null || serverValue === undefined) continue;
    localStorage.setItem(lsKey, String(serverValue));
  }

  // localStorage → server: upload any keys the server doesn't have yet
  uploadMissingPreferences(prefs);
}

/**
 * Check localStorage for preference values the server is missing and upload them.
 * Handles the migration case where values existed before backend persistence was added.
 */
function uploadMissingPreferences(serverPrefs: any) {
  const missing: any = {};

  // Universal keys
  for (const [key, lsKey] of Object.entries(UNIVERSAL_KEYS)) {
    if (key in serverPrefs && serverPrefs[key] !== null && serverPrefs[key] !== undefined) continue;

    const localValue = localStorage.getItem(lsKey);
    if (localValue === null) continue;

    if (key === 'vibe_css' || key === 'gate_filter') {
      try {
        missing[key] = JSON.parse(localValue);
      } catch {
        continue;
      }
    } else if (key === 'full_width') {
      missing[key] = localValue === 'true';
    } else {
      missing[key] = localValue;
    }
  }

  // Device-scoped keys — upload under the device-specific backend key
  for (const [key, lsKey] of Object.entries(DEVICE_KEYS)) {
    const deviceKey = `${key}_${DEVICE_CLASS}`;
    if (deviceKey in serverPrefs && serverPrefs[deviceKey] !== null && serverPrefs[deviceKey] !== undefined) continue;

    const localValue = localStorage.getItem(lsKey);
    if (localValue === null) continue;

    // text_size / content_width are numeric; reading_mode is a string
    // ('scroll' | 'paginated') — upload it verbatim rather than dropping it.
    const num = parseInt(localValue, 10);
    missing[deviceKey] = String(num) === localValue ? num : localValue;
  }

  if (Object.keys(missing).length > 0) {
    // Defer: this runs at module-init, in the middle of the boot network
    // storm, and a mutation POST fired there can sit pending for MINUTES
    // (observed: the pages-mode e2e sweep's networkidle hang — the request is
    // sent but never completes). This is a non-urgent background
    // reconciliation; send it once the load storm is over.
    const send = () => postPreferences(missing);
    if (document.readyState === 'complete') {
      setTimeout(send, 1500);
    } else {
      window.addEventListener('load', () => setTimeout(send, 1500), { once: true });
    }
  }
}

/**
 * Fire-and-forget POST a preference to the backend.
 * Batches rapid successive calls into a single request to avoid race conditions.
 * Device-scoped keys are automatically suffixed with _mobile or _desktop.
 * @param {string} key - One of: theme, vibe_css, text_size, content_width, full_width
 * @param {*} value - The value to save
 */
export function savePreference(key: any, value: any) {
  if (!pendingUpdate) pendingUpdate = {};
  pendingUpdate[backendKey(key)] = value;

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
export function clearPreference(key: any) {
  savePreference(key, null);
}

/**
 * POST a preferences payload to the backend. Fire-and-forget.
 */
function postPreferences(payload: any) {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
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
  })
    .then(res => {
      if (!res.ok) {
        console.warn('[preferences] save failed:', res.status, res.statusText);
      }
    })
    .catch(err => {
      console.warn('[preferences] network error:', err.message);
    });
}

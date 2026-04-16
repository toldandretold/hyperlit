/**
 * VibeCSS module — localStorage + <style> injection + API call + vibe UI + gallery.
 * Follows containerCustomization.js pattern for style injection.
 */

import { savePreference, clearPreference } from '../utilities/preferences.js';

const VIBE_STORAGE_KEY = 'hyperlit_vibe_css';
const VIBE_PROMPT_KEY = 'hyperlit_vibe_prompt';
const VIBE_META_KEY = 'hyperlit_vibe_meta';
const STYLE_ELEMENT_ID = 'vibe-css-overrides';

// Glass panel selector — all containers that use --container-glass-bg
const GLASS_PANELS = '#toc-container, #source-container, #hyperlit-container, #newbook-container, .hyperlit-container-stacked, #user-container';

// Keys applied as direct CSS on specific selectors instead of :root variables.
// Each entry: { selector, property, compound? (extra declarations auto-added) }
const DIRECT_KEYS = {
  // Body background
  '--vibe-body-background':            { selector: 'body.theme-vibe', property: 'background' },
  '--vibe-body-background-size':       { selector: 'body.theme-vibe', property: 'background-size' },
  '--vibe-body-background-attachment': { selector: 'body.theme-vibe', property: 'background-attachment' },
  '--vibe-body-animation':             { selector: 'body.theme-vibe', property: 'animation' },

  // Readability strip on text column
  '--vibe-content-background':         { selector: '.main-content', property: 'background' },
  '--vibe-content-border-radius':      { selector: '.main-content', property: 'border-radius' },
  '--vibe-content-backdrop-filter':    { selector: '.main-content', property: 'backdrop-filter', compound: ['-webkit-backdrop-filter'] },
  '--vibe-content-box-shadow':         { selector: '.main-content', property: 'box-shadow' },

  // Heading effects — gradient text via compound
  '--vibe-heading-background':         { selector: 'body.theme-vibe h1, body.theme-vibe h2, body.theme-vibe h3', property: 'background', compound: ['background-clip: text', '-webkit-background-clip: text', '-webkit-text-fill-color: transparent'] },
  '--vibe-heading-text-shadow':        { selector: 'body.theme-vibe h1, body.theme-vibe h2, body.theme-vibe h3', property: 'text-shadow' },

  // Text and link glow
  '--vibe-text-shadow':                { selector: 'body.theme-vibe .main-content', property: 'text-shadow' },
  '--vibe-link-text-shadow':           { selector: 'body.theme-vibe .main-content a', property: 'text-shadow' },

  // Container glow — borders and shadows on glass panels
  '--vibe-container-border':           { selector: `body.theme-vibe :is(${GLASS_PANELS})`, property: 'border' },
  '--vibe-container-box-shadow':       { selector: `body.theme-vibe :is(${GLASS_PANELS})`, property: 'box-shadow' },
};

// ─── Storage & injection ───

/**
 * Read stored overrides from localStorage and inject them into a <style> element.
 * Groups overrides: CSS custom properties go into :root {},
 * direct keys go into their specific selectors.
 */
export function applyVibeCSS() {
  const overrides = getVibeCSS();
  if (!overrides) return;

  let styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  const varRules = [];
  // Map of selector → array of CSS declarations
  const selectorMap = {};

  for (const [prop, val] of Object.entries(overrides)) {
    const direct = DIRECT_KEYS[prop];
    if (direct) {
      const { selector, property, compound } = direct;
      if (!selectorMap[selector]) selectorMap[selector] = [];
      selectorMap[selector].push(`  ${property}: ${val};`);

      // Compound: extra declarations auto-added when the key is set
      if (compound) {
        for (const extra of compound) {
          if (extra.includes(':')) {
            // Full declaration like "background-clip: text"
            selectorMap[selector].push(`  ${extra};`);
          } else {
            // Property name only — mirror the same value (e.g. -webkit-backdrop-filter)
            selectorMap[selector].push(`  ${extra}: ${val};`);
          }
        }
      }
    } else {
      varRules.push(`  ${prop}: ${val};`);
    }
  }

  let css = '';
  if (varRules.length) {
    css += `:root {\n${varRules.join('\n')}\n}\n`;
  }
  for (const [selector, declarations] of Object.entries(selectorMap)) {
    css += `${selector} {\n${declarations.join('\n')}\n}\n`;
  }

  styleEl.textContent = css;
}

/**
 * Remove vibe overrides from the DOM (keeps localStorage).
 */
export function removeVibeCSS() {
  const styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (styleEl) styleEl.textContent = '';
}

/**
 * Clear vibe from both localStorage and DOM. Switches theme to dark.
 */
export function clearVibeCSS() {
  localStorage.removeItem(VIBE_STORAGE_KEY);
  localStorage.removeItem(VIBE_PROMPT_KEY);
  localStorage.removeItem(VIBE_META_KEY);
  clearPreference('vibe_css');
  removeVibeCSS();
  import('../utilities/themeSwitcher.js').then(m => m.switchTheme(m.THEMES.DARK));
}

/**
 * Returns stored overrides object or null.
 */
export function getVibeCSS() {
  try {
    const stored = localStorage.getItem(VIBE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if a vibe is saved in localStorage.
 */
export function hasVibeCSS() {
  return getVibeCSS() !== null;
}

/**
 * Returns the stored generation prompt or null.
 */
export function getVibePrompt() {
  return localStorage.getItem(VIBE_PROMPT_KEY);
}

// ─── Generation API ───

/**
 * POST prompt to backend; returns overrides object on success.
 */
async function submitVibeRequest(prompt) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrfToken) throw new Error('No CSRF token found');

  const response = await fetch('/api/vibe-css/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
      'Accept': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ prompt }),
  });

  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data.message || 'Vibe generation failed');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data.overrides;
}

/**
 * Lightweight balance pre-check.
 */
async function checkBalance() {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  try {
    const response = await fetch('/api/vibe-css/can-proceed', {
      headers: {
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken || '',
      },
      credentials: 'same-origin',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.canProceed === true;
  } catch {
    return false;
  }
}

// ─── Vibes Gallery API ───

function getHeaders() {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-CSRF-TOKEN': csrfToken || '',
  };
}

export async function fetchMyVibes() {
  const resp = await fetch('/api/vibes/mine', {
    headers: getHeaders(),
    credentials: 'same-origin',
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.vibes || [];
}

export async function saveVibe({ name, css_overrides, prompt, visibility, source_vibe_id, source_creator }) {
  const body = { name, css_overrides, prompt: prompt || null, visibility: visibility || 'private' };
  if (source_vibe_id) body.source_vibe_id = source_vibe_id;
  if (source_creator) body.source_creator = source_creator;
  const resp = await fetch('/api/vibes', {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(data.message || 'Failed to save vibe');
    err.status = resp.status;
    throw err;
  }
  return data.vibe;
}

export async function updateVibe(id, fields) {
  const resp = await fetch(`/api/vibes/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(fields),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Failed to update vibe');
  return data.vibe;
}

export async function deleteVibe(id) {
  const resp = await fetch(`/api/vibes/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
    credentials: 'same-origin',
  });
  if (!resp.ok) {
    const data = await resp.json();
    throw new Error(data.message || 'Failed to delete vibe');
  }
}

export async function fetchPublicVibes(offset = 0, sort = 'top') {
  const params = new URLSearchParams();
  if (offset) params.set('offset', offset);
  if (sort) params.set('sort', sort);
  const url = '/api/vibes/public' + (params.toString() ? '?' + params : '');
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    credentials: 'same-origin',
  });
  if (!resp.ok) return { vibes: [], hasMore: false };
  const data = await resp.json();
  return { vibes: data.vibes || [], hasMore: !!data.has_more };
}

// ─── Colour preview helper ───

const PREVIEW_KEYS = ['--color-primary', '--color-accent', '--color-background'];

function renderColourPreview(cssOverrides) {
  const dots = PREVIEW_KEYS
    .map(k => cssOverrides[k])
    .filter(Boolean)
    .slice(0, 3)
    .map(c => `<span class="vibe-card-dot" style="background:${c}"></span>`)
    .join('');
  return dots ? `<div class="vibe-card-preview">${dots}</div>` : '';
}

// ─── Gallery UI ───

/**
 * Render the vibe gallery inside a container.
 * @param {HTMLElement} container
 * @param {boolean} loggedIn - whether the user is authenticated
 * @param {object} callbacks - { onApply, onClose, onGenerate }
 */
export function showVibeGallery(container, loggedIn, callbacks) {
  const { onApply, onClose, onGenerate } = callbacks;
  const isLoggedIn = loggedIn;

  container.innerHTML = `
    <div class="vibe-gallery">
      <div class="vibe-gallery-tabs">
        ${isLoggedIn ? '<button class="vibe-tab active" data-tab="mine">My Vibes</button>' : ''}
        <button class="vibe-tab ${isLoggedIn ? '' : 'active'}" data-tab="public">Public Vibes</button>
        <div class="vibe-sort-toggle">
          <button class="vibe-sort-btn active" data-sort="top">Top</button>
          <button class="vibe-sort-btn" data-sort="new">New</button>
        </div>
      </div>
      <div class="vibe-gallery-content"></div>
      <div class="vibe-gallery-footer">
        <button type="button" class="vibe-submit-btn vibe-generate-btn">+ Generate New</button>
        <button type="button" class="vibe-cancel-btn vibe-gallery-close">Close</button>
      </div>
    </div>
  `;

  const gallery = container.querySelector('.vibe-gallery');
  const content = gallery.querySelector('.vibe-gallery-content');
  const tabs = gallery.querySelectorAll('.vibe-tab');
  const sortToggle = gallery.querySelector('.vibe-sort-toggle');
  const activeTab = () => gallery.querySelector('.vibe-tab.active')?.dataset.tab || 'public';

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadTab(tab.dataset.tab);
    });
  });

  // Close
  gallery.querySelector('.vibe-gallery-close').addEventListener('click', () => onClose());

  // Generate new
  gallery.querySelector('.vibe-generate-btn').addEventListener('click', () => {
    if (isLoggedIn) {
      onGenerate();
    } else {
      content.innerHTML = `
        <div class="vibe-status" style="opacity:1;">
          <a href="#" class="vibe-auth-link vibe-auth-login">Log in</a> or
          <a href="#" class="vibe-auth-link vibe-auth-register">register</a>
          to generate custom vibes.
        </div>
      `;
      content.querySelector('.vibe-auth-login')?.addEventListener('click', async (e) => {
        e.preventDefault();
        document.getElementById('settings-overlay')?.click();
        const { initializeUserContainer } = await import('./userContainer.js');
        const mgr = initializeUserContainer();
        if (mgr) mgr.showLoginForm();
      });
      content.querySelector('.vibe-auth-register')?.addEventListener('click', async (e) => {
        e.preventDefault();
        document.getElementById('settings-overlay')?.click();
        const { initializeUserContainer } = await import('./userContainer.js');
        const mgr = initializeUserContainer();
        if (mgr) mgr.showRegisterForm();
      });
    }
  });

  // Load initial tab
  loadTab(activeTab());

  async function loadTab(tab) {
    content.innerHTML = '<div class="vibe-status">Loading...</div>';
    // Dim toggle when not on public tab, but keep it visible to avoid layout shift
    sortToggle.style.opacity = tab === 'public' ? '' : '0.3';
    sortToggle.style.pointerEvents = tab === 'public' ? '' : 'none';

    if (tab === 'mine') {
      await loadMyVibes();
    } else {
      await loadPublicVibes();
    }
  }

  async function loadMyVibes() {
    try {
      const vibes = await fetchMyVibes();
      const activeOverrides = getVibeCSS();
      const canSave = vibes.length < 5;

      let html = '';

      // "Save Current" button if there's an active unsaved vibe
      if (activeOverrides && canSave) {
        const isSaved = vibes.some(v =>
          JSON.stringify(v.css_overrides) === JSON.stringify(activeOverrides)
        );
        if (!isSaved) {
          html += `
            <div class="vibe-save-prompt">
              <span>Active vibe is unsaved</span>
              <button type="button" class="vibe-submit-btn vibe-save-current-btn">Save Current</button>
            </div>
          `;
        }
      }

      if (vibes.length === 0 && !activeOverrides) {
        html += '<div class="vibe-status">No saved vibes yet. Generate one to get started!</div>';
      }

      vibes.forEach(v => {
        const isPublic = v.visibility === 'public';
        const isPulled = !!v.source_creator;
        html += `
          <div class="vibe-card" data-vibe-id="${v.id}">
            <div class="vibe-card-info">
              <span class="vibe-card-name">${escapeHtml(v.name)}</span>
              ${isPulled ? `<a href="/u/${encodeURIComponent(v.source_creator)}" class="vibe-card-creator vibe-auth-link">by ${escapeHtml(v.source_creator)}</a>` : ''}
              ${renderColourPreview(v.css_overrides)}
            </div>
            <div class="vibe-card-actions">
              <button type="button" class="vibe-submit-btn vibe-apply-btn" data-vibe-id="${v.id}">Apply</button>
              ${!isPulled ? `<button type="button" class="vibe-cancel-btn vibe-publish-btn" data-vibe-id="${v.id}">${isPublic ? 'Unpublish' : 'Publish'}</button>` : ''}
              <button type="button" class="vibe-reset-btn vibe-delete-btn" data-vibe-id="${v.id}">Delete</button>
            </div>
          </div>
        `;
      });

      if (!canSave && vibes.length >= 5) {
        html += '<div class="vibe-status">5/5 vibes saved. Delete one to make room.</div>';
      }

      content.innerHTML = html;
      bindMyVibeActions(vibes);
    } catch {
      content.innerHTML = '<div class="vibe-status">Failed to load vibes.</div>';
    }
  }

  function bindMyVibeActions(vibes) {
    // Save current
    const saveBtn = content.querySelector('.vibe-save-current-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        const meta = JSON.parse(localStorage.getItem(VIBE_META_KEY) || 'null');
        const name = meta?.name || prompt('Name your vibe:');
        if (!name) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Current';
          return;
        }

        try {
          await saveVibe({
            name: name.slice(0, 100),
            css_overrides: getVibeCSS(),
            prompt: getVibePrompt(),
            source_vibe_id: meta?.source_vibe_id || undefined,
            source_creator: meta?.source_creator || undefined,
          });
          loadTab('mine');
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Current';
          const msg = content.querySelector('.vibe-status') || document.createElement('div');
          msg.className = 'vibe-status';
          msg.textContent = err.message;
          if (!msg.parentNode) content.appendChild(msg);
        }
      });
    }

    // Apply buttons
    content.querySelectorAll('.vibe-apply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const vibe = vibes.find(v => v.id === btn.dataset.vibeId);
        if (vibe) applyVibeFromGallery(vibe.css_overrides, onApply, {
          name: vibe.name,
          source_vibe_id: vibe.source_vibe_id || undefined,
          source_creator: vibe.source_creator || undefined,
        });
      });
    });

    // Publish/unpublish buttons
    content.querySelectorAll('.vibe-publish-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const vibe = vibes.find(v => v.id === btn.dataset.vibeId);
        if (!vibe) return;
        btn.disabled = true;
        try {
          const newVis = vibe.visibility === 'public' ? 'private' : 'public';
          await updateVibe(vibe.id, { visibility: newVis });
          loadTab('mine');
        } catch {
          btn.disabled = false;
        }
      });
    });

    // Delete buttons
    content.querySelectorAll('.vibe-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await deleteVibe(btn.dataset.vibeId);
          loadTab('mine');
        } catch {
          btn.disabled = false;
        }
      });
    });
  }

  async function loadPublicVibes() {
    let allVibes = [];
    let currentOffset = 0;
    let currentSort = 'top';

    content.innerHTML = '';

    sortToggle.querySelectorAll('.vibe-sort-btn').forEach(btn => {
      // Remove old listeners by cloning
      const clone = btn.cloneNode(true);
      btn.replaceWith(clone);
    });

    sortToggle.querySelectorAll('.vibe-sort-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.sort === currentSort) return;
        currentSort = btn.dataset.sort;
        sortToggle.querySelectorAll('.vibe-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Reset state
        allVibes = [];
        currentOffset = 0;
        // Lock height to prevent layout shift during fetch
        content.style.minHeight = content.offsetHeight + 'px';
        content.innerHTML = '';
        await fetchAndRender(false);
        content.style.minHeight = '';
      });
    });

    async function fetchAndRender(append) {
      try {
        const { vibes, hasMore } = await fetchPublicVibes(currentOffset, currentSort);

        if (!append && vibes.length === 0) {
          content.innerHTML = '<div class="vibe-status">No public vibes yet. Be the first to publish!</div>';
          return;
        }

        if (append) {
          content.querySelector('.vibe-load-more')?.remove();
        } else {
          content.innerHTML = '';
        }

        const startIdx = allVibes.length;
        allVibes = allVibes.concat(vibes);
        currentOffset += vibes.length;

        vibes.forEach((v, i) => {
          const idx = startIdx + i;
          const card = document.createElement('div');
          card.className = 'vibe-card';
          card.innerHTML = `
            <div class="vibe-card-info">
              <span class="vibe-card-name">${escapeHtml(v.name)}</span>
              ${v.creator ? `<a href="/u/${encodeURIComponent(v.creator)}" class="vibe-card-creator vibe-auth-link">by ${escapeHtml(v.creator)}</a>` : ''}
              ${renderColourPreview(v.css_overrides)}
            </div>
            <div class="vibe-card-actions">
              <button type="button" class="vibe-submit-btn vibe-apply-public-btn" data-vibe-idx="${idx}">Apply</button>
              <button type="button" class="vibe-cancel-btn vibe-save-public-btn" data-vibe-idx="${idx}">Save</button>
            </div>
          `;
          content.appendChild(card);
        });

        if (hasMore) {
          const loadMoreBtn = document.createElement('button');
          loadMoreBtn.type = 'button';
          loadMoreBtn.className = 'vibe-submit-btn vibe-load-more';
          loadMoreBtn.textContent = 'Load More';
          loadMoreBtn.addEventListener('click', () => {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = 'Loading...';
            fetchAndRender(true);
          });
          content.appendChild(loadMoreBtn);
        }

        bindPublicVibeActions();
      } catch {
        if (!append) {
          content.innerHTML = '<div class="vibe-status">Failed to load public vibes.</div>';
        }
      }
    }

    function bindPublicVibeActions() {
      content.querySelectorAll('.vibe-apply-public-btn').forEach(btn => {
        // Skip already-bound buttons
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          const vibe = allVibes[parseInt(btn.dataset.vibeIdx, 10)];
          if (vibe) applyVibeFromGallery(vibe.css_overrides, onApply, {
            name: vibe.name,
            source_vibe_id: vibe.id,
            source_creator: vibe.creator,
          });
        });
      });

      content.querySelectorAll('.vibe-save-public-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', async () => {
          const vibe = allVibes[parseInt(btn.dataset.vibeIdx, 10)];
          if (!vibe) return;

          if (!isLoggedIn) {
            // Show auth prompt inline
            const msg = document.createElement('div');
            msg.className = 'vibe-status';
            msg.style.opacity = '1';
            msg.innerHTML = `
              <a href="#" class="vibe-auth-link vibe-auth-login">Log in</a> or
              <a href="#" class="vibe-auth-link vibe-auth-register">register</a>
              to save vibes.
            `;
            msg.querySelector('.vibe-auth-login')?.addEventListener('click', async (e) => {
              e.preventDefault();
              document.getElementById('settings-overlay')?.click();
              const { initializeUserContainer } = await import('./userContainer.js');
              const mgr = initializeUserContainer();
              if (mgr) mgr.showLoginForm();
            });
            msg.querySelector('.vibe-auth-register')?.addEventListener('click', async (e) => {
              e.preventDefault();
              document.getElementById('settings-overlay')?.click();
              const { initializeUserContainer } = await import('./userContainer.js');
              const mgr = initializeUserContainer();
              if (mgr) mgr.showRegisterForm();
            });
            // Insert message after the card
            btn.closest('.vibe-card').after(msg);
            return;
          }

          btn.disabled = true;
          btn.textContent = 'Saving...';

          try {
            await saveVibe({
              name: vibe.name,
              css_overrides: vibe.css_overrides,
              source_vibe_id: vibe.id,
              source_creator: vibe.creator,
            });
            btn.textContent = 'Saved!';
            setTimeout(() => {
              btn.textContent = 'Save';
              btn.disabled = false;
            }, 2000);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Save';
            if (err.status === 422) {
              // At 5/5 slots
              const msg = document.createElement('div');
              msg.className = 'vibe-status';
              msg.style.opacity = '1';
              msg.textContent = 'You have 5/5 vibes. Delete one to make room.';
              btn.closest('.vibe-card').after(msg);
            }
          }
        });
      });
    }

    fetchAndRender(false);
  }
}

/**
 * Apply a vibe from the gallery — copies overrides to localStorage + backend.
 */
function applyVibeFromGallery(cssOverrides, onApply, meta) {
  localStorage.setItem(VIBE_STORAGE_KEY, JSON.stringify(cssOverrides));
  if (meta) {
    localStorage.setItem(VIBE_META_KEY, JSON.stringify(meta));
  } else {
    localStorage.removeItem(VIBE_META_KEY);
  }
  savePreference('vibe_css', cssOverrides);
  applyVibeCSS();
  if (onApply) onApply();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── UI ───

/**
 * Show the Top Up UI in a container (insufficient funds).
 * Mirrors brainQuery.js 402 handler pattern.
 */
export function showTopUpUI(container, onCancel) {
  container.innerHTML = `
    <div class="vibe-query-section">
      <div class="vibe-title">Insufficient Balance</div>
      <p class="vibe-status">Top up your balance to generate a custom theme.</p>
      <div class="vibe-action-row">
        <a href="#" class="vibe-submit-btn vibe-topup-btn">Top Up Balance</a>
        <button type="button" class="vibe-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  const topUpBtn = container.querySelector('.vibe-topup-btn');
  const cancelBtn = container.querySelector('.vibe-cancel-btn');

  topUpBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const resp = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-XSRF-TOKEN': decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || ''),
        },
        credentials: 'include',
        body: JSON.stringify({ amount: 5, return_url: window.location.href }),
      });
      const d = await resp.json();
      if (d.checkout_url) window.location.href = d.checkout_url;
    } catch (err) {
      console.warn('Vibe: Top-up checkout failed:', err);
    }
  });

  cancelBtn.addEventListener('click', () => onCancel());
}

/**
 * Show the vibe text input UI.
 * @param {HTMLElement} container - The element to inject UI into
 * @param {Function} onComplete - Called after successful generation
 * @param {Function} onCancel - Called when user cancels
 */
export function showVibeInput(container, onComplete, onCancel) {
  const hasSaved = hasVibeCSS();

  container.innerHTML = `
    <div class="vibe-query-section">
      <div class="vibe-title">Describe your vibe</div>
      <div class="vibe-text-input" contenteditable="true" data-placeholder="e.g. neon green cyberpunk, warm sunset, ocean breeze..."></div>
      <div class="vibe-action-row">
        <button type="button" class="vibe-submit-btn">Generate</button>
        <button type="button" class="vibe-cancel-btn">Cancel</button>
        ${hasSaved ? '<button type="button" class="vibe-reset-btn">Reset</button>' : ''}
      </div>
      <div class="vibe-status" style="display:none;"></div>
    </div>
  `;

  const section = container.querySelector('.vibe-query-section');
  const textInput = section.querySelector('.vibe-text-input');
  const submitBtn = section.querySelector('.vibe-submit-btn');
  const cancelBtn = section.querySelector('.vibe-cancel-btn');
  const resetBtn = section.querySelector('.vibe-reset-btn');
  const statusEl = section.querySelector('.vibe-status');

  // Placeholder behaviour for contenteditable
  const updatePlaceholder = () => {
    if (!textInput.textContent.trim()) {
      textInput.classList.add('empty');
    } else {
      textInput.classList.remove('empty');
    }
  };
  textInput.classList.add('empty');
  textInput.addEventListener('input', updatePlaceholder);
  textInput.addEventListener('focus', updatePlaceholder);
  textInput.addEventListener('blur', updatePlaceholder);

  // Autofocus (desktop only)
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isMobile) {
    setTimeout(() => textInput.focus(), 150);
  }

  // Submit
  submitBtn.addEventListener('click', async () => {
    const promptText = textInput.textContent.trim();
    if (!promptText) return;

    // Disable inputs
    textInput.contentEditable = 'false';
    submitBtn.disabled = true;
    cancelBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';

    // Progressive status
    statusEl.style.display = 'block';
    statusEl.textContent = 'Generating your vibe...';
    const timers = [];
    timers.push(setTimeout(() => { statusEl.textContent = 'Crafting colour palette...'; }, 2000));
    timers.push(setTimeout(() => { statusEl.textContent = 'Almost there...'; }, 5000));

    try {
      const overrides = await submitVibeRequest(promptText);
      timers.forEach(t => clearTimeout(t));

      // Save to localStorage and backend
      localStorage.setItem(VIBE_STORAGE_KEY, JSON.stringify(overrides));
      localStorage.setItem(VIBE_PROMPT_KEY, promptText);
      localStorage.removeItem(VIBE_META_KEY);
      savePreference('vibe_css', overrides);

      // Apply immediately
      applyVibeCSS();

      onComplete();
    } catch (err) {
      timers.forEach(t => clearTimeout(t));

      if (err.status === 401) {
        statusEl.textContent = 'Session expired — please refresh the page.';
      } else if (err.status === 402) {
        // Switch to top-up UI
        showTopUpUI(container, onCancel);
        return;
      } else if (err.status === 504) {
        statusEl.textContent = 'The AI took too long. Please try again.';
      } else {
        statusEl.textContent = err.message || 'Something went wrong. Try again.';
      }

      // Re-enable inputs
      textInput.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
      if (resetBtn) resetBtn.style.display = '';
    }
  });

  // Cancel
  cancelBtn.addEventListener('click', () => onCancel());

  // Reset
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      clearVibeCSS();
      onCancel();
    });
  }
}

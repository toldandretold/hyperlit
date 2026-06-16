/**
 * VibeCSS gallery UI: the My Vibes / Public Vibes gallery rendered inside the
 * settings panel, with save/apply/publish/delete + pagination. Was showVibeGallery
 * (+ helpers) of components/vibeCSS.js.
 */
import { savePreference } from '../../../utilities/preferences';
import {
  getVibeCSS, getVibePrompt, applyVibeCSS,
  VIBE_STORAGE_KEY, VIBE_META_KEY,
} from './storage';
import { fetchMyVibes, saveVibe, updateVibe, deleteVibe, fetchPublicVibes } from './api';

// ─── Colour preview helper ───
const PREVIEW_KEYS = ['--color-primary', '--color-accent', '--color-background'];

function renderColourPreview(cssOverrides: any): string {
  const dots = PREVIEW_KEYS
    .map(k => cssOverrides[k])
    .filter(Boolean)
    .slice(0, 3)
    .map(c => `<span class="vibe-card-dot" style="background:${c}"></span>`)
    .join('');
  return dots ? `<div class="vibe-card-preview">${dots}</div>` : '';
}

function escapeHtml(str: any): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Apply a vibe from the gallery — copies overrides to localStorage + backend.
 */
function applyVibeFromGallery(cssOverrides: any, onApply: any, meta: any) {
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

/**
 * Render the vibe gallery inside a container.
 * @param container
 * @param loggedIn - whether the user is authenticated
 * @param callbacks - { onApply, onClose, onGenerate }
 */
export function showVibeGallery(container: any, loggedIn: boolean, callbacks: any) {
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
        <button type="button" class="vibe-submit-btn vibe-generate-btn">+ Generate ≈ 1¢</button>
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
  tabs.forEach((tab: any) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t: any) => t.classList.remove('active'));
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
      content.querySelector('.vibe-auth-login')?.addEventListener('click', async (e: any) => {
        e.preventDefault();
        document.getElementById('settings-overlay')?.click();
        const { initializeUserContainer } = await import('../../userButton/userButton');
        const mgr = initializeUserContainer();
        if (mgr) mgr.showLoginForm();
      });
      content.querySelector('.vibe-auth-register')?.addEventListener('click', async (e: any) => {
        e.preventDefault();
        document.getElementById('settings-overlay')?.click();
        const { initializeUserContainer } = await import('../../userButton/userButton');
        const mgr = initializeUserContainer();
        if (mgr) mgr.showRegisterForm();
      });
    }
  });

  // Load initial tab
  loadTab(activeTab());

  async function loadTab(tab: any) {
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
        const isSaved = vibes.some((v: any) =>
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

      vibes.forEach((v: any) => {
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

  function bindMyVibeActions(vibes: any[]) {
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
        } catch (err: any) {
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
    content.querySelectorAll('.vibe-apply-btn').forEach((btn: any) => {
      btn.addEventListener('click', () => {
        const vibe = vibes.find((v: any) => v.id === btn.dataset.vibeId);
        if (vibe) applyVibeFromGallery(vibe.css_overrides, onApply, {
          name: vibe.name,
          source_vibe_id: vibe.source_vibe_id || undefined,
          source_creator: vibe.source_creator || undefined,
        });
      });
    });

    // Publish/unpublish buttons
    content.querySelectorAll('.vibe-publish-btn').forEach((btn: any) => {
      btn.addEventListener('click', async () => {
        const vibe = vibes.find((v: any) => v.id === btn.dataset.vibeId);
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
    content.querySelectorAll('.vibe-delete-btn').forEach((btn: any) => {
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
    let allVibes: any[] = [];
    let currentOffset = 0;
    let currentSort = 'top';

    content.innerHTML = '';

    sortToggle.querySelectorAll('.vibe-sort-btn').forEach((btn: any) => {
      // Remove old listeners by cloning
      const clone = btn.cloneNode(true);
      btn.replaceWith(clone);
    });

    sortToggle.querySelectorAll('.vibe-sort-btn').forEach((btn: any) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.sort === currentSort) return;
        currentSort = btn.dataset.sort;
        sortToggle.querySelectorAll('.vibe-sort-btn').forEach((b: any) => b.classList.remove('active'));
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

    async function fetchAndRender(append: boolean) {
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

        vibes.forEach((v: any, i: number) => {
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
      content.querySelectorAll('.vibe-apply-public-btn').forEach((btn: any) => {
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

      content.querySelectorAll('.vibe-save-public-btn').forEach((btn: any) => {
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
            msg.querySelector('.vibe-auth-login')?.addEventListener('click', async (e: any) => {
              e.preventDefault();
              document.getElementById('settings-overlay')?.click();
              const { initializeUserContainer } = await import('../../userButton/userButton');
              const mgr = initializeUserContainer();
              if (mgr) mgr.showLoginForm();
            });
            msg.querySelector('.vibe-auth-register')?.addEventListener('click', async (e: any) => {
              e.preventDefault();
              document.getElementById('settings-overlay')?.click();
              const { initializeUserContainer } = await import('../../userButton/userButton');
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
          } catch (err: any) {
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

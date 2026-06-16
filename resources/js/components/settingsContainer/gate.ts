// Gate-filter sub-panel for the settings panel: replaces the panel's inner HTML
// with the gate UI (showGatePanel is defined locally below), persists choices to
// localStorage + backend + the book's library record, and reapplies annotations.
// Was _openGatePanel of settingsContainer.js. Takes the manager as `self`.
import { savePreference } from '../../utilities/preferences';

export async function _openGatePanel(self: any) {
  const container = document.getElementById('settings-container');
  if (!container) return;

  const savedHTML = container.innerHTML;

  const restorePanel = () => {
    container.innerHTML = savedHTML;
    self.syncSliderUI();
    self.updateButtonStates();
  };

  const { getGateSettings, getBookGateDefaults, setBookGateDefaults, reapplyAnnotationsWithGate } = await import('../utilities/gateFilter');
  const { canUserEditBook } = await import('../../utilities/auth/index');
  const currentSettings = getGateSettings();

  const bookId = (document.querySelector('.main-content') as any)?.id;
  const isOwner = bookId ? await canUserEditBook(bookId) : false;
  const bookGateDefaults = getBookGateDefaults();

  showGatePanel(container, currentSettings, {
    onApply: async (newSettings: any) => {
      // 1. Save to localStorage
      localStorage.setItem('hyperlit_gate_filter', JSON.stringify(newSettings));
      // 2. Sync to backend immediately
      savePreference('gate_filter', newSettings);
      // 3. Restore settings panel and close
      restorePanel();
      self.closeContainer();
      // 4. Re-fetch and reprocess annotations
      await reapplyAnnotationsWithGate();
    },
    onCancel: restorePanel,
    onSaveBookDefault: async (defaults: any) => {
      // 1. Update module cache
      setBookGateDefaults(defaults);

      // 2. Update IndexedDB library record + queue for sync
      if (bookId) {
        const { getLibraryObjectFromIndexedDB } = await import('../../indexedDB/core/library');
        const { openDatabase } = await import('../../indexedDB/index');
        const { queueForSync } = await import('../../indexedDB/syncQueue/queue');

        const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
        if (libraryRecord) {
          const originalRecord = structuredClone(libraryRecord);
          libraryRecord.gate_defaults = defaults;
          const db = await openDatabase();
          const tx = db.transaction('library', 'readwrite');
          tx.objectStore('library').put(libraryRecord);
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          queueForSync('library', bookId, 'update', libraryRecord, originalRecord, true);
        }
      }

      // 3. Close panel and reapply
      restorePanel();
      self.closeContainer();
      await reapplyAnnotationsWithGate();
    },
  }, { isOwner, bookGateDefaults });
}

function showGatePanel(container: any, currentSettings: any, callbacks: any, options: any = {}) {
  const { isOwner = false, bookGateDefaults = null } = options;

  // Working copy so we don't mutate until Apply
  const draft = {
    mode: currentSettings.mode,
    custom: { ...currentSettings.custom },
  };

  // What "Default" means for this book — book overrides or global hardcoded
  const defaultChecks = bookGateDefaults
    ? { hideAI: !!bookGateDefaults.hideAI, hideAnonymous: !!bookGateDefaults.hideAnonymous, hideNoAnnotation: !!bookGateDefaults.hideNoAnnotation }
    : { hideAI: true, hideAnonymous: false, hideNoAnnotation: true };

  // Visual checkbox state: in default/all/hideAll modes, show what those modes imply
  const visualChecks = draft.mode === 'default'
    ? defaultChecks
    : draft.mode === 'all'
      ? { hideAI: false, hideAnonymous: false, hideNoAnnotation: false }
      : draft.mode === 'hideAll'
        ? { hideAI: true, hideAnonymous: true, hideNoAnnotation: true }
        : draft.custom;

  // Owner on default tab: checkboxes are enabled so they can edit the book default
  const defaultEditable = isOwner && draft.mode === 'default';
  const optionsEnabled = draft.mode === 'custom' || defaultEditable;

  container.innerHTML = `
    <div class="gate-panel">
      <div class="gate-mode-selector">
        <button type="button" class="gate-mode-btn${draft.mode === 'default' ? ' active' : ''}" data-mode="default">Default</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'all' ? ' active' : ''}" data-mode="all">Show All</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'hideAll' ? ' active' : ''}" data-mode="hideAll">Hide All</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'custom' ? ' active' : ''}" data-mode="custom">Custom</button>
      </div>

      <div class="gate-options${optionsEnabled ? '' : ' disabled'}">
        <div class="gate-options-heading">Restrict highlights &amp; hypercites from:</div>
        <label class="gate-option">
          <input type="checkbox" data-key="hideAI" ${visualChecks.hideAI ? 'checked' : ''} ${!optionsEnabled ? 'disabled' : ''}>
          <span>AI (like citation review)</span>
        </label>
        <label class="gate-option">
          <input type="checkbox" data-key="hideAnonymous" ${visualChecks.hideAnonymous ? 'checked' : ''} ${!optionsEnabled ? 'disabled' : ''}>
          <span>Anonymous users</span>
        </label>
        <label class="gate-option">
          <input type="checkbox" data-key="hideNoAnnotation" ${visualChecks.hideNoAnnotation ? 'checked' : ''} ${!optionsEnabled ? 'disabled' : ''}>
          <span>Highlights with no annotation</span>
        </label>
      </div>

      <div class="gate-actions">
        ${isOwner && draft.mode === 'default' ? `
          <button type="button" class="vibe-submit-btn gate-save-book-default-btn">Save as Book Default</button>
          ${bookGateDefaults ? '<button type="button" class="vibe-cancel-btn gate-reset-book-default-btn">Reset to Global Default</button>' : ''}
        ` : ''}
        <button type="button" class="vibe-submit-btn gate-apply-btn">Apply</button>
        <button type="button" class="vibe-cancel-btn gate-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  // ── Wire up interactions ──

  const panel = container.querySelector('.gate-panel');

  // Mode selector
  panel.querySelectorAll('.gate-mode-btn').forEach((btn: any) => {
    btn.addEventListener('click', () => {
      draft.mode = btn.dataset.mode;
      // Update active button
      panel.querySelectorAll('.gate-mode-btn').forEach((b: any) => b.classList.remove('active'));
      btn.classList.add('active');

      // Update checkbox state based on mode
      const optionsDiv = panel.querySelector('.gate-options');
      const checkboxes = panel.querySelectorAll('.gate-option input[type="checkbox"]');

      const editable = draft.mode === 'custom' || (isOwner && draft.mode === 'default');

      if (editable) {
        optionsDiv.classList.remove('disabled');
        checkboxes.forEach((cb: any) => { cb.disabled = false; });
      } else {
        optionsDiv.classList.add('disabled');
        checkboxes.forEach((cb: any) => { cb.disabled = true; });
      }

      // Set checkbox values for the mode
      if (draft.mode === 'default') {
        panel.querySelector('[data-key="hideAI"]').checked = defaultChecks.hideAI;
        panel.querySelector('[data-key="hideAnonymous"]').checked = defaultChecks.hideAnonymous;
        panel.querySelector('[data-key="hideNoAnnotation"]').checked = defaultChecks.hideNoAnnotation;
      } else if (draft.mode === 'all') {
        checkboxes.forEach((cb: any) => { cb.checked = false; });
      } else if (draft.mode === 'hideAll') {
        checkboxes.forEach((cb: any) => { cb.checked = true; });
      }

      // Show/hide book default buttons
      const actionsDiv = panel.querySelector('.gate-actions');
      const existingSave = actionsDiv.querySelector('.gate-save-book-default-btn');
      const existingReset = actionsDiv.querySelector('.gate-reset-book-default-btn');
      if (existingSave) existingSave.remove();
      if (existingReset) existingReset.remove();

      if (isOwner && draft.mode === 'default') {
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'vibe-submit-btn gate-save-book-default-btn';
        saveBtn.textContent = 'Save as Book Default';
        saveBtn.addEventListener('click', () => {
          const flags = {
            hideAI: panel.querySelector('[data-key="hideAI"]').checked,
            hideAnonymous: panel.querySelector('[data-key="hideAnonymous"]').checked,
            hideNoAnnotation: panel.querySelector('[data-key="hideNoAnnotation"]').checked,
          };
          if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(flags);
        });
        actionsDiv.insertBefore(saveBtn, actionsDiv.firstChild);

        if (bookGateDefaults) {
          const resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.className = 'vibe-cancel-btn gate-reset-book-default-btn';
          resetBtn.textContent = 'Reset to Global Default';
          resetBtn.addEventListener('click', () => {
            if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(null);
          });
          saveBtn.after(resetBtn);
        }
      }
    });
  });

  // Checkbox changes
  panel.querySelectorAll('.gate-option input').forEach((cb: any) => {
    cb.addEventListener('change', () => {
      draft.custom[cb.dataset.key] = cb.checked;
    });
  });

  // Apply
  panel.querySelector('.gate-apply-btn').addEventListener('click', () => {
    // Sync checkbox state back for non-custom modes too (visual state)
    if (draft.mode === 'default') {
      draft.custom = { ...defaultChecks };
    } else if (draft.mode === 'all') {
      draft.custom = { hideAI: false, hideAnonymous: false, hideNoAnnotation: false };
    } else if (draft.mode === 'hideAll') {
      draft.custom = { hideAI: true, hideAnonymous: true, hideNoAnnotation: true };
    }
    callbacks.onApply(draft);
  });

  // Cancel
  panel.querySelector('.gate-cancel-btn').addEventListener('click', () => {
    callbacks.onCancel();
  });

  // Save as Book Default (owner only) — initial buttons wired here;
  // mode-switch handler creates new ones dynamically when switching back to default
  const saveDefaultBtn = panel.querySelector('.gate-save-book-default-btn');
  if (saveDefaultBtn) {
    saveDefaultBtn.addEventListener('click', () => {
      const flags = {
        hideAI: panel.querySelector('[data-key="hideAI"]').checked,
        hideAnonymous: panel.querySelector('[data-key="hideAnonymous"]').checked,
        hideNoAnnotation: panel.querySelector('[data-key="hideNoAnnotation"]').checked,
      };
      if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(flags);
    });
  }

  const resetDefaultBtn = panel.querySelector('.gate-reset-book-default-btn');
  if (resetDefaultBtn) {
    resetDefaultBtn.addEventListener('click', () => {
      if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(null);
    });
  }
}

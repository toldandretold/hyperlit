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
    self.syncControlsUI();
    self.updateButtonStates();
  };

  const { getGateSettings, getBookGateDefaults, setBookGateDefaults, reapplyAnnotationsWithGate, clearPinnedHypercites } = await import('../utilities/gateFilter');
  const { canUserEditBook } = await import('../../utilities/auth/index');
  const currentSettings = getGateSettings();

  const bookId = (document.querySelector('.main-content') as any)?.id;
  const isOwner = bookId ? await canUserEditBook(bookId) : false;
  const bookGateDefaults = getBookGateDefaults();

  await showGatePanel(container, currentSettings, {
    onApply: async (newSettings: any) => {
      // 1. Save to localStorage
      localStorage.setItem('hyperlit_gate_filter', JSON.stringify(newSettings));
      // 2. Sync to backend immediately
      savePreference('gate_filter', newSettings);
      // 3. An explicit gate change outranks earlier deep-link pins — without this,
      //    Hide All can never hide a once-visited hypercite (the pin re-exempts it
      //    server-side on every fetch). Re-following a link pins it again.
      clearPinnedHypercites();
      // 4. Restore settings panel and close
      restorePanel();
      self.closeContainer();
      // 5. Re-fetch and reprocess annotations
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

      // 3. Close panel and reapply (book-default saves are gate changes too — drop pins)
      clearPinnedHypercites();
      restorePanel();
      self.closeContainer();
      await reapplyAnnotationsWithGate();
    },
  }, { isOwner, bookGateDefaults });
}

// Which checkboxes each column shows (hideNoAnnotation is meaningless for hypercites).
const GATE_COLUMNS: Array<{ type: 'hyperlight' | 'hypercite'; title: string; keys: Array<{ key: string; label: string }> }> = [
  {
    type: 'hyperlight',
    title: 'Highlights',
    keys: [
      { key: 'hideAI', label: 'AI (like citation review)' },
      { key: 'hideAnonymous', label: 'Anonymous users' },
      { key: 'hideNoAnnotation', label: 'No annotation' },
    ],
  },
  {
    type: 'hypercite',
    title: 'Hypercites',
    keys: [
      // AI hypercites come from the AI Archivist (AiBrain), NOT citation review —
      // citation review only leaves highlights.
      { key: 'hideAI', label: 'AI (the Archivist)' },
      { key: 'hideAnonymous', label: 'Anonymous users' },
    ],
  },
];

async function showGatePanel(container: any, currentSettings: any, callbacks: any, options: any = {}) {
  const { isOwner = false, bookGateDefaults = null } = options;
  const { normalizeGateFlags, GLOBAL_DEFAULT_FLAGS } = await import('../utilities/gateFilter');

  // Working copy so we don't mutate until Apply — normalized to the per-type shape
  // (legacy flat customs from old localStorage apply to both columns).
  const draft: any = {
    mode: currentSettings.mode,
    custom: {
      hyperlight: normalizeGateFlags(currentSettings.custom, 'hyperlight'),
      hypercite: normalizeGateFlags(currentSettings.custom, 'hypercite'),
    },
  };

  // What "Default" means for this book, per type — book overrides or global per-type defaults
  const defaultChecks: any = bookGateDefaults
    ? {
        hyperlight: normalizeGateFlags(bookGateDefaults, 'hyperlight'),
        hypercite: normalizeGateFlags(bookGateDefaults, 'hypercite'),
      }
    : structuredClone(GLOBAL_DEFAULT_FLAGS);

  // Visual checkbox state per type: in default/all/hideAll modes, show what those modes imply
  const allFlags = (val: boolean) => ({
    hyperlight: { hideAI: val, hideAnonymous: val, hideNoAnnotation: val },
    hypercite: { hideAI: val, hideAnonymous: val, hideNoAnnotation: val },
  });
  const visualChecks: any = draft.mode === 'default'
    ? defaultChecks
    : draft.mode === 'all'
      ? allFlags(false)
      : draft.mode === 'hideAll'
        ? allFlags(true)
        : draft.custom;

  // Owner on default tab: checkboxes are enabled so they can edit the book default
  const defaultEditable = isOwner && draft.mode === 'default';
  const optionsEnabled = draft.mode === 'custom' || defaultEditable;

  const columnHtml = (col: typeof GATE_COLUMNS[number]) => `
        <div class="gate-options-col" data-type="${col.type}">
          <div class="gate-options-heading">${col.title}</div>
          ${col.keys.map(({ key, label }) => `
          <label class="gate-option">
            <input type="checkbox" data-type="${col.type}" data-key="${key}" ${visualChecks[col.type][key] ? 'checked' : ''} ${!optionsEnabled ? 'disabled' : ''}>
            <span>${label}</span>
          </label>`).join('')}
        </div>`;

  container.innerHTML = `
    <div class="gate-panel">
      <div class="gate-mode-selector">
        <button type="button" class="gate-mode-btn${draft.mode === 'default' ? ' active' : ''}" data-mode="default">Default</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'all' ? ' active' : ''}" data-mode="all">Show All</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'hideAll' ? ' active' : ''}" data-mode="hideAll">Hide All</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'custom' ? ' active' : ''}" data-mode="custom">Custom</button>
      </div>

      <div class="gate-options${optionsEnabled ? '' : ' disabled'}">
        <div class="gate-options-lede">Restrict from:</div>
        <div class="gate-options-columns">
          ${GATE_COLUMNS.map(columnHtml).join('')}
        </div>
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

  // Read the current checkbox state as the nested per-type flags object
  // (the shape written to settings.custom AND library.gate_defaults).
  const collectFlags = () => {
    const flags: any = {};
    for (const col of GATE_COLUMNS) {
      flags[col.type] = {};
      for (const { key } of col.keys) {
        flags[col.type][key] = !!panel.querySelector(`input[data-type="${col.type}"][data-key="${key}"]`)?.checked;
      }
    }
    return flags;
  };

  const setCheckboxes = (perType: any) => {
    for (const col of GATE_COLUMNS) {
      for (const { key } of col.keys) {
        const cb = panel.querySelector(`input[data-type="${col.type}"][data-key="${key}"]`);
        if (cb) cb.checked = !!perType[col.type][key];
      }
    }
  };

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
        setCheckboxes(defaultChecks);
      } else if (draft.mode === 'all') {
        setCheckboxes(allFlags(false));
      } else if (draft.mode === 'hideAll') {
        setCheckboxes(allFlags(true));
      } else {
        setCheckboxes(draft.custom);
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
          if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(collectFlags());
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

  // Checkbox changes — write into the per-type draft
  panel.querySelectorAll('.gate-option input').forEach((cb: any) => {
    cb.addEventListener('change', () => {
      draft.custom[cb.dataset.type][cb.dataset.key] = cb.checked;
    });
  });

  // Apply
  panel.querySelector('.gate-apply-btn').addEventListener('click', () => {
    // Sync checkbox state back for non-custom modes too (visual state)
    if (draft.mode === 'default') {
      draft.custom = structuredClone(defaultChecks);
    } else if (draft.mode === 'all') {
      draft.custom = allFlags(false);
    } else if (draft.mode === 'hideAll') {
      draft.custom = allFlags(true);
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
      if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(collectFlags());
    });
  }

  const resetDefaultBtn = panel.querySelector('.gate-reset-book-default-btn');
  if (resetDefaultBtn) {
    resetDefaultBtn.addEventListener('click', () => {
      if (callbacks.onSaveBookDefault) callbacks.onSaveBookDefault(null);
    });
  }
}

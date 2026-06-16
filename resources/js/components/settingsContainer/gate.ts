// Gate-filter sub-panel for the settings panel: replaces the panel's inner HTML
// with the gate UI (from ../gateFilter showGatePanel), persists choices to
// localStorage + backend + the book's library record, and reapplies annotations.
// Was _openGatePanel of settingsContainer.js. Takes the manager as `self`.
import { savePreference } from '../../utilities/preferences.js';

export async function _openGatePanel(self: any) {
  const container = document.getElementById('settings-container');
  if (!container) return;

  const savedHTML = container.innerHTML;

  const restorePanel = () => {
    container.innerHTML = savedHTML;
    self.syncSliderUI();
    self.updateButtonStates();
  };

  const { showGatePanel, getGateSettings, getBookGateDefaults, setBookGateDefaults, reapplyAnnotationsWithGate } = await import('../gateFilter.js');
  const { canUserEditBook } = await import('../../utilities/auth.js');
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

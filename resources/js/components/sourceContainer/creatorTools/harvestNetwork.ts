// Source Network Harvester section (#harvest-network-section /
// #harvest-network-btn) inside Creator Tools: "Import Knowledge Network".
// Flow: POST estimate (pure SQL, no cost) → confirmDialog with the numbers →
// POST trigger → poll /api/source-harvest/status until completed/failed →
// refresh the citations display (harvested texts surface automatically as
// canonical best-versions). Takes `self` (SourceContainerManager).
import { book } from '../../../app';
import { confirmDialog, alertDialog } from '../../dialog/dialog';
import { log } from '../../../utilities/logger';

const FILE = 'components/sourceContainer/creatorTools/harvestNetwork.ts';

const IDLE_LABEL_HTML = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="5" r="2"></circle><circle cx="5" cy="19" r="2"></circle><circle cx="19" cy="19" r="2"></circle>
    <line x1="12" y1="7" x2="6" y2="17"></line><line x1="12" y1="7" x2="18" y2="17"></line><line x1="7" y1="19" x2="17" y2="19"></line>
  </svg>
  Import Knowledge Network`;

export function loadHarvestSection(self: any) {
  const section = self.container.querySelector('#harvest-network-section');
  if (!section) return;

  section.innerHTML = `
      <button type="button" id="harvest-network-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
        ${IDLE_LABEL_HTML}
      </button>
      <p style="font-size: 11px; color: var(--color-text-faint); margin-top: 6px;">Fetch and import the open-access works this book cites, as verified source texts.</p>`;

  const btn = section.querySelector('#harvest-network-btn');
  if (btn) btn.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    self.handleHarvestNetwork();
  });

  // Restore in-progress state if a harvest is already running for this book
  // (panel reopened mid-run, or another tab kicked it off).
  fetch(`/api/source-harvest/running/${encodeURIComponent(book)}`, { credentials: 'include' })
    .then((resp) => (resp.ok ? resp.json() : null))
    .then((data) => {
      if (data?.harvest?.id) {
        self._harvestId = data.harvest.id;
        setHarvestButtonRunning(self, data.harvest.step_detail || 'Harvest in progress…');
        self.startHarvestPolling();
      }
    })
    .catch(() => { /* section stays idle; the trigger path re-checks server-side */ });
}

export async function handleHarvestNetwork(self: any) {
  const btn = self.container.querySelector('#harvest-network-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking citations…'; }

  try {
    const estResp = await fetch(`/api/library/${encodeURIComponent(book)}/harvest/estimate`, {
      method: 'POST',
      headers: postHeaders(),
      credentials: 'include',
    });
    if (!estResp.ok) {
      const err = await estResp.json().catch(() => ({}));
      throw new Error(err.message || `Estimate failed: ${estResp.status}`);
    }
    const est = await estResp.json();

    if (est.running?.id) {
      // Another tab beat us to it — just attach to the running harvest.
      self._harvestId = est.running.id;
      setHarvestButtonRunning(self, 'Harvest in progress…');
      self.startHarvestPolling();
      return;
    }

    const e = est.estimate || {};
    const lines = [
      `${e.eligible ?? 0} of ${e.resolved ?? 0} resolved citations are open access and fetchable now.`,
      e.unresolved ? `${e.unresolved} unresolved entries will be scanned first and may add more.` : null,
      e.already_harvested ? `${e.already_harvested} cited works are already in the library as verified versions.` : null,
      `Up to ${est.max_works} works will be fetched and imported this run.`,
    ].filter(Boolean);

    const confirmed = await confirmDialog({
      title: 'Import Knowledge Network',
      message: lines.join('\n\n'),
      confirmLabel: 'Start import',
    });
    if (!confirmed) {
      resetHarvestButton(self);
      return;
    }

    const trigResp = await fetch(`/api/library/${encodeURIComponent(book)}/harvest/trigger`, {
      method: 'POST',
      headers: postHeaders(),
      credentials: 'include',
    });
    if (!trigResp.ok) {
      const err = await trigResp.json().catch(() => ({}));
      throw new Error(err.message || `Trigger failed: ${trigResp.status}`);
    }
    const trig = await trigResp.json();

    self._harvestId = trig.harvest_id;
    setHarvestButtonRunning(self, 'Harvest queued…');
    self.startHarvestPolling();
    log.user('Source network harvest queued', FILE, { book, harvest: trig.harvest_id });
  } catch (error: any) {
    log.error('Harvest start failed', FILE, error);
    await alertDialog({ title: 'Import Knowledge Network', message: error?.message || 'Could not start the harvest.' });
    resetHarvestButton(self);
  }
}

export function startHarvestPolling(self: any, intervalMs = 10000) {
  self.stopHarvestPolling();
  self._harvestPollInterval = setInterval(() => {
    self.pollHarvestStatus();
  }, intervalMs);
}

export function stopHarvestPolling(self: any) {
  if (self._harvestPollInterval) {
    clearInterval(self._harvestPollInterval);
    self._harvestPollInterval = null;
  }
}

export async function pollHarvestStatus(self: any) {
  try {
    if (!self._harvestId) return;

    const resp = await fetch(`/api/source-harvest/status/${encodeURIComponent(self._harvestId)}`, {
      credentials: 'include',
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const harvest = data.harvest;
    if (!harvest) return;

    if (harvest.status === 'completed') {
      self.stopHarvestPolling();
      self._harvestId = null;
      resetHarvestButton(self);

      const c = harvest.counts || {};
      const imported = (c.assigned || 0) + (c.assigned_existing || 0);
      const summary = [
        `${imported} cited work${imported === 1 ? '' : 's'} imported as verified source texts.`,
        c.fetch_failed || c.ocr_failed ? `${(c.fetch_failed || 0) + (c.ocr_failed || 0)} could not be fetched or converted.` : null,
        c.capped ? `${c.capped} eligible works were over this run's limit — run again to continue.` : null,
        imported === 0 && !c.eligible ? 'No open-access fetchable works were found in the citations.' : null,
      ].filter(Boolean);

      await alertDialog({ title: 'Import Knowledge Network', message: summary.join('\n\n') });

      // New canonical links + versions exist — re-render the citations panel.
      self.refreshCitationDisplay?.();
    } else if (harvest.status === 'failed') {
      self.stopHarvestPolling();
      self._harvestId = null;
      resetHarvestButton(self);
      await alertDialog({
        title: 'Import Knowledge Network',
        message: 'Harvest failed: ' + (harvest.error || 'unknown error') + '\n\nRe-running is safe — finished works are kept.',
      });
    } else {
      setHarvestButtonRunning(self, harvest.step_detail || 'Harvest in progress…');
    }
  } catch (err: any) {
    // Transient poll misses are fine; the next tick retries.
    log.error('Harvest poll failed', FILE, err);
  }
}

function setHarvestButtonRunning(self: any, detail: string) {
  const btn = self.container.querySelector('#harvest-network-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.style.cursor = 'default';
  btn.textContent = detail;
}

function resetHarvestButton(self: any) {
  const btn = self.container.querySelector('#harvest-network-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.style.cursor = 'pointer';
  btn.innerHTML = IDLE_LABEL_HTML;
}

function postHeaders(): Record<string, string> {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  return { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken };
}

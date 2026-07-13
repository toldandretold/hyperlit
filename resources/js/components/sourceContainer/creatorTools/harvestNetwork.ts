// Source Network Harvester section (#harvest-network-section /
// #harvest-network-btn) inside Creator Tools: "Import Knowledge Network".
// Flow: POST estimate (pure SQL, no cost) → confirmDialog with the numbers →
// POST trigger → poll /api/source-harvest/status until completed/failed →
// refresh the citations display (harvested texts surface automatically as
// canonical best-versions). Takes `self` (SourceContainerManager).
import { book } from '../../../app';
import { alertDialog, choiceDialog, formDialog } from '../../dialog/dialog';
import { log } from '../../../utilities/logger';
import { getAuthContext, getAuthContextSync } from '../../../utilities/auth/session';
import { isLoggedIn } from '../../../utilities/auth/index';
import { promptLogin } from '../../../utilities/auth/promptLogin';
import { offerTopUp } from '../../../utilities/billing/topUp';
import { combineIcon } from './combineIcon';

const FILE = 'components/sourceContainer/creatorTools/harvestNetwork.ts';

const BUTTON_LABEL = 'Knowledge Commons Harvester';
const IDLE_LABEL_HTML = `${combineIcon(14)} <span>${BUTTON_LABEL}</span>`;

export function loadHarvestSection(self: any) {
  const section = self.container.querySelector('#harvest-network-section');
  if (!section) return;

  // Logged out → dim the button; a click routes to login (like the import flow).
  const dim = getAuthContextSync()?.isLoggedIn ? '' : ' opacity: 0.5;';
  section.innerHTML = `
      <button type="button" id="harvest-network-btn" style="width: 100%; padding: 8px 12px; font-size: var(--sc-13); color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;${dim}">
        ${IDLE_LABEL_HTML}
      </button>
      <p style="font-size: var(--sc-11); color: var(--color-text-faint); margin-top: 6px;">
        Fetch and import the open-access works that this text cites, and then repeat the process on those texts.
        <span class="harvest-info-toggle" tabindex="0" role="button" aria-label="What this does" aria-expanded="false" style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;border:1px solid rgba(239,141,52,0.5);font-size:var(--sc-10);vertical-align:middle;margin-left:2px;color:var(--hyperlit-orange);">?</span>
      </p>
      <div class="harvest-info-detail" style="display:none; font-size: var(--sc-11); line-height: 1.55; color: var(--color-text-faint); margin-top: 2px; padding: 8px 10px; border-left: 2px solid rgba(239,141,52,0.4); background: rgba(239,141,52,0.05); border-radius: 3px;">
        This reads the book's bibliography and footnotes, matches each citation to the real published work, then — for every cited work that is <strong>open access</strong> and legally fetchable — downloads it, converts it to a readable text, and adds it to the library as a verified source your citations link to. You choose how far to follow the network: just this book's citations, the works those cite, and so on — up to the whole reachable open-access web of sources. Every source it brings in is collected onto a shelf. Nothing behind a paywall is ever taken.
      </div>
      <div id="harvest-report-link" style="margin-top: 8px;"></div>`;

  const btn = section.querySelector('#harvest-network-btn');
  if (btn) btn.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    self.handleHarvestNetwork();
  });

  // Info "?" expandable (same pattern as the AI-review cost info toggle).
  const infoToggle: any = section.querySelector('.harvest-info-toggle');
  const infoDetail: any = section.querySelector('.harvest-info-detail');
  if (infoToggle && infoDetail) {
    const toggle = () => {
      const open = infoDetail.style.display !== 'none';
      infoDetail.style.display = open ? 'none' : 'block';
      infoToggle.setAttribute('aria-expanded', String(!open));
    };
    infoToggle.addEventListener('click', (e: any) => { e.stopPropagation(); toggle(); });
    infoToggle.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }

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

  // Persistent "See the yield report →" link for the book's latest finished
  // harvest (shared per book) — mirrors AI Review's "See Review" affordance.
  renderHarvestReportLink(self);
}

/** Fetch the book's latest finished harvest report + shelf and render a link. */
async function renderHarvestReportLink(self: any) {
  try {
    const resp = await fetch(`/api/source-harvest/latest/${encodeURIComponent(book)}`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json();
    const h = data?.harvest;
    const slot = self.container.querySelector('#harvest-report-link');
    if (!h?.report_book || !slot) return;

    const reportUrl = `/${encodeURIComponent(h.report_book)}`;
    const shelf = h.shelf;
    const shelfUrl = (shelf && shelf.creator)
      ? `/u/${encodeURIComponent(shelf.creator)}/shelf/${encodeURIComponent(shelf.slug)}`
      : null;
    slot.innerHTML = `<a href="${reportUrl}" style="color: var(--hyperlit-aqua, #4EACAE); text-decoration: underline; font-size: var(--sc-12);">See the yield report →</a>`
      + (shelfUrl ? ` <a href="${shelfUrl}" style="color: var(--hyperlit-aqua, #4EACAE); text-decoration: underline; font-size: var(--sc-12); margin-left: 10px;">View the shelf</a>` : '');
  } catch { /* best-effort */ }
}

export async function handleHarvestNetwork(self: any) {
  // Anonymous click → route to login (like the import flow), not a silent fail.
  if (!(await isLoggedIn())) {
    await self.closeContainer?.();
    await promptLogin();
    return;
  }

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

    const cost = est.cost || {};
    const isPremium = !!cost.is_premium;
    const estUser = Number(cost.estimated_user || 0);
    const perWork = Number(cost.per_work || 0);

    const context = [
      isPremium
        ? 'Each fetched work is OCR’d from its PDF — included in your plan.'
        : `Each fetched work is OCR’d from its PDF (~$${perWork.toFixed(2)} per work). Rough estimate for this run: ~$${estUser.toFixed(2)} — the real cost depends on page counts, so set a limit below.`,
      'How far should it follow the citation network?',
    ].filter(Boolean).join('\n\n');

    // Depth choice: 1 = only this book's citations; 2 = also the works those
    // cite; deeper; or unlimited. Plus, for pay-as-you-go users, an optional
    // hard spend cap (the harvest stops gracefully once reached).
    const result = await formDialog({
      title: BUTTON_LABEL,
      message: context,
      confirmLabel: 'Start harvest',
      cancelLabel: 'Cancel',
      radios: {
        selected: '1',
        options: [
          { value: '1', label: 'Just this book’s sources', description: 'Pull only the open-access works cited in this article.' },
          { value: '2', label: 'One level deeper', description: 'Also pull the open-access works cited in those articles.' },
          { value: '3', label: 'Three levels deep', description: 'Follow the citations three hops out.' },
          { value: 'unlimited', label: 'The whole commons', description: 'Keep following open-access citations outward until the network runs dry.' },
        ],
      },
      numberField: isPremium ? undefined : {
        label: 'Stop if spending reaches',
        prefix: '$',
        value: estUser > 0 ? estUser.toFixed(2) : '',
        placeholder: 'no limit',
        hint: 'Leave blank for no limit (your balance still applies). It stops once spending reaches this and lists any it didn’t get in the Source Yield Report — raise it and rerun to continue.',
      },
    });
    if (!result || !result.radio) {
      resetHarvestButton(self);
      return;
    }
    const depth = result.radio;
    const maxSpendRaw = (result.number || '').trim();
    const max_spend = maxSpendRaw === '' ? null : Math.max(0, Number(maxSpendRaw) || 0);

    const trigResp = await fetch(`/api/library/${encodeURIComponent(book)}/harvest/trigger`, {
      method: 'POST',
      headers: postHeaders(),
      credentials: 'include',
      body: JSON.stringify({ depth, max_spend }),
    });
    if (!trigResp.ok) {
      if (trigResp.status === 402) {
        // Out of funds → offer a Stripe top-up instead of a dead error.
        resetHarvestButton(self);
        await offerTopUp('Insufficient balance to harvest. Top up $5 to continue?');
        return;
      }
      const err = await trigResp.json().catch(() => ({}));
      throw new Error(err.message || `Trigger failed: ${trigResp.status}`);
    }
    const trig = await trigResp.json();

    self._harvestId = trig.harvest_id;
    setHarvestButtonRunning(self, 'Harvest queued…');
    self.startHarvestPolling();
    log.user('Source network harvest queued', FILE, { book, harvest: trig.harvest_id, depth });
  } catch (error: any) {
    log.error('Harvest start failed', FILE, error);
    await alertDialog({ title: BUTTON_LABEL, message: error?.message || 'Could not start the harvest.' });
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

    // Keep an open viz overlay live on every poll.
    if (self._harvestVizOpen) self.renderHarvestViz(harvest);

    if (harvest.status === 'completed' || harvest.status === 'cancelled') {
      self.stopHarvestPolling();
      self._harvestId = null;
      resetHarvestButton(self);

      const c = harvest.counts || {};
      const imported = (c.assigned || 0) + (c.assigned_existing || 0);
      const failed = harvest.failed_count || 0;
      const overBudget = c.skipped_over_budget || 0;
      const spent = Number(harvest.spend || 0);
      const summary = [
        harvest.status === 'cancelled' ? 'Harvest cancelled — here’s what completed first.' : null,
        `${imported} cited work${imported === 1 ? '' : 's'} imported as verified source texts.`,
        spent > 0 ? `Spent $${spent.toFixed(2)} on OCR this run.` : null,
        failed ? `${failed} couldn't be fetched — the Source Yield Report lists them so you can chase them by hand.` : null,
        overBudget ? `${overBudget} work${overBudget === 1 ? '' : 's'} went untried at your spending limit — raise it and run again to continue.` : null,
        c.capped ? `${c.capped} eligible works were over this run's limit — run again to continue.` : null,
        imported === 0 && !c.eligible ? 'No open-access fetchable works were found in the citations.' : null,
      ].filter(Boolean);

      // If the viz overlay is open it already shows the completion banner +
      // shelf/report links — don't stack a dialog on top of it.
      if (!self._harvestVizOpen) {
        const shelf = harvest.shelf;
        const shelfUrl = (shelf && shelf.creator)
          ? `/u/${encodeURIComponent(shelf.creator)}/shelf/${encodeURIComponent(shelf.slug)}`
          : null;
        const reportUrl = harvest.report_book ? `/${encodeURIComponent(harvest.report_book)}` : null;

        if (reportUrl || shelfUrl) {
          const options = [];
          if (reportUrl) options.push({ value: 'report', label: 'Read the yield report', description: 'What came home, and what to chase by hand.' });
          if (shelfUrl) options.push({ value: 'shelf', label: 'View the shelf', description: 'The harvested sources on your page.' });
          const choice = await choiceDialog({
            title: BUTTON_LABEL,
            message: summary.join('\n\n'),
            options,
            cancelLabel: 'Close',
          });
          if (choice === 'report' && reportUrl) window.location.href = reportUrl;
          else if (choice === 'shelf' && shelfUrl) window.location.href = shelfUrl;
        } else {
          await alertDialog({ title: BUTTON_LABEL, message: summary.join('\n\n') });
        }
      }

      // New canonical links + versions exist — re-render the citations panel.
      self.refreshCitationDisplay?.();
    } else if (harvest.status === 'failed') {
      self.stopHarvestPolling();
      self._harvestId = null;
      resetHarvestButton(self);
      if (!self._harvestVizOpen) {
        await alertDialog({
          title: BUTTON_LABEL,
          message: 'Harvest failed: ' + (harvest.error || 'unknown error') + '\n\nRe-running is safe — finished works are kept.',
        });
      }
    } else {
      setHarvestButtonRunning(self, harvest.step_detail || 'Harvest in progress…', harvest);
    }
  } catch (err: any) {
    // Transient poll misses are fine; the next tick retries.
    log.error('Harvest poll failed', FILE, err);
  }
}

function setHarvestButtonRunning(self: any, detail: string, harvest?: any) {
  const btn = self.container.querySelector('#harvest-network-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.style.cursor = 'default';
  btn.textContent = detail;
  ensureHarvestRunningRow(self, harvest);
}

function resetHarvestButton(self: any) {
  const btn = self.container.querySelector('#harvest-network-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.style.cursor = 'pointer';
  btn.innerHTML = IDLE_LABEL_HTML;
  self.container.querySelector('#harvest-running-row')?.remove();
}

/**
 * The running-state row under the button: a "See live progress" toggle that
 * opens the viz overlay, plus (for logged-in users) an "Email me when done"
 * opt-in. Idempotent — created once, wired once (mirrors ensureAiReviewLivePanel).
 */
function ensureHarvestRunningRow(self: any, harvest?: any) {
  const section = self.container.querySelector('#harvest-network-section');
  if (!section || section.querySelector('#harvest-running-row')) return;

  const row = document.createElement('div');
  row.id = 'harvest-running-row';
  row.style.cssText = 'margin-top: 8px; display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: var(--sc-12);';
  row.innerHTML = `
      <button type="button" id="harvest-viz-toggle" style="background: none; border: none; color: var(--hyperlit-aqua, #4EACAE); text-decoration: underline; cursor: pointer; padding: 0; font-size: var(--sc-12);">See live progress ▸</button>
      <span id="harvest-notify-slot"></span>
      <button type="button" id="harvest-cancel-btn" style="background: none; border: none; color: var(--hyperlit-orange, #EF8D34); text-decoration: underline; cursor: pointer; padding: 0; font-size: var(--sc-12);">Cancel harvest</button>`;
  section.appendChild(row);

  row.querySelector('#harvest-viz-toggle')?.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    self.openHarvestVizOverlay();
  });

  row.querySelector('#harvest-cancel-btn')?.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    cancelHarvest(self, row);
  });

  // "Email me when done" — logged-in owners only (anonymous users have no
  // email). Hide it entirely if this harvest already opted in.
  const slot = row.querySelector('#harvest-notify-slot');
  if (slot) {
    if (harvest?.notify_email) {
      slot.textContent = "We'll email you when it's done.";
      (slot as HTMLElement).style.color = 'var(--color-text-faint)';
    } else {
      getAuthContext().then((ctx) => {
        if (!ctx?.isLoggedIn || !self._harvestId) return;
        // Guard against a late resolve after the row was torn down.
        if (!self.container.querySelector('#harvest-notify-slot')) return;
        slot.innerHTML = `<button type="button" id="harvest-notify-btn" style="background: none; border: none; color: var(--hyperlit-aqua, #4EACAE); text-decoration: underline; cursor: pointer; padding: 0; font-size: var(--sc-12);">Email me when done</button>`;
        slot.querySelector('#harvest-notify-btn')?.addEventListener('click', (e: any) => {
          e.preventDefault();
          e.stopPropagation();
          requestHarvestEmail(self, slot as HTMLElement);
        });
      }).catch(() => { /* leave the toggle only */ });
    }
  }
}

async function cancelHarvest(self: any, row: HTMLElement) {
  const btn = row.querySelector('#harvest-cancel-btn') as HTMLButtonElement | null;
  if (!self._harvestId) return;
  if (btn) { btn.textContent = 'Cancelling…'; btn.disabled = true; btn.style.cursor = 'default'; }
  try {
    const resp = await fetch(`/api/source-harvest/${encodeURIComponent(self._harvestId)}/cancel`, {
      method: 'POST',
      headers: postHeaders(),
      credentials: 'include',
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      log.error('Harvest cancel failed', FILE, err);
      if (btn) { btn.textContent = 'Cancel harvest'; btn.disabled = false; btn.style.cursor = 'pointer'; }
      return;
    }
    // The runner stops at the next work boundary and finalizes; polling picks
    // up the 'cancelled' status and closes out the UI.
    if (btn) btn.textContent = 'Cancelling — finishing current work…';
  } catch (err: any) {
    log.error('Harvest cancel failed', FILE, err);
    if (btn) { btn.textContent = 'Cancel harvest'; btn.disabled = false; btn.style.cursor = 'pointer'; }
  }
}

async function requestHarvestEmail(self: any, slot: HTMLElement) {
  slot.textContent = 'Requesting…';
  try {
    const resp = await fetch(`/api/source-harvest/${encodeURIComponent(self._harvestId)}/notify`, {
      method: 'POST',
      headers: postHeaders(),
      credentials: 'include',
    });
    slot.textContent = resp.ok
      ? "We'll email you when done. You can close this tab."
      : ((await resp.json().catch(() => ({}))).message || 'Could not set up the email.');
  } catch {
    slot.textContent = 'Could not set up the email.';
  }
  slot.style.color = 'var(--color-text-faint)';
}

function postHeaders(): Record<string, string> {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  return { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken };
}

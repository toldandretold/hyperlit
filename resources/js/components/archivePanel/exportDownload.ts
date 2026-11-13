// One archive-export download button (markdown vault / SQLite) — a
// parameterized port of the audiobook button's state machine
// (sourceContainer/audiobookDownload.ts):
//   busy   — dimmed with a % readout while the server packages the artifact
//   ready  — press to download (Content-Disposition names the file)
// Server state comes from GET /api/archive-export/{scope}/status?kind=…,
// which mirrors the audiobook status contract.

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { drainResponse } from '../../utilities/drainResponse';

const BUSY_CLASS = 'is-busy';
const POLL_MS = 2000;
/** Stop polling a build that never reports progress rather than spinning forever. */
const MAX_POLLS = 900; // 30 minutes
/**
 * Consecutive unreadable status polls tolerated before the wait is abandoned.
 * A single failed read is ROUTINE during a minutes-long build — Safari kills
 * in-flight fetches when the tab is backgrounded or the phone locks ("Fetch
 * API cannot load … due to access control checks"), a deploy blips a 502, a
 * poll 429s — and used to end the wait silently: the button sat dimmed at its
 * last % forever and the finished artifact was never downloaded.
 */
const MAX_CONSECUTIVE_FAILURES = 30; // a minute of nothing but failures

export type ExportKind = 'markdown' | 'sqlite';

export interface ArchiveScope {
  scopeType: string;
  scopeId: string;
}

interface ExportStatus {
  state: 'unavailable' | 'buildable' | 'building' | 'ready';
  progress?: number;
  message?: string | null;
  bytes?: number;
}

export interface ExportDownloadHandle {
  destroy(): void;
}

function apiBase(scope: ArchiveScope): string {
  return `/api/archive-export/${encodeURIComponent(scope.scopeType)}/${encodeURIComponent(scope.scopeId)}`;
}

async function fetchStatus(scope: ArchiveScope, kind: ExportKind): Promise<ExportStatus | null> {
  try {
    const resp = await fetch(`${apiBase(scope)}/status?kind=${kind}`, { credentials: 'include' });
    if (!resp.ok) {
      await drainResponse(resp);

      return null;
    }

    return (await resp.json()) as ExportStatus;
  } catch {
    return null; // offline / aborted — leave the button as it was
  }
}

export function initExportDownload(
  container: HTMLElement,
  buttonId: string,
  scope: ArchiveScope,
  kind: ExportKind,
): ExportDownloadHandle | null {
  const button = container.querySelector<HTMLButtonElement>(`#${buttonId}`);
  if (!button) return null;

  const readout = button.querySelector<HTMLElement>('.export-progress');
  let timer: number | null = null;
  let polls = 0;
  let destroyed = false;
  let downloadWhenReady = false;
  let latest: ExportStatus | null = null;
  let failures = 0;
  let sawBuilding = false;

  const stopPolling = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  const setBusy = (busy: boolean, percent = ''): void => {
    button.classList.toggle(BUSY_CLASS, busy);
    button.disabled = busy;
    if (readout) readout.textContent = percent;
  };

  const triggerDownload = (): void => {
    const a = document.createElement('a');
    a.href = `/exports/${encodeURIComponent(scope.scopeType)}/${encodeURIComponent(scope.scopeId)}/${kind}`;
    a.download = ''; // the server's Content-Disposition supplies the real name
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /** End a wait that will never produce a download, and SAY so. */
  const abandonWait = (message: string): void => {
    const wasOurs = downloadWhenReady; // merely watching someone else's build → no dialog
    downloadWhenReady = false;
    sawBuilding = false;
    stopPolling();
    setBusy(false);
    if (!wasOurs) return;
    void import('../dialog/dialog').then(({ alertDialog }) => alertDialog({ title: 'Export unavailable', message }));
  };

  const apply = (status: ExportStatus | null): void => {
    if (destroyed) return;
    if (!status) {
      // Unreadable poll. If we're mid-wait, KEEP WAITING — the build is
      // server-side and unaffected; only give up after a sustained outage.
      if (!button.classList.contains(BUSY_CLASS)) return;
      failures++;
      if (failures < MAX_CONSECUTIVE_FAILURES) {
        schedulePoll();

        return;
      }
      log.error(`archive export status unreadable ${failures}x in a row — giving up the wait (${kind})`, '/components/archivePanel/exportDownload');
      failures = 0;
      abandonWait('Lost contact with the server while the export was being prepared. Please try again.');

      return;
    }
    failures = 0;
    latest = status;

    if (status.state === 'unavailable') {
      button.hidden = true;
      stopPolling();

      return;
    }
    button.hidden = false;

    if (status.state === 'ready' && downloadWhenReady) {
      downloadWhenReady = false;
      stopPolling();
      setBusy(false);
      triggerDownload();

      return;
    }
    if (status.state === 'building') sawBuilding = true;
    // The build we were waiting on is gone without an artifact: it reported a
    // failure, OR it went 'building' → 'buildable' (worker died / no worker on
    // the queue and the heartbeat went stale / the corpus changed under it).
    // Either way stop — spinning to MAX_POLLS tells the user nothing.
    if (downloadWhenReady && (status.message || (sawBuilding && status.state === 'buildable'))) {
      abandonWait(status.message ?? 'The export did not finish. Please try again.');

      return;
    }

    // Stay busy while we're waiting on a build we asked for, even if a single
    // 'buildable' reading lands between dispatch and the worker starting.
    const busy = status.state === 'building' || downloadWhenReady;
    setBusy(busy, status.state === 'building' ? `${Math.round((status.progress ?? 0) * 100)}%` : '');

    if (busy) {
      schedulePoll();

      return;
    }
    stopPolling();
  };

  function schedulePoll(): void {
    stopPolling();
    if (destroyed) return;
    if (polls >= MAX_POLLS) {
      abandonWait('The export is taking too long. Please try again later.');

      return;
    }
    timer = window.setTimeout(() => {
      polls++;
      void fetchStatus(scope, kind).then(apply);
    }, POLL_MS);
  }

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;

    if (latest?.state === 'ready') {
      triggerDownload();

      return;
    }

    // Not packaged yet: kick off the build and download it when it lands.
    downloadWhenReady = true;
    sawBuilding = false;
    failures = 0;
    setBusy(true, '0%');
    void (async () => {
      try {
        const csrf = await ensureCsrfToken();
        const resp = await fetch(`${apiBase(scope)}/build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf ?? '' },
          credentials: 'include',
          body: JSON.stringify({ kind }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { message?: string };
          downloadWhenReady = false;
          setBusy(false);
          const { alertDialog } = await import('../dialog/dialog');
          await alertDialog({
            title: 'Export unavailable',
            message: body.message ?? 'The export could not be prepared.',
          });

          return;
        }
        polls = 0;
        void fetchStatus(scope, kind).then(apply);
      } catch (e) {
        downloadWhenReady = false;
        setBusy(false);
        log.error('archive export build request failed', '/components/archivePanel/exportDownload', e);
      }
    })();
  };

  button.addEventListener('click', onClick);
  void fetchStatus(scope, kind).then(apply);
  verbose.init(`archive export button armed (${kind})`, '/components/archivePanel/exportDownload');

  return {
    destroy(): void {
      destroyed = true;
      stopPolling();
      button.removeEventListener('click', onClick);
    },
  };
}

// One archive-export download button (markdown vault / SQLite) — a
// parameterized port of the audiobook button's state machine
// (sourceContainer/audiobookDownload.ts):
//   busy   — dimmed with a % readout while the server packages the artifact
//   ready  — press to download (Content-Disposition names the file)
// Server state comes from GET /api/archive-export/{scope}/status?kind=…,
// which mirrors the audiobook status contract.

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';

const BUSY_CLASS = 'is-busy';
const POLL_MS = 2000;
/** Stop polling a build that never reports progress rather than spinning forever. */
const MAX_POLLS = 900; // 30 minutes

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
    if (!resp.ok) return null;

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

  const apply = (status: ExportStatus | null): void => {
    if (destroyed || !status) return;
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
    if (status.message && downloadWhenReady) {
      downloadWhenReady = false; // the build reported a failure
      stopPolling();
      setBusy(false);

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
    if (destroyed || polls >= MAX_POLLS) return;
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

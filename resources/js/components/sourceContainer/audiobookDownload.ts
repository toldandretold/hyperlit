// The "download the audiobook" button in the source container's Download row.
//
// Downloads ONE .m4b — AAC in an MP4 container with chapter markers derived
// from the book's own h1/h2 headings. That's the real audiobook format: Apple
// Books, Audiobookshelf, BookPlayer and friends read the chapter list and
// remember your place, whereas an mp3 imports into Apple Books as music with no
// chapter UI at all.
//
// The button is a small state machine because packaging is real work:
//   hidden    — no narration yet, an encrypted book, or a host without ffmpeg
//   busy      — dimmed with a % readout, while EITHER the narration run or the
//               .m4b packaging is in flight (from the reader's point of view
//               both are just "the audiobook isn't ready yet")
//   ready     — press to download
// Server state comes from GET /api/book-audio/{book}/audiobook, which answers
// all of that in one poll.

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';

const BUTTON_ID = 'download-audiobook';
const BUSY_CLASS = 'is-busy';
const POLL_MS = 2000;
/** Stop polling a build that never reports progress rather than spinning forever. */
const MAX_POLLS = 900; // 30 minutes

interface AudiobookStatus {
  supported: boolean;
  reason?: string;
  state: 'unavailable' | 'empty' | 'buildable' | 'building' | 'ready';
  progress: number;
  message: string | null;
  sections: number;
  total_nodes: number;
  audio_nodes: number;
  stale_nodes: number;
  generating: boolean;
  bytes: number;
}

export interface AudiobookDownloadHandle {
  destroy(): void;
}

async function fetchStatus(bookId: string): Promise<AudiobookStatus | null> {
  try {
    const resp = await fetch(`/api/book-audio/${encodeURIComponent(bookId)}/audiobook`, { credentials: 'include' });
    if (!resp.ok) return null;

    return (await resp.json()) as AudiobookStatus;
  } catch {
    return null; // offline / aborted — leave the button as it was
  }
}

function coverageNote(status: AudiobookStatus): string {
  const missing = Math.max(0, status.total_nodes - status.audio_nodes);
  const notes: string[] = [];
  if (missing > 0) notes.push(`${missing} section${missing === 1 ? '' : 's'} not narrated yet`);
  if (status.stale_nodes > 0) notes.push(`${status.stale_nodes} edited since narration`);

  return notes.length > 0 ? ` (${notes.join(', ')})` : '';
}

function describe(status: AudiobookStatus): string {
  if (status.generating) return 'Narrating this book…';
  if (status.state === 'building') return `Packaging the audiobook… ${Math.round(status.progress * 100)}%`;
  if (status.state === 'ready') {
    const mb = status.bytes / 1048576;
    return `Download audiobook — ${status.sections} sections, ${mb.toFixed(0)} MB, .m4b with chapters${coverageNote(status)}`;
  }

  return `Build and download the audiobook (.m4b with chapters)${coverageNote(status)}`;
}

export function initAudiobookDownload(container: HTMLElement, bookId: string): AudiobookDownloadHandle | null {
  const button = container.querySelector<HTMLButtonElement>(`#${BUTTON_ID}`);
  if (!button) return null;

  const readout = button.querySelector<HTMLElement>('.audiobook-progress');
  const label = button.querySelector<HTMLElement>('.audiobook-label');
  let timer: number | null = null;
  let polls = 0;
  let destroyed = false;
  let downloadWhenReady = false;
  let latest: AudiobookStatus | null = null;

  const stopPolling = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  const setBusy = (busy: boolean, percent = '', what = ''): void => {
    button.classList.toggle(BUSY_CLASS, busy);
    button.disabled = busy;
    if (readout) readout.textContent = percent;
    if (label) label.textContent = busy ? what : '';
  };

  const triggerDownload = (): void => {
    const a = document.createElement('a');
    a.href = `/${encodeURIComponent(bookId)}/audiobook.m4b`;
    a.download = ''; // the server's Content-Disposition supplies the real name
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const apply = (status: AudiobookStatus | null): void => {
    if (destroyed || !status) return;
    latest = status;

    // Nothing to offer: no narration, an encrypted book, or no ffmpeg here.
    if (!status.supported || status.state === 'empty') {
      button.hidden = true;
      stopPolling();

      return;
    }

    button.hidden = false;
    button.title = describe(status);
    button.setAttribute('aria-label', describe(status));

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

    // Stay busy while we're waiting on a build we asked for, even if this one
    // reading says otherwise — a single 'buildable' between dispatch and the
    // worker starting must not cancel the download the user asked for.
    const busy = status.generating || status.state === 'building' || downloadWhenReady;
    // Name the work: a percentage alone reads like a download, and this bar is
    // the SERVER building the file — which is why a long book takes minutes.
    const packaging = status.state === 'building' || (downloadWhenReady && !status.generating);
    setBusy(
      busy,
      status.state === 'building' ? `${Math.round(status.progress * 100)}%` : '',
      status.generating ? 'narrating' : (packaging ? 'generating' : ''),
    );

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
      void fetchStatus(bookId).then(apply);
    }, POLL_MS);
  }

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!latest || button.disabled) return;

    if (latest.state === 'ready') {
      triggerDownload();

      return;
    }

    // Not packaged yet: kick off the build and download it when it lands.
    downloadWhenReady = true;
    setBusy(true, '0%', 'generating');
    void (async () => {
      try {
        const csrf = await ensureCsrfToken();
        const resp = await fetch(`/api/book-audio/${encodeURIComponent(bookId)}/audiobook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf ?? '' },
          credentials: 'include',
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          downloadWhenReady = false;
          setBusy(false);
          const { alertDialog } = await import('../dialog/dialog');
          await alertDialog({
            title: 'Audiobook unavailable',
            message: (body as { message?: string }).message ?? 'The audiobook could not be prepared.',
          });

          return;
        }
        polls = 0;
        void fetchStatus(bookId).then(apply);
      } catch (e) {
        downloadWhenReady = false;
        setBusy(false);
        log.error('audiobook build request failed', '/components/sourceContainer/audiobookDownload', e);
      }
    })();
  };

  button.addEventListener('click', onClick);
  void fetchStatus(bookId).then(apply);
  verbose.init('audiobook download button armed', '/components/sourceContainer/audiobookDownload');

  return {
    destroy(): void {
      destroyed = true;
      stopPolling();
      button.removeEventListener('click', onClick);
    },
  };
}

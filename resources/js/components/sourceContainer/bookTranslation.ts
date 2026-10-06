// "Translate this book" — the source container's Translate section.
//
// A Chinese book translates into English and an English book into Chinese,
// on Kimi K3, paid for by whoever presses the button. The result is a NEW
// private book in their library (translating in place would orphan every
// highlight and hypercite, which point at character offsets in the original).
//
// The section is a small state machine driven by GET /api/book-translation/{book}:
//   hidden    — a book that can't be translated
//   login     — a guest: "Log in to translate into English", opening the login prompt
//   offer     — "Translate into English", with the cost estimate under it
//   running   — disabled with a progress readout
//   failed    — the job's message, and the button again ("Try again" resumes:
//               finished paragraphs are cached server-side, never re-billed)
//   done      — "Open the English translation", linking to the copy
//
// A run is watched at MODULE level, not by the panel: a long book takes an
// hour and the reader will have closed the panel long before. When a run this
// tab watched finishes, the copy opens by itself if the reader is still on the
// book; if they've moved on to another, they're asked rather than pulled away.

import { log, verbose } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { isLoggedIn } from '../../utilities/auth/session';

const SECTION_ID = 'book-translation-section';
const POLL_MS = 5000;
/** A long novel takes about an hour; stop polling an abandoned tab after three. */
const MAX_POLLS = 2160;

export interface BookTranslationStatus {
  success: boolean;
  available: boolean;
  reason?: string;
  target_lang?: string;
  target_label?: string;
  characters?: number | null;
  estimated_cost?: number | null;
  running?: boolean;
  progress?: { status: string | null; phase: string | null; percent: number; error: string | null } | null;
  existing?: { book: string; title: string } | null;
  /** False for a guest — the endpoint is public so the button can say "Log in". */
  logged_in?: boolean;
}

export interface BookTranslationHandle {
  destroy(): void;
}

type Listener = (status: BookTranslationStatus) => void;

interface RunWatch {
  timer: number | null;
  polls: number;
  listeners: Set<Listener>;
}

/** Runs being watched, by source book. */
const runs = new Map<string, RunWatch>();

async function fetchStatus(bookId: string): Promise<BookTranslationStatus | null> {
  try {
    const resp = await fetch(`/api/book-translation/${encodeURIComponent(bookId)}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return null; // 401 logged out, 404 not visible — leave it hidden

    return (await resp.json()) as BookTranslationStatus;
  } catch {
    return null;
  }
}

/** "about $3" / "under $0.01" — an estimate, so never more precise than cents. */
export function formatEstimate(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return '';
  if (cost < 0.01) return 'under $0.01';

  return `about $${cost.toFixed(2)}`;
}

/** The book in the reader right now (its root, for a sub-book overlay). */
function currentBookId(): string {
  const id = document.querySelector('.main-content')?.id ?? '';

  return id.split('/')[0] ?? id;
}

/** Open a book the way a link click would: SPA transition, full load as a fallback. */
async function openBook(bookId: string): Promise<void> {
  const url = new URL(`/${encodeURIComponent(bookId)}`, window.location.origin);
  try {
    const { NavigationManager } = await import('../../SPA/navigation/NavigationManager');
    await NavigationManager.navigateByStructure({
      fromBook: currentBookId(),
      toBook: bookId,
      targetUrl: url.href,
      hash: '',
    });
  } catch (e) {
    log.error('opening the translation failed; loading it directly', '/components/sourceContainer/bookTranslation', e);
    window.location.href = url.href;
  }
}

async function openWhenReady(sourceBook: string, copy: { book: string; title: string }): Promise<void> {
  if (currentBookId() === sourceBook) {
    await openBook(copy.book);

    return;
  }
  // They've moved on to another book: don't pull them out of it unasked.
  const { confirmDialog } = await import('../dialog/dialog');
  const open = await confirmDialog({
    title: 'Translation ready',
    message: `“${copy.title}” is ready in your library.`,
    confirmLabel: 'Open it',
    cancelLabel: 'Later',
  });
  if (open) await openBook(copy.book);
}

/**
 * Poll a running translation until it ends, outliving the panel, and open the
 * copy when it lands. Idempotent: a second call joins the existing watch.
 */
export function watchTranslation(bookId: string): void {
  if (runs.has(bookId)) return;
  const run: RunWatch = { timer: null, polls: 0, listeners: new Set() };
  runs.set(bookId, run);

  const tick = async (): Promise<void> => {
    run.timer = null;
    const status = await fetchStatus(bookId);
    if (runs.get(bookId) !== run) return; // stopped meanwhile

    if (status) run.listeners.forEach((listener) => listener(status));

    if (status?.existing) {
      stopWatching(bookId);
      await openWhenReady(bookId, status.existing);

      return;
    }
    if ((status && !status.running) || ++run.polls >= MAX_POLLS) {
      stopWatching(bookId); // failed, or abandoned — the panel shows why

      return;
    }
    run.timer = window.setTimeout(() => void tick(), POLL_MS);
  };
  run.timer = window.setTimeout(() => void tick(), POLL_MS);
}

/** Stop watching one book's run, or every run. */
export function stopWatching(bookId?: string): void {
  for (const [id, run] of runs) {
    if (bookId !== undefined && id !== bookId) continue;
    if (run.timer !== null) window.clearTimeout(run.timer);
    runs.delete(id);
  }
}


export function initBookTranslation(container: HTMLElement, bookId: string): BookTranslationHandle | null {
  const section = container.querySelector<HTMLElement>(`#${SECTION_ID}`);
  const button = section?.querySelector<HTMLButtonElement>('.book-translation-btn');
  const note = section?.querySelector<HTMLElement>('.book-translation-note');
  const link = section?.querySelector<HTMLAnchorElement>('.book-translation-open');
  if (!section || !button || !note || !link) return null;

  // Sub-book overlays share the source card; translation is of the root book.
  const rootBook = String(bookId).split('/')[0] ?? String(bookId);
  let destroyed = false;
  let latest: BookTranslationStatus | null = null;

  /**
   * Follow the module-level watch of this book's run while the panel is open.
   * Joins whichever watch is current, so a "Try again" after a failed run is
   * followed too.
   */
  const follow = (): void => {
    watchTranslation(rootBook);
    runs.get(rootBook)?.listeners.add(apply);
  };

  function apply(status: BookTranslationStatus | null): void {
    if (destroyed || !status) return;
    latest = status;

    if (!status.available) {
      section!.hidden = true;

      return;
    }
    section!.hidden = false;
    const language = status.target_label ?? 'the other language';

    if (status.existing) {
      button!.hidden = true;
      link!.hidden = false;
      link!.href = `/${encodeURIComponent(status.existing.book)}`;
      link!.textContent = `Open the ${language} translation`;
      note!.textContent = `“${status.existing.title}” is in your library (private).`;

      return;
    }

    link!.hidden = true;
    button!.hidden = false;

    if (status.running) {
      const percent = Math.round((status.progress?.percent ?? 0) * 100);
      const what = status.progress?.phase === 'notes' ? 'footnotes' : 'text';
      button!.disabled = true;
      // Kimi K3 reasons before it answers, so the first batches take a minute
      // or two to come back — say so rather than sit on a 0% that looks stuck.
      button!.textContent = status.progress?.status === 'queued'
        ? `Waiting to translate into ${language}…`
        : percent === 0
          ? `Translating into ${language}… first results in a minute or two`
          : `Translating ${what} into ${language}… ${percent}%`;
      note!.textContent = 'It opens by itself when it’s done. A long book takes about an hour — you can close this panel meanwhile.';
      follow();

      return;
    }

    button!.disabled = false;
    const failed = status.progress?.status === 'failed';
    const guest = status.logged_in === false;
    button!.textContent = guest
      ? `Log in to translate into ${language}`
      : failed ? `Try again: translate into ${language}` : `Translate into ${language}`;
    const estimate = formatEstimate(status.estimated_cost);
    const cost = estimate ? `Kimi K3, ${estimate}, charged for what's used.` : 'Kimi K3, charged for what\'s used.';
    note!.textContent = failed && status.progress?.error
      ? `${status.progress.error} ${cost}`
      : `Makes a private copy in ${language} for you. ${cost}`;
  }

  const onClick = async (event: Event): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!latest?.available || button.disabled) return;

    if (latest.logged_in === false) {
      // Logged in since the panel opened? Pick up their status and carry on.
      if (await isLoggedIn()) {
        apply(await fetchStatus(rootBook));
        if (latest.logged_in === false || latest.existing || latest.running || destroyed) return;
      } else {
        const { showLoginPromptMenu } = await import('../shelves/addToShelfMenu');
        showLoginPromptMenu(button, `Log in to translate this book into ${latest.target_label ?? 'another language'}`);

        return;
      }
    }

    const language = latest.target_label ?? 'the other language';
    const estimate = formatEstimate(latest.estimated_cost);
    const { confirmDialog, alertDialog } = await import('../dialog/dialog');
    const ok = await confirmDialog({
      title: `Translate into ${language}?`,
      message: `This makes a private ${language} copy of the book in your library, translated by Kimi K3.`
        + (estimate ? ` It should cost ${estimate}; you're charged for what's actually used.` : '')
        + ' It opens by itself when it’s done; a long book takes about an hour.',
      confirmLabel: 'Translate',
    });
    if (!ok || destroyed) return;

    button.disabled = true;
    button.textContent = `Starting translation into ${language}…`;
    try {
      const csrf = await ensureCsrfToken();
      const resp = await fetch(`/api/book-translation/${encodeURIComponent(rootBook)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf ?? '' },
      });
      const body: any = await resp.json().catch(() => ({}));

      if (resp.status === 409 && body.existing) {
        apply({ ...latest, existing: body.existing });

        return;
      }
      if (!resp.ok) {
        apply(latest);
        await alertDialog({
          title: 'Translation not started',
          message: resp.status === 402
            ? 'Not enough credit to translate this book — top up your balance and try again.'
            : (body.message ?? 'The translation could not be started.'),
        });

        return;
      }

      apply({ ...latest, running: true, progress: { status: 'queued', phase: 'text', percent: 0, error: null } });
    } catch (e) {
      apply(latest);
      log.error('book translation request failed', '/components/sourceContainer/bookTranslation', e);
    }
  };

  const listener = (event: Event) => { void onClick(event); };
  button.addEventListener('click', listener);

  // Guests too: they're offered "Log in to translate" (the status read is public).
  void fetchStatus(rootBook).then(apply);
  verbose.init('book translation section armed', '/components/sourceContainer/bookTranslation');

  return {
    destroy(): void {
      // Stop drawing, but leave any run's watch going: it outlives the panel.
      destroyed = true;
      runs.get(rootBook)?.listeners.delete(apply);
      button.removeEventListener('click', listener);
    },
  };
}

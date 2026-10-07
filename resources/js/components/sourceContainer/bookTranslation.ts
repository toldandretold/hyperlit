// "Translate this book" — the source container's Translate section.
//
// A Chinese book translates into English and an English book into Chinese,
// on Kimi K3, paid for by whoever presses the button. The result is a NEW
// book in their library (translating in place would orphan every highlight
// and hypercite, which point at character offsets in the original). The
// commons rule: a PUBLIC book's translation is public — one reader pays and
// everyone else gets the open-link instead of the paid button — while a
// private book's translation stays private.
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
import { openTranslationVizOverlay, closeTranslationVizOverlay } from './translationViz';

const SECTION_ID = 'book-translation-section';
const PROGRESS_ROW_ID = 'book-translation-live';
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
  progress?: {
    status: string | null;
    phase: string | null;
    percent: number;
    error: string | null;
    /** Current TranslationMap stage id, for the live-progress overlay. */
    stage?: string | null;
    /** Latest-state map per stage id (status + live signals). */
    stages?: Record<string, { status?: string; [signal: string]: unknown }> | null;
    new_book?: string | null;
    publish_clamped?: string | null;
  } | null;
  /** Bounded boundary log (stage transitions + section starts). */
  telemetry?: Array<{ t: string; stage?: string; status?: string; detail?: string }>;
  existing?: { book: string; title: string; own?: boolean; creator?: string } | null;
  /** False for a guest — the endpoint is public so the button can say "Log in". */
  logged_in?: boolean;
  /** The commons rule: a public book's translation will itself be public. */
  will_be_public?: boolean;
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
  // The overlay must not outlive the page it narrates.
  closeTranslationVizOverlay();
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

  /**
   * The running-state row under the button: "See live progress ▸" opens the
   * stage-chain overlay (pattern: harvestNetwork's ensureHarvestRunningRow).
   * Idempotent — created once, wired once; removed when the run ends. The
   * overlay subscribes to the SAME module-level watch, so it keeps updating
   * after this panel is destroyed.
   */
  const ensureProgressRow = (): void => {
    if (section!.querySelector(`#${PROGRESS_ROW_ID}`)) return;
    const row = document.createElement('div');
    row.id = PROGRESS_ROW_ID;
    row.className = 'book-translation-live-row';
    row.innerHTML = '<button type="button" class="book-translation-viz-toggle">See live progress ▸</button>';
    section!.appendChild(row);
    row.querySelector('.book-translation-viz-toggle')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!latest) return;
      void openTranslationVizOverlay(latest, (vizListener) => {
        watchTranslation(rootBook);
        runs.get(rootBook)?.listeners.add(vizListener);

        return () => runs.get(rootBook)?.listeners.delete(vizListener);
      });
    });
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

    if (!status.running) {
      section!.querySelector(`#${PROGRESS_ROW_ID}`)?.remove();
    }

    if (status.existing) {
      // A finished translation is the Versions/Translations rail's job to
      // surface (it sits with the citation, where identity facts belong) —
      // repeating an open-link here would be noise, so the whole section
      // goes away. The module-level watch still reads `existing` to know a
      // run it followed just finished.
      section!.hidden = true;

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
      ensureProgressRow();
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
    const what = status.will_be_public
      ? `Makes a public ${language} translation anyone can read — you pay once, nobody pays again.`
      : `Makes a private copy in ${language} for you.`;
    note!.textContent = failed && status.progress?.error
      ? `${status.progress.error} ${cost}`
      : `${what} ${cost}`;
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
      message: (latest.will_be_public
        ? `This makes a public ${language} translation of the book, by Kimi K3, in your library — everyone can read it, so nobody pays for it twice.`
        : `This makes a private ${language} copy of the book in your library, translated by Kimi K3.`)
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

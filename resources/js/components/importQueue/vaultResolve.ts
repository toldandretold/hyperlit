// "Is this note already a book in Hyperlit?" — the pre-flight for a folder
// drop. A vault exported from Hyperlit names each note's original book
// (`hyperlit:` / `book:` front matter); any scholarly vault may carry DOIs.
// Before a single byte uploads, those hints go to
// POST /api/import-batches/resolve, and if any note matches a book the user
// can read, ONE dialog asks what to do with the matches:
//
//   existing — put the books already in Hyperlit on the shelf. Nothing is
//              imported, so hypercites, highlights and versions stay intact.
//   own      — import the user's own private version of each (sent with
//              `version_of`, so it carries the same citation details).
//
// Notes that contain a hypercite link, or are the target of one from another
// note in the drop, ALWAYS use the existing book: a hypercite is a link
// between two specific books, and a re-imported copy has no such link — it
// would arrive with dead arrows. Unmatched notes are imported as new books
// either way.

import { log, verbose } from '../../utilities/logger';
import { choiceDialog } from '../dialog/dialog';
import { hasIdentityHint } from './vaultMetadata';
import type { ImportBundle, SkippedNote } from './folderIngest';
import { uploadBatch } from './batchUploader';

const FILE = '/components/importQueue/vaultResolve.ts';

/** One match from the resolve endpoint. */
export interface ResolvedBook {
  book: string;
  slug: string | null;
  title: string | null;
  matchedBy: 'hyperlit' | 'doi';
}

export interface VaultDropDecision {
  /** Notes to upload (new books, plus own versions when chosen). */
  bundles: ImportBundle[];
  /** Ids of books already in Hyperlit to put straight on the shelf. */
  existingBooks: string[];
}

function csrfToken(): string {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta instanceof HTMLMetaElement ? meta.content : '';
}

/**
 * Ask the server which of these notes are books the caller can already read.
 * Returns a map keyed by bundle index. Never throws: a failed lookup means
 * "nothing recognised" and the drop imports as it always did.
 */
export async function resolveExistingBooks(bundles: ImportBundle[]): Promise<Map<number, ResolvedBook>> {
  const matches = new Map<number, ResolvedBook>();
  const items = bundles
    .map((bundle, index) => ({ bundle, index }))
    .filter(({ bundle }) => hasIdentityHint(bundle.identity ?? null))
    .map(({ bundle, index }) => ({
      key: String(index),
      ...(bundle.identity?.book ? { book: bundle.identity.book } : {}),
      ...(bundle.identity?.hyperlitUrl ? { hyperlit_url: bundle.identity.hyperlitUrl } : {}),
      ...(bundle.identity?.doi ? { doi: bundle.identity.doi } : {}),
      title: bundle.title,
    }));
  if (!items.length) return matches;

  try {
    const resp = await fetch('/api/import-batches/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken(),
      },
      credentials: 'include',
      body: JSON.stringify({ items }),
    });
    const data: unknown = await resp.json().catch(() => null);
    if (!resp.ok || typeof data !== 'object' || data === null) {
      verbose.content(`vaultResolve: resolve returned ${resp.status} — importing everything as new`, FILE);
      return matches;
    }
    const results = (data as { results?: unknown }).results;
    if (!Array.isArray(results)) return matches;

    for (const raw of results) {
      if (typeof raw !== 'object' || raw === null) continue;
      const row = raw as Record<string, unknown>;
      if (row.status !== 'existing' || typeof row.book !== 'string' || typeof row.key !== 'string') continue;
      const index = Number(row.key);
      if (!Number.isInteger(index) || !bundles[index]) continue;
      matches.set(index, {
        book: row.book,
        slug: typeof row.slug === 'string' ? row.slug : null,
        title: typeof row.title === 'string' ? row.title : null,
        matchedBy: row.matched_by === 'doi' ? 'doi' : 'hyperlit',
      });
    }
  } catch (err) {
    log.error('vaultResolve: could not check the folder against the library — importing everything as new', FILE, err instanceof Error ? err.message : String(err));
  }

  return matches;
}

/**
 * Bundle indexes that must use the existing book: the note carries a hypercite
 * link, or some note in the drop links a hypercite INTO it.
 */
export function forcedExisting(bundles: ImportBundle[], matches: Map<number, ResolvedBook>): Set<number> {
  const targeted = new Set<string>();
  for (const bundle of bundles) {
    for (const target of bundle.identity?.hyperciteTargets ?? []) targeted.add(target);
  }

  const forced = new Set<number>();
  for (const [index, match] of matches) {
    const cites = (bundles[index]?.identity?.hyperciteTargets.length ?? 0) > 0;
    const cited = targeted.has(match.book) || (match.slug !== null && targeted.has(match.slug));
    if (cites || cited) forced.add(index);
  }
  return forced;
}

/** Split the drop by the user's choice. Pure — the dialog lives in the caller. */
export function applyChoice(
  bundles: ImportBundle[],
  matches: Map<number, ResolvedBook>,
  forced: Set<number>,
  choice: 'existing' | 'own',
): VaultDropDecision {
  const upload: ImportBundle[] = [];
  const existing = new Set<string>();

  bundles.forEach((bundle, index) => {
    const match = matches.get(index);
    if (!match) {
      upload.push(bundle);
    } else if (choice === 'existing' || forced.has(index)) {
      existing.add(match.book);
    } else {
      upload.push({ ...bundle, versionOf: match.book });
    }
  });

  return { bundles: upload, existingBooks: [...existing] };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The whole pre-flight: resolve, ask once if anything matched, and return what
 * to upload and what to shelve. Returns null when the user cancels the drop.
 */
export async function decideVaultDrop(bundles: ImportBundle[], skipped: SkippedNote[] = []): Promise<VaultDropDecision | null> {
  const matches = await resolveExistingBooks(bundles);
  if (matches.size === 0) return { bundles, existingBooks: [] };

  const forced = forcedExisting(bundles, matches);
  const fresh = bundles.length - matches.size;
  const byDoi = [...matches.values()].filter((m) => m.matchedBy === 'doi').length;

  const message = [
    `${matches.size} of ${plural(bundles.length, 'file', 'files')} ${matches.size === 1 ? 'is' : 'are'} already in Hyperlit`
      + (byDoi ? ` (${byDoi} matched by DOI)` : '') + '.',
    fresh ? `The other ${fresh} will be imported as ${fresh === 1 ? 'a new book' : 'new books'}.` : '',
    skipped.length ? `Skipped: ${skipped.map((n) => `${n.filename} (${n.reason === 'hub' ? 'the export’s index page' : 'empty'})`).join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  const ownDescription = forced.size === matches.size
    ? 'Not available here: every one of them contains or is cited by a hypercite, which only works with the existing book.'
    : 'Each becomes your own private copy with the same citation details.'
      + (forced.size ? ` ${plural(forced.size, 'book', 'books')} that contain or are cited by hypercites still use the existing version so the links keep working.` : '');

  const choice = await choiceDialog({
    title: 'Already in Hyperlit',
    message,
    options: [
      {
        value: 'existing',
        label: 'Add the existing books to the shelf',
        description: 'Nothing is re-imported. Hypercites, highlights and versions keep working.',
      },
      {
        value: 'own',
        label: 'Import my own versions',
        description: ownDescription,
      },
    ],
  });
  if (choice !== 'existing' && choice !== 'own') return null;

  const decision = applyChoice(bundles, matches, forced, choice);
  verbose.content(
    `vaultResolve: ${matches.size} matched (${forced.size} forced existing) → ${decision.existingBooks.length} shelved, ${decision.bundles.length} to upload`,
    FILE,
  );
  return decision;
}

/* ── A single upload ────────────────────────────────────────────────────── */

export type SingleNoteOutcome =
  /** Not a book we hold (or it carries no hint): import as before. */
  | { action: 'proceed' }
  | { action: 'cancel' }
  /** Use the book already in Hyperlit — nothing is imported. */
  | { action: 'existing'; match: ResolvedBook }
  /** Import the user's own version; the bundle carries `versionOf`. */
  | { action: 'own'; bundle: ImportBundle };

/**
 * The single-file twin of decideVaultDrop: one note, dropped or picked on its
 * own. If it is already a book the user can read, ask whether to open that
 * book (filed on `shelfName`, or "Imported works") or import their own
 * editable version.
 *
 * A note carrying hypercite links only offers the existing book: an own
 * version would arrive with those links as plain text, which is the one
 * outcome this whole check exists to prevent.
 */
export async function decideSingleNote(bundle: ImportBundle, shelfName: string | null): Promise<SingleNoteOutcome> {
  if (!hasIdentityHint(bundle.identity ?? null)) return { action: 'proceed' };

  const match = (await resolveExistingBooks([bundle])).get(0);
  if (!match) return { action: 'proceed' };

  const hasHypercites = (bundle.identity?.hyperciteTargets.length ?? 0) > 0;
  const destination = shelfName ? `“${shelfName}”` : 'your “Imported works” shelf';

  const options = [{
    value: 'existing',
    label: 'Open the existing book',
    description: `Nothing is re-imported. It is added to ${destination}, and its hypercites and highlights keep working.`,
  }];
  if (!hasHypercites) {
    options.push({
      value: 'own',
      label: 'Import my own version',
      description: 'A private copy in your library that you can edit, with the same citation details.',
    });
  }

  const choice = await choiceDialog({
    title: 'Already in Hyperlit',
    message: `“${match.title || bundle.title}” is already in Hyperlit${match.matchedBy === 'doi' ? ' (matched by DOI)' : ''}.`
      + (hasHypercites ? ' This file contains hypercites, which only work in the existing book, so it can’t be imported as a separate copy.' : ''),
    options,
  });

  if (choice === 'existing') return { action: 'existing', match };
  if (choice === 'own') return { action: 'own', bundle: { ...bundle, versionOf: match.book } };
  return { action: 'cancel' };
}

/**
 * Put a book already in Hyperlit on the user's shelf — `shelfId` when they
 * dropped the file onto one of their own open shelves, otherwise "Imported
 * works" — and open it. Throws if the shelf step fails; the book is opened
 * only once it is filed, so it can always be found again.
 */
export async function openExistingBook(match: ResolvedBook, shelfId: string | null): Promise<void> {
  await uploadBatch([], {
    label: match.title || match.book,
    source: 'files',
    autoShelf: false,
    ...(shelfId ? { shelfId } : { importsShelf: true }),
    existingBooks: [match.book],
  });
  window.location.assign(`/${encodeURIComponent(match.slug || match.book)}`);
}

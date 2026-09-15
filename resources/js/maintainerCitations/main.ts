/**
 * /maintainer/citations — the ambiguous-citation review queue (standalone, non-SPA,
 * admin-only; see Maintainer\CitationConsoleController).
 *
 * Every card is a QUESTION the converter stored instead of a silent guess: a bare-year
 * citation more than one bibliography entry fits. The maintainer answers from the card
 * (the sentence + each candidate's full entry + how often the book cites it properly
 * elsewhere); the answer patches the stored nodes at once and lands in the ledger that
 * every later reconvert re-applies.
 */

import { log } from '../utilities/logger';
import { ensureCsrfToken } from '../utilities/auth/csrf';

interface Candidate {
  target: string;
  entry: string | null;
  cited_elsewhere: number;
}

interface PendingItem {
  id: string;
  year: string;
  sentence: string;
  href_current: string;
  candidates: Candidate[];
}

interface PendingBook {
  book: string;
  title: string;
  slug: string | null;
  items: PendingItem[];
}

interface PendingPayload {
  pending_books: PendingBook[];
  pending_total: number;
  resolved_total: number;
}

const listEl = (): HTMLElement | null => document.getElementById('mc-list');

async function postResolve(id: string, choice: string | null): Promise<{ ok: boolean; message?: string }> {
  const token = await ensureCsrfToken();
  if (!token) return { ok: false, message: 'session error — refresh and retry' };
  const res = await fetch(`/api/maintainer/citations/ambiguous/${id}/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-XSRF-TOKEN': token,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ choice }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: data.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

/** The sentence with its trailing year highlighted, built with DOM nodes (never innerHTML). */
function sentenceEl(item: PendingItem): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'mc-sentence';
  p.append(document.createTextNode(item.sentence.replace(/\s*⟦.*$/u, '') + ' '));
  const year = document.createElement('mark');
  year.className = 'mc-year';
  year.textContent = `(${item.year})`;
  p.append(year);
  return p;
}

function candidateButton(item: PendingItem, cand: Candidate, onAnswer: (choice: string | null) => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mc-candidate';
  if (cand.target === item.href_current) btn.classList.add('mc-current');

  const head = document.createElement('span');
  head.className = 'mc-cand-head';
  head.textContent = cand.target + (cand.target === item.href_current ? ' — current guess' : '');
  const cited = document.createElement('span');
  cited.className = 'mc-cand-cited';
  cited.textContent = cand.cited_elsewhere > 0
    ? `cited properly ${cand.cited_elsewhere}× elsewhere in this book`
    : 'never cited properly elsewhere';
  head.append(' · ', cited);

  const entry = document.createElement('span');
  entry.className = 'mc-cand-entry';
  entry.textContent = cand.entry ?? '(entry text not found)';

  btn.append(head, entry);
  btn.addEventListener('click', () => onAnswer(cand.target));
  return btn;
}

function itemCard(item: PendingItem): HTMLElement {
  const card = document.createElement('section');
  card.className = 'mc-card';

  card.append(sentenceEl(item));

  const answer = async (choice: string | null): Promise<void> => {
    card.classList.add('mc-busy');
    const result = await postResolve(item.id, choice);
    card.classList.remove('mc-busy');
    if (!result.ok) {
      log.error(`Citation resolve failed: ${result.message}`, '/maintainerCitations/main.ts');
      flash(card, result.message ?? 'failed');
      return;
    }
    card.classList.add('mc-done');
    card.replaceChildren(doneLine(item, choice));
    updateCountAfterResolve();
  };

  for (const cand of item.candidates) {
    card.append(candidateButton(item, cand, answer));
  }

  const notCitation = document.createElement('button');
  notCitation.type = 'button';
  notCitation.className = 'mc-not-citation';
  notCitation.textContent = 'Not a citation — unlink it';
  notCitation.addEventListener('click', () => answer(null));
  card.append(notCitation);

  return card;
}

function doneLine(item: PendingItem, choice: string | null): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'mc-done-line';
  p.textContent = choice === null
    ? `(${item.year}) unlinked — not a citation`
    : `(${item.year}) → ${choice}`;
  return p;
}

function flash(card: HTMLElement, message: string): void {
  const note = document.createElement('p');
  note.className = 'mc-error';
  note.textContent = message;
  card.append(note);
  setTimeout(() => note.remove(), 4000);
}

let pendingLeft = 0;
let resolvedTotal = 0;

function updateCountAfterResolve(): void {
  pendingLeft = Math.max(0, pendingLeft - 1);
  resolvedTotal += 1;
  renderCounts();
}

function renderCounts(): void {
  const el = document.getElementById('mc-counts');
  if (el) el.textContent = `${pendingLeft} open · ${resolvedTotal} answered`;
}

function bookGroup(book: PendingBook): HTMLElement {
  const group = document.createElement('article');
  group.className = 'mc-book';

  const h2 = document.createElement('h2');
  const link = document.createElement('a');
  link.href = '/' + encodeURIComponent(book.slug ?? book.book);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = book.title;
  h2.append(link);
  const count = document.createElement('span');
  count.className = 'mc-book-count';
  count.textContent = `${book.items.length} open`;
  h2.append(' ', count);
  group.append(h2);

  for (const item of book.items) {
    group.append(itemCard(item));
  }
  return group;
}

async function load(): Promise<void> {
  const root = listEl();
  if (!root) return;
  try {
    const res = await fetch('/api/maintainer/citations/ambiguous', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as PendingPayload;
    pendingLeft = payload.pending_total;
    resolvedTotal = payload.resolved_total;
    renderCounts();

    if (!payload.pending_books.length) {
      root.replaceChildren(empty('Nothing pending — every ambiguous citation has an answer.'));
      return;
    }
    root.replaceChildren(...payload.pending_books.map(bookGroup));
    log.init(`Ambiguous citation queue: ${payload.pending_total} open across ${payload.pending_books.length} book(s)`, '/maintainerCitations/main.ts');
  } catch (e) {
    log.error(`Ambiguous citation queue failed to load: ${(e as Error).message}`, '/maintainerCitations/main.ts');
    root.replaceChildren(empty('Failed to load — are you signed in as an admin?'));
  }
}

function empty(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'mc-empty';
  p.textContent = text;
  return p;
}

void load();

/**
 * /maintainer/stats — site-wide reading analytics wiring (standalone, non-SPA,
 * admin-only; see Maintainer\StatsController).
 *
 * Charts are hand-rolled DOM bars, same policy as maintainerStorage: the only
 * viz dependency in the project is three.js (docuverse), and stat tiles + a
 * daily bar strip + a ranked list need nothing.
 */

import { log } from '../utilities/logger';

interface Summary {
  views: number;
  views_30d: number;
  readers: number;
  books_read: number;
  likes: number;
  books_liked: number;
  /** Homepage visits — page_views, NOT book_reads. Same unit (one per
   *  identity per day), different surface: a home view is not a book read. */
  home_views: number;
  home_views_30d: number;
}

interface DayPoint { day: string; n: number }

interface TopBook {
  book: string;
  title: string | null;
  creator: string | null;
  views: number;
  views_30d: number;
  likes: number;
  avg_depth_pct: number | null;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function esc(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
  if (!resp.ok) throw new Error(`${url} → ${resp.status}`);
  return (await resp.json()) as T;
}

function renderTiles(s: Summary): void {
  const tiles = el('mst-tiles');
  if (!tiles) return;
  const tile = (val: string, label: string) => `
    <div class="mst-tile">
      <span class="mst-tile-val">${val}</span>
      <span class="mst-tile-label">${label}</span>
    </div>`;
  tiles.innerHTML =
    tile(String(s.views), 'book views all-time') +
    tile(String(s.views_30d), 'book views, 30 days') +
    tile(String(s.readers), 'distinct readers') +
    tile(String(s.books_read), 'books read') +
    tile(String(s.likes), 'likes') +
    tile(String(s.books_liked), 'books liked') +
    tile(String(s.home_views), 'home views all-time') +
    tile(String(s.home_views_30d), 'home views, 30 days');

  const sub = el('mst-summary');
  if (sub) {
    sub.textContent =
      `${s.views} book views · ${s.home_views} home views · ${s.readers} readers · ${s.likes} likes`;
  }
}

function renderDaily(views: DayPoint[], likes: DayPoint[], home: DayPoint[]): void {
  const host = el('mst-daily');
  if (!host) return;

  const likesByDay = new Map(likes.map(p => [p.day, p.n]));
  // Dense 90-day axis (query returns only non-zero days).
  const days: string[] = [];
  const start = new Date();
  start.setDate(start.getDate() - 89);
  const viewsByDay = new Map(views.map(p => [p.day, p.n]));
  const homeByDay = new Map(home.map(p => [p.day, p.n]));
  for (let i = 0; i < 90; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const max = Math.max(1, ...days.map(
    d => (viewsByDay.get(d) || 0) + (likesByDay.get(d) || 0) + (homeByDay.get(d) || 0)
  ));

  host.innerHTML = days.map(d => {
    const v = viewsByDay.get(d) || 0;
    const l = likesByDay.get(d) || 0;
    const h = homeByDay.get(d) || 0;
    return `
      <div class="mst-day" title="${d}: ${v} book views, ${h} home views, ${l} likes">
        <div class="mst-day-likes" style="height: ${(l / max) * 100}%"></div>
        <div class="mst-day-home" style="height: ${(h / max) * 100}%"></div>
        <div class="mst-day-views" style="height: ${(v / max) * 100}%"></div>
      </div>`;
  }).join('');
}

function renderTop(books: TopBook[]): void {
  const host = el('mst-top');
  if (!host) return;
  if (!books.length) {
    host.innerHTML = '<p class="mst-empty">No reads recorded yet.</p>';
    return;
  }
  const max = Math.max(1, ...books.map(b => b.views));
  host.innerHTML = books.map(b => `
    <div class="mst-top-row">
      <a class="mst-top-title" href="/${encodeURIComponent(b.book)}" title="${esc(b.book)}">${esc(b.title || b.book)}</a>
      <div class="mst-top-bar-track">
        <div class="mst-top-bar" style="width: ${(b.views / max) * 100}%"></div>
      </div>
      <span class="mst-top-nums">
        ${b.views} views · ${b.views_30d} this month · ♡ ${b.likes}${b.avg_depth_pct !== null ? ` · depth ${b.avg_depth_pct}%` : ''}
      </span>
    </div>`).join('');
}

function wireHelp(): void {
  const toggle = el('mst-help-toggle');
  const panel = el('mst-help-panel');
  const close = el('mst-help-close');
  if (!toggle || !panel) return;
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  toggle.addEventListener('click', () => setOpen(!!panel.hidden));
  close?.addEventListener('click', () => setOpen(false));
}

async function boot(): Promise<void> {
  wireHelp();
  try {
    const [summary, daily, top] = await Promise.all([
      getJson<Summary>('/api/maintainer/stats/summary'),
      getJson<{ views: DayPoint[]; likes: DayPoint[]; home: DayPoint[] }>('/api/maintainer/stats/daily'),
      getJson<{ books: TopBook[] }>('/api/maintainer/stats/top-books'),
    ]);
    renderTiles(summary);
    renderDaily(daily.views, daily.likes, daily.home || []);
    renderTop(top.books);
  } catch (error) {
    log.error('maintainer-stats: load failed', '/maintainerStats/main.ts', error);
    const sub = el('mst-summary');
    if (sub) sub.textContent = 'failed to load — are you logged in as an admin?';
  }
}

void boot();

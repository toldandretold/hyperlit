/**
 * /maintainer/storage — storage analysis wiring (standalone, non-SPA,
 * admin-only; see Maintainer\StorageController).
 *
 * Charts are hand-rolled DOM/SVG: the only viz dependency in the project is
 * three.js (docuverse), and a stacked bar + meters + ranked bars need nothing.
 * Colour follows the CATEGORY, never its rank — the map below is fixed, so a
 * category keeps its colour when the ordering changes. Every segment is also
 * named with its value in the ranked list, which is what lets the light-mode
 * palette ship despite its contrast warning.
 */

import { log } from '../utilities/logger';
import { ensureCsrfToken } from '../utilities/auth/csrf';

interface Category {
  category: string;
  bytes: number;
  file_count: number;
  orphan_bytes: number;
  reclaimable: boolean;
}

interface BookRow {
  book: string;
  owner: string | null;
  bytes: number;
  is_orphan: boolean;
}

interface DetailRow {
  label: string;
  bytes: number;
  file_count: number;
  orphan_bytes: number;
  book_count: number;
  /** Only meaningful when the rows are grouped BY BOOK. */
  is_orphan: boolean;
  owner: string | null;
}

interface Summary {
  scan: { id: number; finished_at: string; age_seconds: number | null; duration_ms: number } | null;
  totals?: {
    total_bytes: number;
    db_bytes: number;
    file_bytes: number;
    orphan_bytes: number;
    disk_free_bytes: number | null;
    disk_total_bytes: number | null;
    images_tracked_bytes: number;
    audio_tracked_bytes: number;
  };
  categories?: Category[];
  top_books?: BookRow[];
  db_is_managed?: boolean;
  db_limit_bytes?: number | null;
}

/** Fixed category → colour slot. Never reordered, never cycled. */
const CATEGORY_VAR: Record<string, string> = {
  documents: '--ms-cat-1',
  images: '--ms-cat-2',
  audio: '--ms-cat-3',
  cache: '--ms-cat-4',
  legacy_images: '--ms-cat-5',
  database: '--ms-cat-6',
  other: '--ms-cat-7',
};

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const colorFor = (category: string): string => `var(${CATEGORY_VAR[category] ?? '--ms-cat-7'})`;

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  for (const unit of units) {
    if (value < 1024 || unit === 'TB') {
      return `${unit === 'B' ? Math.round(value) : value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes}`;
}

function ago(seconds: number | null): string {
  if (seconds === null) return 'unknown age';
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

let statusTimer: number | undefined;

function setStatus(text: string): void {
  const node = el<HTMLDivElement>('ms-status');
  node.textContent = text;
  node.classList.add('ms-visible');
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => node.classList.remove('ms-visible'), 4000);
}

// ── Load + render ─────────────────────────────────────────────────────────

async function load(): Promise<void> {
  const resp = await fetch('/api/maintainer/storage/summary', { credentials: 'include' });
  if (!resp.ok) {
    log.error(`Storage summary fetch failed (${resp.status})`, 'maintainer-storage');
    setStatus(`could not load (${resp.status})`);
    return;
  }
  render(await resp.json());
}

function render(data: Summary): void {
  const hasScan = data.scan !== null && data.totals !== undefined;
  el<HTMLParagraphElement>('ms-empty').hidden = hasScan;
  el<HTMLDivElement>('ms-body').hidden = !hasScan;

  if (!hasScan || !data.totals || !data.categories) {
    el<HTMLElement>('ms-summary').textContent = 'no snapshot yet';
    return;
  }

  const totals = data.totals;
  el<HTMLElement>('ms-summary').textContent =
    `scanned ${ago(data.scan!.age_seconds)} · ${data.scan!.duration_ms}ms`;
  el<HTMLElement>('ms-total').textContent = human(totals.total_bytes);

  renderStack(data.categories, totals.total_bytes);
  renderMeters(data);
  renderCategories(data.categories, totals.total_bytes);
  renderBooks(data.top_books ?? []);
  renderOrphans(totals.orphan_bytes, totals.file_bytes);
  renderDrift(data.categories, totals);
}

function renderStack(categories: Category[], total: number): void {
  const stack = el<HTMLDivElement>('ms-stack');
  const legend = el<HTMLDivElement>('ms-legend');
  stack.textContent = '';
  legend.textContent = '';

  for (const cat of categories) {
    if (cat.bytes <= 0) continue;
    const pct = (cat.bytes / total) * 100;

    const seg = document.createElement('button');
    seg.type = 'button';
    seg.className = 'ms-seg';
    seg.style.width = `${pct}%`;
    seg.style.background = colorFor(cat.category);
    seg.title = `${cat.category} — ${human(cat.bytes)} (${pct.toFixed(1)}%)`;
    seg.setAttribute('aria-label', seg.title);
    seg.addEventListener('click', () => void showDetail(cat.category));
    stack.appendChild(seg);

    const item = document.createElement('span');
    item.className = 'ms-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'ms-swatch';
    swatch.style.background = colorFor(cat.category);
    const name = document.createElement('span');
    name.className = 'ms-legend-name';
    name.textContent = cat.category;
    const val = document.createElement('span');
    val.className = 'ms-legend-val';
    val.textContent = human(cat.bytes);
    item.append(swatch, name, val);
    legend.appendChild(item);
  }
}

function renderMeters(data: Summary): void {
  const box = el<HTMLDivElement>('ms-meters');
  box.textContent = '';
  const totals = data.totals!;

  if (totals.disk_total_bytes) {
    const used = totals.disk_total_bytes - (totals.disk_free_bytes ?? 0);
    box.appendChild(meter(
      'Droplet disk',
      used,
      totals.disk_total_bytes,
      `${human(used)} of ${human(totals.disk_total_bytes)}`,
    ));
  }

  const dbLabel = data.db_is_managed ? 'Database (managed cluster)' : 'Database';
  box.appendChild(data.db_limit_bytes
    ? meter(dbLabel, totals.db_bytes, data.db_limit_bytes, `${human(totals.db_bytes)} of ${human(data.db_limit_bytes)}`)
    : meter(dbLabel, 0, 0, human(totals.db_bytes), true));

  el<HTMLParagraphElement>('ms-managed-note').hidden = !data.db_is_managed;
}

/** A single ratio against a limit. `bare` = no known ceiling, so show no track. */
function meter(label: string, value: number, limit: number, text: string, bare = false): HTMLElement {
  const wrap = document.createElement('div');

  const top = document.createElement('div');
  top.className = 'ms-meter-top';
  const name = document.createElement('span');
  name.className = 'ms-meter-label';
  name.textContent = label;
  const val = document.createElement('span');
  val.className = 'ms-meter-val';
  val.textContent = bare ? `${text} (no limit configured)` : text;
  top.append(name, val);
  wrap.appendChild(top);

  if (!bare && limit > 0) {
    const pct = Math.min(100, (value / limit) * 100);
    const track = document.createElement('div');
    track.className = 'ms-meter-track';
    const fill = document.createElement('div');
    fill.className = 'ms-meter-fill';
    if (pct >= 90) fill.classList.add('ms-crit');
    else if (pct >= 75) fill.classList.add('ms-warn');
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    wrap.appendChild(track);
  }

  return wrap;
}

function renderCategories(categories: Category[], total: number): void {
  const box = el<HTMLDivElement>('ms-categories');
  box.textContent = '';

  for (const cat of categories) {
    const row = rowEl({
      label: cat.category,
      sub: `${cat.file_count.toLocaleString()} ${cat.category === 'database' ? 'rows' : 'files'}`,
      bytes: cat.bytes,
      max: total,
      color: colorFor(cat.category),
      tags: [
        ...(cat.reclaimable ? ['reclaimable'] : []),
        ...(cat.orphan_bytes > 0 ? [`${human(cat.orphan_bytes)} orphaned`] : []),
      ],
      orphanTag: cat.orphan_bytes > 0,
      button: true,
    });
    row.addEventListener('click', () => void showDetail(cat.category));
    box.appendChild(row);
  }
}

function renderBooks(books: BookRow[]): void {
  const box = el<HTMLDivElement>('ms-books');
  box.textContent = '';
  const max = books[0]?.bytes ?? 1;

  for (const book of books) {
    box.appendChild(rowEl({
      label: book.book,
      sub: book.owner ? `owner: ${book.owner}` : 'no owner',
      bytes: book.bytes,
      max,
      color: 'var(--ms-cat-1)',
      tags: book.is_orphan ? ['orphaned'] : [],
      orphanTag: book.is_orphan,
    }));
  }
}

async function renderOrphans(orphanBytes: number, fileBytes: number): Promise<void> {
  const section = el<HTMLElement>('ms-orphan-section');
  section.hidden = orphanBytes <= 0;
  if (orphanBytes <= 0) return;

  const share = fileBytes > 0 ? Math.round((orphanBytes / fileBytes) * 100) : 0;
  el<HTMLElement>('ms-orphan-total').textContent = human(orphanBytes);
  el<HTMLParagraphElement>('ms-orphan-line').textContent =
    `${share}% of all file storage belongs to books that no longer exist.`;

  const resp = await fetch('/api/maintainer/storage/orphans', { credentials: 'include' });
  if (!resp.ok) {
    log.error(`Orphan list fetch failed (${resp.status})`, 'maintainer-storage');
    return;
  }

  const data = await resp.json();
  const rows = (data.rows ?? []) as Array<DetailRow & { categories: string; path: string | null }>;
  const box = el<HTMLDivElement>('ms-orphan-rows');
  box.textContent = '';

  el<HTMLParagraphElement>('ms-orphan-line').textContent =
    `${data.book_count} book${data.book_count === 1 ? '' : 's'} no longer in the database — `
    + `${share}% of all file storage.`;

  const max = rows[0]?.bytes ?? 1;
  for (const row of rows) {
    box.appendChild(rowEl({
      label: row.label,
      sub: `${row.file_count.toLocaleString()} files · ${row.categories}`,
      bytes: row.bytes,
      max,
      color: 'var(--ms-cat-2)',
      tags: [],
    }));
  }
}

/** Bytes on disk that no book_images/book_audio row accounts for. */
function renderDrift(categories: Category[], totals: NonNullable<Summary['totals']>): void {
  const checks: Array<[string, number]> = [
    ['images', totals.images_tracked_bytes],
    ['audio', totals.audio_tracked_bytes],
  ];

  const messages: string[] = [];
  for (const [category, tracked] of checks) {
    const disk = categories.find((c) => c.category === category)?.bytes ?? 0;
    if (disk > 0 && Math.abs(disk - tracked) > 0.05 * disk) {
      messages.push(`${category}: ${human(disk)} on disk vs ${human(tracked)} recorded`);
    }
  }
  if (messages.length > 0) {
    setStatus(`drift — ${messages.join(' · ')}`);
  }
}

// ── Detail drill-down ─────────────────────────────────────────────────────

async function showDetail(category: string): Promise<void> {
  const resp = await fetch(`/api/maintainer/storage/detail/${encodeURIComponent(category)}`, {
    credentials: 'include',
  });
  if (!resp.ok) {
    setStatus(`detail failed (${resp.status})`);
    return;
  }

  const data = await resp.json();
  const rows = (data.rows ?? []) as DetailRow[];
  const section = el<HTMLElement>('ms-detail-section');
  const box = el<HTMLDivElement>('ms-detail');

  el<HTMLHeadingElement>('ms-detail-h').textContent = `${category} — by ${data.grouped_by}`;
  box.textContent = '';
  const max = rows[0]?.bytes ?? 1;

  const unit = category === 'database' ? 'rows' : 'files';

  for (const row of rows) {
    // Grouped by book: one owner, and the book either exists or it doesn't.
    // Grouped by type/table: no owner (a file type belongs to nobody) and no
    // orphan flag — instead say how much of it is orphaned, across how many books.
    // A database TABLE has no books attached to its snapshot row (those items
    // carry book = null), so a book count there is always 0 and always noise.
    const sub = data.grouped_by === 'book'
      ? `${row.file_count.toLocaleString()} ${unit}${row.owner ? ` · ${row.owner}` : ' · no owner'}`
      : data.grouped_by === 'table'
        ? `${row.file_count.toLocaleString()} ${unit}`
        : `${row.file_count.toLocaleString()} ${unit} · ${row.book_count.toLocaleString()} book${row.book_count === 1 ? '' : 's'}`;

    // ONE number per row. In "all" the value is the total; in "orphaned only"
    // it is the orphaned total. Mixing both in one row (a total on the right,
    // an orphan figure in a chip) just made people ask which number they were
    // reading. The book view keeps a plain flag — no number, it's binary there.
    const tags = data.grouped_by === 'book' && row.is_orphan ? ['orphaned'] : [];

    // Every leaf drills one more level: a table or a file type opens the books
    // filling it. A book row is already the bottom.
    const drillable = data.grouped_by !== 'book';

    const el = rowEl({
      label: drillable ? `${row.label} ›` : row.label,
      sub,
      bytes: row.bytes,
      max,
      color: colorFor(category),
      tags,
      orphanTag: tags.length > 0,
      button: drillable,
    });

    if (drillable) {
      el.addEventListener('click', () => void (data.grouped_by === 'table'
        ? showTableBooks(row.label)
        : showTypeBooks(category, row.label)));
    }

    box.appendChild(el);
  }

  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Second level: the books filling one database table (measured live). */
async function showTableBooks(table: string): Promise<void> {
  setStatus(`measuring ${table}… (full scan)`);
  const resp = await fetch(`/api/maintainer/storage/table/${encodeURIComponent(table)}`, {
    credentials: 'include',
  });
  if (!resp.ok) {
    setStatus(`could not measure ${table} (${resp.status})`);
    return;
  }

  const data = await resp.json();
  if (data.per_book === false) {
    setStatus(data.message);
    return;
  }

  renderDetailRows(
    `${table} — biggest books`,
    (data.rows ?? []) as DetailRow[],
    'database',
    data.note ? `Rows in ${table}. ${data.note}.` : '',
  );
  setStatus(`${table}: top ${data.rows?.length ?? 0} books`);
}

/** Second level: the books holding the most of one file type. */
async function showTypeBooks(category: string, subtype: string): Promise<void> {
  const resp = await fetch(
    `/api/maintainer/storage/type/${encodeURIComponent(category)}/${encodeURIComponent(subtype)}`,
    { credentials: 'include' },
  );
  if (!resp.ok) {
    setStatus(`could not load ${subtype} (${resp.status})`);
    return;
  }

  const data = await resp.json();
  renderDetailRows(
    `${category} · ${subtype} — biggest books`,
    (data.rows ?? []) as DetailRow[],
    category,
    `Books holding the most ${subtype} files.`,
  );
}

/** Shared renderer for any book-level list. */
function renderDetailRows(heading: string, rows: DetailRow[], category: string, note: string): void {
  const section = el<HTMLElement>('ms-detail-section');
  const box = el<HTMLDivElement>('ms-detail');

  el<HTMLHeadingElement>('ms-detail-h').textContent = heading;
  el<HTMLParagraphElement>('ms-detail-note').textContent = note;
  el<HTMLParagraphElement>('ms-detail-note').hidden = note === '';
  box.textContent = '';

  const max = rows[0]?.bytes ?? 1;
  for (const row of rows) {
    box.appendChild(rowEl({
      label: row.label,
      sub: `${row.file_count.toLocaleString()} ${category === 'database' ? 'rows' : 'files'}`
        + (row.owner ? ` · ${row.owner}` : ''),
      bytes: row.bytes,
      max,
      color: colorFor(category),
      tags: row.is_orphan ? ['orphaned'] : [],
      orphanTag: row.is_orphan,
    }));
  }

  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Row builder ───────────────────────────────────────────────────────────

interface RowSpec {
  label: string;
  sub: string;
  bytes: number;
  max: number;
  color: string;
  tags: string[];
  orphanTag?: boolean;
  button?: boolean;
}

function rowEl(spec: RowSpec): HTMLElement {
  const row = document.createElement(spec.button ? 'button' : 'div');
  row.className = 'ms-row';
  if (spec.button) (row as HTMLButtonElement).type = 'button';
  else row.setAttribute('role', 'listitem');

  const label = document.createElement('span');
  label.className = 'ms-row-label';
  label.textContent = spec.label;
  for (const tag of spec.tags) {
    const chip = document.createElement('span');
    chip.className = spec.orphanTag ? 'ms-tag ms-tag-orphan' : 'ms-tag';
    chip.textContent = tag;
    label.appendChild(chip);
  }
  const sub = document.createElement('span');
  sub.className = 'ms-row-sub';
  sub.textContent = ` ${spec.sub}`;
  label.appendChild(sub);

  const track = document.createElement('span');
  track.className = 'ms-row-track';
  const fill = document.createElement('span');
  fill.className = 'ms-row-fill';
  fill.style.width = `${Math.max(1, (spec.bytes / Math.max(1, spec.max)) * 100)}%`;
  fill.style.background = spec.color;
  track.appendChild(fill);

  const val = document.createElement('span');
  val.className = 'ms-row-val';
  val.textContent = human(spec.bytes);

  row.append(label, track, val);

  return row;
}

// ── Actions ───────────────────────────────────────────────────────────────

async function rescan(): Promise<void> {
  const token = await ensureCsrfToken();
  if (!token) {
    setStatus('session error — refresh and retry');
    return;
  }

  const btn = el<HTMLButtonElement>('ms-rescan');
  btn.disabled = true;
  setStatus('measuring…');

  const resp = await fetch('/api/maintainer/storage/rescan', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
  });

  btn.disabled = false;
  if (!resp.ok) {
    setStatus(`rescan failed (${resp.status})`);
    return;
  }

  render(await resp.json());
  setStatus('rescanned');
}

function wireHelp(): void {
  const panel = el<HTMLDivElement>('ms-help-panel');
  const toggle = el<HTMLButtonElement>('ms-help-toggle');

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) el<HTMLButtonElement>('ms-help-close').focus();
    else toggle.focus();
  };

  // `hidden` is boolean | "until-found" in lib.dom — coerce, don't assume.
  toggle.addEventListener('click', () => setOpen(Boolean(panel.hidden)));
  el<HTMLButtonElement>('ms-help-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });
}

el<HTMLButtonElement>('ms-rescan').addEventListener('click', () => void rescan());
el<HTMLButtonElement>('ms-export').addEventListener('click', () => {
  // Full snapshot, every row — the page only ever shows top-N.
  setStatus('preparing json…');
  window.location.href = '/api/maintainer/storage/export';
});
el<HTMLButtonElement>('ms-detail-close').addEventListener('click', () => {
  el<HTMLElement>('ms-detail-section').hidden = true;
});
wireHelp();
void load();

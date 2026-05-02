# Shelves — Design & Implementation Plan

Branch: `claude/book-shelves-feature-VjtCd`

## 1. Concept

Introduce **shelves** as the unifying abstraction for grouping books on a user's
home page. A shelf is a named, sortable, optionally-public collection of books
(like a Spotify playlist for texts). The existing **Public** and **Private**
tabs become *virtual shelves* over `library.creator + library.visibility`, so
all "groups of books" share one rendering pipeline.

A shelf is itself represented as a synthetic book (same trick already used for
`{username}` / `{username}Private` and the homepage rankings `most-recent`,
`most-connected`, `most-lit`) so we get chunk-based lazy loading for free with
zero new frontend infrastructure.

## 2. Data Model

### New tables

```sql
-- a shelf, owned by a user, optionally public
shelves (
  id              bigserial PRIMARY KEY,
  creator         varchar NOT NULL,        -- username
  name            varchar NOT NULL,
  description     text NULL,
  visibility      varchar NOT NULL DEFAULT 'private', -- 'public' | 'private'
  default_sort    varchar NOT NULL DEFAULT 'recent',  -- 'recent' | 'added' | 'views' | 'manual' | ...
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shelves_creator_updated_idx ON shelves (creator, updated_at DESC);

-- membership: which books are in which shelf
shelf_items (
  shelf_id        bigint NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  book            varchar NOT NULL REFERENCES library(book) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  manual_position double precision NULL,   -- for 'manual' sort
  PRIMARY KEY (shelf_id, book)
);
CREATE INDEX shelf_items_book_idx ON shelf_items (book);

-- pin overlay (works for both system and user shelves)
shelf_pins (
  shelf_key       varchar NOT NULL,        -- '{user}_public' | '{user}_private' | shelf:{id}
  book            varchar NOT NULL REFERENCES library(book) ON DELETE CASCADE,
  position        double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (shelf_key, book)
);
```

### Why virtual public/private (not materialized)

Avoids double-state and visibility-flip races. The shelf renderer accepts
either:
- a *virtual source*: `WHERE creator = ? AND visibility = ?`
- a *materialized source*: `JOIN shelf_items ON shelf_id = ?`

Pins overlay both via `shelf_pins.shelf_key`.

### Migration files

Naming convention (per repo): `YYYY_MM_DD_NNNNNN_description.php`

- `2026_05_02_000002_create_shelves_table.php`
- `2026_05_02_000003_create_shelf_items_table.php`
- `2026_05_02_000004_create_shelf_pins_table.php`

## 3. Backend Changes

### 3.1 Generalize the synthetic-book chunk generator

**File:** `app/Http/Controllers/UserHomeServerController.php`

Today, `generateUserHomeBook()` (lines 159–228) hardcodes Public/Private as two
queries against `library`. Refactor so it takes a **shelf descriptor**:

```php
// Pseudo-shape
[
  'shelf_key'  => 'username_public' | 'username_private' | 'shelf:42',
  'source'     => fn() => /* Eloquent builder yielding library rows */,
  'sort'       => 'recent' | 'added' | 'views' | 'manual',
  'pins'       => [book_id => position, ...], // from shelf_pins
]
```

Then both system shelves and user shelves go through one path:

1. Build the ordered list of book IDs (pins on top in `shelf_pins.position`
   order, then the rest in the requested sort)
2. Fetch matching `library` rows
3. Hand each chunk of 100 to existing `generateLibraryCardChunk()`
   (lines 427–464) → write to `nodes` table with `chunk_id = floor((pos-1)/100)`

`generateLibraryCardHtml()` (lines 466–480) is reused unchanged for the row
markup — but with the bin replaced by a `...` button (see §4.3).

### 3.2 New controller: `ShelfController`

**File:** `app/Http/Controllers/ShelfController.php` (new)

Endpoints:

| Method | Route                                    | Action                       |
|--------|------------------------------------------|------------------------------|
| POST   | `/api/shelves`                           | create shelf                 |
| PATCH  | `/api/shelves/{id}`                      | rename / change visibility / change default_sort |
| DELETE | `/api/shelves/{id}`                      | delete shelf                 |
| GET    | `/api/shelves/mine`                      | list my shelves (recently-updated) for the add-to-shelf submenu |
| POST   | `/api/shelves/{id}/items`                | add book to shelf            |
| DELETE | `/api/shelves/{id}/items/{book}`         | remove book from shelf       |
| POST   | `/api/shelves/{shelf_key}/pins`          | pin book in any shelf        |
| DELETE | `/api/shelves/{shelf_key}/pins/{book}`   | unpin                        |
| GET    | `/api/shelves/{id}/render?sort=...`      | trigger (re)generation of synthetic book nodes for this shelf+sort, returns synthetic book id |

Routes added in `routes/api.php` near line 244 (existing book/library group).

### 3.3 Models

**Files:** `app/Models/Shelf.php`, `app/Models/ShelfItem.php`, `app/Models/ShelfPin.php` (all new)

Relationships:
- `Shelf` hasMany `ShelfItem`
- `Shelf` belongsTo `User` (via `creator`)
- `ShelfItem` belongsTo `PgLibrary` (via `book`)

### 3.4 Synthetic book convention

Synthetic book IDs:
- `{username}_public` — system shelf
- `{username}_private` — system shelf
- `shelf_{id}_{sort}` — user shelf, one per (shelf, sort) so chunks cache cleanly

All marked `listed = false` in `library` and `raw_json.type = 'shelf'` so they
don't pollute search/homepage rankings.

### 3.5 Eager cache invalidation

When any of the following happen, **delete the synthetic book's `nodes` rows**
for *all* sort variants of the affected shelf, so next render rebuilds chunk 0
from scratch:

- `POST /api/shelves/{id}/items` (add)
- `DELETE /api/shelves/{id}/items/{book}` (remove)
- `POST /api/shelves/{shelf_key}/pins` (pin)
- `DELETE /api/shelves/{shelf_key}/pins/{book}` (unpin)
- `PATCH /api/shelves/{id}` if `default_sort` changes
- `library.visibility` flip → invalidate `{username}_public` and `{username}_private`

Add a small helper `ShelfCacheInvalidator::flush($shelfKey)` used by all of the
above. The frontend separately busts its IndexedDB cache for that book id (see
existing pattern in `resources/js/components/userContainer/cacheManager.js:15`
and `resources/js/components/toc.js:332,341`).

### 3.6 Sort / reorder threshold

- **Small shelves (≤ 100 books):** the backend returns the full ordered ID list
  with cheap metric columns (`recent`, `total_views`, `total_citations`). The
  frontend reorders in JS on sort-dropdown change — no round trip.
- **Large shelves (> 100 books):** sort change → frontend hits
  `/api/shelves/{id}/render?sort=X`, gets the synthetic book id, swaps the
  active book in the chunk loader, lazy-loads chunk 0 then onwards.

Threshold chosen because chunk 0 already fits 100 items.

## 4. Frontend Changes

### 4.1 Tabs on user.blade.php

**Files:**
- `resources/views/user.blade.php` (tab markup at lines 75–81)
- `resources/js/homepageDisplayUnit.js` (tab handlers at lines 82–114, 206–215, 397)

Changes:
- Keep Public · Private · Account pinned as today
- Add **one swappable shelf slot** to the right of Account
- When a user opens a shelf (via "go to shelf" from anywhere), it loads into
  the slot. Opening a different shelf replaces the current slot occupant —
  not a new tab.
- Slot is empty by default and hidden when no shelf is open
- Tab click handler is generalized: each tab knows its synthetic book id; the
  loader fetches that book's chunk 0

### 4.2 Sort dropdown + search bar (per shelf)

Above the list inside each shelf (Public, Private, and user shelves):
- Sort dropdown: Recent · Most viewed · Most cited · Most highlighted ·
  Date added (user shelves only) · Manual (user shelves only)
- Search input: filters the currently-loaded items by title/author client-side
  (server-side search is a v2)

Component is shared across all shelf tabs (Public/Private/user shelves are
visually identical except for tab name and which sort options apply).

Sort change behavior follows §3.6 threshold.

### 4.3 Replace bin with `...` action button

**File:** `app/Http/Controllers/UserHomeServerController.php` lines 471–476
(the `generateLibraryCardHtml()` method that emits the bin icon)

- Remove the `<button class="delete-book">` bin
- Add `<button class="card-actions">…</button>`
- Keep the `↗` arrow for SPA-nav (line 469) — it's the dominant action and
  shouldn't be folded into the menu

**Client-side handler:** `resources/js/components/userProfilePage.js` line 14
- Replace `.delete-book` listener with `.card-actions` listener that opens the
  hyperlight-style floating action set

### 4.4 Reuse the hyperlighting buttons component for row actions

**Files referenced:**
- `resources/views/reader.blade.php` line 95 (`<div id="hyperlight-buttons">`)
- `resources/js/hyperlights/selection.js` lines 172, 262–306, 363
- `resources/css/buttons.css` lines 465, 2054–2236

The selection-triggered floating buttons on reader.blade.php already do all the
hard work (mobile bottom-sheet vs desktop float-near-cursor). Extract its
positioning/show/hide logic into a small reusable module, e.g.:

```
resources/js/components/floatingActionMenu.js
```

API:
```js
floatingActionMenu.open({
  anchor: clickEvent | DOMRect,   // for desktop positioning
  buttons: [
    { id: 'preview',  label: 'Preview',       icon: '...' },
    { id: 'add',      label: 'Add to shelf',  icon: '...' },
    { id: 'delete',   label: contextLabel,    icon: '...' },
  ],
  onSelect: (id) => { ... },
});
```

Both `selection.js` (reader hyperlights) and the new card-actions handler
(library rows) call into this module. Visual style stays identical.

**Button order for v1** (left = easiest reach on mobile):
`Preview · Add to shelf · Delete`

**Context-aware delete label:**
- On a user shelf: "Remove from shelf" (calls `DELETE /api/shelves/{id}/items/{book}`)
- On Public/Private system shelves: "Delete book" (calls existing
  `DELETE /api/books/{book}` at `routes/api.php:244` →
  `DbLibraryController::destroy()` at line 55)

### 4.5 Preview action

When `Preview` is selected:
- Open the existing `hyperlit-container` overlay
- Load **chunk 0** of the previewed book via the existing endpoint
  `GET /api/database-to-indexeddb/books/{bookId}/chunk/{chunkId}`
  (`routes/api.php:356` → `DatabaseToIndexedDBController::getSingleChunk()` at
  line 1318) using `resources/js/chunkFetcher.js`
- Render those nodes inside the overlay
- Show a small floating sub-action bar at bottom: `Add to shelf · Delete · Go`
- `Go` = SPA-nav to the book (same as the row arrow)
- Closing the overlay leaves no state behind

No new endpoint needed — preview is just chunk 0 in a modal.

### 4.6 Add-to-shelf submenu

When `Add to shelf` is selected (from row menu or preview overlay):
- Mobile: second bottom sheet
- Desktop: flyout from the cursor menu

Contents:
- `+ New shelf…` at the top (opens a tiny inline form for name + visibility)
- List of the user's shelves from `GET /api/shelves/mine`, ordered by
  `updated_at DESC`
- Each row: shelf name, visibility icon, checkbox if the book is already in it
  (so the same UI handles add and remove from multiple shelves at once)

On confirm: batched POST/DELETE to `/api/shelves/{id}/items` per shelf.

### 4.7 Shelf creation entry points (v1)

1. The `+ New shelf…` row inside the add-to-shelf submenu (described above)
2. A `+` button in the new tab area on user.blade.php for an empty shelf
   (no initial book)

(A dedicated shelf-management page can come later.)

## 5. Caching Strategy

| Layer       | Key                                          | Invalidated when                              |
|-------------|----------------------------------------------|-----------------------------------------------|
| `nodes` rows (DB) | synthetic book id `shelf_{id}_{sort}`  | shelf items change, pins change, sort default change, visibility flip (for system shelves) |
| IndexedDB (browser) | `books/{syntheticBookId}/chunks/*`   | client-side cache bust on mutation response   |

Cache busting on the client mirrors the existing patterns in
`resources/js/components/userContainer/cacheManager.js` and
`resources/js/components/toc.js`.

## 6. Open Questions

- **Public shelf discoverability** — proposal: `listed = false` so shelves don't
  appear in homepage rankings; only reachable via direct link or creator's
  profile. Confirm before building.
- **Shelf-of-shelves** — explicitly out of scope. Don't allow nesting.
- **Server-side search inside a shelf** — v2. Client-side filter on loaded
  chunks is enough for v1.
- **Reorder of pins** — drag handle in pin list, or just unpin/repin? Default
  to unpin/repin in v1.
- **Threshold of 100** for frontend-vs-backend reorder — gut number; revisit
  if it feels wrong in practice.

## 7. Phased Rollout

### v1 (this branch)
- [ ] Migrations: `shelves`, `shelf_items`, `shelf_pins`
- [ ] Models: `Shelf`, `ShelfItem`, `ShelfPin`
- [ ] `ShelfController` with CRUD + add/remove items + render endpoints
- [ ] Routes added to `routes/api.php`
- [ ] Refactor `UserHomeServerController::generateUserHomeBook()` to accept
      shelf descriptor; existing Public/Private become virtual shelves through
      the same path
- [ ] `ShelfCacheInvalidator` helper + wire into mutation endpoints
- [ ] Extract `floatingActionMenu.js` from `hyperlights/selection.js`; make
      both reader and library use it
- [ ] Replace bin with `...` in `generateLibraryCardHtml()`
- [ ] Add-to-shelf submenu (with new-shelf inline form)
- [ ] Preview overlay reusing `hyperlit-container` + `chunkFetcher.js`
- [ ] Tab system on `user.blade.php`: pinned Public/Private/Account + one
      swappable shelf slot
- [ ] Sort dropdown + client-side search per shelf
- [ ] Small/large threshold for sort changes (frontend reorder vs backend regen)

### v1.1
- [ ] Pinning UI (pin/unpin button in card actions; pinned items render on top)
- [ ] Pin reorder (drag handle)

### v2
- [ ] Server-side search within large shelves
- [ ] Dedicated shelf-management page (rename, bulk add/remove, change visibility)
- [ ] Sharing UI for public shelves (copy link, embed snippet, etc.)

## 8. File Touch List (concrete targets)

**New:**
- `database/migrations/2026_05_02_000002_create_shelves_table.php`
- `database/migrations/2026_05_02_000003_create_shelf_items_table.php`
- `database/migrations/2026_05_02_000004_create_shelf_pins_table.php`
- `app/Models/Shelf.php`
- `app/Models/ShelfItem.php`
- `app/Models/ShelfPin.php`
- `app/Http/Controllers/ShelfController.php`
- `app/Services/ShelfCacheInvalidator.php`
- `resources/js/components/floatingActionMenu.js`
- `resources/js/components/shelves/addToShelfMenu.js`
- `resources/js/components/shelves/shelfPreview.js`
- `resources/js/components/shelves/shelfTabs.js`
- `resources/js/components/shelves/shelfSortAndSearch.js`

**Edit:**
- `app/Http/Controllers/UserHomeServerController.php` — refactor
  `generateUserHomeBook()` (159–228), generalize `generateLibraryCardChunk()`
  (427–464), update bin → `...` in `generateLibraryCardHtml()` (471–476)
- `app/Http/Controllers/DbLibraryController.php` — `destroy()` (55) should also
  call `ShelfCacheInvalidator` for system shelves of the book's creator
- `routes/api.php` — add `/api/shelves/*` route group near line 244
- `resources/views/user.blade.php` — tab markup (75–81): generalize for
  swappable shelf slot
- `resources/js/homepageDisplayUnit.js` — tab handlers (82–114, 206–215, 397):
  generalize for variable tab list
- `resources/js/components/userProfilePage.js` — line 14 selector swap
  (`.delete-book` → `.card-actions`) and wire to `floatingActionMenu`
- `resources/js/hyperlights/selection.js` — extract positioning/show/hide
  (172, 262–306, 363) into `floatingActionMenu.js`, then call it from here
- `resources/css/buttons.css` — port the hyperlight button styles
  (465, 2054–2236) to also apply to card-action menus (likely just a
  shared class name)

## 9. Test Plan

- Migrations apply cleanly on fresh DB
- Create shelf → appears in `/api/shelves/mine`
- Add book to shelf → appears in shelf chunk 0; `nodes` rows generated
- Remove book → `nodes` rows for that synthetic book are flushed; next render
  rebuilds without it
- Pin a book → appears at top of shelf regardless of sort
- Change sort on small shelf (< 100) → no network request, items reorder in JS
- Change sort on large shelf (> 100) → backend regenerates, chunk 0 reloads
- Make shelf public → other users can load `/u/{username}/shelf/{id}` (or
  whichever URL shape we land on)
- Toggle book `visibility` from public to private → both `{username}_public`
  and `{username}_private` synthetic books are flushed and rerender correctly
- Preview opens chunk 0, action bar works, close leaves no leaked state
- Floating action menu visually matches reader hyperlights on mobile and desktop

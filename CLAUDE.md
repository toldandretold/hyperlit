# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hyperlit is a Laravel 11 + Vite application that provides a sophisticated document reader with automatic two-way citation linking. Users can read documents, create highlights with annotations, and cite passages across documents with automatic bidirectional hyperlinking. The system uses a hybrid data storage approach with PostgreSQL, IndexedDB, and filesystem sources.

## Tech Stack

- **Backend**: Laravel 11 (PHP 8.2+)
- **Frontend**: Vanilla JavaScript (ES6 modules), Alpine.js
- **Build Tool**: Vite 6.2
- **Database**: PostgreSQL (primary), IndexedDB (client-side caching)
- **CSS**: Tailwind CSS 3.4, custom SCSS
- **Testing**: Pest (PHP testing framework)
- **Python**: Document processing utilities (EPUB, HTML, footnotes)

## Development Commands

### Starting the Development Environment

```bash
# Start all services (PHP server, queue worker, Vite dev server)
npm run dev:all

# Start individual services
npm run php        # Laravel server on localhost:8000
npm run queue      # Queue worker
npm run dev        # Vite dev server on port 5173

# Build for production
npm run build
```

### Database & Dependencies

```bash
# Install PHP dependencies
composer install

# Install Node dependencies
npm install

# Run database migrations
php artisan migrate

# Clear application cache
php artisan cache:clear
php artisan config:clear
php artisan route:clear
```

### Testing

```bash
# Run all tests with Pest
./vendor/bin/pest

# Run specific test suite
./vendor/bin/pest tests/Feature
./vendor/bin/pest tests/Unit
```

## Architecture

### Data Flow & Storage Strategy

Hyperlit uses a **three-tier data storage system** with priority-based loading:

1. **PostgreSQL** (primary source) - User data, annotations, highlights, citations
2. **IndexedDB** (client-side cache) - Offline support, performance optimization
3. **Filesystem** (fallback) - Static markdown/HTML files in `resources/markdown/{book}/`

**Loading Priority**: PostgreSQL → Filesystem → IndexedDB

The `TextController.php:14` determines which source to use when loading a book.

### Key Architectural Patterns

#### Automatic Two-Way Citation System (Hypercites)

The hypercite system (`hyperCites.js`) enables **automatic bidirectional citation linking** between documents:

**How it works:**
1. User selects text and clicks "Copy as Hypercite" button
2. System copies formatted citation to clipboard with auto-generated link
3. When user pastes into another document, a bidirectional link is created:
   - **Source document** (where text was copied): gets a `<u>` element marking the cited passage
   - **Target document** (where citation was pasted): contains the citation link
   - **Automatic backlink**: Source citation tracks where it was cited via `citedIN` array

**Citation Relationship States:**
- `single` - Not cited anywhere (no backlinks)
- `couple` - Cited in exactly one location (one backlink)
- `poly` - Cited in multiple locations (multiple backlinks)

When clicking a hypercite, behavior depends on relationship status:
- `single`: No action (not cited anywhere)
- `couple`: Navigates directly to the citing location
- `poly`: Opens container showing all citing locations with formatted bibliographic references

**Key Functions:**
- `handleCopyEvent()` (line 69) - Creates hypercite and copies to clipboard
- `wrapSelectedTextInDOM()` (line 231) - Wraps cited text in DOM with `<u>` element
- `NewHyperciteIndexedDB()` (line 302) - Saves hypercite to database with immediate sync
- `CoupleClick()` / `PolyClick()` - Handle clicks based on relationship status
- `delinkHypercite()` (line 1527) - Removes backlinks when citation is deleted

**Cross-Document Navigation:**
The system intelligently handles same-book and cross-book citations:
- Same-book highlight citations: Sequential navigation (highlight first, then internal hypercite)
- Cross-book citations: Full page navigation with loading overlay
- Uses `navigateToHyperciteTarget()` (line 901) for proper sequencing

#### Lazy Loading Architecture

Content is loaded on-demand using intersection observers:

- `lazyLoaderFactory.js` - Main lazy loading orchestrator
- `chunkManager.js` - Manages content chunks (typically 10 paragraphs per chunk)
- `indexedDB.js` - IndexedDB operations (DB_VERSION = 21)

Content is divided into "chunks" stored in the `node_chunks` table/store, loaded as users scroll.

#### Real-time Sync & Broadcasting

- Changes sync from IndexedDB → PostgreSQL via `postgreSQL.js`
- Cross-tab synchronization using `BroadcastChannel` API (`BroadcastListener.js`)
- Hypercites flush sync queue immediately via `debouncedMasterSync.flush()` for cross-device pasting
- Laravel Reverb for server-side broadcasting (optional)

### Database Schema

#### PostgreSQL Tables

- `node_chunks` - Document content chunks (book, startLine, content, node_uuid)
  - Contains embedded arrays: `hyperlights`, `hypercites`, `footnotes`
- `hyperlights` - User highlights (hyperlight_id, book, startLine, endLine, annotation, time_since, hidden)
- `hypercites` - Citations with backlinks (hyperciteId, book, hypercitedText, hypercitedHTML, startChar, endChar, relationshipStatus, citedIN array, time_since)
- `footnotes` - Footnotes (footnoteId, book, content)
- `bibliography` (references) - Bibliography entries (referenceId, book, content)
- `library` - Book metadata (book, title, author, creator, bibtex, timestamp, private)
- `users` - User accounts (Laravel Sanctum authentication)
- `anonymous_sessions` - Anonymous user tracking

**Important**: The `hypercites` table's `citedIN` field is an array storing URLs of all locations citing this hypercite. The `relationshipStatus` field is computed from the length of this array.

#### IndexedDB Stores

Mirrors PostgreSQL structure for offline capability (see `indexedDB.js:35`):
- `nodeChunks` - keyPath: `["book", "startLine"]`
- `hyperlights` - keyPath: `["book", "hyperlight_id"]`
- `hypercites` - keyPath: `["book", "hyperciteId"]`
- `footnotes` - keyPath: `["book", "footnoteId"]`
- `references` - keyPath: `["book", "referenceId"]`
- `library` - keyPath: `"book"`
- `historyLog`, `redoLog` - Undo/redo functionality

### Frontend Module Organization

#### Core Modules

- `app.js` - Application entry point, exports global `book` variable
- `initializePage.js` - Main initialization orchestrator
- `readerDOMContentLoaded.js` - DOM ready handler, initializes reader view
- `viewManager.js` - View state management (reader/edit modes)

#### Content Management

- `hyperLights.js` - Highlighting functionality (mark creation, click handlers)
- `hyperCites.js` - **Two-way automatic citation system** (copy/paste citations with bidirectional linking)
- `divEditor.js` - Rich text editing with toolbar
- `editToolbar.js` - Editor toolbar component
- `unifiedContainer.js` - Unified popup container for highlights/citations/footnotes
- `containerManager.js` - Manages container lifecycle

#### Navigation & UI

- `toc.js` - Table of contents generation and navigation
- `nav-buttons.js` - Navigation controls
- `scrolling.js` - Scroll behavior and position management
- `userContainer.js` - User profile/library interface

#### Data Synchronization

- `indexedDB.js` - IndexedDB CRUD operations, schema migrations
- `postgreSQL.js` - PostgreSQL sync via Laravel API
- `operationState.js` - Tracks pending operations, prevents race conditions
- `BroadcastListener.js` - Cross-tab synchronization

#### Editing & History

- `historyManager.js` - Undo/redo functionality
- `selectionHandler.js` - Text selection utilities
- `selectionDelete.js` - Deletion operations

### Backend Controllers

#### Document Controllers

- `TextController.php` - Book rendering, determines data source priority
- `CiteCreator.php` - Document import (DOCX, EPUB, Markdown, HTML)
- `ConversionController.php` - Markdown ↔ HTML conversion

#### Database API Controllers

All expose RESTful JSON APIs for frontend:

- `DbNodeChunkController.php` - Node chunk CRUD
- `DbHyperlightController.php` - Highlight operations
- `DbHyperciteController.php` - Citation operations (hypercites with backlinks)
- `DbFootnoteController.php` - Footnote operations
- `DbReferencesController.php` - Bibliography operations
- `DbLibraryController.php` - Book library management

#### Special Controllers

- `DatabaseToIndexedDBController.php` - Bulk sync PostgreSQL → IndexedDB
- `UserHomeServerController.php` - Generates user homepage "books"
- `HomePageServerController.php` - Public homepage data
- `BeaconSyncController.php` - Accepts sync beacons from Navigator `sendBeacon()`

### Python Document Processing

Located in `app/Python/`, these scripts process uploaded documents:

- `process_document.py` - Main document processor (DOCX, EPUB)
- `epub_processor.py` - EPUB extraction and conversion
- `html_footnote_processor.py` - Footnote extraction from HTML
- `preprocess_html.py` - HTML normalization
- `normalize_headings.py` - Heading structure normalization
- `process_footnotes.py` - Footnote processing pipeline
- `process_references.py` - Bibliography extraction

Called from PHP via `Symfony\Component\Process\Process`.

## Important Implementation Details

### BookID Conventions

- Main books: Simple string (e.g., `"myBook"`)
- User pages: Username string (e.g., `"john_doe"`)

User pages are dynamically generated books showing a user's library. When accessing `/{username}`, the system checks if a user exists with that name and generates their library page.

### Hypercite Workflow (Two-Way Citations)

**Creating a Citation:**
1. User selects text in document A
2. Clicks "Copy as Hypercite" button
3. System generates unique `hypercite_XXXXX` ID
4. Wraps selected text in `<u id="hypercite_XXXXX" class="single">` element
5. Copies to clipboard: `'quoted text'<a href="/bookA#hypercite_XXXXX">↗</a>`
6. Saves to IndexedDB and immediately flushes sync queue to PostgreSQL

**Pasting a Citation:**
1. User pastes in document B (creates link to document A's hypercite)
2. When document A loads, system fetches hypercite from database
3. Parses `citedIN` array to find backlinks
4. Updates relationship status and CSS class (`single` → `couple` or `poly`)

**Clicking a Citation:**
- If `couple`: Navigate directly to citing location
- If `poly`: Show container with all citing locations (formatted as bibliographic citations using BibTeX data)

**Deleting a Citation:**
- System calls `delinkHypercite()` to remove backlink from source document
- Updates relationship status of source hypercite
- Syncs changes to PostgreSQL

### Content Editing Flow

1. User clicks edit button → `viewManager.js` enables edit mode
2. Content becomes editable via `divEditor.js` (contenteditable divs)
3. Changes debounced and saved to IndexedDB via `indexedDB.js`
4. Background sync pushes to PostgreSQL via `postgreSQL.js`
5. Success/error indicators via `editIndicator.js`
6. History tracked in `historyLog` store for undo/redo

### Highlighting Flow

1. User selects text → `selectionHandler.js` captures range
2. Click highlight button → `hyperLights.js` creates marks
3. Generate unique ID: `HL_{timestamp}_{random}`
4. Save to IndexedDB `hyperlights` store
5. Sync to PostgreSQL `hyperlights` table
6. Broadcast to other tabs via `BroadcastChannel`

### Adding New Database Fields

When adding fields to PostgreSQL tables:

1. Create Laravel migration in `database/migrations/`
2. Run migration: `php artisan migrate`
3. Update corresponding model in `app/Models/`
4. Update IndexedDB schema in `indexedDB.js`:
   - Increment `DB_VERSION`
   - Add field to store config
   - Handle migration in `onupgradeneeded`
5. Update sync logic in `postgreSQL.js`
6. Update relevant controllers/API endpoints

### Routes

Main routes defined in `routes/web.php`:

- `/{book}` - Display book (reader view)
- `/{book}/edit` - Edit mode
- `/{book}/{hl}` - Book with specific highlight (e.g., `/{book}/HL_123456`)
- `/{username}` - User's library page (if username matches a user)
- `/{book}/media/{filename}` - Serve images
- `/{book}/main-text-footnotes.json` - Footnote data
- `/import-file` - Document upload endpoint

### Environment Variables

Key variables in `.env`:

- `APP_URL` - Application base URL
- `DB_CONNECTION` - Database type (pgsql or sqlite)
- `VITE_APP_URL` - For Vite proxy configuration
- `QUEUE_CONNECTION` - Queue driver (database or sync)

### Vite Configuration

The `vite.config.js` includes:
- HMR configuration for network access
- Proxy for `/api`, `/markdown` endpoints
- Static copy of service worker
- PWA plugin configuration

## Common Development Tasks

### Adding a New Document Format

1. Create processor in `app/Python/` (follow `epub_processor.py` pattern)
2. Add format detection in `CiteCreator.php`
3. Call Python processor via `Process` class
4. Save result to `node_chunks` table

### Creating a New Frontend Module

1. Create `.js` file in `resources/js/`
2. Add to `vite.config.js` inputs array
3. Import where needed (ES6 modules)
4. Export functions/state as needed

### Debugging Sync Issues

1. Check browser console for IndexedDB operations
2. Inspect `historyLog` store for pending operations
3. Check Laravel logs: `storage/logs/laravel.log`
4. Verify `operationState.js` pending operations map
5. Check PostgreSQL directly for data consistency
6. For hypercites: Check `citedIN` arrays and relationship status consistency

### Debugging Hypercite Issues

1. Check if `citedIN` array is properly populated in both IndexedDB and PostgreSQL
2. Verify relationship status matches array length (0=single, 1=couple, 2+=poly)
3. Check DOM element classes match database relationship status
4. Verify immediate sync flush happened (`debouncedMasterSync.flush()`)
5. Check cross-document navigation logic in `navigateToHyperciteTarget()`

### IndexedDB Schema Changes

Always increment `DB_VERSION` in `indexedDB.js` and handle migration in the `onupgradeneeded` event. The migration system preserves existing data during upgrades (see `indexedDB.js:27`).

## Key Design Decisions

### Why Immediate Sync for Hypercites?

Hypercites flush the sync queue immediately (bypassing the 3-second debounce) to enable cross-device citation pasting. Without this, a user could copy on device A, switch to device B, and paste before the sync completes, breaking the bidirectional link.

### Why Store Citations in Both Tables?

Hypercite data is stored in both `hypercites` table (main record) and embedded in `node_chunks.hypercites` array (for fast chunk-based rendering). This denormalization trades storage for performance during lazy loading.

### Why Three Relationship States?

The `single`/`couple`/`poly` pattern provides clear UX feedback:
- Visual differentiation via CSS classes
- Different click behaviors (direct navigation vs. list)
- Clear indication of citation impact/usage

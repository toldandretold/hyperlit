<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

use App\Http\Controllers\DbNodeChunkController;
use App\Http\Controllers\SubBookController;
use App\Http\Controllers\DbHyperlightController;
use App\Http\Controllers\DbHyperciteController;
use App\Http\Controllers\DbLibraryController;
use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Http\Controllers\HomePageServerController;
use App\Http\Controllers\BeaconSyncController;
use App\Http\Controllers\DbReferencesController;
use App\Http\Controllers\DbFootnoteController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\UnifiedSyncController;
use App\Http\Controllers\SearchController;
use App\Http\Controllers\NodeHistoryController;
use App\Http\Controllers\OpenAlexController;



// Public routes with rate limiting to prevent brute force and spam
Route::post('/login', [AuthController::class, 'login'])
    ->middleware('throttle:20,1') // 20 attempts per minute (reasonable for normal use + typos)
    ->name('login');

Route::post('/register', [AuthController::class, 'register'])
    ->middleware('throttle:10,1'); // 10 registrations per minute per IP

// Search routes - public access with rate limiting
Route::prefix('search')->middleware('throttle:60,1')->group(function () {
    Route::get('/library', [SearchController::class, 'searchLibrary']);
    Route::get('/nodes', [SearchController::class, 'searchNodes']);
    Route::get('/openalex', [OpenAlexController::class, 'search']);
    Route::get('/combined', [SearchController::class, 'searchWithOpenAlex']);
});

// OpenAlex: save a work as a library stub — no auth required (anonymous users can cite too)
Route::post('/openalex/save-to-library', [OpenAlexController::class, 'saveToLibrary'])
    ->middleware('throttle:10,1');

// OpenAlex citation lookup — requires authentication
Route::middleware('auth:sanctum')->group(function () {
    Route::post('/openalex/lookup-citation', [OpenAlexController::class, 'lookupCitation']);
});

Route::post('/auth/associate-content', [AuthController::class, 'associateContent'])->middleware('auth:sanctum');

Route::get('/auth/session-info', [AuthController::class, 'getSessionInfo']);

Route::post('/anonymous-session', [AuthController::class, 'createAnonymousSession']);
// Auth check (works for both authenticated and guest)
Route::get('/auth-check', [AuthController::class, 'checkAuth']);

Route::middleware(['author', 'throttle:120,1'])->group(function () {

    /* ----------------  Unified Sync Endpoint  ---------------- */
    Route::post(
        '/db/unified-sync',
        [UnifiedSyncController::class, 'sync']
    );

    /* ----------------  Homepage / library stats  ---------------- */
    Route::get(
        '/homepage/books',
        [HomePageServerController::class, 'getHomePageBooks']
    );
    
    Route::post(
        '/homepage/books/update',
        [HomePageServerController::class, 'updateHomePageBooks']
    );

    Route::post(
        '/library/{book}/update-stats',
        [DbLibraryController::class, 'updateBookStats']
    );

    Route::post(
        '/library/update-all-stats',
        [DbLibraryController::class, 'updateAllLibraryStats']
    );

    /* ----------------  Bulk-create  ---------------- */
    Route::post(
        '/db/node-chunks/bulk-create',
        [DbNodeChunkController::class, 'bulkCreate']
    );

    Route::post(
        '/db/hyperlights/bulk-create',
        [DbHyperlightController::class, 'bulkCreate']
    );

    Route::post(
        '/db/hypercites/bulk-create',
        [DbHyperciteController::class, 'bulkCreate']
    );

    Route::post(
        '/db/library/bulk-create',
        [DbLibraryController::class, 'bulkCreate']
    );


    /* ----------------  Upsert / targeted / delete  ---------------- */
    Route::post(
        '/db/node-chunks/upsert',
        [DbNodeChunkController::class, 'upsert']
    );

    Route::post(
        '/db/node-chunks/targeted-upsert',
        [DbNodeChunkController::class, 'targetedUpsert']
    );

    Route::post(
        '/db/hyperlights/upsert',
        [DbHyperlightController::class, 'upsert']
    );

    Route::post(
        '/db/hyperlights/delete',
        [DbHyperlightController::class, 'delete']
    );

    Route::post(
        '/db/hyperlights/hide',
        [DbHyperlightController::class, 'hide']
    );

    Route::post(
        '/db/hypercites/upsert',
        [DbHyperciteController::class, 'upsert']
    );

    Route::post(
        '/db/library/upsert',
        [DbLibraryController::class, 'upsert']
    );


    Route::post(
        '/db/library/update-timestamp', 
        [DbLibraryController::class, 'updateTimestamp']
    );

    Route::post(
        '/validate-book-id',
        [DbLibraryController::class, 'validateBookId']
    );

    Route::post(
        '/db/sync/beacon', 
        [BeaconSyncController::class, 'handleSync']
        );

    Route::delete('/books/{book}', [DbLibraryController::class, 'destroy'])->middleware('auth:sanctum');

     Route::get(
        '/db/hypercites/find/{book}/{hyperciteId}',
        [DbHyperciteController::class, 'find']
    );

    Route::post('/db/footnotes/upsert', [DbFootnoteController::class, 'upsert']);
    Route::post('/db/references/upsert', [DbReferencesController::class, 'upsertReferences']);

    /* ----------------  Sub-Books  ---------------- */
    Route::post('/db/sub-books/create', [SubBookController::class, 'create']);
    Route::post('/db/sub-books/migrate-existing', [SubBookController::class, 'migrateExisting']);

    /* ----------------  Node History / Version Control  ---------------- */
    // Get all versions of a specific node
    Route::get(
        '/nodes/{book}/{nodeId}/history',
        [NodeHistoryController::class, 'getNodeHistory']
    );

    // Get node as it was at a specific timestamp
    Route::get(
        '/nodes/{book}/{nodeId}/at/{timestamp}',
        [NodeHistoryController::class, 'getNodeAtTimestamp']
    )->where('timestamp', '.*'); // Allow slashes in timestamp

    // Get entire book state at a specific timestamp
    Route::get(
        '/books/{book}/at/{timestamp}',
        [NodeHistoryController::class, 'getBookAtTimestamp']
    )->where('timestamp', '.*');

    // Get recent changes for undo UI
    Route::get(
        '/books/{book}/changes',
        [NodeHistoryController::class, 'getRecentChanges']
    );

    // Restore a single node to a historical version
    Route::post(
        '/nodes/{book}/{nodeId}/restore',
        [NodeHistoryController::class, 'restoreNodeVersion']
    );

    // Restore entire book to a point in time
    Route::post(
        '/books/{book}/restore',
        [NodeHistoryController::class, 'restoreBookToTimestamp']
    );
});

// API routes for transferring data from database to IndexedDB
Route::prefix('database-to-indexeddb')->group(function () {
    // Get list of available books
    Route::get('books', [DatabaseToIndexedDBController::class, 'getAvailableBooks'])
        ->name('api.database-to-indexeddb.books');

    // Sub-book routes (two-segment IDs: {parentBook}/{subId})
    // Must be defined before the single-segment routes to avoid {bookId} swallowing the slash.
    Route::get('books/{parentBook}/{subId}/data', [DatabaseToIndexedDBController::class, 'getSubBookData'])
        ->name('api.database-to-indexeddb.sub-book-data');
    Route::get('books/{parentBook}/{subId}/metadata', [DatabaseToIndexedDBController::class, 'getSubBookMetadata'])
        ->name('api.database-to-indexeddb.sub-book-metadata');
    Route::get('books/{parentBook}/{subId}/library', [DatabaseToIndexedDBController::class, 'getSubBookLibrary'])
        ->name('api.database-to-indexeddb.sub-book-library');

    // Get full book data for IndexedDB import
    Route::get('books/{bookId}/data', [DatabaseToIndexedDBController::class, 'getBookData'])
        ->name('api.database-to-indexeddb.book-data');

    // Get just metadata (for checking if update needed)
    Route::get('books/{bookId}/metadata', [DatabaseToIndexedDBController::class, 'getBookMetadata'])
        ->name('api.database-to-indexeddb.book-metadata');

    // Get just library data for a specific book
    Route::get('books/{bookId}/library', [DatabaseToIndexedDBController::class, 'getBookLibrary'])
        ->name('api.database-to-indexeddb.book-library');
});


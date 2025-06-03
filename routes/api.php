<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

use App\Http\Controllers\DbNodeChunkController;
use App\Http\Controllers\DbHyperlightController;
use App\Http\Controllers\DbHyperciteController;
use App\Http\Controllers\DbLibraryController;
use App\Http\Controllers\DbFootnoteController;
use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Http\Controllers\HomePageServerController;

Route::middleware('auth:sanctum')->get('/user', function (Request $request) {
    return $request->user();
});
 

Route::post('/homepage/books/update', [HomePageServerController::class, 'updateHomePageBooks']);

Route::post('/library/{book}/update-stats', [DbLibraryController::class, 'updateBookStats']);
// Update stats for all books
Route::post('/library/update-all-stats', [DbLibraryController::class, 'updateAllLibraryStats']);

// Bulk Create 
Route::post('/db/node-chunks/bulk-create', [DbNodeChunkController::class, 'bulkCreate']);
Route::post('/db/hyperlights/bulk-create', [DbHyperlightController::class, 'bulkCreate']);
Route::post('/db/hypercites/bulk-create', [DbHyperciteController::class, 'bulkCreate']);
Route::post('/db/library/bulk-create', [DbLibraryController::class, 'bulkCreate']);
Route::post('/db/footnotes/bulk-create', [DbFootnoteController::class, 'bulkCreate']);

// Upsert routes (FIXED - removed extra 's' from controller names)
Route::post('/db/node-chunks/upsert', [DbNodeChunkController::class, 'upsert']);
Route::post('db/node-chunks/targeted-upsert', [DbNodeChunkController::class, 'targetedUpsert']);
Route::post('/db/hyperlights/upsert', [DbHyperlightController::class, 'upsert']);
Route::post('/db/hypercites/upsert', [DbHyperciteController::class, 'upsert']);
Route::post('/db/library/upsert', [DbLibraryController::class, 'upsert']);
Route::post('/db/footnotes/upsert', [DbFootnoteController::class, 'upsert']);




// API routes for transferring data from database to IndexedDB
Route::prefix('database-to-indexeddb')->group(function () {
    // Get list of available books
    Route::get('books', [DatabaseToIndexedDBController::class, 'getAvailableBooks'])
        ->name('api.database-to-indexeddb.books');
    
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

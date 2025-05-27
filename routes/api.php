<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

use App\Http\Controllers\DbNodeChunkController;
use App\Http\Controllers\DbHyperlightController;
use App\Http\Controllers\DbHyperciteController;
use App\Http\Controllers\DbLibraryController;
use App\Http\Controllers\DbFootnoteController;
use App\Http\Controllers\DatabaseToIndexedDBController;

Route::middleware('auth:sanctum')->get('/user', function (Request $request) {
    return $request->user();
});

// Bulk Create 
// Update database with the entire indexedDB objectstore of a specified book
Route::post('/db/node-chunks/bulk-create', [DbNodeChunkController::class, 'bulkCreate']);
Route::post('/db/hyperlights/bulk-create', [DbHyperlightController::class, 'bulkCreate']);
Route::post('/db/hypercites/bulk-create', [DbHyperciteController::class, 'bulkCreate']);
Route::post('/db/library/bulk-create', [DbLibraryController::class, 'bulkCreate']);
Route::post('/db/footnotes/bulk-create', [DbFootnoteController::class, 'bulkCreate']);

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
});

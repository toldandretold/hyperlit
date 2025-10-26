<?php

use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Auth;
use App\Http\Controllers\TextController;
use Illuminate\Http\Request;
use App\Models\User;

use App\Events\ProcessComplete;
use App\Http\Controllers\FootnotesController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\ConversionController;
use App\Http\Controllers\DbLibraryController;
use Illuminate\Validation\ValidationException;




require __DIR__.'/auth.php';

// Homepage
Route::get('/', [HomeController::class, 'index'])->name('home');
Route::get('/home', [HomeController::class, 'index']);

Route::get('/test-log', function () {
    Log::info('Hello with blank line');
    return 'Logged to storage/logs/laravel.log';
});

// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');

// File import route - use existing CiteCreator controller
Route::post('/import-file', [App\Http\Controllers\CiteCreator::class, 'store'])->name('import.file');

// JSON book route
Route::get('/{book}/main-text-footnotes.json', function ($book) {
    $filePath = public_path("/markdown/{$book}/main-text-footnotes.json");

    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }

    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-]+');

// Media serving route for all images (folder uploads use media/, docx uses media/)
Route::get('/{book}/media/{filename}', function ($book, $filename) {
    $filePath = resource_path("markdown/{$book}/media/{$filename}");

    if (!file_exists($filePath)) {
        abort(404, 'Image not found.');
    }

    // Get MIME type for proper content type
    $mimeType = mime_content_type($filePath);

    return response()->file($filePath, [
        'Content-Type' => $mimeType,
        'Cache-Control' => 'public, max-age=3600'
    ]);
})->where([
    'book' => '[a-zA-Z0-9\-_]+',
    'filename' => '[a-zA-Z0-9\-_.]+\.(jpg|jpeg|png|gif|webp|svg)'
]);

// Book edit route
Route::get('/{book}/edit', [TextController::class, 'show'])
     ->where('book', '[A-Za-z0-9_-]+')
     ->name('book.edit');

// Dynamic route - checks if identifier is username, otherwise treats as book
Route::get('/{identifier}', function(Request $request, $identifier) {
    // Check if it's a username
    if (User::where('name', $identifier)->exists()) {
        // It's a user page - use UserHomeServerController
        return app(\App\Http\Controllers\UserHomeServerController::class)->show($identifier);
    }

    // Otherwise it's a regular book - show reader.blade.php
    return app(TextController::class)->show($request, $identifier);
})->where('identifier', '[A-Za-z0-9_-]+');

// Book with hyperlight route
Route::get('/{book}/{hl?}', [TextController::class, 'show'])
     ->where([
       'book' => '[A-Za-z0-9_-]+',
       'hl'   => 'HL_[A-Za-z0-9_-]+'
     ])
     ->name('book.show');

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

// Offline fallback page - now served as static /public/offline.html by Service Worker

// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');

// File import route - requires authentication (logged in or valid anonymous session)
Route::post('/import-file', [App\Http\Controllers\ImportController::class, 'store'])
    ->middleware('author')
    ->name('import.file');

// JSON book route
Route::get('/{book}/main-text-footnotes.json', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

    $filePath = resource_path("markdown/{$book}/main-text-footnotes.json");

    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }

    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-_]+');

// Main text markdown file route
Route::get('/{book}/main-text.md', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

    $filePath = resource_path("markdown/{$book}/main-text.md");

    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }

    return response()->file($filePath, ['Content-Type' => 'text/markdown']);
})->where('book', '[a-zA-Z0-9\-_]+');

// Latest update JSON route
Route::get('/{book}/latest_update.json', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

    $filePath = resource_path("markdown/{$book}/latest_update.json");

    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }

    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-_]+');

// SECURITY: Helper function to check if user can access book content
// Returns true if book is public OR user is the owner
if (!function_exists('canAccessBookContent')) {
    function canAccessBookContent($book, $request) {
        $library = \App\Models\PgLibrary::where('book', $book)->first();

        // If no library record, allow access (legacy or public content)
        if (!$library) {
            return true;
        }

        // Public books are accessible to everyone
        if ($library->visibility === 'public') {
            return true;
        }

        // For private books, check ownership
        $user = Auth::user();
        if ($user && $library->creator === $user->name) {
            return true;
        }

        // Check anonymous token
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $library->creator_token === $anonToken) {
            return true;
        }

        return false;
    }
}

// JSON routes for nodes, footnotes, references (fallback file access)
Route::get('/{book}/nodes.json', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

    $filePath = resource_path("markdown/{$book}/nodes.json");
    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }
    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-_]+');

Route::get('/{book}/footnotes.json', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

    $filePath = resource_path("markdown/{$book}/footnotes.json");
    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }
    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-_]+');

Route::get('/{book}/references.json', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

    $filePath = resource_path("markdown/{$book}/references.json");
    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }
    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-_]+');

// Media serving route for all images (folder uploads use media/, docx uses media/)
Route::get('/{book}/media/{filename}', function (Request $request, $book, $filename) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // SECURITY: Check authorization
    if (!canAccessBookContent($book, $request)) {
        abort(403, 'Access denied.');
    }

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

// User pages - /u/{username}
Route::get('/u/{username}', function($username) {
    return app(\App\Http\Controllers\UserHomeServerController::class)->show($username);
})->where('username', '[A-Za-z0-9_-]+')->name('user.home');

// Legacy user page route - redirects to new /u/{username} format
Route::get('/{identifier}', function(Request $request, $identifier) {
    // Check if it's a username - redirect to new format
    // Try exact match first
    $user = User::where('name', $identifier)->first();

    // If no exact match, try sanitized match (handles usernames with spaces)
    if (!$user) {
        $users = User::all();
        foreach ($users as $potentialUser) {
            $sanitizedDbName = str_replace(' ', '', $potentialUser->name);
            $sanitizedIdentifier = str_replace(' ', '', $identifier);
            if ($sanitizedDbName === $sanitizedIdentifier) {
                $user = $potentialUser;
                break;
            }
        }
    }

    // If we found a user, redirect to /u/{sanitized_username}
    if ($user) {
        $sanitizedUsername = str_replace(' ', '', $user->name);
        return redirect("/u/{$sanitizedUsername}", 301);
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

// Book with footnote route (footnote IDs contain _Fn)
Route::get('/{book}/{fn}', [TextController::class, 'show'])
     ->where([
       'book' => '[A-Za-z0-9_-]+',
       'fn'   => '[A-Za-z0-9_-]*_Fn[A-Za-z0-9_-]+'
     ])
     ->name('book.footnote');

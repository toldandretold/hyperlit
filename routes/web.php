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

// Standalone sub-book route: /based/{subBookId} loads sub-book as full-screen
Route::get('/based/{subBookId}', [TextController::class, 'showStandalone'])
     ->where('subBookId', '.+')
     ->name('book.standalone');

// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');

// AI Citation Review sub-book route
Route::get('/{book}/AIreview', function (Request $request, $book) {
    $subBookId = "{$book}/AIreview";
    if (!DB::table('nodes')->where('book', $subBookId)->exists()) {
        abort(404, 'AI Review not found for this book.');
    }
    return view('reader', [
        'html'       => '',
        'book'       => $subBookId,
        'editMode'   => false,
        'dataSource' => 'database',
        'pageType'   => 'reader',
    ]);
})->where('book', '[A-Za-z0-9_-]+')->name('book.aireview');

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

// Download all book data as ZIP (owner-only)
Route::get('/{book}/download-all', function (Request $request, $book) {
    $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book);

    // Check ownership (not just read access)
    $user    = $request->user();
    $anonTok = $request->cookie('anon_author');

    $record = DB::table('library')->where('book', $book)->first();
    if (!$record) {
        abort(404, 'Book not found.');
    }

    $isOwner = false;
    if ($user && $record->creator === $user->name) {
        $isOwner = true;
    } elseif (!$user && $anonTok && $record->creator_token && hash_equals($record->creator_token, $anonTok)) {
        $isOwner = true;
    }
    if (!$isOwner) {
        abort(403, 'Only the book owner can download all data.');
    }

    $bookDir = resource_path("markdown/{$book}");
    if (!is_dir($bookDir)) {
        abort(404, 'Book directory not found.');
    }

    $zipPath = tempnam(sys_get_temp_dir(), 'hyperlit_') . '.zip';
    $zip = new \ZipArchive();
    if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
        abort(500, 'Could not create ZIP archive.');
    }

    $files = new \RecursiveIteratorIterator(
        new \RecursiveDirectoryIterator($bookDir, \RecursiveDirectoryIterator::SKIP_DOTS),
        \RecursiveIteratorIterator::LEAVES_ONLY
    );

    foreach ($files as $file) {
        if ($file->isFile()) {
            $realPath = $file->getRealPath();
            $relativePath = $book . '/' . substr($realPath, strlen($bookDir) + 1);
            $zip->addFile($realPath, $relativePath);
        }
    }

    $zip->close();

    return response()->download($zipPath, "{$book}_all_data.zip")->deleteFileAfterSend(true);
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

// Password reset page
Route::get('/reset-password/{token}', function (Request $request, $token) {
    return view('reset-password', [
        'token' => $token,
        'email' => $request->query('email', ''),
    ]);
})->name('password.reset');

// Email verification link (clicked from email)
Route::get('/email/verify/{id}/{hash}', [\App\Http\Controllers\AuthController::class, 'verifyEmail'])
    ->middleware('signed')
    ->name('verification.verify');

// Time machine route (must come before /{book}/edit catch)
Route::get('/{book}/timemachine', [TextController::class, 'showTimeMachine'])
     ->where('book', '[A-Za-z0-9_-]+')
     ->name('book.timemachine');

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

// Deep nesting route: /book/2/Fn.../HL_... loads parent book with auto-open chain
Route::get('/{book}/{rest}', [TextController::class, 'showNested'])
     ->where([
       'book' => '[A-Za-z0-9_-]+',
       'rest' => '[0-9]+/.+',
     ])
     ->name('book.nested');

// Book with hyperlight route
Route::get('/{book}/{hl?}', [TextController::class, 'show'])
     ->where([
       'book' => '[A-Za-z0-9_-]+',
       'hl'   => 'HL_[A-Za-z0-9_-]+'
     ])
     ->name('book.show');

// Book with footnote route
// Matches all known footnote ID formats:
//   Fn1766534896037_2ksr                        (starts with Fn)
//   asdf324_Fn1766385828280_2zhg                (_Fn in middle)
//   ahumada2025_section_1_Fn1766534896037_2ksr  (_Fn in middle)
//   book_1757846828811Fn175784683098524         (Fn in middle, no preceding _)
Route::get('/{book}/{fn}', [TextController::class, 'show'])
     ->where([
       'book' => '[A-Za-z0-9_-]+',
       'fn'   => '[A-Za-z0-9_-]*Fn[A-Za-z0-9_-]+'
     ])
     ->name('book.footnote');

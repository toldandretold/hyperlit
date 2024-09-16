<?php

use App\Http\Controllers\ProfileController;
use App\Http\Controllers\MarkdownController;
use App\Http\Controllers\PageController;
use App\Http\Controllers\BookController;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\PandocBookController;
use App\Http\Controllers\HighlightController;
use App\Http\Controllers\TextController;
use App\Http\Controllers\TestController;
use App\Http\Controllers\MarkdownITController;


// Home route
Route::get('/', function () {
    return view('markdown');
});

// Dashboard route with middleware
Route::get('/dashboard', function () {
    return view('dashboard');
})->middleware(['auth', 'verified'])->name('dashboard');

// Authenticated routes group
Route::middleware('auth')->group(function () {
    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');
});

// Markdown editor routes
Route::get('/markdown-editor', [MarkdownController::class, 'showEditor'])->name('markdown.editor');
Route::post('/markdown-editor/save', [MarkdownController::class, 'saveMarkdown'])->name('markdown.save');
Route::get('/editor', [MarkdownController::class, 'showEditor'])->name('showEditor');
Route::get('/markdown', [MarkdownController::class, 'getMarkdown'])->name('getMarkdown');
Route::post('/save-markdown', [MarkdownController::class, 'saveMarkdown'])->name('saveMarkdown');

// Markdown-it routes
Route::get('/markdown-IT-editor', [MarkdownITController::class, 'show'])->name('markdown.show');
Route::post('/markdown-IT-editor/save', [MarkdownITController::class, 'save'])->name('markdownIT.save');

// Page creation routes
Route::post('/create-page', [PageController::class, 'createPage']);
Route::post('/save-content', [PageController::class, 'saveContent']);

// Book route for strategic_imaginaries (specific book)
Route::get('/book/strategic_imaginaries', [App\Http\Controllers\SiteController::class, 'show']);

// Dynamic book page routes (specific before general)
Route::get('/book/{filename}', [PandocBookController::class, 'show']);
Route::get('/book/{page}', [BookController::class, 'show']);

// Deepnote route
Route::get('/deepnote', function () {
    return view('deepnote');
});

// Highlight routes
Route::post('/save-highlight', [HighlightController::class, 'store']);
Route::post('/update-markdown', [HighlightController::class, 'updateMarkdown']);
Route::post('/delete-highlight', [HighlightController::class, 'deleteHighlight']);
Route::post('/save-updated-html', [HighlightController::class, 'store']);

// Hyperlighting route
Route::get('/hyperlighting', function () {
    return view('hyperlighting');
});

// Test mapping route
Route::get('/test-mapping', [TestController::class, 'testMapping']);

Route::get('/test-parsedown', function () {
    $markdown = "Sample **bold** text";
    $parsedown = new \App\Http\Controllers\MappedParsedown();
    $result = $parsedown->text($markdown);

    // Output result for testing
    return response()->json($result);
});

// Specific route for book's hyperlights
Route::get('/{book}/hyperlights', [MarkdownITController::class, 'showEditor'])->name('markdownIT.show');
Route::post('/{book}/saveMarkdown', [MarkdownITController::class, 'saveMarkdown'])->name('markdownIT.save');

// General book route (should be last to avoid conflict with more specific routes)
Route::get('/{book}', [TextController::class, 'show']);


require __DIR__.'/auth.php';
